import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { decode } from '@toon-format/toon'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { copyClientInput } from '../fixtures/client-inputs.js'
import type Database from 'better-sqlite3'
import { createApp } from '../../src/server/app.js'
import { ArtifactStore, artifactDefaults } from '../../src/server/artifacts.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { issueRecentAuthTicket } from '../../src/server/auth/tokens.js'
import { Runner } from '../../src/server/runner/runner.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { transferLimits } from '../../src/shared/api.js'
import type { TransferScope } from '../../src/shared/api.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { SessionStore } from '../../src/cli/session.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
let adapter: ReturnType<typeof createMgAdapter>
const selections: TransferScope['selection'][] = [
  { operation: 'mail.message.export', selector: 'mailbox@contoso.example/synthetic-message', type: 'mime' },
  { operation: 'mail.attachment.save', selector: 'mailbox@contoso.example/synthetic-message/synthetic-attachment', type: 'attachment' },
]
const credential = { mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph-secret',
  tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' }
const settings = { enabledPacks: ['entra', 'mail'], writes: { allowWrites: true, operations: selections.map(item => item.operation) } }
beforeEach(async () => {
  // Install the rejecting boundary before constructing the application.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this fixture') }))
  directory = await mkdtemp(join(tmpdir(), 'artium-mail-transfer-'))
  copyClientInput('bundle', join(directory, 'artium-axi.mjs'))
  const root = join(directory, 'artifacts')
  await mkdir(root, { mode: 0o700 })
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  db = openStore(join(directory, 'store.db'), key)
  await seedToolUser(db)
  db.prepare("UPDATE tools SET enabled = 1, native_settings = ? WHERE name = 'mg-axi'").run(JSON.stringify(settings))
  db.prepare("INSERT OR IGNORE INTO role_tools (role_id, tool) SELECT id, 'mg-axi' FROM roles").run()
  const credentials = createCredentialStore(db, key)
  credentials.replaceCredential('mg-axi', credential, 0, 'synthetic-development-user', Date.now())
  const audit = new Audit(db)
  const store = await ArtifactStore.create(audit, root, { inspect: async () => ({
    mountinfo: `1 2 0:1 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1048576k`,
    filesystemType: 0x01021994, capacityBytes: transferLimits.reservedBytes, freeBytes: transferLimits.reservedBytes,
    memoryMax: artifactDefaults.containerBytes, memoryCurrent: 0, swapMax: 0, swapCurrent: 0 }) })
  adapter = createMgAdapter(new EmbeddedSecretSource(credentials), join(directory, 'writes.log'),
    loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!)
  const prepare = adapter.prepareArtifact!.bind(adapter)
  vi.spyOn(adapter, 'prepareArtifact').mockImplementation(async (...args) => {
    const call = await prepare(...args)
    return { ...call, executable: process.execPath,
      args: [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args] }
  })
  app = createApp({ db, audit, runner: await Runner.create(join(directory, 'calls')), adapters: [adapter],
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials, artifactStore: store, environment: {} })
  await app.ready()
  const token = issueTestAccessToken(db, 'synthetic-development-user')
  headers = { authorization: `Bearer ${token}`, 'x-artium-reauth-ticket': issueRecentAuthTicket(db, token).ticket,
    'accept-encoding': 'identity' }
})
afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})
const post = (action: string, payload: object) => app.inject({ method: 'POST', url: `/v1/transfers/mg/${action}`, headers, payload })
const inputFor = (selection = selections[0]) => ({ selection, targetDigest: 'a'.repeat(64) })

test.each(selections)('$operation verifies published native bytes and journal before one-shot retrieval', async selection => {
  const input = inputFor(selection)
  const prepared = await post('prepare', input)
  expect(prepared.statusCode, prepared.body).toBe(200)
  const preview = prepared.json()
  expect(preview.warnings.join(' ')).toContain('untrusted data')
  expect(JSON.parse(preview.confirm)).toEqual([preview.transferId, input.targetDigest, 1, selection, preview.expiresAt])
  const request = { ...input, transferId: preview.transferId }
  const executed = await post('execute', { ...request, execute: true, confirm: preview.confirm })
  expect(executed.statusCode, executed.body).toBe(200)
  const download = await post('retrieve', request)
  expect(download.statusCode, download.body).toBe(200)
  expect(download.body).toBe('Synthetic inert Graph artifact\n')
  expect((await post('receipt', { ...request, archive: executed.json().archive, saveOutcome: 'verified-save' })).statusCode).toBe(204)
  expect((await post('retrieve', request)).statusCode).not.toBe(200)
  const records = db.prepare("SELECT * FROM audit WHERE event = 'transfer'").all()
  expect(JSON.stringify(records)).not.toMatch(/mailbox@|synthetic-message|synthetic-attachment|CANARY-/)
  expect(records).toContainEqual(expect.objectContaining({ native_journal_result: 'SUCCESS', client_save_outcome: 'verified-save' }))
  expect(await readdir(join(directory, 'artifacts'))).toEqual([])
  expect(await readdir(join(directory, 'calls'))).toEqual([])
  const journal = await readFile(join(directory, `writes.log.${preview.transferId}`), 'utf8')
  expect(journal).not.toContain('synthetic-message')
  expect(journal).toContain('"outcome":"SUCCESS"')
})

test('bundled CLI saves and receipts Graph MIME bytes in a new private file', async () => {
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated',
    accessToken: headers.authorization.slice(7), refreshToken: 'CANARY-unused-refresh',
    accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 43200000 })
  await mkdir(join(directory, 'downloads'), { mode: 0o700 })
  const destination = join(directory, 'downloads', 'message.eml')
  const cli = async (args: string[]) => {
    const child = spawn(process.execPath, [join(directory, 'artium-axi.mjs'), 'download', ...args, '--password-stdin'],
      { env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.end('CANARY-local-password\n')
    const [code] = await once(child, 'close')
    expect(code, stdout + stderr).toBe(0)
    expect(stderr).toBe('')
    return stdout
  }
  const args = ['--operation', 'mail.message.export', '--selector', selections[0].selector, '--type', 'mime', '--destination', destination]
  const preview = decode(await cli(args)) as { transferId: string, confirm: string }
  const saved = await cli([...args, '--transfer', preview.transferId, '--execute', '--confirm', preview.confirm])
  expect(saved).toContain('saveOutcome: verified-save')
  expect(saved).toContain('receipt: confirmed')
  expect(await readFile(destination, 'utf8')).toBe('Synthetic inert Graph artifact\n')
  expect((await stat(destination)).mode & 0o777).toBe(0o600)
  expect(await readdir(join(directory, 'artifacts'))).toEqual([])
})

test.each(['reference-attachment', 'oversize-attachment'])('%s fails closed and removes partial bytes', async id => {
  const input = inputFor({ ...selections[1], selector: `mailbox@contoso.example/synthetic-message/${id}` })
  const prepared = await post('prepare', input)
  expect(prepared.statusCode, prepared.body).toBe(200)
  const preview = prepared.json()
  const result = await post('execute', { ...input, transferId: preview.transferId, execute: true, confirm: preview.confirm })
  expect(result.statusCode).not.toBe(200)
  expect(await readdir(join(directory, 'artifacts'))).toEqual([])
})

test.each(['bad-hash', 'missing-journal'])('%s prevents retrieval and removes generated bytes', async id => {
  const input = inputFor({ ...selections[0], selector: `mailbox@contoso.example/${id}` })
  const preview = (await post('prepare', input)).json()
  const result = await post('execute', { ...input, transferId: preview.transferId, execute: true, confirm: preview.confirm })
  expect(result.statusCode).not.toBe(200)
  expect(await readdir(join(directory, 'artifacts'))).toEqual([])
})

test.each(['pack', 'operation', 'revision', 'selector', 'destination', 'confirmation'])('changed %s refuses execution without launching the native downloader', async change => {
  const input = inputFor()
  const preview = (await post('prepare', input)).json()
  vi.mocked(adapter.prepareArtifact!).mockClear()
  if (change === 'pack') db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'mg-axi'").run(JSON.stringify({ ...settings, enabledPacks: ['entra'] }))
  if (change === 'operation') db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'mg-axi'").run(JSON.stringify({ ...settings, writes: { allowWrites: true, operations: ['mail.attachment.save'] } }))
  if (change === 'revision') db.exec("UPDATE credentials SET revision = revision + 1 WHERE tool = 'mg-axi'")
  const result = await post('execute', { ...input, transferId: preview.transferId, execute: true,
    confirm: change === 'confirmation' ? 'wrong' : preview.confirm,
    ...(change === 'selector' ? { selection: { ...selections[0], selector: 'mailbox@contoso.example/other' } } : {}),
    ...(change === 'destination' ? { targetDigest: 'b'.repeat(64) } : {}) })
  expect(result.statusCode).not.toBe(200)
  expect(adapter.prepareArtifact).not.toHaveBeenCalled()
  expect(await readdir(join(directory, 'artifacts'))).toEqual([])
})

test.each(['mail attachment save', 'mail message export'])('ordinary %s is refused before credential lookup', async command => {
  const getCredential = vi.fn()
  const ordinary = createMgAdapter({ getCredential }, join(directory, 'unused.log'))
  await expect(ordinary.prepare(command.split(' '), { id: 'fixture', tool: 'mg-axi', revision: 1 }))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([
  { enabledPacks: ['entra'], writes: settings.writes },
  { enabledPacks: ['entra', 'mail'] },
  { ...settings, writes: { allowWrites: true, operations: ['entra.user.update'] } },
])('downloads require explicit pack and operation opt-in before preview', async disabled => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'mg-axi'").run(JSON.stringify(disabled))
  expect((await post('prepare', inputFor())).statusCode).not.toBe(200)
  expect(adapter.prepareArtifact).not.toHaveBeenCalled()
  expect(await readdir(join(directory, 'artifacts'))).toEqual([])
})
