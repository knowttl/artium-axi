import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import type { Adapter } from '../../src/server/adapters/types.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner, RunnerError } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import type { MutableCredentialStore, ToolName } from '../../src/server/store/credential-store.js'
import { adminCredentialSchema, adminToolSchema, healthSchema, loginResponseSchema } from '../../src/shared/api.js'
import { errors, type ErrorCode } from '../../src/shared/errors.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let runner: Runner
let store: MutableCredentialStore
let adapters: Adapter<unknown>[]
let url: string
let headers: Record<string, string>
let network: FakeTokenTransport
let cache: AzureTokenCache
const actor = 'synthetic-development-user'
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const values = {
  'falcon-axi': { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' },
  'vectra-axi': { kind: 'qux', apiVersion: '2.5', origin: 'https://synthetic.invalid', auth: 'token', token: 'CANARY-token',
    writes: { allowWrites: true, operations: ['notes.set'] } },
  'az-axi': { tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222', auth: 'secret', clientSecret: 'CANARY-azure',
    subscriptions: ['synthetic-subscription'], allowWrites: true },
} as const

function request(method: string, path: string, body?: unknown, proof = headers) {
  const { 'content-type': _contentType, ...withoutContentType } = proof
  return fetch(`${url}/v1/admin/tools${path}`, { method, headers: body === undefined ? withoutContentType : proof,
    body: body === undefined ? undefined : JSON.stringify(body) })
}
async function adminHeaders(username = 'synthetic-user') {
  const login = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'CANARY-local-password' }) })
  expect(login.status).toBe(200)
  const session = loginResponseSchema.parse(await login.json())
  if (session.status !== 'authenticated') throw new Error('Expected local login')
  const proof = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }
  const response = await fetch(`${url}/v1/auth/reauth`, { method: 'POST', headers: proof,
    body: JSON.stringify({ password: 'CANARY-local-password' }) })
  expect(response.status).toBe(200)
  const { ticket } = await response.json() as { ticket: string }
  return { ...proof, 'x-artium-reauth-ticket': ticket }
}
async function failure(response: Response, code: ErrorCode) {
  expect(response.status).toBe(errors[code].status)
  expect(await response.json()).toMatchObject({ error: { code } })
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-admin-tools-'))
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  await seedToolUser(db)
  db.exec(`UPDATE users SET administrator = 1;
    INSERT INTO users (id, username, display_name, password_hash, must_change)
      SELECT 'synthetic-ordinary', 'synthetic-ordinary', 'Ordinary', password_hash, 0 FROM users LIMIT 1;
    INSERT INTO user_roles VALUES ('synthetic-ordinary', 'synthetic-role'); UPDATE tools SET enabled = 1;`)
  store = createCredentialStore(db, provider)
  const source = new EmbeddedSecretSource(store)
  network = new FakeTokenTransport()
  cache = new AzureTokenCache(network)
  adapters = [createFalconAdapter(source), createVectraAdapter(source, join(directory, 'writes.log')),
    createAzAdapter(source, join(directory, 'az-writes.log'), cache)]
  for (const adapter of adapters) {
    const prepare = adapter.prepare.bind(adapter)
    vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => {
      const prepared = await prepare(args, reference, input)
      return { ...prepared, executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'synthetic-health-output'],
        limits: { timeoutMs: 5000 } }
    })
  }
  runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {}, adapters,
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  headers = await adminHeaders()
  db.exec('DELETE FROM audit')
})
afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
async function replace(tool: ToolName, value: unknown = values[tool], expectedRevision = 0) {
  const response = await request('PUT', `/${tool}/credential`, { value, expectedRevision })
  expect(response.status).toBe(200)
  return adminCredentialSchema.parse(await response.json())
}
const routes = [
  { method: 'GET', path: '', body: undefined },
  { method: 'PATCH', path: '/falcon-axi', body: { enabled: false, expectedRevision: 1 } },
  { method: 'GET', path: '/falcon-axi/credential', body: undefined },
  { method: 'PUT', path: '/falcon-axi/credential', body: { value: values['falcon-axi'], expectedRevision: 0 } },
  { method: 'POST', path: '/falcon-axi/test', body: {} },
]
test.each(routes)('$method $path requires admin capability despite tool grants', async route => {
  await failure(await request(route.method, route.path, route.body, await adminHeaders('synthetic-ordinary')), 'ADMIN_REQUIRED')
  expect(db.prepare("SELECT user_id, outcome FROM audit WHERE event = 'denial'").get())
    .toEqual({ user_id: 'synthetic-ordinary', outcome: 'ADMIN_REQUIRED' })
})
test.each(routes)('$method $path requires password reauthentication', async route => {
  const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
  await failure(await request(route.method, route.path, route.body, missing), 'REAUTH_REQUIRED')
})
test('fixed tools list has pinned versions and performs no credential reads or remote calls', async () => {
  const read = vi.spyOn(store, 'readCredential')
  const response = await request('GET', '')
  expect(response.status).toBe(200)
  const { tools } = await response.json() as { tools: unknown[] }
  expect(tools.map(tool => adminToolSchema.parse(tool))).toMatchObject([
    { name: 'falcon-axi', version: '0.3.0', health: { status: 'unconfigured' } },
    { name: 'vectra-axi', version: '0.1.3', health: { status: 'unconfigured' } },
    { name: 'az-axi', version: '0.1.4', health: { status: 'unconfigured' } },
  ])
  expect(read).not.toHaveBeenCalled()
  expect(network.requests).toEqual([])
  await failure(await request('POST', '', { executable: '/synthetic' }), 'NOT_FOUND')
})
test.each(['falcon-axi', 'vectra-axi', 'az-axi'] as const)('%s replacement and reads expose only safe metadata, revision and actor', async tool => {
  const absent = await request('GET', `/${tool}/credential`)
  expect(await absent.json()).toEqual({ tool, configured: false, metadata: {}, revision: 0, updatedAt: null, updatedBy: null })
  const created = await replace(tool)
  expect(created).toMatchObject({ tool, configured: true, revision: 1, updatedBy: actor, updatedAt: expect.any(Number) })
  const read = await request('GET', `/${tool}/credential`)
  expect(await read.json()).toEqual(created)
  const replaced = await replace(tool, values[tool], 1)
  expect(replaced.revision).toBe(2)
  expect(JSON.stringify([created, replaced])).not.toMatch(/CANARY-|clientSecret|privateKey|"token"\s*:/)
  expect(readFileSync(join(directory, 'data', 'artium.db-wal')).includes(Buffer.from('CANARY-secret'))).toBe(false)
  expect(db.prepare("SELECT action, tool, user_id, arguments FROM audit WHERE event = 'admin-change'").all()).toEqual([
    { action: 'replace-credential', tool, user_id: actor, arguments: null },
    { action: 'replace-credential', tool, user_id: actor, arguments: null },
  ])
})
test('credential replacement rejects a stale revision without data, policy or audit changes', async () => {
  await replace('vectra-axi')
  const before = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  await failure(await request('PUT', '/vectra-axi/credential', { value: { ...values['vectra-axi'], token: 'CANARY-new' }, expectedRevision: 0 }), 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})
test('native settings apply to adapter profiles and clearing them removes the previous write policy', async () => {
  await replace('vectra-axi')
  const first = await request('PATCH', '/vectra-axi', { nativeSettings: { writes: { allowWrites: false, operations: ['notes.set'] } }, expectedRevision: 2 })
  expect(first.status).toBe(200)
  expect(adminToolSchema.parse(await first.json())).toMatchObject({ revision: 3, updatedBy: actor })
  const prepared = await adapters[1].prepare(['health', 'list'], store.findCredential('vectra-axi')!)
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium.writes).toEqual({ allowWrites: false, operations: ['notes.set'] })
  const cleared = await request('PATCH', '/vectra-axi', { nativeSettings: {}, enabled: false, expectedRevision: 3 })
  expect(cleared.status).toBe(200)
  expect(adminToolSchema.parse(await cleared.json())).toMatchObject({ nativeSettings: {}, enabled: false, revision: 4, health: { status: 'disabled' } })
  expect(store.readCredential(store.findCredential('vectra-axi')!)).not.toHaveProperty('writes')
  await failure(await request('PATCH', '/vectra-axi', { enabled: true, expectedRevision: 3 }), 'REVISION_CONFLICT')
})
test.each([
  { tool: 'falcon-axi', settings: {}, current: {}, credential: values['falcon-axi'] },
  { tool: 'vectra-axi', settings: { writes: values['vectra-axi'].writes },
    current: { writes: { allowWrites: false, operations: ['notes.set'] } },
    credential: { kind: 'qux', apiVersion: '2.5', origin: 'https://synthetic.invalid', auth: 'token', token: 'CANARY-token' } },
  { tool: 'az-axi', settings: { subscriptions: ['synthetic-subscription'], allowWrites: true,
    managementGroup: 'synthetic-group', workspaces: { synthetic: '33333333-3333-4333-8333-333333333333' }, description: 'Synthetic' },
    current: { subscriptions: ['synthetic-current'] },
    credential: { tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222', auth: 'secret', clientSecret: 'CANARY-azure' } },
] as const)('$tool legacy native settings agree across listing, edits and credential reads', async ({ tool, settings, current, credential }) => {
  store.replaceCredential(tool, { ...values[tool], ...settings }, 0, actor, Date.now())
  db.prepare('UPDATE tools SET native_settings = ? WHERE name = ?').run(JSON.stringify(current), tool)
  createCredentialStore(db, provider)
  const effective = { ...settings, ...current }
  const response = await request('GET', '')
  expect(await response.json()).toMatchObject({ tools: expect.arrayContaining([
    expect.objectContaining({ name: tool, nativeSettings: effective, revision: 1 }),
  ]) })
  const enabled = await request('PATCH', `/${tool}`, { enabled: true, expectedRevision: 1 })
  expect(enabled.status).toBe(200)
  expect(adminToolSchema.parse(await enabled.json())).toMatchObject({ nativeSettings: effective, revision: 2 })
  expect(store.readCredential(store.findCredential(tool)!)).toEqual({ ...values[tool], ...settings, ...current })
  const cleared = await request('PATCH', `/${tool}`, { nativeSettings: {}, expectedRevision: 2 })
  expect(cleared.status).toBe(200)
  expect(adminToolSchema.parse(await cleared.json()).nativeSettings).toEqual({})
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(credential)
  createCredentialStore(db, provider)
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(credential)
  expect(db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(tool)).toEqual({ native_settings: '{}' })
})
test.each([
  { tool: 'falcon-axi', settings: { executable: '/synthetic' } },
  { tool: 'vectra-axi', settings: { writes: { allowWrites: 'yes', operations: [] } } },
  { tool: 'az-axi', settings: { workspaces: { synthetic: 'invalid' } } },
])('invalid native settings for $tool fail without an audit change', async ({ tool, settings }) => {
  await failure(await request('PATCH', `/${tool}`, { nativeSettings: settings, expectedRevision: 1 }), 'INVALID_INPUT')
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})
test.each(['PATCH', 'PUT'] as const)('%s audit failure rolls back credentials, settings and revisions', async method => {
  await replace('vectra-axi')
  const before = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  db.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON audit WHEN NEW.event = 'admin-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const body = method === 'PUT' ? { value: { ...values['vectra-axi'], token: 'CANARY-new' }, expectedRevision: 1 }
    : { nativeSettings: {}, expectedRevision: 2 }
  await failure(await request(method, `/vectra-axi${method === 'PUT' ? '/credential' : ''}`, body), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
})
test('Azure replacement immediately evicts old tokens and refuses a previously resolved reference', async () => {
  await replace('az-axi')
  const old = store.findCredential('az-axi')!
  await adapters[2].prepare(['account', 'list'], old)
  expect(network.requests).toHaveLength(1)
  await replace('az-axi', { ...values['az-axi'], clientSecret: 'CANARY-new-azure' }, 1)
  expect(store.readCredential(old)).toBeUndefined()
  await expect(adapters[2].prepare(['account', 'list'], old)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  await expect(cache.acquire({ id: old.id, revision: old.revision!, credential: values['az-axi'] }, { required: ['arm'], optional: [] }))
    .rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  await adapters[2].prepare(['account', 'list'], store.findCredential('az-axi')!)
  expect(network.requests.map(entry => entry.form.get('client_secret'))).toEqual(['CANARY-azure', 'CANARY-new-azure'])
})
test.each([
  { tool: 'falcon-axi', args: ['auth', 'status'] },
  { tool: 'vectra-axi', args: ['health', 'list'] },
  { tool: 'az-axi', args: ['account', 'list'] },
] as const)('$tool manual test uses a fixed read, stores safe health and audits the administrator', async ({ tool, args }) => {
  await replace(tool)
  const response = await request('POST', `/${tool}/test`, {})
  expect(response.status).toBe(200)
  const health = healthSchema.parse(await response.json())
  expect(health).toMatchObject({ status: 'ok', credentialRevision: 1, errorCode: null })
  expect(adapters.find(adapter => adapter.name === tool)!.prepare).toHaveBeenCalledWith(args, store.findCredential(tool))
  expect(db.prepare("SELECT event, user_id, outcome FROM audit WHERE event != 'admin-change' ORDER BY id").all()).toEqual([
    { event: 'run-start', user_id: actor, outcome: 'started' },
    { event: 'run-terminal', user_id: actor, outcome: 'completed' },
    { event: 'credential-test', user_id: actor, outcome: 'success' },
  ])
  const list = await request('GET', '')
  expect(await list.text()).not.toContain('synthetic-health-output')
  expect(db.prepare('SELECT status FROM tool_health WHERE tool = ?').get(tool)).toEqual({ status: 'ok' })
  const evidence = db.prepare(`SELECT event, checked_at, credential_revision, error_code FROM audit
    WHERE event != 'admin-change' ORDER BY id`).all()
  expect(evidence).toEqual([
    { event: 'run-start', checked_at: expect.any(Number), credential_revision: 1, error_code: null },
    { event: 'run-terminal', checked_at: health.checkedAt, credential_revision: 1, error_code: null },
    { event: 'credential-test', checked_at: health.checkedAt, credential_revision: 1, error_code: null },
  ])
  await replace(tool, values[tool], 1)
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
  expect(db.prepare(`SELECT event, checked_at, credential_revision, error_code FROM audit
    WHERE event != 'admin-change' ORDER BY id`).all()).toEqual(evidence)
})
test('unconfigured test admission records safe evidence without a credential revision', async () => {
  await failure(await request('POST', '/falcon-axi/test', {}), 'CREDENTIAL_UNAVAILABLE')
  expect(db.prepare('SELECT checked_at, credential_revision, error_code FROM audit').get())
    .toEqual({ checked_at: expect.any(Number), credential_revision: null, error_code: 'CREDENTIAL_UNAVAILABLE' })
})
test('manual test rejects caller-selected arguments before credential retrieval', async () => {
  const read = vi.spyOn(store, 'readCredential')
  await failure(await request('POST', '/falcon-axi/test', { args: ['host', 'delete'] }), 'INVALID_INPUT')
  expect(read).not.toHaveBeenCalled()
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})
test('manual tests share the administrator two-call quota and release it after completion', async () => {
  await replace('falcon-axi')
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
  const health = db.prepare('SELECT * FROM tool_health').all()
  db.exec('DELETE FROM audit')
  const controller = new AbortController()
  let readyFirst!: () => void
  let readySecond!: () => void
  const firstReady = new Promise<void>(resolve => { readyFirst = resolve })
  const secondReady = new Promise<void>(resolve => { readySecond = resolve })
  const calls = [runner.run(actor, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, [], { signal: controller.signal }, {}, [], readyFirst),
    runner.run(actor, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, [], { signal: controller.signal }, {}, [], readySecond)]
  const completed = Promise.allSettled(calls)
  try {
    await Promise.all([firstReady, secondReady])
    await failure(await request('POST', '/falcon-axi/test', {}), 'TOO_MANY_CALLS')
    expect(db.prepare("SELECT outcome FROM audit WHERE event = 'credential-test'").get()).toEqual({ outcome: 'TOO_MANY_CALLS' })
    expect(db.prepare('SELECT * FROM tool_health').all()).toEqual(health)
    expect(await (await request('GET', '')).json()).toMatchObject({ tools: expect.arrayContaining([
      expect.objectContaining({ name: 'falcon-axi', health: expect.objectContaining({ status: 'ok' }) }),
    ]) })
  } finally { controller.abort(); await completed }
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
})
test('runner shutdown rejects a manual test without changing cached health', async () => {
  await replace('falcon-axi')
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
  const health = db.prepare('SELECT * FROM tool_health').all()
  await runner.shutdown()
  await failure(await request('POST', '/falcon-axi/test', {}), 'RUNNER_CLOSED')
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual(health)
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'credential-test' ORDER BY id DESC LIMIT 1").get())
    .toEqual({ outcome: 'RUNNER_CLOSED' })
})
test.each([
  { code: 'TOKEN_INVALID', revoke: async () => {
    const response = await fetch(`${url}/v1/auth/logout`, { method: 'POST', headers: { authorization: headers.authorization } })
    expect(response.status).toBe(204)
  } },
  { code: 'TOKEN_EXPIRED', revoke: () => db.prepare("UPDATE tokens SET expires_at = 0 WHERE user_id = ? AND type = 'access'").run(actor) },
  { code: 'USER_DISABLED', revoke: () => db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(actor) },
  { code: 'ADMIN_REQUIRED', revoke: () => db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(actor) },
  { code: 'REAUTH_REQUIRED', revoke: () => db.prepare('UPDATE recent_auth_tickets SET expires_at = 0').run() },
] as const)('pre-spawn $code rejection preserves cached health and is audited', async ({ code, revoke }) => {
  db.prepare('UPDATE users SET administrator = 1 WHERE id = ?').run('synthetic-ordinary')
  await replace('falcon-axi')
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
  const health = db.prepare('SELECT * FROM tool_health').all()
  db.exec('DELETE FROM audit')
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { started = resolve })
  const prepare = adapters[0].prepare.bind(adapters[0])
  vi.mocked(adapters[0].prepare).mockImplementationOnce(async (args, reference) => {
    const prepared = await prepare(args, reference)
    started()
    await held
    return prepared
  })
  const pending = request('POST', '/falcon-axi/test', {})
  try {
    await preparing
    await revoke()
  } finally { release() }
  await failure(await pending, code)
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual(health)
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'credential-test'").get()).toEqual({ outcome: code })
  expect(db.prepare("SELECT outcome, stdout_bytes, stderr_bytes FROM audit WHERE event = 'run-terminal'").get())
    .toEqual({ outcome: code, stdout_bytes: 0, stderr_bytes: 0 })
})
test.each(['SECRET_IN_OUTPUT', 'TIMEOUT', 'OUTPUT_LIMIT'] as const)('manual test audit preserves %s runner measurements', async code => {
  await replace('falcon-axi')
  const error = new RunnerError(code)
  error.durationMs = 17.25
  error.outputBytes = { stdout: 12, stderr: 34 }
  vi.spyOn(runner, 'run').mockRejectedValueOnce(error)
  await failure(await request('POST', '/falcon-axi/test', {}), code)
  expect(db.prepare("SELECT outcome, duration_ms, stdout_bytes, stderr_bytes FROM audit WHERE event = 'run-terminal'").get())
    .toEqual({ outcome: code, duration_ms: 17, stdout_bytes: 12, stderr_bytes: 34 })
})
test('credential test audit failure withholds success and rolls back cached health', async () => {
  await replace('falcon-axi')
  db.exec("CREATE TRIGGER fail_test BEFORE INSERT ON audit WHEN NEW.event = 'credential-test' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request('POST', '/falcon-axi/test', {}), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
})
test.each([
  { method: 'GET', path: '/unknown/credential', body: undefined, code: 'NOT_FOUND' },
  { method: 'PUT', path: '/falcon-axi/credential', body: { value: { clientSecret: 'CANARY-secret' }, expectedRevision: 0 }, code: 'INVALID_INPUT' },
  { method: 'PUT', path: '/vectra-axi/credential', body: { value: { ...values['vectra-axi'], executable: '/synthetic' }, expectedRevision: 0 }, code: 'INVALID_INPUT' },
  { method: 'POST', path: '/falcon-axi/test', body: {}, code: 'CREDENTIAL_UNAVAILABLE' },
] as const)('$method $path returns $code without leaking the submitted value', async route => {
  await failure(await request(route.method, route.path, route.body), route.code)
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual([])
})
test('concurrent credential replacements accept one revision and return 409 for the other', async () => {
  const responses = await Promise.all([
    request('PUT', '/falcon-axi/credential', { value: values['falcon-axi'], expectedRevision: 0 }),
    request('PUT', '/falcon-axi/credential', { value: { ...values['falcon-axi'], clientSecret: 'CANARY-other' }, expectedRevision: 0 }),
  ])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})
test('Azure replacement discards an in-flight old-revision acquisition', async () => {
  await replace('az-axi')
  const old = store.findCredential('az-axi')!
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const posted = new Promise<void>(resolve => { started = resolve })
  const post = network.sendPostRequestAsync.bind(network)
  network.sendPostRequestAsync = async (url, options) => { started(); await held; return post(url, options) }
  const pending = adapters[2].prepare(['account', 'list'], old)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
  try {
    await posted
    await replace('az-axi', { ...values['az-axi'], clientSecret: 'CANARY-new-azure' }, 1)
  } finally { release() }
  await rejected
  await adapters[2].prepare(['account', 'list'], store.findCredential('az-axi')!)
  expect(network.requests.map(entry => entry.form.get('client_secret'))).toEqual(['CANARY-azure', 'CANARY-new-azure'])
})
test('manual tests never overlap for one tool and reject a credential replaced during preparation', async () => {
  await replace('falcon-axi')
  const prepare = adapters[0].prepare.bind(adapters[0])
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const preparing = new Promise<void>(resolve => { started = resolve })
  vi.mocked(adapters[0].prepare).mockImplementationOnce(async (args, reference) => {
    const prepared = await prepare(args, reference)
    started()
    await held
    return prepared
  })
  const pending = request('POST', '/falcon-axi/test', {})
  try {
    await preparing
    await failure(await request('POST', '/falcon-axi/test', {}), 'TOO_MANY_CALLS')
    expect(db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE event = 'credential-test'").get())
      .toEqual({ checked_at: expect.any(Number), credential_revision: 1, error_code: 'TOO_MANY_CALLS' })
    await replace('falcon-axi', { ...values['falcon-axi'], clientSecret: 'CANARY-new' }, 1)
  } finally { release() }
  await failure(await pending, 'CREDENTIAL_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
})
test.each([
  { mode: 'exit', args: ['3'], code: 'CREDENTIAL_UNAVAILABLE' },
  { mode: 'leak', args: ['raw'], code: 'SECRET_IN_OUTPUT' },
] as const)('manual test $mode stores a safe failure without upstream output or secrets', async ({ mode, args, code }) => {
  await replace('falcon-axi')
  const prepare = adapters[0].prepare.bind(adapters[0])
  vi.mocked(adapters[0].prepare).mockImplementationOnce(async (argsInput, reference) => {
    const prepared = await prepare(argsInput, reference)
    return { ...prepared, args: [...fakeTool.args, mode, ...args],
      environment: { ...prepared.environment, ARTIUM_TEST_CANARY: 'CANARY-secret' } }
  })
  await failure(await request('POST', '/falcon-axi/test', {}), code)
  expect(db.prepare('SELECT status, error_code FROM tool_health').get()).toEqual({ status: 'error', error_code: code })
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'credential-test'").get()).toEqual({ outcome: code })
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-secret')
  const evidence = db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE event = 'credential-test'").get()
  expect(evidence).toEqual({ checked_at: expect.any(Number), credential_revision: 1, error_code: code })
  await replace('falcon-axi', values['falcon-axi'], 1)
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
  expect(db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE event = 'credential-test'").get()).toEqual(evidence)
})
test('test admission audit failure prevents credential preparation and child creation', async () => {
  await replace('falcon-axi')
  db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON audit WHEN NEW.event = 'run-start' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request('POST', '/falcon-axi/test', {}), 'AUDIT_UNAVAILABLE')
  expect(adapters[0].prepare).not.toHaveBeenCalled()
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
})
test('Azure configuration remains editable while runtime enable and tests stay disabled', async () => {
  await replace('az-axi')
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {}, adapters: adapters.slice(0, 2),
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const settings = await request('PATCH', '/az-axi', { enabled: false, nativeSettings: { allowWrites: false }, expectedRevision: 2 })
  expect(settings.status).toBe(200)
  expect(adminToolSchema.parse(await settings.json())).toMatchObject({ nativeSettings: { allowWrites: false }, health: { status: 'disabled' } })
  await failure(await request('PATCH', '/az-axi', { enabled: true, expectedRevision: 3 }), 'TOOL_DISABLED')
  await failure(await request('POST', '/az-axi/test', {}), 'TOOL_DISABLED')
  expect(db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE event = 'credential-test'").get())
    .toEqual({ checked_at: expect.any(Number), credential_revision: 2, error_code: 'TOOL_DISABLED' })
  expect(network.requests).toEqual([])
})
