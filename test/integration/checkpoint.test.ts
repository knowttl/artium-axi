import { readFileSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { beforeAll, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createCheckpointAdapter } from '../../src/server/adapters/checkpoint.js'
import type { PreparedCall } from '../../src/server/adapters/types.js'
import { SessionStore } from '../../src/cli/session.js'
import { ArtifactStore, artifactDefaults } from '../../src/server/artifacts.js'
import { Audit } from '../../src/server/audit/audit.js'
import { issueRecentAuthTicket } from '../../src/server/auth/tokens.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { transferLimits } from '../../src/shared/api.js'
import type { TransferScope } from '../../src/shared/api.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })

async function withCheckpoint(check: (fixture: {
  app: ReturnType<typeof createApp>, db: ReturnType<typeof openStore>, directory: string,
  post: (path: string, body?: unknown) => Promise<Response>,
  cli: (args: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }>,
  enable: (operations: string[]) => Promise<void>, run: (args: string[], input?: object) => Promise<{ stdout: string, exitCode: number }>,
  evidence: () => Promise<{ requests: { path: string, canaryReceived: boolean }[], mutations: number }>,
}) => Promise<void>) {
  await withFakeService(async ({ directory, port, send }) => {
    const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), key)
    const credentials = createCredentialStore(db, key)
    await seedToolUser(db)
    db.exec('UPDATE users SET administrator = 1')
    const adapter = createCheckpointAdapter(new EmbeddedSecretSource(credentials), join(directory, 'journal', 'writes.log'))
    const wrap = (call: PreparedCall): PreparedCall => ({ ...call, executable: process.execPath,
          args: ['--import', join(process.cwd(), 'test/fake-service/checkpoint-transport.mjs'),
            join(process.cwd(), 'tools/node_modules/@knowttl/checkpoint-axi/bin/checkpoint-axi.js'), ...call.args],
          environment: { ...call.environment, ARTIUM_TEST_CHECKPOINT_ORIGIN: `https://localhost:${port}` } })
    const prepare = adapter.prepare.bind(adapter)
    const prepareArtifact = adapter.prepareArtifact!.bind(adapter)
    adapter.prepare = async (...input) => wrap(await prepare(...input))
    adapter.prepareArtifact = async (...input) => wrap(await prepareArtifact(...input))
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const audit = new Audit(db)
    const root = join(directory, 'artifacts')
    await mkdir(root, { mode: 0o700 })
    const artifactStore = await ArtifactStore.create(audit, root, { inspect: async () => ({
      mountinfo: `1 2 0:1 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw`, filesystemType: 0x01021994,
      capacityBytes: transferLimits.reservedBytes, freeBytes: transferLimits.reservedBytes,
      memoryMax: artifactDefaults.containerBytes, memoryCurrent: 0, swapMax: 0, swapCurrent: 0 }) })
    const app = createApp({ db, audit, runner, adapters: [adapter], credentialStore: credentials,
      resolver: new SharedIdentityResolver(credentials), artifactStore, environment: {} })
    const url = await app.listen({ host: '127.0.0.1', port: 0 })
    const token = issueTestAccessToken(db, 'synthetic-development-user')
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: token,
      refreshToken: 'CANARY-unused-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 43200000 })
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-encoding': 'identity',
      'x-artium-reauth-ticket': issueRecentAuthTicket(db, token).ticket }
    const post = (path: string, body: unknown = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) })
    const settings = async () => (await fetch(url + '/v1/admin/tools/checkpoint-axi', { headers })).json()
    const cli = async (args: string[]) => {
      const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli/artium-axi.mjs'), 'download', ...args, '--password-stdin'],
        { env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdin.end('CANARY-local-password\n')
      const [code] = await once(child, 'close')
      expect(stdout + stderr).not.toContain('CANARY-')
      return { code, stdout, stderr }
    }
    try {
      const saved = await fetch(url + '/v1/admin/tools/checkpoint-axi/credential', { method: 'PATCH', headers,
        body: JSON.stringify({ value: { region: 'ca', clientId: 'synthetic-client', clientSecret: 'CANARY-checkpoint-secret', scope: 'synthetic-scope' },
          expectedRevision: 0, expectedToolRevision: 1 }) })
      expect(saved.status, await saved.clone().text()).toBe(200)
      expect(await saved.text()).not.toContain('CANARY-')
      const activated = await fetch(url + '/v1/admin/tools/checkpoint-axi', { method: 'PATCH', headers,
        body: JSON.stringify({ enabled: true, expectedRevision: (await settings()).revision }) })
      expect(activated.status).toBe(200)
      const enable = async (operations: string[]) => {
        const response = await fetch(url + '/v1/admin/tools/checkpoint-axi/write-access', { method: 'PATCH', headers,
          body: JSON.stringify({ enabled: true, operations, expectedRevision: (await settings()).revision }) })
        expect(response.status, await response.clone().text()).toBe(200)
      }
      const run = async (args: string[], input = {}) => {
        const response = await post('/v1/tools/checkpoint-axi/run', { args, ...input })
        expect(response.status, await response.clone().text()).toBe(200)
        const result = await response.json()
        expect(JSON.stringify(result)).not.toMatch(/CANARY-checkpoint-(secret|token)/)
        return result
      }
      await check({ app, db, directory, post, cli, enable, run, evidence: async () => JSON.parse(await send('/__evidence')) })
      expect(await readdir(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}

test('published CLI reads and health run through managed credentials before administrator-selected writes', async () => {
  await withCheckpoint(async ({ post, run, enable, db, evidence }) => {
    expect((await run(['email', 'search', '--limit=1'])).stdout).toContain('Synthetic email')
    expect((await run(['event', 'show', 'synthetic-event'])).stdout).toContain('phishing')
    expect((await run(['task', 'show', 'synthetic-task'])).stdout).toContain('completed')
    expect((await run(['exception', 'list', 'malware', '--type', 'hash'])).exitCode).toBe(0)
    const health = await post('/v1/admin/tools/checkpoint-axi/test')
    expect(await health.json()).toMatchObject({ status: 'ok' })
    const args = ['email', 'quarantine', '--ids', 'synthetic-email']
    expect((await run(args)).stdout).toContain('WRITES_DISABLED')
    await enable(['email.quarantine', 'event.action.dismiss'])
    expect((await run(['email', 'restore', '--ids', 'synthetic-email'])).stdout).toContain('OPERATION_NOT_WRITABLE')
    expect((await run(args)).stdout).toContain('confirm: email.quarantine synthetic-email')
    expect((await run([...args, '--execute', '--confirm', 'incorrect'])).stdout).toContain('CONFIRM_MISMATCH')
    expect((await evidence()).mutations).toBe(0)
    const written = await run([...args, '--execute', '--confirm', 'email.quarantine synthetic-email'])
    expect(written.exitCode, written.stdout).toBe(0)
    expect((decode(written.stdout) as { auditId: string }).auditId).toBeTruthy()
    expect(db.prepare("SELECT action FROM audit WHERE tool = 'checkpoint-axi' AND event = 'run-terminal' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ action: 'write' })
    const event = await run(['event', 'action', '--ids', 'synthetic-event', '--name', 'dismiss', '--execute', '--confirm', 'event.action.dismiss synthetic-event'])
    expect(event.exitCode, event.stdout).toBe(0)
    expect((await evidence()).mutations).toBe(2)
    expect((await evidence()).requests.every(record => record.canaryReceived)).toBe(true)
  })
})

test.each([
  { command: ['email', 'search'], field: 'emails', detail: { entityInfo: { entityId: 'synthetic-email' } } },
  { command: ['event', 'list'], field: 'events', detail: { eventId: 'synthetic-event' } },
])('published $field expansion stays read-only through the managed API', async ({ command, field, detail }) => {
  await withCheckpoint(async ({ run, evidence, db }) => {
    const result = await run([...command, '--limit', '1', '--expand-limit', '1', '--expand-requests', '3', '--expand'])
    expect(result.exitCode, result.stdout).toBe(0)
    const output = decode(result.stdout) as Record<string, unknown>
    expect(output[field]).toMatchObject([{ detail }])
    expect(output.expansion).toMatchObject({ expanded: 1, itemLimit: 1, requestLimit: 3, complete: true })
    expect((await evidence()).requests).toHaveLength(3)
    expect((await evidence()).mutations).toBe(0)
    expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ action: 'read' })
  })
})

test('published expansion preserves list rows when authentication and listing exhaust the request cap', async () => {
  await withCheckpoint(async ({ run, evidence }) => {
    const result = await run(['email', 'search', '--expand', '--expand-requests', '2'])
    expect(result.exitCode, result.stdout).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ emails: [{ id: 'synthetic-email' }], expansion: {
      expanded: 0, complete: false, notExpanded: [{ id: 'synthetic-email', reason: 'request-cap-reached' }],
    } })
    expect((await evidence()).requests).toHaveLength(2)
    expect((await evidence()).mutations).toBe(0)
  })
})

test('published task wait returns the existing terminal task without enabling writes', async () => {
  await withCheckpoint(async ({ run, evidence }) => {
    const result = await run(['task', 'show', 'synthetic-task', '--timeout', '30', '--poll-interval', '1', '--wait-requests', '2', '--wait'])
    expect(result.exitCode, result.stdout).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ task: { status: 'completed' }, wait: { terminal: true, polls: 1, reason: 'terminal' } })
    expect((await evidence()).requests).toHaveLength(2)
    expect((await evidence()).mutations).toBe(0)
  })
})

test.each([
  { command: ['email', 'search'], fields: 'id,subject,state,verdict', collection: 'emails',
    row: { id: 'synthetic-email', subject: 'Synthetic email', state: 'unactioned', verdict: null } },
  { command: ['event', 'list'], fields: 'id,severity', collection: 'events',
    row: { id: 'synthetic-event', severity: 'high' } },
])('published $command row selection passes through the managed API', async ({ command, fields, collection, row }) => {
  await withCheckpoint(async ({ run, evidence }) => {
    const result = await run([...command, '--limit', '1', '--fields', fields])
    expect(result.exitCode, result.stdout).toBe(0)
    expect((decode(result.stdout) as Record<string, unknown>)[collection]).toEqual([row])
    expect((await evidence()).mutations).toBe(0)
  })
})

test.each([
  { command: ['email', 'search'], fields: 'emails,count', expected: { emails: [{ id: 'synthetic-email' }], count: 1 } },
  { command: ['event', 'list'], fields: 'events,count', expected: { events: [{ id: 'synthetic-event' }], count: 1 } },
])('published $command top-level selection passes through the managed API', async ({ command, fields, expected }) => {
  await withCheckpoint(async ({ run }) => {
    const result = await run([...command, '--limit', '1', '--fields', fields])
    expect(result.exitCode, result.stdout).toBe(0)
    expect(Object.keys(decode(result.stdout) as object)).toEqual(Object.keys(expected))
    expect(decode(result.stdout)).toMatchObject(expected)
  })
})

test.each([
  ['email', 'search', '--expand', '--expand-limit', '9'],
  ['event', 'list', '--expand', '--expand-requests', '11'],
  ['email', 'search', '--expand-limit', '1'],
  ['task', 'show', 'synthetic-task', '--wait'],
  ['task', 'show', 'synthetic-task', '--wait', '--timeout', '61'],
  ['task', 'show', 'synthetic-task', '--wait', '--timeout', '30', '--poll-interval', '11'],
  ['task', 'show', 'synthetic-task', '--wait', '--timeout', '30', '--wait-requests', '11'],
  ['task', 'show', 'synthetic-task', '--timeout', '30'],
  ['email', 'search', '--filter', '[{"saasAttrName":"subject","saasAttrOp":"invalid","saasAttrValue":"synthetic"}]'],
  ['event', 'list', '--states', 'invalid'],
].map(args => ({ args })))('published bounds refuse $args before network access', async ({ args }) => {
  await withCheckpoint(async ({ run, evidence }) => {
    const result = await run(args)
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('VALIDATION_ERROR')
    expect((await evidence()).requests).toEqual([])
  })
})

test('private exception uploads preserve native preview, confirmation and journal through the published CLI', async () => {
  await withCheckpoint(async ({ run, enable, directory, evidence }) => {
    await enable(['exception.spam-allow.create'])
    const input = { files: [{ name: 'rule.json', contentBase64: Buffer.from('{"subject":"Synthetic rule"}').toString('base64') }] }
    const args = ['exception', 'create', 'spam-allow', '--input', 'rule.json', '--full']
    const preview = await run(args, input)
    expect(preview.exitCode, preview.stdout).toBe(0)
    const confirm = (decode(preview.stdout) as { preview: { confirm: string } }).preview.confirm
    expect((await evidence()).mutations).toBe(0)
    const result = await run([...args, '--execute', '--confirm', confirm], input)
    expect(result.exitCode, result.stdout).toBe(0)
    const auditId = (decode(result.stdout) as { auditId: string }).auditId
    expect(readFileSync(join(directory, 'journal/writes.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({ auditId, kind: 'intent', operation: 'exception.spam-allow.create' }))
    expect((await evidence()).mutations).toBe(1)
  })
})

test('published response diagnostics preserve failing paths and types without response values', async () => {
  await withCheckpoint(async ({ run }) => {
    const result = await run(['email', 'show', 'synthetic-invalid'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('RESPONSE_INVALID')
    expect(result.stdout).toContain('$.responseData[0].entityPayload.subject: object')
    expect(result.stdout).not.toContain('CANARY-invalid-subject')
  })
})

test.each<TransferScope['selection']>([
  { operation: 'email.download', selector: 'synthetic-email', type: 'email' },
  { operation: 'email.download', selector: 'synthetic-email', type: 'original' },
  { operation: 'attachment.download', selector: 'synthetic-email/synthetic-attachment', type: 'attachment' },
  { operation: 'attachment.download-all', selector: 'synthetic-email', type: 'zip' },
])('host-confirmed $operation $type transfers verified bytes without fabricating a native journal', async selection => {
  await withCheckpoint(async ({ post, enable, evidence, db, directory }) => {
    const input = { selection, targetDigest: 'a'.repeat(64) }
    expect((await post('/v1/transfers/checkpoint/prepare', input)).status).toBe(400)
    await enable([selection.operation])
    const requestsBeforePreview = (await evidence()).requests
    const prepared = await post('/v1/transfers/checkpoint/prepare', input)
    expect(prepared.status, await prepared.clone().text()).toBe(200)
    const preview = await prepared.json()
    const credential = db.prepare("SELECT revision FROM credentials WHERE tool = 'checkpoint-axi'").get() as { revision: number }
    expect(JSON.parse(preview.confirm)).toEqual([preview.transferId, input.targetDigest, credential.revision, selection, preview.expiresAt])
    expect((await evidence()).requests).toEqual(requestsBeforePreview)
    const body = { ...input, transferId: preview.transferId, execute: true, confirm: preview.confirm }
    const executed = await post('/v1/transfers/checkpoint/execute', body)
    expect(executed.status, await executed.clone().text()).toBe(200)
    const ready = await executed.json()
    const retrieval = { ...input, transferId: preview.transferId }
    const download = await post('/v1/transfers/checkpoint/retrieve', retrieval)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('Synthetic inert Check Point artifact\n')
    expect(download.headers.get('x-artium-archive-sha256')).toBe(ready.archive.archiveSha256)
    expect((await post('/v1/transfers/checkpoint/receipt', { ...retrieval, archive: ready.archive, saveOutcome: 'verified-save' })).status).toBe(204)
    expect(db.prepare("SELECT tool, native_audit_id, native_journal_result, client_save_outcome FROM audit WHERE event = 'transfer' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ tool: 'checkpoint-axi', native_audit_id: null, native_journal_result: null, client_save_outcome: 'verified-save' })
    expect((await evidence()).requests.filter(record => record.path.includes('/download/'))).toHaveLength(1)
    expect(await readdir(join(directory, 'artifacts'))).toEqual([])
  })
})

test('missing upstream download hash fails closed and removes bytes', async () => {
  await withCheckpoint(async ({ post, enable, directory }) => {
    await enable(['email.download'])
    const input = { selection: { operation: 'email.download', selector: 'missing-hash', type: 'email' }, targetDigest: 'a'.repeat(64) }
    const preview = await (await post('/v1/transfers/checkpoint/prepare', input)).json()
    const result = await post('/v1/transfers/checkpoint/execute', { ...input, transferId: preview.transferId, execute: true, confirm: preview.confirm })
    expect(result.status).not.toBe(200)
    expect(await readdir(join(directory, 'artifacts'))).toEqual([])
  })
})

test('the bundled Artium CLI confirms, privately saves and receipts a native Check Point download', async () => {
  await withCheckpoint(async ({ cli, enable, directory }) => {
    await enable(['email.download'])
    const destination = join(directory, 'downloads', 'message.eml')
    await mkdir(join(directory, 'downloads'), { mode: 0o700 })
    const args = ['--operation', 'email.download', '--selector', 'synthetic-email', '--type', 'original', '--destination', destination]
    const preview = await cli(args)
    expect(preview).toMatchObject({ code: 0, stderr: '' })
    const prepared = decode(preview.stdout) as { transferId: string, confirm: string }
    const saved = await cli([...args, '--transfer', prepared.transferId, '--execute', '--confirm', prepared.confirm])
    expect(saved).toMatchObject({ code: 0, stderr: '' })
    expect(saved.stdout).toContain('saveOutcome: verified-save')
    expect(saved.stdout).toContain('receipt: confirmed')
    expect(readFileSync(destination, 'utf8')).toBe('Synthetic inert Check Point artifact\n')
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(directory, 'artifacts'))).toEqual([])
  })
})

test.each([
  { change: 'selector', expected: 400 }, { change: 'destination', expected: 400 },
  { change: 'credential', expected: 409 }, { change: 'policy', expected: 400 },
])('Check Point execution rechecks $change and removes the reservation without native download', async ({ change, expected }) => {
  await withCheckpoint(async ({ post, enable, db, evidence, directory }) => {
    await enable(['email.download'])
    const input = { selection: { operation: 'email.download', selector: 'synthetic-email', type: 'email' }, targetDigest: 'a'.repeat(64) }
    const preview = await (await post('/v1/transfers/checkpoint/prepare', input)).json()
    if (change === 'credential') db.exec("UPDATE credentials SET revision = revision + 1 WHERE tool = 'checkpoint-axi'")
    if (change === 'policy') db.exec("UPDATE tools SET native_settings = '{}' WHERE name = 'checkpoint-axi'")
    const result = await post('/v1/transfers/checkpoint/execute', { ...input,
      ...(change === 'selector' ? { selection: { ...input.selection, selector: 'other-email' } } : {}),
      ...(change === 'destination' ? { targetDigest: 'b'.repeat(64) } : {}),
      transferId: preview.transferId, execute: true, confirm: preview.confirm })
    expect(result.status, await result.clone().text()).toBe(expected)
    expect((await evidence()).requests.filter(record => record.path.includes('/download/'))).toEqual([])
    expect(await readdir(join(directory, 'artifacts'))).toEqual([])
  })
})
