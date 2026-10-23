import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createVectraAdapter, vectraCredentialSchema } from '../../src/server/adapters/vectra.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { preflight } from '../../src/server/health/preflight.js'
import { diagnosticError } from '../../src/server/health/diagnostic.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import type { Adapter } from '../../src/server/adapters/types.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner, RunnerError } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import type { MutableCredentialStore, ToolName } from '../../src/server/store/credential-store.js'
import { adminCredentialSchema, adminToolSchema, errorResponseSchema, healthSchema, loginResponseSchema, toolsResponseSchema } from '../../src/shared/api.js'
import { toolsView, toolView } from '../../src/cli/views.js'
import { errors, type ErrorCode } from '../../src/shared/errors.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'
import { CredentialProfile, loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import profileSchema from '../fixtures/axi-credential.schema.json' with { type: 'json' }

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
  'tenable-axi': { accessKey: 'CANARY-tenable-access', secretKey: 'CANARY-tenable-secret' },
  'awx-axi': { origin: 'https://controller.example', token: 'CANARY-awx-token' },
  'ado-axi': { org: 'synthetic-org', auth: 'pat', token: 'CANARY-ado-pat' },
  'ldap-axi': { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap-password' },
  'mg-axi': { tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222', auth: 'secret', clientSecret: 'CANARY-graph' },
  'falcon-axi': { clientId: 'synthetic-client', clientSecret: 'CANARY-secret', region: 'us-2' },
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
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-ordinary', 'synthetic-role'); UPDATE tools SET enabled = 1;`)
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

const diagnosticCases = [
  { code: 'UPSTREAM_AUTH_FAILED', stage: 'authentication', text: 'code: AUTH_FAILED\nmessage: Invalid credentials\nhint: Check the credential.' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'DNS', text: 'code: ENOTFOUND\nmessage: DNS lookup failed for synthetic.invalid' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'TCP', text: 'code: ECONNREFUSED\nmessage: TCP connection refused' },
  { code: 'UPSTREAM_TLS_FAILED', stage: 'TLS', text: 'code: TLS_FAILED\nmessage: TLS certificate verification failed' },
  { code: 'TOOL_REJECTED_INPUT', stage: 'configuration', text: 'code: INVALID_CONFIG\nmessage: Invalid configuration combination' },
  { code: 'TOOL_FAILED', stage: 'tool run', text: 'code: API_ERROR\nmessage: Synthetic upstream failure' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'TCP', text: 'code: SERVER_UNREACHABLE\nmessage: could not connect to the directory' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'TCP', text: 'code: OPERATION_TIMEOUT\nmessage: the operation deadline elapsed' },
  { code: 'UPSTREAM_AUTH_FAILED', stage: 'authentication', text: 'code: ACCESS_DENIED\nmessage: API access was denied' },
  { code: 'UPSTREAM_AUTH_FAILED', stage: 'authentication', text: 'code: AUTH_EXPIRED\nmessage: API credential has expired' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'token acquisition', text: 'code: AUTH_EXCHANGE_FAILED\nmessage: OAuth credential exchange could not complete' },
  { code: 'TOOL_FAILED', stage: 'token acquisition', text: 'code: AUTH_EXCHANGE_FAILED\nmessage: OAuth credential exchange failed' },
] as const

test.each(['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi', 'ldap-axi'] as const)(
  '%s administrator sees each tool failure category and diagnostic; users and audit see no detail', async tool => {
    if (tool === 'mg-axi') adapters.push(createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'mg-writes.log')))
    if (tool === 'ldap-axi') adapters.push(createLdapAdapter(new EmbeddedSecretSource(store)))
    await replace(tool)
    const adapter = adapters.find(adapter => adapter.name === tool)!
    const prepare = adapter.prepare.bind(adapter)
    const mocked = vi.spyOn(adapter, 'prepare')
    for (const { code, stage, text } of diagnosticCases) {
      mocked.mockImplementationOnce(async (args, reference) => ({ ...await prepare(args, reference),
        executable: fakeTool.executable, args: [...fakeTool.args, 'failure', text] }))
      const tested = await request('POST', `/${tool}/test`, {})
      expect(tested.status).toBe(503)
      expect(await tested.json()).toMatchObject({ error: { code, diagnostic: { stage, message: text,
        checkedAt: expect.any(Number), credentialRevision: 1 } } })
      const listed = await request('GET', '')
      const cached = (await listed.json()).tools.find((entry: { name: string }) => entry.name === tool)
      expect(cached.health).toMatchObject({ errorCode: code, diagnostic: { stage, message: text } })
      const ordinary = await request('POST', `/${tool}/test`, {}, await adminHeaders('synthetic-ordinary'))
      expect(ordinary.status).toBe(403)
      expect(await ordinary.text()).not.toContain(text)
    }
    const auditText = JSON.stringify(db.prepare('SELECT * FROM audit').all())
    expect(auditText).not.toContain('Synthetic upstream failure')
    expect(auditText).not.toContain('Check the credential.')
  })

test('preflight failure is redacted in the response and cached administrator health', async () => {
  await replace('falcon-axi')
  vi.mocked(preflight).mockRejectedValueOnce(diagnosticError('UPSTREAM_TLS_FAILED', {
    stage: 'TLS', host: 'synthetic.invalid', message: 'CANARY-secret', hint: 'Untrusted chain.' }))
  const response = await request('POST', '/falcon-axi/test', {})
  const body = await response.json()
  expect(body).toMatchObject({ error: { code: 'UPSTREAM_TLS_FAILED' } })
  expect(body.error.diagnostic).toBeUndefined()
  const listing = await request('GET', '')
  expect(await listing.text()).not.toContain('CANARY-secret')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-secret')
})

test('Graph sign-in failure retains the native message and token-acquisition stage', async () => {
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'mg-writes.log'))
  adapters.push(adapter)
  await replace('mg-axi')
  const text = 'code: AUTH_REQUIRED\nmessage: Application authentication failed for the configured identity; no user or device-code fallback was attempted'
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementationOnce(async (args, reference) => ({ ...await prepare(args, reference),
    executable: fakeTool.executable, args: [...fakeTool.args, 'failure', text] }))
  const response = await request('POST', '/mg-axi/test', {})
  const body = errorResponseSchema.parse(await response.json())
  expect(body).toMatchObject({ error: { code: 'UPSTREAM_AUTH_FAILED', diagnostic: { toolCode: 'AUTH_REQUIRED',
    stage: 'token acquisition', message: text, checkedAt: expect.any(Number), credentialRevision: 1 } } })
  const cached = (await (await request('GET', '')).json()).tools.find((tool: { name: string }) => tool.name === 'mg-axi')
  expect(cached.health.diagnostic).toEqual(body.error.diagnostic)
  expect(JSON.stringify(body)).not.toContain(values['mg-axi'].clientSecret)
})

test.each([
  { tool: 'falcon-axi', value: { ...values['falcon-axi'], clientSecret: 123 }, field: 'clientSecret' },
  { tool: 'vectra-axi', value: { ...values['vectra-axi'], token: 123 }, field: 'token' },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', origin: values['vectra-axi'].origin,
    auth: 'oauth', clientId: 'synthetic-client', clientSecret: 123 }, field: 'clientSecret' },
  { tool: 'vectra-axi', value: { kind: 'rux', apiVersion: '3.4', origin: values['vectra-axi'].origin,
    auth: 'oauth', clientId: 'synthetic-client', clientSecret: 123 }, field: 'clientSecret' },
] as const)('$tool invalid stored credentials name $field without its value', async ({ tool, value, field }) => {
  if (tool === 'vectra-axi') adapters.find(adapter => adapter.name === tool)!.credentialSchema = vectraCredentialSchema
  store.replaceCredential(tool, value, 0, actor, Date.now())
  const response = await request('POST', `/${tool}/test`, {})
  expect(response.status).toBe(errors.CREDENTIAL_INVALID.status)
  expect(await response.json()).toMatchObject({ error: { code: 'CREDENTIAL_INVALID', diagnostic: {
    stage: 'configuration', message: `Invalid credential field: ${field}.`, credentialRevision: 1,
  } } })
})

test('ordinary tool callers receive an upstream category without administrator diagnostics', async () => {
  store.replaceCredential('az-axi', values['az-axi'], 0, actor, Date.now())
  network.status = 400
  network.response = { error: 'invalid_client', error_description: 'AADSTS7000222: CANARY-PROVIDER-BODY' }
  const response = await fetch(`${url}/v1/tools/az-axi/run`, { method: 'POST',
    headers: await adminHeaders('synthetic-ordinary'), body: JSON.stringify({ args: ['account', 'list'] }) })
  const body = await response.json()
  expect(body).toMatchObject({ error: { code: 'UPSTREAM_AUTH_FAILED' } })
  expect(body.error.diagnostic).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain('AADSTS7000222')
  expect(JSON.stringify(body)).not.toContain('CANARY-PROVIDER-BODY')
})

test.each([
  { name: 'stall', code: 'UPSTREAM_NETWORK_FAILED', elapsed: 10_000, configure: (transport: FakeTokenTransport) => {
    transport.sendPostRequestAsync = () => new Promise(() => {})
  } },
  { name: 'network failure', code: 'UPSTREAM_NETWORK_FAILED', elapsed: 750, configure: (transport: FakeTokenTransport) => {
    transport.failure = `CANARY-NETWORK-FAILURE ${values['az-axi'].clientSecret}`
  } },
  { name: 'expired token', code: 'UPSTREAM_AUTH_FAILED', elapsed: 0, configure: (transport: FakeTokenTransport) => {
    transport.response = { ...transport.response, expires_in: -1 }
  } },
  { name: 'service outage', code: 'TOOL_FAILED', elapsed: 0, configure: (transport: FakeTokenTransport) => {
    transport.status = 503
    transport.response = { error: 'temporarily_unavailable',
      error_description: `${values['az-axi'].clientSecret} CANARY-RAW-SERVICE-RESPONSE` }
  } },
])('token $name has safe administrator diagnostics in the test response and cached health', async ({ code, elapsed, configure }) => {
  store.replaceCredential('az-axi', values['az-axi'], 0, actor, Date.now())
  configure(network)
  let started!: () => void
  const acquiring = new Promise<void>(resolve => { started = resolve })
  const post = network.sendPostRequestAsync.bind(network)
  vi.spyOn(network, 'sendPostRequestAsync').mockImplementation((url, options) => { started(); return post(url, options) })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const pending = app.inject({ method: 'POST', url: '/v1/admin/tools/az-axi/test', headers, payload: {} }).then(response => response)
    await acquiring
    await vi.advanceTimersByTimeAsync(elapsed)
    const tested = await pending
    expect(tested.statusCode).toBe(503)
    const diagnostic = { stage: 'token acquisition', host: 'login.microsoftonline.com',
      checkedAt: Date.now(), credentialRevision: 1 }
    expect(tested.json()).toMatchObject({ error: { code, diagnostic } })
    const listing = await app.inject({ method: 'GET', url: '/v1/admin/tools', headers })
    const cached = listing.json().tools.find((tool: { name: string }) => tool.name === 'az-axi')
    expect(cached.health).toMatchObject({ errorCode: code, diagnostic })
    const evidence = tested.body + listing.body + JSON.stringify(db.prepare('SELECT * FROM audit').all())
    expect(evidence).not.toContain(values['az-axi'].clientSecret)
    expect(evidence).not.toContain('CANARY-AZURE-ACCESS-TOKEN')
    expect(evidence).not.toContain('CANARY-NETWORK-FAILURE')
    expect(evidence).not.toContain('CANARY-RAW-SERVICE-RESPONSE')
  } finally { vi.useRealTimers() }
})

test('a retired cached category requires a fresh test without breaking administrator listing', async () => {
  await replace('falcon-axi')
  db.prepare("UPDATE tool_health SET status = 'error', error_code = ?").run('RETIRED_CATEGORY')
  const response = await request('GET', '')
  expect(response.status).toBe(200)
  const tool = (await response.json()).tools.find((entry: { name: string }) => entry.name === 'falcon-axi')
  expect(tool.health).toMatchObject({ status: 'unknown', checkedAt: null, credentialRevision: null, errorCode: null })
})

test.each([
  { tool: 'falcon-axi', settings: { allowWrites: true }, readOnly: false, writableTools: ['falcon-axi'] },
  { tool: 'az-axi', settings: { allowWrites: true }, readOnly: false, writableTools: ['az-axi'] },
  { tool: 'mg-axi', settings: { writes: { allowWrites: true, operations: ['mg.entra.group.member.add'] } }, readOnly: false, writableTools: ['mg-axi'] },
  { tool: 'vectra-axi', settings: { writes: { allowWrites: true, operations: ['qux.detection.tag.set'] } }, readOnly: false, writableTools: ['vectra-axi'] },
] as const)('$tool administrator switch is audited and independent of other tools', async ({ tool, settings, readOnly, writableTools }) => {
  const initial = await request('GET', '')
  const before = (await initial.json() as { tools: Array<{ name: string, readOnly: boolean, health: { readOnly: boolean } }> }).tools
  expect(before.every(item => item.readOnly && item.health.readOnly)).toBe(true)
  const enabled = await request('PATCH', `/${tool}`, { nativeSettings: settings, expectedRevision: 1 })
  expect(enabled.status).toBe(200)
  expect(await enabled.json()).toMatchObject({ nativeSettings: settings, readOnly, health: { readOnly } })
  const list = (await (await request('GET', '')).json() as { tools: Array<{ name: string, readOnly: boolean }> }).tools
  expect(list.filter(item => !item.readOnly).map(item => item.name)).toEqual(writableTools)
  expect(db.prepare("SELECT action, tool, user_id FROM audit WHERE event = 'admin-change'").all())
    .toEqual([{ action: 'update-tool', tool, user_id: actor }])
  const disabled = await request('PATCH', `/${tool}`, { nativeSettings: {}, expectedRevision: 2 })
  expect(disabled.status).toBe(200)
  expect(await disabled.json()).toMatchObject({ readOnly: true, health: { readOnly: true } })
})

test.each([
  { tool: 'falcon-axi', settings: { allowWrites: true }, writableTools: ['falcon-axi'] },
  { tool: 'az-axi', settings: { allowWrites: true }, writableTools: ['az-axi'] },
  { tool: 'mg-axi', settings: { writes: { allowWrites: true, operations: ['mg.entra.group.member.add'] } }, writableTools: ['mg-axi'] },
  { tool: 'vectra-axi', settings: { writes: { allowWrites: true, operations: ['qux.detection.tag.set'] } }, writableTools: ['vectra-axi'] },
] as const)('$tool migration preserves an explicit write opt-in', async ({ tool, settings, writableTools }) => {
  store.replaceCredential(tool, { ...values[tool], ...settings }, 0, actor, 123)
  store = createCredentialStore(db, provider)
  expect(store.readToolSettings!(tool)).toMatchObject(settings)
  expect(store.readCredential(store.findCredential(tool)!)).toMatchObject(settings)
  const list = (await (await request('GET', '')).json() as { tools: Array<{ name: string, readOnly: boolean }> }).tools
  expect(list.filter(item => !item.readOnly).map(item => item.name)).toEqual(writableTools)
})

test('Falcon discovery and health expose the enabled execution switch', async () => {
  await replace('falcon-axi', { ...values['falcon-axi'], allowWrites: true })
  const tested = await request('POST', '/falcon-axi/test', {})
  expect(tested.status).toBe(200)
  expect(healthSchema.parse(await tested.json())).toMatchObject({ status: 'ok', readOnly: false })
  const admin = (await (await request('GET', '')).json() as { tools: unknown[] }).tools
    .map(tool => adminToolSchema.parse(tool)).find(tool => tool.name === 'falcon-axi')!
  expect(admin).toMatchObject({ nativeSettings: { allowWrites: true }, readOnly: false,
    health: { status: 'ok', readOnly: false } })
  const discovery = await fetch(`${url}/v1/tools`, { headers })
  expect(discovery.status).toBe(200)
  const tool = toolsResponseSchema.parse(await discovery.json()).tools.find(tool => tool.name === 'falcon-axi')!
  expect(tool).toMatchObject({ status: 'ok', readOnly: false })
  expect(toolView(tool)).toContain('readOnly: false\n')
  expect(toolsView([tool])).toContain('falcon-axi,ok,"0.6.0",false\n')
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const page = await app.inject({ method: 'GET', url: '/admin/tools/falcon-axi',
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('Writes enabled')
  expect(page.body).toContain('RTR read-only command execution')
})

test('schema-driven replacement reaches the isolated runner and keeps secrets out of metadata', async () => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = new CredentialProfile(profileSchema)
  const adapter = createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({
    ...await prepare(args, reference, input), executable: fakeTool.executable,
    args: [...fakeTool.args, 'hosted-profile', 'vectra-axi'],
  }))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const value = { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId, auth: 'certificate',
    privateKey: 'CANARY-hosted-key', thumbprintSha256: 'a'.repeat(64), writes: values['vectra-axi'].writes }
  const credential = await replace('vectra-axi', value)
  expect(credential.metadata).toEqual({ mode: value.mode, tenantId: value.tenantId, clientId: value.clientId, auth: value.auth,
    thumbprintSha256: value.thumbprintSha256, writes: value.writes })
  const response = await fetch(`${url}/v1/tools/vectra-axi/run`, { method: 'POST', headers,
    body: JSON.stringify({ args: ['detection', 'list'] }) })
  expect(response.status).toBe(200)
  const result = await response.json() as { stdout: string }
  expect(JSON.parse(result.stdout)).toEqual({ profile: 'artium', auth: 'certificate', thumbprintSha256: value.thumbprintSha256,
    writes: value.writes, secretResolved: true, privateFiles: true, emptyHome: true })
  expect(readFileSync(join(directory, 'data', 'artium.db-wal')).includes(Buffer.from(value.privateKey))).toBe(false)
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(value.privateKey)
  await failure(await request('PUT', '/vectra-axi/credential', { value: { ...value, thumbprintSha256: 'a'.repeat(40) },
    expectedRevision: 1, expectedToolRevision: 2 }), 'INVALID_INPUT')
  const edit = await request('PATCH', '/vectra-axi', { nativeSettings: { writes: { allowWrites: false, operations: ['notes.set'] } }, expectedRevision: 2 })
  expect(edit.status).toBe(200)
  expect(store.readCredential(store.findCredential('vectra-axi')!)).toMatchObject({ writes: { allowWrites: false } })
})

test.each([
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', tokenEnv: 'UNBOUND_TOKEN' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'oauth', origin: 'https://appliance.test', clientId: 'synthetic' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'oauth', origin: 'https://appliance.test', clientId: 'synthetic', secretEnv: 'UNBOUND_SECRET' } },
  { tool: 'vectra-axi', value: { kind: 'rux', apiVersion: '3.4', auth: 'oauth', origin: 'https://appliance.test', clientId: 'synthetic' } },
  { tool: 'vectra-axi', value: { kind: 'rux', apiVersion: '3.4', auth: 'oauth', origin: 'https://appliance.test', clientId: 'synthetic', secretEnv: 'UNBOUND_SECRET' } },
  { tool: 'mg-axi', value: { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId, auth: 'client-secret' } },
  { tool: 'mg-axi', value: { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId, auth: 'certificate', thumbprintSha256: 'a'.repeat(64) } },
  { tool: 'mg-axi', value: { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId, auth: 'federated' } },
  { tool: 'mg-axi', value: { mode: 'delegated', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token: 'CANARY interior token\n' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test/path', token: 'CANARY-token' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', auth: 'oauth', origin: 'http://appliance.test', clientId: 'synthetic', clientSecret: 'CANARY-secret' } },
  { tool: 'vectra-axi', value: { kind: 'rux', apiVersion: '3.4', auth: 'oauth', origin: 'https://appliance.test?query', clientId: 'synthetic', clientSecret: 'CANARY-secret' } },
] as const)('published $tool rejects unusable replacement without overwriting credentials', async ({ tool, value }) => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile(tool, join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))!
  const source = new EmbeddedSecretSource(store)
  const adapter = tool === 'mg-axi' ? createMgAdapter(source, join(directory, 'writes.log'), profile)
    : createVectraAdapter(source, join(directory, 'writes.log'), profile)
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const original = tool === 'mg-axi' ? { mode: 'application', tenantId: azureTestTenant,
    clientId: values['mg-axi'].clientId, auth: 'client-secret', clientSecret: 'CANARY-original' }
    : { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token: 'CANARY-original' }
  store.replaceCredential(tool, original, 0, actor, 123)
  const reference = store.findCredential(tool)!
  await failure(await request('PUT', `/${tool}/credential`, { value, expectedRevision: 1, expectedToolRevision: 1 }), 'INVALID_INPUT')
  expect(store.findCredential(tool)).toEqual(reference)
  expect(store.readCredential(reference)).toEqual(original)
  expect(db.prepare("SELECT revision FROM tools WHERE name = ?").get(tool)).toEqual({ revision: 1 })
})

test.each(['PUT', 'PATCH'])('%s credential normalizes safe input and reports changes without secrets', async method => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const adapter = createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('vectra-axi')
  const logged = vi.spyOn(app.log, 'error')
  const value = { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: ' HTTPS://Appliance.Test:443/ ', token: ' CANARY-normalized-token\n' }
  const response = await request(method, '/vectra-axi/credential', { value, expectedRevision: 0, expectedToolRevision: 1 })
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(saved.metadata.origin).toBe('https://appliance.test')
  expect(saved.normalizations).toEqual(expect.arrayContaining([
    { field: 'origin', reason: 'canonicalized format' },
    { field: 'token', reason: 'removed surrounding whitespace' },
  ]))
  expect(store.readCredential(store.findCredential('vectra-axi')!)).toEqual({ ...value,
    origin: 'https://appliance.test', token: 'CANARY-normalized-token' })
  expect(JSON.stringify(saved)).not.toContain('CANARY')
  const rejected = await request(method, '/vectra-axi/credential', {
    value: { ...value, origin: 'https://CANARY-user:CANARY-password@appliance.test/path' },
    expectedRevision: 1, expectedToolRevision: 2,
  })
  expect(rejected.status).toBe(400)
  const error = await rejected.json()
  expect(error.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('origin') })
  expect(JSON.stringify(error)).not.toContain('CANARY')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY')
  expect(JSON.stringify(logged.mock.calls)).not.toContain('CANARY')
})

test.each([
  { kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-token', origin: 'https://appliance.test' },
  { kind: 'qux', apiVersion: '2.5', auth: 'oauth', clientId: 'synthetic', clientSecret: 'CANARY-secret', origin: 'https://appliance.test:8443' },
  { kind: 'rux', apiVersion: '3.4', auth: 'oauth', clientId: 'synthetic', clientSecret: 'CANARY-secret', origin: 'https://[::1]:8443' },
])('published Vectra stores canonical origin $origin for $kind $auth', async value => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const adapter = createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({
    ...await prepare(args, reference, input), executable: fakeTool.executable,
    args: [...fakeTool.args, 'print', 'synthetic-health-output'],
  }))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  expect((await replace('vectra-axi', value)).metadata.origin).toBe(value.origin)
  expect(store.readCredential(store.findCredential('vectra-axi')!)).toEqual(value)
})

test.each([
  values['mg-axi'],
  { tenantId: azureTestTenant, clientId: values['mg-axi'].clientId, auth: 'certificate',
    privateKey: 'CANARY-legacy-key', thumbprint: 'a'.repeat(40) },
])('schema activation leaves incompatible credentials replaceable: $auth', async value => {
  store.replaceCredential('mg-axi', value, 0, actor, 123)
  await app.close()
  const profile = new CredentialProfile(profileSchema)
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [...adapters, adapter],
    environment: {}, resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const response = await request('GET', '/mg-axi/credential')
  expect(response.status).toBe(200)
  expect(adminCredentialSchema.parse(await response.json())).toEqual({ tool: 'mg-axi', configured: true,
    metadata: {}, revision: 1, updatedAt: 123, updatedBy: actor })
  await expect(adapter.prepare(['entra', 'user', 'list'], store.findCredential('mg-axi')!))
    .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
  await failure(await request('PUT', '/mg-axi/credential', { value, expectedRevision: 1, expectedToolRevision: 1 }), 'INVALID_INPUT')

  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const page = await app.inject({ method: 'GET', url: '/admin/tools/mg-axi',
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).not.toContain('CANARY-')
  expect(page.body).toContain('action="/v1/admin/tools/mg-axi/credential"')
  const replacement = { mode: 'application', tenantId: value.tenantId, clientId: value.clientId,
    auth: 'client-secret', clientSecret: 'CANARY-replacement' }
  expect(await replace('mg-axi', replacement, 1)).toMatchObject({ revision: 2,
    metadata: { mode: 'application', tenantId: value.tenantId, clientId: value.clientId, auth: 'client-secret' } })
  expect(store.readCredential(store.findCredential('mg-axi')!)).toEqual(replacement)
  expect((await adapter.prepare(['entra', 'user', 'list'], store.findCredential('mg-axi')!)).secrets)
    .toEqual([replacement.clientSecret])
})

test.each([false, true])('rendered Azure and Graph controls reflect enabled=%s without exposing secrets', async enabled => {
  for (const tool of ['falcon-axi', 'vectra-axi', 'az-axi'] as const) {
    expect((await request('PUT', `/${tool}/credential`, { value: values[tool], expectedRevision: 0, expectedToolRevision: 1 })).status).toBe(200)
  }
  db.prepare("UPDATE tools SET enabled = ? WHERE name = 'az-axi'").run(Number(enabled))
  db.prepare("UPDATE tools SET enabled = ? WHERE name = 'mg-axi'").run(Number(enabled))
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const cookie = login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  for (const path of ['/admin', '/admin/tools', '/admin/tools/az-axi', '/admin/tools/mg-axi', '/admin/roles']) {
    const page = await app.inject({ method: 'GET', url: path, headers: { cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.body).not.toContain(values['falcon-axi'].clientId)
    expect(page.body).not.toContain(values['falcon-axi'].clientSecret)
    expect(page.body).not.toContain(values['vectra-axi'].token)
    expect(page.body).not.toContain(values['az-axi'].clientSecret)
    if (path === '/admin/tools/az-axi') {
      expect(page.body).toContain('data-test-tool="az-axi" action="/v1/admin/tools/az-axi/test"')
      expect(page.body).toContain('data-profile-field="tenantId"')
      expect(page.body.match(/name="expectedToolRevision" data-type="number" value="2"/g)).toHaveLength(1)
      expect(page.body).toContain('Last changed by synthetic-user')
    }
    if (path === '/admin/tools/az-axi') {
      const forms = page.body.match(/<form\b[^>]*action="\/v1\/admin\/tools\/az-axi"[^>]*>[\s\S]*?<\/form>/g)!
      expect(forms).toEqual(expect.arrayContaining([expect.stringContaining(
        `<input type="hidden" name="enabled" data-type="boolean" value="${!enabled}"><button>${enabled ? 'Disable tool' : 'Enable tool'}</button>`)]))
    }
    if (path === '/admin/tools/mg-axi') {
      const graphForms = page.body.match(/<form\b[^>]*action="\/v1\/admin\/tools\/mg-axi"[^>]*>[\s\S]*?<\/form>/g)!
      expect(graphForms).toEqual(expect.arrayContaining([expect.stringContaining(
        `<input type="hidden" name="enabled" data-type="boolean" value="${!enabled}"><button>${enabled ? 'Disable tool' : 'Enable tool'}</button>`)]))
    }
  }
})
async function replace(tool: ToolName, value: unknown = values[tool], expectedRevision = 0) {
  const listed = await request('GET', '')
  const { tools } = await listed.json() as { tools: unknown[] }
  const expectedToolRevision = tools.map(item => adminToolSchema.parse(item)).find(item => item.name === tool)!.revision
  const response = await request('PUT', `/${tool}/credential`, { value, expectedRevision, expectedToolRevision })
  expect(response.status).toBe(200)
  return adminCredentialSchema.parse(await response.json())
}
async function save(tool: ToolName, value: Record<string, unknown>, expectedRevision: number) {
  const { tools } = await (await request('GET', '')).json() as { tools: Array<{ name: ToolName, revision: number }> }
  return request('PATCH', `/${tool}/credential`, { value, expectedRevision,
    expectedToolRevision: tools.find(item => item.name === tool)!.revision })
}

test.each(['falcon-axi', 'vectra-axi', 'az-axi', 'mg-axi'] as const)('%s save retains omitted secrets and native settings', async tool => {
  await replace(tool)
  const current = store.readCredential(store.findCredential(tool)!) as Record<string, unknown>
  const { clientSecret: _secret, token: _token, writes: _writes, subscriptions: _subscriptions, allowWrites: _allowWrites, ...value } = current
  const response = await save(tool, value, 1)
  expect(response.status).toBe(200)
  expect(adminCredentialSchema.parse(await response.json())).toMatchObject({ revision: 2, updatedBy: actor })
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(current)
  expect(db.prepare("SELECT action, user_id FROM audit WHERE event = 'admin-change' ORDER BY id DESC LIMIT 1").get())
    .toEqual({ action: 'replace-credential', user_id: actor })
})

test('save can configure credentials without repeating separately saved settings', async () => {
  expect((await request('PATCH', '/az-axi', { nativeSettings: { subscriptions: ['synthetic-current'], allowWrites: false }, expectedRevision: 1 })).status).toBe(200)
  const { subscriptions: _subscriptions, allowWrites: _allowWrites, ...value } = values['az-axi']
  expect((await save('az-axi', value, 0)).status).toBe(200)
  expect(store.readCredential(store.findCredential('az-axi')!)).toEqual({ ...value, subscriptions: ['synthetic-current'], allowWrites: false })
})

test('save replaces supplied secrets and evicts old Azure tokens', async () => {
  await replace('az-axi')
  const old = store.findCredential('az-axi')!
  await adapters[2].prepare(['account', 'list'], old)
  const { subscriptions: _subscriptions, allowWrites: _allowWrites, ...value } = values['az-axi']
  expect((await save('az-axi', { ...value, clientSecret: 'CANARY-rotated' }, 1)).status).toBe(200)
  await expect(adapters[2].prepare(['account', 'list'], old)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await adapters[2].prepare(['account', 'list'], store.findCredential('az-axi')!)
  expect(network.requests.map(entry => entry.form.get('client_secret'))).toEqual(['CANARY-azure', 'CANARY-rotated'])
  expect(store.readCredential(store.findCredential('az-axi')!)).toEqual({ ...values['az-axi'], clientSecret: 'CANARY-rotated' })
})

test('save removes omitted optional non-secret fields', async () => {
  await replace('falcon-axi', { ...values['falcon-axi'], memberCid: 'synthetic-member' })
  expect((await save('falcon-axi', { clientId: values['falcon-axi'].clientId, region: 'us-2' }, 1)).status).toBe(200)
  expect(store.readCredential(store.findCredential('falcon-axi')!)).toEqual(values['falcon-axi'])
})

test.each([
  values['ado-axi'],
  { org: 'synthetic-org', auth: 'client-secret', tenantId: azureTestTenant,
    clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-ado-client-secret' },
])('ADO retains $auth secrets only for the same identity and exposes a secret-free editor', async value => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const adapter = createAdoAdapter(new EmbeddedSecretSource(store))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  db.exec("UPDATE tools SET enabled = 0 WHERE name = 'ado-axi'")
  await replace('ado-axi', value)
  const { token: _token, clientSecret: _clientSecret, ...identity } = value as Record<string, unknown>
  const saved = await save('ado-axi', { ...identity, org: 'https://dev.azure.com/synthetic-org/', project: 'Other Project' }, 1)
  expect(saved.status).toBe(200)
  expect(store.readCredential(store.findCredential('ado-axi')!)).toEqual({ ...value, project: 'Other Project' })
  expect(JSON.stringify(await saved.json())).not.toContain('CANARY-')
  await failure(await save('ado-axi', { ...identity, org: 'other-org' }, 2), 'INVALID_INPUT')
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const page = await app.inject({ method: 'GET', url: '/admin/tools/ado-axi',
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('data-profile-field="org"')
  expect(page.body).toContain('data-profile-field="token"')
  expect(page.body).toContain('data-profile-field="clientSecret"')
  expect(page.body).toContain('data-profile-field="tenantId"')
  expect(page.body).toContain('data-profile-field="clientId"')
  expect(page.body).not.toContain('CANARY-')
})

test.each([
  { tool: 'mg-axi', value: { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId,
    auth: 'certificate', privateKey: '-----BEGIN PRIVATE KEY-----\nCANARY-key-line-1\nCANARY-key-line-2\n-----END PRIVATE KEY-----\n',
    thumbprintSha256: 'a'.repeat(64) }, secret: 'privateKey', changed: { tenantId: '33333333-3333-4333-8333-333333333333' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', origin: values['vectra-axi'].origin,
    auth: 'oauth', clientId: 'synthetic-client', clientSecret: 'CANARY-oauth' }, secret: 'clientSecret',
    changed: { kind: 'rux', apiVersion: '3.4' } },
  { tool: 'mg-axi', value: { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId,
    auth: 'federated', token: 'CANARY-federated' }, secret: 'token', changed: { mode: 'delegated', auth: undefined } },
] as const)('published $tool save retains $secret only for an unchanged identity ($changed)', async ({ tool, value, secret, changed }) => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile(tool, join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))!
  const source = new EmbeddedSecretSource(store)
  const adapter = tool === 'mg-axi' ? createMgAdapter(source, join(directory, 'writes.log'), profile)
    : createVectraAdapter(source, join(directory, 'writes.log'), profile)
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  // Disabled tools do not run health checks after saving.
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run(tool)
  await replace(tool, value)
  const { [secret]: _secret, ...nonSecrets } = value
  const response = await save(tool, nonSecrets, 1)
  expect(response.status).toBe(200)
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(value)
  expect(JSON.stringify(await response.json())).not.toContain(value[secret])
  await failure(await save(tool, { ...nonSecrets, ...changed }, 2), 'INVALID_INPUT')
  expect(store.findCredential(tool)!.revision).toBe(2)
})

test.each([
  { tool: 'falcon-axi', value: { clientId: 'CANARY-other-client', region: 'us-2' } },
  { tool: 'az-axi', value: { tenantId: '33333333-3333-4333-8333-333333333333', clientId: values['az-axi'].clientId, auth: 'secret' } },
  { tool: 'az-axi', value: { tenantId: azureTestTenant, clientId: '33333333-3333-4333-8333-333333333333', auth: 'secret' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', origin: 'https://other.invalid', auth: 'token' } },
  { tool: 'vectra-axi', value: { kind: 'qux', apiVersion: '2.5', origin: values['vectra-axi'].origin, auth: 'oauth', clientId: 'synthetic-client' } },
] as const)('$tool save requires new secrets after changing identity to $value', async ({ tool, value }) => {
  await replace(tool)
  const credentials = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  await failure(await save(tool, value, 1), 'INVALID_INPUT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(credentials)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})

test('save changes authentication kind with a new secret and discards the previous kind secret', async () => {
  await replace('vectra-axi')
  const value = { kind: 'rux', apiVersion: '3.4', origin: values['vectra-axi'].origin, auth: 'oauth',
    clientId: 'synthetic-client', clientSecret: 'CANARY-new-oauth' }
  expect((await save('vectra-axi', value, 1)).status).toBe(200)
  expect(store.readCredential(store.findCredential('vectra-axi')!)).toEqual({ ...value, writes: values['vectra-axi'].writes })
})

test.each([
  { expectedRevision: 0, expectedToolRevision: 2 },
  { expectedRevision: 1, expectedToolRevision: 1 },
])('save rejects stale credential or settings revisions: $expectedRevision/$expectedToolRevision', async revisions => {
  await replace('vectra-axi')
  const credentials = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  await failure(await request('PATCH', '/vectra-axi/credential', { value: { ...values['vectra-axi'], writes: undefined }, ...revisions }), 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(credentials)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
})

test('save rejects native settings instead of silently changing or ignoring them', async () => {
  await replace('vectra-axi')
  await failure(await save('vectra-axi', values['vectra-axi'], 1), 'INVALID_INPUT')
  expect(store.findCredential('vectra-axi')!.revision).toBe(1)
  expect(store.readCredential(store.findCredential('vectra-axi')!)).toEqual(values['vectra-axi'])
})

test('save audit failure rolls back the credential and tool revisions', async () => {
  await replace('falcon-axi')
  const credentials = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON audit WHEN NEW.event = 'admin-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await save('falcon-axi', values['falcon-axi'], 1), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(credentials)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
})

test.each(['', null])('save rejects an explicit invalid secret (%s) without retaining the old one', async clientSecret => {
  await replace('falcon-axi')
  await failure(await save('falcon-axi', { ...values['falcon-axi'], clientSecret }, 1), 'INVALID_INPUT')
  expect(store.readCredential(store.findCredential('falcon-axi')!)).toEqual(values['falcon-axi'])
  expect(store.findCredential('falcon-axi')!.revision).toBe(1)
})

test('concurrent saves retain one secret revision and reject the competing edit', async () => {
  await replace('falcon-axi')
  const responses = await Promise.all([
    request('PATCH', '/falcon-axi/credential', { value: { clientId: values['falcon-axi'].clientId, region: 'us-1' }, expectedRevision: 1, expectedToolRevision: 2 }),
    request('PATCH', '/falcon-axi/credential', { value: { clientId: values['falcon-axi'].clientId, region: 'us-2' }, expectedRevision: 1, expectedToolRevision: 2 }),
  ])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  expect(store.readCredential(store.findCredential('falcon-axi')!)).toMatchObject({ clientSecret: values['falcon-axi'].clientSecret })
  expect(store.findCredential('falcon-axi')!.revision).toBe(2)
})

const routes = [
  { method: 'GET', path: '/az-axi', body: undefined },
  { method: 'PATCH', path: '/az-axi/write-access', body: { enabled: true, expectedRevision: 1 } },
  { method: 'GET', path: '', body: undefined },
  { method: 'PATCH', path: '/falcon-axi', body: { enabled: false, expectedRevision: 1 } },
  { method: 'GET', path: '/falcon-axi/credential', body: undefined },
  { method: 'PUT', path: '/falcon-axi/credential', body: { value: values['falcon-axi'], expectedRevision: 0, expectedToolRevision: 1 } },
  { method: 'PATCH', path: '/falcon-axi/credential', body: { value: values['falcon-axi'], expectedRevision: 0, expectedToolRevision: 1 } },
  { method: 'POST', path: '/falcon-axi/test', body: {} },
]
test('admin list and detail expose write capability for every tool, including unavailable runtime adapters', async () => {
  const response = await request('GET', '')
  const { tools } = await response.json()
  expect(tools.map((tool: { name: string, writeAccess: unknown }) => ({ name: tool.name, ...tool.writeAccess as object })))
    .toMatchObject([
      { name: 'falcon-axi', capable: true, enabled: false, reason: null },
      { name: 'vectra-axi', capable: true, enabled: false, reason: null },
      { name: 'az-axi', capable: true, enabled: false, reason: null },
      { name: 'mg-axi', capable: true, enabled: false, reason: null },
      { name: 'ldap-axi', capable: false, enabled: false, reason: expect.stringContaining('no write path') },
      { name: 'ado-axi', capable: true, enabled: false, reason: null },
      { name: 'awx-axi', capable: true, enabled: false, reason: null },
      { name: 'tenable-axi', capable: true, enabled: false, reason: null },
    ])
  for (const tool of tools) {
    const detail = await request('GET', `/${tool.name}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()).writeAccess).toEqual(tool.writeAccess)
    expect(tool.writeAccess.unlocks.length).toBeGreaterThan(0)
    expect(tool.writeAccess.blocked.length).toBeGreaterThan(0)
  }
})

test.each(['falcon-axi', 'az-axi', 'ado-axi', 'awx-axi'] as const)('%s write switch preserves native settings and credentials', async tool => {
  await replace(tool)
  const settings = tool === 'az-axi' ? { allowWrites: true, subscriptions: ['synthetic-subscription'],
    managementGroup: 'synthetic-group', workspaces: { synthetic: '33333333-3333-4333-8333-333333333333' },
    description: 'Synthetic description', tlsDestinations: { storageAccounts: ['syntheticstore'],
      keyVaults: ['synthetic-vault'], registries: ['syntheticregistry'] } } : { allowWrites: true }
  expect((await request('PATCH', `/${tool}`, { nativeSettings: settings, expectedRevision: 2 })).status).toBe(200)
  const before = store.readCredential(store.findCredential(tool)!) as Record<string, unknown>
  const reference = store.findCredential(tool)!
  const off = await request('PATCH', `/${tool}/write-access`, { enabled: false, expectedRevision: 3 })
  expect(off.status).toBe(200)
  expect(await off.json()).toMatchObject({ nativeSettings: { ...settings, allowWrites: false },
    writeAccess: { capable: true, enabled: false }, revision: 4 })
  expect(store.readCredential(store.findCredential(tool)!)).toEqual({ ...before, allowWrites: false })
  const on = await request('PATCH', `/${tool}/write-access`, { enabled: true, expectedRevision: 4 })
  expect(on.status).toBe(200)
  expect(await on.json()).toMatchObject({ nativeSettings: settings, writeAccess: { enabled: true }, revision: 5 })
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(before)
  expect(store.findCredential(tool)).toEqual({ ...reference, revision: reference.revision! + 2 })
})

test.each(['az-axi', 'ado-axi'] as const)('%s write switch rejects an in-flight write and permits a fresh write after re-enabling', async tool => {
  const adapter = tool === 'az-axi' ? adapters[2] : createAdoAdapter(new EmbeddedSecretSource(store), cache)
  if (tool === 'ado-axi') adapters.push(adapter)
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run(tool)
  const value = tool === 'az-axi' ? values[tool] : { org: 'synthetic-org', auth: 'client-secret',
    tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222',
    clientSecret: 'CANARY-ado-client-secret', allowWrites: true }
  await replace(tool, value)
  db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  const args = tool === 'az-axi'
    ? ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic-group', '--execute']
    : ['pr', 'comment', '42', '--body', 'Synthetic comment']
  const old = store.findCredential(tool)!
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const posted = new Promise<void>(resolve => { started = resolve })
  const post = network.sendPostRequestAsync.bind(network)
  vi.spyOn(network, 'sendPostRequestAsync').mockImplementationOnce(async (url, options) => { started(); await held; return post(url, options) })
  const pending = adapter.prepare(args, old)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  try {
    await posted
    const response = await request('PATCH', `/${tool}/write-access`, { enabled: false, expectedRevision: 2 })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ writeAccess: { enabled: false } })
  } finally { release() }
  await rejected
  await expect(adapter.prepare(args, store.findCredential(tool)!)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect((await request('PATCH', `/${tool}/write-access`, { enabled: true, expectedRevision: 3 })).status).toBe(200)
  expect(await adapter.prepare(args, store.findCredential(tool)!)).toMatchObject({ write: expect.any(Object) })
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(value)
})

test.each(['ldap-axi'] as const)('%s refuses write changes with the fixed read-only reason', async tool => {
  const detail = await request('GET', `/${tool}`)
  const { writeAccess } = await detail.json()
  const response = await request('PATCH', `/${tool}/write-access`, { enabled: true, expectedRevision: 1 })
  expect(response.status).toBe(400)
  expect((await response.json()).error.message).toContain(writeAccess.reason)
  expect(db.prepare("SELECT * FROM audit WHERE event = 'tool-write-access'").all()).toEqual([])
})

test.each([
  { tool: 'mg-axi', operations: ['mg.entra.group.member.add', 'entra.user.update'], settings: { preview: true } },
  { tool: 'vectra-axi', operations: ['qux.host.tag.set', 'rux.detection.note.edit'], settings: {} },
] as const)('$tool selectable writes reach the real adapter and retain other settings', async ({ tool, operations, settings }) => {
  const source = new EmbeddedSecretSource(store)
  const adapter = tool === 'mg-axi' ? createMgAdapter(source, join(directory, 'writes.log'))
    : createVectraAdapter(source, join(directory, 'writes.log'))
  await replace(tool)
  expect((await request('PATCH', `/${tool}`, { nativeSettings: settings, expectedRevision: 2 })).status).toBe(200)
  const enabled = await request('PATCH', `/${tool}/write-access`, { enabled: true, operations, expectedRevision: 3 })
  expect(enabled.status).toBe(200)
  const state = await enabled.json()
  expect(state).toMatchObject({ writeAccess: { enabled: true, allowedOperations: operations }, nativeSettings: settings })
  const prepared = await adapter.prepare(tool === 'mg-axi' ? ['entra', 'user', 'list'] : ['health', 'list'], store.findCredential(tool)!)
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium.writes).toEqual({ allowWrites: true, operations })
  const disabled = await request('PATCH', `/${tool}/write-access`, { enabled: false, expectedRevision: 4 })
  expect(disabled.status).toBe(200)
  expect((await disabled.json()).nativeSettings).toEqual({ ...settings, writes: { allowWrites: false, operations } })
  const changed = await request('PATCH', `/${tool}/write-access`, { enabled: false, operations: [operations[1]], expectedRevision: 5 })
  expect(changed.status).toBe(200)
  expect((await changed.json()).writeAccess.allowedOperations).toEqual([operations[1]])
})

test('Graph choices use native operation identities, including names that differ from command spelling', async () => {
  const response = await request('GET', '/mg-axi')
  expect((await response.json()).writeAccess.supportedOperations).toEqual([
    'entra.conditional-access.policy.update', 'entra.risky-user.dismiss', 'entra.user.revokeSessions',
    'entra.user.update', 'mg.entra.group.member.add',
  ])
})

test('Vectra choices contain implemented QUX and RUX operations without placeholder names', async () => {
  const response = await request('GET', '/vectra-axi')
  const { writeAccess } = await response.json()
  expect(writeAccess.supportedOperations).toHaveLength(30)
  expect(writeAccess.supportedOperations).toEqual(expect.arrayContaining([
    'qux.detection.tag.bulk-set', 'qux.host.assignment.unassign', 'rux.account.note.delete',
  ]))
  expect(writeAccess.supportedOperations).not.toContain('notes.set')
  expect(writeAccess.supportedOperations).not.toContain('rux.host.tag.set')
})

test.each(['mg-axi', 'vectra-axi'] as const)('%s rejects unsupported operations and enabling without a scope', async tool => {
  await failure(await request('PATCH', `/${tool}/write-access`, { enabled: true, expectedRevision: 1 }), 'INVALID_INPUT')
  await failure(await request('PATCH', `/${tool}/write-access`, {
    enabled: true, operations: ['synthetic.unsupported'], expectedRevision: 1 }), 'INVALID_INPUT')
  expect((await (await request('GET', `/${tool}`)).json()).revision).toBe(1)
  expect(db.prepare("SELECT * FROM audit WHERE event = 'tool-write-access'").all()).toEqual([])
})

test('write changes are audited without credentials or native setting values and no-ops do not emit changes', async () => {
  await replace('az-axi')
  db.exec('DELETE FROM audit')
  const response = await request('PATCH', '/az-axi/write-access', { enabled: false, expectedRevision: 2 })
  expect(response.status).toBe(200)
  const reference = store.findCredential('az-axi')
  const noOp = await request('PATCH', '/az-axi/write-access', { enabled: false, expectedRevision: 3 })
  expect(noOp.status).toBe(200)
  expect(store.findCredential('az-axi')).toEqual(reference)
  const records = db.prepare('SELECT * FROM audit').all()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ event: 'tool-write-access', tool: 'az-axi', user_id: actor,
    outcome: 'success', arguments: JSON.stringify({ enabled: false, operations: [], unsupportedOperationCount: 0 }) })
  expect(JSON.stringify(records)).not.toContain('CANARY')
  expect(JSON.stringify(records)).not.toContain('synthetic-subscription')
  await failure(await request('PATCH', '/az-axi/write-access', { enabled: true, expectedRevision: 2 }), 'REVISION_CONFLICT')
  expect((await (await request('GET', '/az-axi')).json()).writeAccess.enabled).toBe(false)
})
test('advanced settings write changes are audited while arbitrary operation names stay out of audit', async () => {
  const saved = await request('PATCH', '/mg-axi', { expectedRevision: 1,
    nativeSettings: { preview: true, writes: { allowWrites: true, operations: ['entra.user.update', 'CANARY-not-an-operation'] } } })
  expect(saved.status).toBe(200)
  const rows = db.prepare("SELECT * FROM audit WHERE event = 'tool-write-access'").all() as { arguments: string }[]
  expect(rows).toHaveLength(1)
  expect(JSON.parse(rows[0].arguments)).toEqual({ enabled: true, operations: ['entra.user.update'], unsupportedOperationCount: 1 })
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY')
  const disabled = await request('PATCH', '/mg-axi/write-access', { expectedRevision: 2, enabled: false })
  expect(disabled.status).toBe(200)
  expect((await disabled.json()).writeAccess).toMatchObject({ enabled: false, allowedOperations: ['entra.user.update', 'CANARY-not-an-operation'] })
  const cleared = await request('PATCH', '/mg-axi', { expectedRevision: 3, nativeSettings: {} })
  expect(cleared.status).toBe(200)
  expect((await cleared.json()).nativeSettings).toEqual({})
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'tool-write-access'").get()).toEqual({ count: 3 })
})

test('write updates roll back when the dedicated audit record cannot be stored', async () => {
  await replace('az-axi')
  const before = db.prepare('SELECT * FROM credentials').all()
  db.exec("CREATE TRIGGER refuse_write_audit BEFORE INSERT ON audit WHEN NEW.event = 'tool-write-access' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END")
  await failure(await request('PATCH', '/az-axi/write-access', { enabled: false, expectedRevision: 2 }), 'AUDIT_UNAVAILABLE')
  expect((await (await request('GET', '/az-axi')).json())).toMatchObject({ revision: 2,
    nativeSettings: { subscriptions: ['synthetic-subscription'], allowWrites: true }, writeAccess: { enabled: true } })
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(before)
})

test.each(['mg-axi', 'vectra-axi'] as const)('%s can clear the allow-list when disabling and audit a list-only edit', async tool => {
  const operation = tool === 'mg-axi' ? 'entra.user.update' : 'qux.host.tag.set'
  const selected = await request('PATCH', `/${tool}/write-access`, { enabled: false, operations: [operation], expectedRevision: 1 })
  expect(selected.status).toBe(200)
  expect((await selected.json()).writeAccess).toMatchObject({ enabled: false, allowedOperations: [operation] })
  const record = db.prepare("SELECT arguments FROM audit WHERE event = 'tool-write-access'").get() as { arguments: string }
  expect(JSON.parse(record.arguments)).toEqual({ enabled: false, operations: [operation], unsupportedOperationCount: 0 })
  const cleared = await request('PATCH', `/${tool}/write-access`, { enabled: false, operations: [], expectedRevision: 2 })
  expect(cleared.status).toBe(200)
  expect((await cleared.json())).toMatchObject({ nativeSettings: {}, writeAccess: { enabled: false, allowedOperations: [] } })
})

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
    { name: 'falcon-axi', version: '0.6.0', health: { status: 'unconfigured' } },
    { name: 'vectra-axi', version: '0.1.8', health: { status: 'unconfigured' } },
    { name: 'az-axi', version: '0.1.10', health: { status: 'unconfigured' } },
    { name: 'mg-axi', version: '0.1.10', health: { status: 'disabled' } },
    { name: 'ldap-axi', version: '0.3.0', health: { status: 'disabled' } },
    { name: 'ado-axi', version: '0.4.6', health: { status: 'disabled' } },
    { name: 'awx-axi', version: '0.1.8', health: { status: 'disabled' } },
    { name: 'tenable-axi', version: '0.1.0', health: { status: 'disabled' } },
  ])
  expect(read).not.toHaveBeenCalled()
  expect(network.requests).toEqual([])
  await failure(await request('POST', '', { executable: '/synthetic' }), 'NOT_FOUND')
})
test.each([
  { tool: 'az-axi', previousVersion: '0.1.7', version: '0.1.10' },
  { tool: 'mg-axi', previousVersion: '0.1.6', version: '0.1.10' },
] as const)('$tool upgrade reports the bundled version while retaining configuration', async ({ tool, previousVersion, version }) => {
  const { tenantId, clientId, auth, clientSecret } = values[tool]
  const credential = { tenantId, clientId, auth, clientSecret }
  store.replaceCredential(tool, credential, 0, actor, 123)
  db.prepare('UPDATE tools SET pinned_version = ?, revision = 3, updated_at = 123, updated_by = ? WHERE name = ?')
    .run(previousVersion, actor, tool)
  const configuration = db.prepare('SELECT * FROM tools WHERE name = ?').get(tool)
  await app.close()
  db.close()
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  store = createCredentialStore(db, provider)
  const source = new EmbeddedSecretSource(store)
  const adapter = tool === 'az-axi' ? createAzAdapter(source, join(directory, 'az-writes.log'), cache)
    : createMgAdapter(source, join(directory, 'mg-writes.log'))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {}, adapters: [adapter],
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  headers = await adminHeaders()

  const discovery = await fetch(`${url}/v1/tools`, { headers })
  expect(discovery.status).toBe(200)
  const { tools } = toolsResponseSchema.parse(await discovery.json())
  expect(tools).toEqual([{ name: tool, version, status: 'unknown', readOnly: true }])
  expect(toolView(tools[0]!)).toContain(`version: "${version}"`)
  const admin = await request('GET', '')
  expect(admin.status).toBe(200)
  expect((await admin.json() as { tools: unknown[] }).tools).toContainEqual(expect.objectContaining({ name: tool, version, revision: 3 }))
  expect(db.prepare('SELECT * FROM tools WHERE name = ?').get(tool)).toEqual(configuration)
  expect(store.readCredential(store.findCredential(tool)!)).toEqual(credential)
  expect(network.requests).toEqual([])
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
  await failure(await request('PUT', '/vectra-axi/credential', { value: { ...values['vectra-axi'], token: 'CANARY-new' }, expectedRevision: 0, expectedToolRevision: 2 }), 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})
test.each([
  { tool: 'vectra-axi', settings: { writes: values['vectra-axi'].writes }, value: { ...values['vectra-axi'], writes: undefined } },
  { tool: 'az-axi', settings: { allowWrites: true }, value: { ...values['az-axi'], subscriptions: undefined, allowWrites: undefined } },
  { tool: 'vectra-axi', settings: { writes: values['vectra-axi'].writes }, value: values['vectra-axi'] },
  { tool: 'az-axi', settings: { allowWrites: true }, value: values['az-axi'] },
] as const)('$tool unconfigured credential replacement rejects newer native settings without mutation', async ({ tool, settings, value }) => {
  const edited = await request('PATCH', `/${tool}`, { nativeSettings: settings, expectedRevision: 1 })
  expect(edited.status).toBe(200)
  const tools = db.prepare('SELECT * FROM tools').all()
  const audit = db.prepare('SELECT * FROM audit').all()
  await failure(await request('PUT', `/${tool}/credential`, { value, expectedRevision: 0, expectedToolRevision: 1 }), 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual([])
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
  expect(db.prepare('SELECT * FROM audit').all()).toEqual(audit)
})
test.each([
  { tool: 'falcon-axi', value: values['falcon-axi'] },
  { tool: 'vectra-axi', value: values['vectra-axi'] },
  { tool: 'vectra-axi', value: { ...values['vectra-axi'], writes: undefined } },
  { tool: 'az-axi', value: values['az-axi'] },
  { tool: 'az-axi', value: { ...values['az-axi'], subscriptions: undefined, allowWrites: undefined } },
] as const)('$tool configured credential replacement rejects a stale tool revision without mutation', async ({ tool, value }) => {
  await replace(tool)
  expect((await request('POST', `/${tool}/test`, {})).status).toBe(200)
  expect((await request('PATCH', `/${tool}`, { enabled: false, expectedRevision: 2 })).status).toBe(200)
  const credentials = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  const health = db.prepare('SELECT * FROM tool_health').all()
  const audit = db.prepare('SELECT * FROM audit').all()
  await failure(await request('PUT', `/${tool}/credential`, { value, expectedRevision: 1, expectedToolRevision: 2 }), 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(credentials)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual(health)
  expect(db.prepare('SELECT * FROM audit').all()).toEqual(audit)
})
test.each(['falcon-axi', 'vectra-axi', 'az-axi'] as const)('%s settings edit rejects a newer credential replacement without mutation', async tool => {
  await replace(tool)
  const credentials = db.prepare('SELECT * FROM credentials').all()
  const tools = db.prepare('SELECT * FROM tools').all()
  const audit = db.prepare('SELECT * FROM audit').all()
  await failure(await request('PATCH', `/${tool}`, { nativeSettings: {}, expectedRevision: 1 }), 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual(credentials)
  expect(db.prepare('SELECT * FROM tools').all()).toEqual(tools)
  expect(db.prepare('SELECT * FROM audit').all()).toEqual(audit)
})
test.each([
  { tool: 'vectra-axi', value: { ...values['vectra-axi'], writes: undefined } },
  { tool: 'az-axi', value: { ...values['az-axi'], subscriptions: undefined, allowWrites: undefined } },
] as const)('$tool current complete credential replacement clears omitted settings', async ({ tool, value }) => {
  await replace(tool)
  const replaced = await replace(tool, value, 1)
  expect(replaced.revision).toBe(2)
  const listed = await request('GET', '')
  const { tools } = await listed.json() as { tools: unknown[] }
  expect(tools.map(item => adminToolSchema.parse(item)).find(item => item.name === tool))
    .toMatchObject({ revision: 3, nativeSettings: {} })
})
test.each([undefined, 0, -1, 1.5, '1'])('credential replacement requires a positive integer tool revision: %s', async expectedToolRevision => {
  await failure(await request('PUT', '/falcon-axi/credential', { value: values['falcon-axi'], expectedRevision: 0, expectedToolRevision }), 'INVALID_INPUT')
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual([])
  expect(db.prepare('SELECT revision FROM tools WHERE name = ?').get('falcon-axi')).toEqual({ revision: 1 })
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
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
  const body = method === 'PUT' ? { value: { ...values['vectra-axi'], token: 'CANARY-new' }, expectedRevision: 1, expectedToolRevision: 2 }
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
  await expect(adapters[2].prepare(['account', 'list'], old)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(cache.acquire({ id: old.id, revision: old.revision!, credential: values['az-axi'] }, { required: ['arm'], optional: [] }))
    .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
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
  expect(db.prepare("SELECT event, user_id, outcome FROM audit WHERE event IN ('run-start', 'run-terminal', 'credential-test') AND user_id IS NOT NULL ORDER BY id").all()).toEqual([
    { event: 'run-start', user_id: actor, outcome: 'started' },
    { event: 'run-terminal', user_id: actor, outcome: 'completed' },
    { event: 'credential-test', user_id: actor, outcome: 'success' },
  ])
  const list = await request('GET', '')
  expect(await list.text()).not.toContain('synthetic-health-output')
  expect(db.prepare('SELECT status FROM tool_health WHERE tool = ?').get(tool)).toEqual({ status: 'ok' })
  const evidence = db.prepare(`SELECT event, checked_at, credential_revision, error_code FROM audit
    WHERE event IN ('run-start', 'run-terminal', 'credential-test') AND user_id IS NOT NULL ORDER BY id`).all()
  expect(evidence).toEqual([
    { event: 'run-start', checked_at: expect.any(Number), credential_revision: 1, error_code: null },
    { event: 'run-terminal', checked_at: health.checkedAt, credential_revision: 1, error_code: null },
    { event: 'credential-test', checked_at: health.checkedAt, credential_revision: 1, error_code: null },
  ])
  await replace(tool, values[tool], 1)
  expect(db.prepare('SELECT status, credential_revision FROM tool_health').get()).toEqual({ status: 'ok', credential_revision: 2 })
  expect(db.prepare(`SELECT event, checked_at, credential_revision, error_code FROM audit
    WHERE event IN ('run-start', 'run-terminal', 'credential-test') AND user_id IS NOT NULL ORDER BY id`).all()).toEqual(evidence)
})
test('unconfigured test admission records safe evidence without a credential revision', async () => {
  const response = await request('POST', '/falcon-axi/test', {})
  expect(response.status).toBe(errors.CREDENTIAL_NOT_CONFIGURED.status)
  expect(errorResponseSchema.parse(await response.json())).toMatchObject({ error: { code: 'CREDENTIAL_NOT_CONFIGURED',
    diagnostic: { stage: 'configuration', checkedAt: expect.any(Number), credentialRevision: null } } })
  expect(db.prepare('SELECT checked_at, credential_revision, error_code FROM audit').get())
    .toEqual({ checked_at: expect.any(Number), credential_revision: null, error_code: 'CREDENTIAL_NOT_CONFIGURED' })
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
  expect(db.prepare("SELECT outcome, duration_ms, stdout_bytes, stderr_bytes FROM audit WHERE event = 'run-terminal' AND user_id IS NOT NULL").get())
    .toEqual({ outcome: code, duration_ms: 17, stdout_bytes: 12, stderr_bytes: 34 })
})
test('credential test audit failure withholds success and rolls back cached health', async () => {
  await replace('falcon-axi')
  const health = db.prepare('SELECT * FROM tool_health').all()
  db.exec("CREATE TRIGGER fail_test BEFORE INSERT ON audit WHEN NEW.event = 'credential-test' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request('POST', '/falcon-axi/test', {}), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual(health)
})
test.each([
  { method: 'GET', path: '/unknown/credential', body: undefined, code: 'NOT_FOUND' },
  { method: 'PUT', path: '/falcon-axi/credential', body: { value: { clientSecret: 'CANARY-secret' }, expectedRevision: 0, expectedToolRevision: 1 }, code: 'INVALID_INPUT' },
  { method: 'PUT', path: '/vectra-axi/credential', body: { value: { ...values['vectra-axi'], executable: '/synthetic' }, expectedRevision: 0, expectedToolRevision: 1 }, code: 'INVALID_INPUT' },
  { method: 'POST', path: '/falcon-axi/test', body: {}, code: 'CREDENTIAL_NOT_CONFIGURED' },
] as const)('$method $path returns $code without leaking the submitted value', async route => {
  await failure(await request(route.method, route.path, route.body), route.code)
  expect(db.prepare('SELECT * FROM credentials').all()).toEqual([])
})
test('concurrent credential replacements accept one revision and return 409 for the other', async () => {
  const responses = await Promise.all([
    request('PUT', '/falcon-axi/credential', { value: values['falcon-axi'], expectedRevision: 0, expectedToolRevision: 1 }),
    request('PUT', '/falcon-axi/credential', { value: { ...values['falcon-axi'], clientSecret: 'CANARY-other' }, expectedRevision: 0, expectedToolRevision: 1 }),
  ])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})
test('Azure replacement discards an in-flight old-revision acquisition', async () => {
  db.exec("UPDATE tools SET enabled = 0 WHERE name = 'az-axi'")
  await replace('az-axi')
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'az-axi'")
  const old = store.findCredential('az-axi')!
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const posted = new Promise<void>(resolve => { started = resolve })
  const post = network.sendPostRequestAsync.bind(network)
  vi.spyOn(network, 'sendPostRequestAsync').mockImplementationOnce(async (url, options) => { started(); await held; return post(url, options) })
  const pending = adapters[2].prepare(['account', 'list'], old)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  try {
    await posted
    await replace('az-axi', { ...values['az-axi'], clientSecret: 'CANARY-new-azure' }, 1)
  } finally { release() }
  await rejected
  await adapters[2].prepare(['account', 'list'], store.findCredential('az-axi')!)
  expect(network.requests.map(entry => entry.form.get('client_secret')).sort()).toEqual(['CANARY-azure', 'CANARY-new-azure'])
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
    db.exec("UPDATE tools SET enabled = 0 WHERE name = 'falcon-axi'")
  } finally { release() }
  await failure(await pending, 'REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
})
test.each([
  { mode: 'exit', args: ['3'], code: 'TOOL_FAILED' },
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
  expect(db.prepare('SELECT status, credential_revision FROM tool_health').get()).toEqual({ status: 'ok', credential_revision: 2 })
  expect(db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE event = 'credential-test'").get()).toEqual(evidence)
})
test('test admission audit failure prevents credential preparation and child creation', async () => {
  await replace('falcon-axi')
  const health = db.prepare('SELECT * FROM tool_health').all()
  vi.mocked(adapters[0].prepare).mockClear()
  db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON audit WHEN NEW.event = 'run-start' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request('POST', '/falcon-axi/test', {}), 'AUDIT_UNAVAILABLE')
  expect(adapters[0].prepare).not.toHaveBeenCalled()
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual(health)
})
test('Graph canonical credential can be tested while disabled and enabled for audited fake reads', async () => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'mg-writes.log'), profile)
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({
    ...await prepare(args, reference, input), executable: process.execPath,
    args: [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...args],
  }))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  db.exec("UPDATE tools SET enabled = 0 WHERE name = 'mg-axi'")
  const credential = { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId,
    auth: 'client-secret', clientSecret: 'CANARY-graph-secret' }
  await replace('mg-axi', credential)
  const tested = await request('POST', '/mg-axi/test', {})
  expect(tested.status).toBe(200)
  expect(healthSchema.parse(await tested.json())).toMatchObject({ status: 'ok', credentialRevision: 1, errorCode: null })
  expect(adapter.prepare).toHaveBeenCalledWith(['entra', 'user', 'list', '--limit', '1'], store.findCredential('mg-axi'))
  expect((await request('PATCH', '/mg-axi', { enabled: true, expectedRevision: 2 })).status).toBe(200)
  const response = await fetch(`${url}/v1/tools/mg-axi/run`, { method: 'POST', headers,
    body: JSON.stringify({ args: ['entra', 'user', 'list'] }) })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic User') })
  const audit = db.prepare('SELECT event, outcome FROM audit ORDER BY id').all()
  expect(audit).toContainEqual({ event: 'credential-test', outcome: 'success' })
  expect(db.prepare("SELECT event, outcome FROM audit WHERE event = 'run-terminal' ORDER BY id").all()).toEqual([
    { event: 'run-terminal', outcome: 'completed' }, { event: 'run-terminal', outcome: 'completed' },
  ])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(credential.clientSecret)
})

test('Azure configuration can enable the runtime and test credentials', async () => {
  await replace('az-axi')
  const settings = await request('PATCH', '/az-axi', { enabled: false, nativeSettings: { allowWrites: false }, expectedRevision: 2 })
  expect(settings.status).toBe(200)
  expect(adminToolSchema.parse(await settings.json())).toMatchObject({ nativeSettings: { allowWrites: false }, health: { status: 'disabled' } })
  expect((await request('PATCH', '/az-axi', { enabled: true, expectedRevision: 3 })).status).toBe(200)
  expect((await request('POST', '/az-axi/test', {})).status).toBe(200)
  expect(db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE event = 'credential-test'").get())
    .toEqual({ checked_at: expect.any(Number), credential_revision: 2, error_code: null })
})
