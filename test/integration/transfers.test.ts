import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { watch } from 'node:fs'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decode } from '@toon-format/toon'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createApp } from '../../src/server/app.js'
import { ArtifactStore, artifactDefaults } from '../../src/server/artifacts.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createHybridAdapter, hybridWritePolicy } from '../../src/server/adapters/hybrid.js'
import { issueRecentAuthTicket } from '../../src/server/auth/tokens.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { transferLimits, transferWarning } from '../../src/shared/api.js'
import type { TransferScope } from '../../src/shared/api.js'
import { transferTargetDigest } from '../../src/server/transfer.js'
import { SessionStore } from '../../src/cli/session.js'
import { Client } from '../../src/cli/http.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'

let directory: string
let root: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let url: string
let token: string
let headers: Record<string, string>
let variant: string
let artifactSize: number
let destination: string
let policy: ReturnType<typeof vi.spyOn>
const selection = { operation: 'hash-download-bin' as const, selector: 'a'.repeat(64), type: 'bin' as const }
const reportSelections: TransferScope['selection'][] = [
  { operation: 'report-download-bin', selector: 'synthetic-report', type: 'bin' },
  { operation: 'report-download-dropped-files', selector: 'synthetic-report', type: 'dropped-files' },
  { operation: 'report-download-memory', selector: 'synthetic-report', type: 'memory' },
]
const password = 'CANARY-local-password'
const user = 'synthetic-development-user'
const body = () => ({ selection, targetDigest: transferTargetDigest(destination) })
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artium-transfer-http-'))
  root = join(directory, 'artifacts')
  await mkdir(root, { mode: 0o700 })
  await mkdir(join(directory, 'downloads'), { mode: 0o700 })
  destination = join(directory, 'downloads', 'new.bin')
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  db = openStore(join(directory, 'data', 'artium.db'), key)
  await seedToolUser(db)
  db.exec(`UPDATE tools SET enabled = 1, native_settings = '{"writes":{"allowWrites":true,"operations":["hash-download-bin"]}}' WHERE name = 'hybrid-axi'`)
  const credentials = createCredentialStore(db, key)
  credentials.replaceCredential('hybrid-axi', { apiKey: 'CANARY-download-key' }, 0, user, Date.now())
  const audit = new Audit(db)
  const store = await ArtifactStore.create(audit, root, { inspect: async () => ({
    mountinfo: `1 2 0:1 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1048576k`,
    filesystemType: 0x01021994, capacityBytes: transferLimits.reservedBytes, freeBytes: transferLimits.reservedBytes,
    memoryMax: artifactDefaults.containerBytes, memoryCurrent: 0, swapMax: 0, swapCurrent: 0 }) })
  const adapter = createHybridAdapter(new EmbeddedSecretSource(credentials), join(directory, 'writes.log'))
  const prepare = adapter.prepareArtifact!.bind(adapter)
  variant = 'success'
  artifactSize = 257
  vi.spyOn(adapter, 'prepareArtifact').mockImplementation(async (args, reference, scope) => {
    const prepared = await prepare(args, reference, scope)
    return { ...prepared, executable: fakeTool.executable,
    args: [...fakeTool.args, variant === 'success' || !args.includes('--execute') ? 'native-artifact' : 'artifact', ...args],
    environment: { ...prepared.environment,
      ARTIUM_TEST_ARTIFACT_VARIANT: variant, ARTIUM_TEST_ARTIFACT_BYTES: String(artifactSize),
      ARTIUM_TEST_RSS_FILE: join(directory, 'rss.json'), ARTIUM_TEST_READY_FILE: join(directory, 'ready.json') },
  } })
  // Fake only the not-yet-enabled capability boundary. All current tool, user,
  // write selection, credential, native confirmation and journal checks remain real.
  const read = hybridWritePolicy.read
  policy = vi.spyOn(hybridWritePolicy, 'read').mockImplementation(settings => ({ ...read(settings),
    supportedOperations: [...read(settings).supportedOperations!, selection.operation, ...reportSelections.map(row => row.operation)] }))
  const runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, audit, runner, adapters: [adapter], resolver: new SharedIdentityResolver(credentials),
    credentialStore: credentials, artifactStore: store, environment: {} })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  token = issueTestAccessToken(db, user)
  headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-artium-reauth-ticket': issueRecentAuthTicket(db, token).ticket, 'accept-encoding': 'identity' }
  new SessionStore(url, join(directory, 'artium-axi', 'session.json')).write({ status: 'authenticated',
    accessToken: token, refreshToken: 'CANARY-unused-refresh', accessExpiresAt: Date.now() + 3600000,
    familyExpiresAt: Date.now() + 43200000 })
})
afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})
const post = (action: string, input: unknown, authorization = headers) => fetch(`${url}/v1/transfers/hybrid/${action}`,
  { method: 'POST', headers: authorization, body: JSON.stringify(input) })
async function preview(input: Pick<TransferScope, 'selection' | 'targetDigest'> = body()) {
  const response = await post('prepare', input)
  expect(response.status).toBe(200)
  return response.json() as Promise<{ transferId: string, confirm: string, expiresAt: number }>
}
async function ready(input: Pick<TransferScope, 'selection' | 'targetDigest'> = body()) {
  const prepared = await preview(input)
  const response = await post('execute', { ...input, transferId: prepared.transferId, confirm: prepared.confirm, execute: true })
  expect(response.status).toBe(200)
  return { ...prepared, ...await response.json() }
}
function events() { return db.prepare("SELECT outcome, client_save_outcome, archive_bytes FROM audit WHERE event = 'transfer' ORDER BY id").all() as
  { outcome: string, client_save_outcome: string, archive_bytes: number | null }[] }
async function cli(args: string[], started?: (child: ChildProcess) => void, managed = false) {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli/artium-axi.mjs'), ...(managed ? ['--managed-session'] : []), 'download', ...args, '--password-stdin'],
    { env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  if (managed) (child.stdio[3] as Writable).end(JSON.stringify({ serverUrl: url, accessToken: token }))
  else (child.stdio[3] as Writable).end()
  ;(child.stdio[4] as Readable).resume()
  child.stdin!.end(password + '\n')
  started?.(child)
  const [code] = await once(child, 'close')
  expect(stdout + stderr).not.toContain(password)
  return { code, stdout, stderr }
}

test('real HTTP retrieval is opaque, one-shot and records delivery separately from client save', async () => {
  const transfer = await ready()
  const input = { ...body(), transferId: transfer.transferId }
  const response = await post('retrieve', input)
  expect(response.status).toBe(200)
  expect(Object.fromEntries(response.headers)).toMatchObject({ 'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="artium-archive.bin"', 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store, no-transform' })
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(bytes).toEqual(Buffer.alloc(257, 0xa5))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(transfer.archive.archiveSha256)
  expect((await post('status', input)).status).toBe(200)
  expect(await readdir(root)).toEqual([])
  expect(events()).toContainEqual(expect.objectContaining({ outcome: 'delivery-completed', client_save_outcome: 'unconfirmed' }))
  expect((await post('retrieve', input)).status).toBe(400)
})

test.each([false, true])('bundled CLI privately verifies and publishes inert bytes with a separate receipt (managed=%s)', async managed => {
  const args = ['--operation', selection.operation, '--selector', selection.selector, '--type', 'bin', '--destination', destination]
  const first = await cli(args, undefined, managed)
  expect(first).toMatchObject({ code: 0, stderr: '' })
  expect(first.stdout).toContain(transferWarning)
  const prepared = decode(first.stdout) as { transferId: string, confirm: string }
  const saved = await cli([...args, '--transfer', prepared.transferId, '--execute', '--confirm', prepared.confirm], undefined, managed)
  expect(saved).toMatchObject({ code: 0, stderr: '' })
  expect(saved.stdout).toContain('saveOutcome: verified-save')
  expect(saved.stdout).toContain('receipt: confirmed')
  expect(await readFile(destination)).toEqual(Buffer.alloc(257, 0xa5))
  expect((await stat(destination)).mode & 0o777).toBe(0o600)
  expect(await readdir(join(directory, 'downloads'))).toEqual(['new.bin'])
  expect(await readdir(root)).toEqual([])
  expect(events()).toContainEqual(expect.objectContaining({ outcome: 'delivery-completed', client_save_outcome: 'verified-save' }))
})

test.each(reportSelections)('$operation preserves its native type and opaque archive through real HTTP', async selection => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'hybrid-axi'")
    .run(JSON.stringify({ writes: { allowWrites: true, operations: [selection.operation] } }))
  const input = { ...body(), selection }
  const transfer = await ready(input)
  const response = await post('retrieve', { ...input, transferId: transfer.transferId })
  expect(response.status).toBe(200)
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(257, 0xa5))
})

test.each(['other-user', 'other-session'])('retrieval denies %s without disclosing or consuming owner bytes', async kind => {
  const transfer = await ready()
  if (kind === 'other-user') db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('other', 'other', 'Synthetic', 'unusable')`)
  const other = issueTestAccessToken(db, kind === 'other-user' ? 'other' : user)
  const denied = await post('retrieve', { ...body(), transferId: transfer.transferId }, { ...headers,
    authorization: `Bearer ${other}`, 'x-artium-reauth-ticket': issueRecentAuthTicket(db, other).ticket })
  expect(denied.status).toBe(401)
  expect(Buffer.from(await (await post('retrieve', { ...body(), transferId: transfer.transferId })).arrayBuffer())).toEqual(Buffer.alloc(257, 0xa5))
})

test.each([
  ['credential', "UPDATE credentials SET revision = revision + 1 WHERE tool = 'hybrid-axi'"],
  ['policy', "UPDATE tools SET enabled = 0 WHERE name = 'hybrid-axi'"],
  ['grant', `DELETE FROM user_roles WHERE user_id = '${user}'`],
  ['session', 'UPDATE session_families SET revoked_at = 1'],
])('current %s revocation removes ready bytes before the next response', async (_kind, sql) => {
  const transfer = await ready()
  db.exec(sql)
  await fetch(`${url}/health/live`)
  expect(await readdir(root)).toEqual([])
  expect((await post('retrieve', { ...body(), transferId: transfer.transferId })).status).not.toBe(200)
})

test.each(['target', 'confirm', 'selection'])('changed %s denies execution and removes the reservation', async changed => {
  const prepared = await preview()
  const input = { ...body(), transferId: prepared.transferId, confirm: prepared.confirm, execute: true }
  if (changed === 'target') input.targetDigest = 'b'.repeat(64)
  if (changed === 'confirm') input.confirm += ' '
  if (changed === 'selection') input.selection = { ...selection, selector: 'b'.repeat(64) }
  expect((await post('execute', input)).status).toBe(400)
  expect(await readdir(root)).toEqual([])
  expect(events()).not.toContainEqual(expect.objectContaining({ outcome: 'ready' }))
})

test.each(['upstream-failure', 'restricted-key'])('native %s keeps HTTP 403 and proven key-level entitlement guidance', async failure => {
  variant = failure
  const prepared = await preview()
  const response = await post('execute', { ...body(), transferId: prepared.transferId, confirm: prepared.confirm, execute: true })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ error: {
    code: failure === 'restricted-key' ? 'KEY_LEVEL_RESTRICTED' : 'PERMISSION_DENIED',
    message: expect.stringContaining(failure === 'restricted-key' ? 'restricted' : 'unknown'),
    next: expect.stringContaining(failure === 'restricted-key' ? 'vetted-account' : 'vetting') } })
  expect(await readdir(root)).toEqual([])
})

test('real capability boundary remains disabled even with stale download selections', async () => {
  policy.mockRestore()
  expect((await post('prepare', body())).status).toBe(400)
  expect(await readdir(root)).toEqual([])
})

test('absolute preparation expiry denies retrieval and removes bytes', async () => {
  const transfer = await ready()
  vi.spyOn(Date, 'now').mockReturnValue(transfer.expiresAt)
  const response = await post('retrieve', { ...body(), transferId: transfer.transferId })
  expect(response.status).toBe(401)
  expect(await readdir(root)).toEqual([])
  expect(events()).toContainEqual(expect.objectContaining({ outcome: 'expired' }))
})

test('replayed execution cannot send a second native download', async () => {
  const transfer = await ready()
  const response = await post('execute', { ...body(), transferId: transfer.transferId, confirm: transfer.confirm, execute: true })
  expect(response.status).toBe(400)
  expect(await readdir(root)).toEqual([])
  expect(events().filter(event => event.outcome === 'ready')).toHaveLength(1)
})

test('retrieval requires current identity confirmation and immediately deletes denied owner bytes', async () => {
  const transfer = await ready()
  const response = await post('retrieve', { ...body(), transferId: transfer.transferId }, { ...headers, 'x-artium-reauth-ticket': 'CANARY-invalid-ticket' })
  expect(response.status).toBe(401)
  expect((await response.json()).error.code).toBe('REAUTH_REQUIRED')
  expect(await readdir(root)).toEqual([])
})

test.each<[string, string]>([['range', 'bytes=0-1'], ['if-range', 'synthetic'], ['accept-encoding', 'gzip']])('retrieval refuses ranges/resume and transformations: %s', async (name, value) => {
  const transfer = await ready()
  const response = await post('retrieve', { ...body(), transferId: transfer.transferId }, { ...headers, [name]: value })
  expect(response.status).toBe(400)
  expect(await readdir(root)).toEqual([])
})

test('sign-out immediately cleans a pending owner transfer', async () => {
  await ready()
  const response = await fetch(`${url}/v1/auth/logout`, { method: 'POST', headers, body: '{}' })
  expect(response.status).toBe(204)
  expect(await readdir(root)).toEqual([])
})

test('real retrieval disconnect interrupts delivery and deletes the completed file', async () => {
  artifactSize = 8 * 1024 * 1024
  const transfer = await ready()
  const client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory })
  let received = false
  await expect(client.artifact('/v1/transfers/hybrid/retrieve', { ...body(), transferId: transfer.transferId },
    token, headers['x-artium-reauth-ticket'], transfer.expiresAt, async response => {
      for await (const _chunk of response) { received = true; client.cancel() }
    })).rejects.toThrow()
  expect(received).toBe(true)
  await app.close()
  expect(await readdir(root)).toEqual([])
  expect(events()).toContainEqual(expect.objectContaining({ outcome: 'delivery-interrupted' }))
  expect(events()).not.toContainEqual(expect.objectContaining({ outcome: 'delivery-completed' }))
})

test('bundled CLI interruption cancels an active native generation without publishing bytes', async () => {
  const prepared = await preview()
  variant = 'partial'
  let watcher: ReturnType<typeof watch>
  const active = new Promise<void>(resolve => {
    watcher = watch(directory, (_event, file) => { if (file === 'ready.json') resolve() })
  })
  const result = await cli(['--operation', selection.operation, '--selector', selection.selector, '--type', 'bin',
    '--destination', destination, '--transfer', prepared.transferId, '--execute', '--confirm', prepared.confirm],
  child => { void active.then(() => child.kill('SIGINT')) })
  watcher!.close()
  expect(result.code).not.toBe(0)
  await app.close()
  expect(await readdir(root)).toEqual([])
  expect(await readdir(join(directory, 'downloads'))).toEqual([])
  expect(events()).not.toContainEqual(expect.objectContaining({ outcome: 'ready' }))
})

test.each(['local', 'sso'])('browser %s account offers guidance and metadata with no artifact download link or bytes', async source => {
  await ready()
  if (source === 'sso') db.prepare("UPDATE users SET source = 'sso', password_hash = NULL, must_change = 0 WHERE id = ?").run(user)
  const session = createBrowserSession(db, user, 'CANARY-csrf')
  const page = await fetch(`${url}/account`, { headers: { cookie: `artium-session=${session.id}` } })
  const html = await page.text()
  expect(html).toContain(transferWarning)
  expect(html).toContain('artium-axi download --help')
  expect(html).toContain(`<pre>artium-axi download --operation report-download-bin --selector &lt;report-id&gt; --type bin --destination /controlled/artifacts/new-archive.bin${source === 'sso' ? ' --sso' : ''}</pre>`)
  expect(html).toContain(selection.selector)
  expect(html).toContain('unconfirmed')
  expect(html).not.toContain('href="/v1/transfers')
  expect(html).not.toContain(Buffer.alloc(257, 0xa5).toString('base64'))
})

test.each(['existing-file', 'leaf-symlink', 'parent-symlink'])('CLI refuses %s before native preparation', async kind => {
  if (kind === 'existing-file') await writeFile(destination, 'sentinel')
  if (kind === 'leaf-symlink') await symlink(join(directory, 'sentinel'), destination)
  if (kind === 'parent-symlink') { await symlink(join(directory, 'downloads'), join(directory, 'alias')); destination = join(directory, 'alias', 'new.bin') }
  const result = await cli(['--operation', selection.operation, '--selector', selection.selector, '--type', 'bin', '--destination', destination])
  expect(result.code).not.toBe(0)
  expect(result.stdout).toContain('ARTIFACT_SAVE_FAILED')
  expect(events()).toEqual([])
})
