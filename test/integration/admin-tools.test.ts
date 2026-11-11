import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { createTenableAdapter } from '../../src/server/adapters/tenable.js'
import { createVectraAdapter, vectraCredentialSchema } from '../../src/server/adapters/vectra.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { createGhAdapter } from '../../src/server/adapters/gh.js'
import { GithubAppTokenCache } from '../../src/server/adapters/github-app-tokens.js'
import * as credentialTls from '../../src/server/credential-tls.js'
import { generateKeyPairSync } from 'node:crypto'
import { connect as connectTls } from 'node:tls'
import { failedTlsSocket } from '../fixtures/failed-tls-socket.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import type { Adapter } from '../../src/server/adapters/types.js'
import { Audit } from '../../src/server/audit/audit.js'
import { healthDefaults, runnerLimits } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner, RunnerError } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import type { MutableCredentialStore, ToolName } from '../../src/server/store/credential-store.js'
import { checkRawApiPolicy } from '../../src/server/policy/policy.js'
import { adminCredentialSchema, adminInstanceSchema, adminRoleSchema, adminToolSchema, errorResponseSchema, healthSchema, loginResponseSchema, toolsResponseSchema } from '../../src/shared/api.js'
import { toolsView, toolView } from '../../src/cli/views.js'
import { errors, type ErrorCode } from '../../src/shared/errors.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'
import { CredentialProfile, loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { createTestCertificates } from '../fake-service/certificates.mjs'
import profileSchema from '../fixtures/axi-credential.schema.json' with { type: 'json' }
import { createSshAdapter } from '../../src/server/adapters/ssh.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { encryptCredential } from '../../src/server/store/crypto.js'

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
  'kubernetes-axi': { origin: 'https://cluster.example', auth: 'token', certificateAuthority: 'CANARY-CA-PEM', token: 'CANARY-kubernetes-token' },
  'technitium-axi': { origin: 'https://dns.example', auth: 'token', tokenKind: 'api', token: 'CANARY-technitium-token' },
  'shodan-axi': { origin: 'https://api.shodan.io', auth: 'api-key', apiKey: 'CANARY-shodan-key' },
  'gitea-axi': { origin: 'https://forge.example', tokenOrigin: 'https://forge.example', token: 'CANARY-gitea-token' },
  'unifi-axi': { origin: 'https://controller.example', apiKey: 'CANARY-unifi-key' },
  'proxmox-axi': { origin: 'https://cluster.example', auth: 'api-token', tokenId: 'reader@pve!automation', token: 'CANARY-proxmox-token' },
  'gh-axi': { origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' },
  'hybrid-axi': { apiKey: 'CANARY-hybrid-key' },
  'beyondtrust-axi': { host: 'example.pm.beyondtrustcloud.com', clientId: 'synthetic-client', clientSecret: 'CANARY-beyondtrust-secret' },
  'checkpoint-axi': { region: 'us', clientId: 'synthetic-client', clientSecret: 'CANARY-checkpoint-secret' },
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
  vi.spyOn(credentialTls, 'credentialFetch').mockRejectedValue(new Error('Unexpected synthetic network request'))
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
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

const diagnosticCases = [
  { code: 'UPSTREAM_AUTH_FAILED', stage: 'authentication', text: 'code: AUTH_FAILED\nmessage: Invalid credentials\nhint: Check the credential.' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'DNS', text: 'code: ENOTFOUND\nmessage: DNS lookup failed for synthetic.invalid' },
  { code: 'UPSTREAM_NETWORK_FAILED', stage: 'TCP', text: 'code: ECONNREFUSED\nmessage: TCP connection refused' },
  { code: 'UPSTREAM_TLS_FAILED', stage: 'TLS', text: 'code: TLS_FAILED\nmessage: TLS certificate verification failed' },
  { code: 'TOOL_REJECTED_INPUT', stage: 'configuration', text: 'code: INVALID_CONFIG\nmessage: Invalid configuration combination' },
  { code: 'TOOL_FAILED', stage: 'tool run', text: 'code: API_ERROR\nmessage: Synthetic upstream failure' },
  { code: 'UPSTREAM_RESPONSE_INVALID', stage: 'response', text: 'code: API_RESPONSE_INVALID\nmessage: Unexpected response: [REDACTED]' },
  { code: 'TOOL_REJECTED_INPUT', stage: 'configuration', text: 'code: AUTH_ENDPOINT_NOT_FOUND\nmessage: Token endpoint returned 404\nhint: Check the service host.' },
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
      expect(errorResponseSchema.parse(await tested.json())).toMatchObject({ error: { code, diagnostic: { stage, message: text,
        checkedAt: expect.any(Number), credentialRevision: 1 } } })
      const listed = await request('GET', '')
      const cached = (await listed.json()).tools.find((entry: { name: string }) => entry.name === tool)
      expect(cached.health).toMatchObject({ errorCode: code, diagnostic: { stage, message: text } })
      expect(db.prepare("SELECT outcome, error_code FROM audit WHERE event = 'credential-test' AND tool = ? ORDER BY rowid DESC LIMIT 1").get(tool))
        .toEqual({ outcome: code, error_code: code })
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
  vi.mocked(connectTls).mockImplementationOnce(() => failedTlsSocket('CERT_HAS_EXPIRED', 'CANARY-secret'))
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

test('saving empty and repeated session grants journals each change', async () => {
  const grants = [{}, { 'synthetic-user': [] }, { 'synthetic-user': ['exec'] },
    { 'synthetic-user': ['exec', 'exec'] }, { 'synthetic-user': ['exec'] }, { 'synthetic-user': [] }, {}]
  for (const [index, value] of grants.entries()) {
    expect((await request('PATCH', '/kubernetes-axi', { expectedRevision: index + 1,
      nativeSettings: { sessions: { grants: value } } })).status).toBe(200)
  }
  expect((await request('PATCH', '/kubernetes-axi', { expectedRevision: 8, nativeSettings: {} })).status).toBe(200)
  const rows = db.prepare("SELECT arguments FROM audit WHERE event = 'admin-change' ORDER BY id").all() as { arguments: string }[]
  expect(rows.map(row => JSON.parse(row.arguments))).toEqual([
    { settings: [{ path: ['sessions', 'grants'], before: null, after: {} }] },
    { settings: [{ path: ['sessions', 'grants', 'synthetic-user'], before: null, after: [] }] },
    { settings: [{ path: ['sessions', 'grants', 'synthetic-user'], added: ['exec'], removed: [] }] },
    { settings: [{ path: ['sessions', 'grants', 'synthetic-user'], added: ['exec'], removed: [] }] },
    { settings: [{ path: ['sessions', 'grants', 'synthetic-user'], added: [], removed: ['exec'] }] },
    { settings: [{ path: ['sessions', 'grants', 'synthetic-user'], added: [], removed: ['exec'] }] },
    { settings: [{ path: ['sessions', 'grants', 'synthetic-user'], before: [], after: null }] },
    { settings: [{ path: ['sessions', 'grants'], before: {}, after: null }] },
  ])
})

function grantUser(tool: string, policy: string, userId: string, operations: string[], expectedRevision: number) {
  return request('PUT', `/${tool}/user-grants`, { policy, userId, operations, expectedRevision })
}

test('per-person grants change one person at a time and journal each change', async () => {
  expect((await grantUser('kubernetes-axi', 'sessions', 'synthetic-ordinary', ['exec', 'logs', 'exec'], 1)).status).toBe(200)
  expect((await grantUser('kubernetes-axi', 'sessions', actor, ['watch'], 2)).status).toBe(200)
  expect((await grantUser('kubernetes-axi', 'sessions', 'synthetic-ordinary', ['exec'], 3)).status).toBe(200)
  const removed = await grantUser('kubernetes-axi', 'sessions', 'synthetic-ordinary', [], 4)
  expect(removed.status).toBe(200)
  expect(await removed.json()).toMatchObject({ revision: 5, nativeSettings: { sessions: { grants: { [actor]: ['watch'] } } } })
  const rows = db.prepare("SELECT action, arguments FROM audit WHERE event = 'admin-change' ORDER BY id").all() as { action: string, arguments: string }[]
  expect(rows.map(row => [row.action, JSON.parse(row.arguments)])).toEqual([
    ['update-tool-user-grants', { settings: [{ path: ['sessions', 'grants', 'synthetic-ordinary'], added: ['logs', 'exec'], removed: [] }] }],
    ['update-tool-user-grants', { settings: [{ path: ['sessions', 'grants', actor], added: ['watch'], removed: [] }] }],
    ['update-tool-user-grants', { settings: [{ path: ['sessions', 'grants', 'synthetic-ordinary'], added: [], removed: ['logs'] }] }],
    ['update-tool-user-grants', { settings: [{ path: ['sessions', 'grants', 'synthetic-ordinary'], added: [], removed: ['exec'] }] }],
  ])
})

test('per-person Shodan grants keep ceilings and journal writes and exports', async () => {
  const ceilings = { maxQueryCredits: 5, maxRequests: 6 }
  const exportCeilings = { ...ceilings, maxRecords: 7, maxBytes: 8, retentionSeconds: 9 }
  expect((await request('PATCH', '/shodan-axi', { expectedRevision: 1, nativeSettings: {
    writes: { grants: {}, ...ceilings }, exports: { grants: {}, ...exportCeilings } } })).status).toBe(200)
  db.exec('DELETE FROM audit')
  expect((await grantUser('shodan-axi', 'writes', 'synthetic-ordinary', ['OP-021', 'OP-070'], 2)).status).toBe(200)
  const granted = await grantUser('shodan-axi', 'exports', 'synthetic-ordinary', ['CLI-005'], 3)
  expect(granted.status).toBe(200)
  expect(await granted.json()).toMatchObject({ nativeSettings: {
    writes: { grants: { 'synthetic-ordinary': ['OP-021', 'OP-070'] }, ...ceilings },
    exports: { grants: { 'synthetic-ordinary': ['CLI-005'] }, ...exportCeilings } } })
  const rows = db.prepare("SELECT arguments FROM audit WHERE event = 'admin-change' ORDER BY id").all() as { arguments: string }[]
  expect(rows.map(row => JSON.parse(row.arguments))).toEqual([
    { settings: [{ path: ['writes', 'grants', 'synthetic-ordinary'], added: ['OP-021', 'OP-070'], removed: [] }] },
    { settings: [{ path: ['exports', 'grants', 'synthetic-ordinary'], added: ['CLI-005'], removed: [] }] },
  ])
})

test('a stale grant for a person who no longer exists can be removed but not added', async () => {
  expect((await request('PATCH', '/kubernetes-axi', { expectedRevision: 1,
    nativeSettings: { sessions: { grants: { 'departed-user': ['exec'] } } } })).status).toBe(200)
  await failure(await grantUser('kubernetes-axi', 'sessions', 'departed-user', ['logs'], 2), 'INVALID_INPUT')
  const removed = await grantUser('kubernetes-axi', 'sessions', 'departed-user', [], 2)
  expect(removed.status).toBe(200)
  expect(await removed.json()).toMatchObject({ nativeSettings: { sessions: { grants: {} } } })
})

test.each([
  { name: 'an operation outside the catalogue', tool: 'kubernetes-axi', policy: 'sessions', userId: 'synthetic-ordinary', operations: ['sudo'], code: 'INVALID_INPUT' },
  { name: 'a Shodan policy without saved ceilings', tool: 'shodan-axi', policy: 'scans', userId: 'synthetic-ordinary', operations: ['OP-009'], code: 'INVALID_INPUT' },
  { name: 'a policy the tool does not have', tool: 'kubernetes-axi', policy: 'exports', userId: 'synthetic-ordinary', operations: [], code: 'INVALID_INPUT' },
  { name: 'a tool without per-person grants', tool: 'falcon-axi', policy: 'sessions', userId: 'synthetic-ordinary', operations: [], code: 'INVALID_INPUT' },
  { name: 'an unknown person', tool: 'kubernetes-axi', policy: 'sessions', userId: 'unknown-user', operations: ['exec'], code: 'INVALID_INPUT' },
  { name: 'a stale revision', tool: 'kubernetes-axi', policy: 'sessions', userId: 'synthetic-ordinary', operations: ['exec'], code: 'REVISION_CONFLICT', staleBy: 8 },
] as const)('per-person grants reject $name without changing settings', async ({ tool, policy, userId, operations, code, ...rest }) => {
  const before = await (await request('GET', `/${tool}`)).json() as { revision: number }
  await failure(await grantUser(tool, policy, userId, [...operations], before.revision + ((rest as { staleBy?: number }).staleBy ?? 0)), code)
  expect(await (await request('GET', `/${tool}`)).json()).toEqual(before)
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 0 })
})

test.each([
  { tool: 'kubernetes-axi', initial: { sessions: { grants: { 'synthetic-user': ['exec'] } } },
    next: { sessions: { grants: { 'synthetic-user': ['logs'] } } },
    changes: [{ path: ['sessions', 'grants', 'synthetic-user'], added: ['logs'], removed: ['exec'] }] },
  { tool: 'shodan-axi', initial: { scans: { grants: { 'synthetic-user': ['OP-009'] }, maxScanCredits: 10, maxRequests: 10 },
    sessions: { grants: { 'synthetic-user': ['OP-046'] }, perUser: 1, perCredential: 1, total: 1, sessionEvents: 1, totalEvents: 1,
      sessionBytes: 1, totalBytes: 1, retentionSeconds: 1, leaseSeconds: 1 },
    writes: { grants: { 'synthetic-user': ['OP-013'] }, maxQueryCredits: 1, maxRequests: 1 } },
    next: { scans: { grants: { 'synthetic-user': ['OP-010'] }, maxScanCredits: 10, maxRequests: 10 },
      sessions: { grants: { 'synthetic-user': ['OP-047'] }, perUser: 1, perCredential: 1, total: 1, sessionEvents: 1, totalEvents: 1,
        sessionBytes: 1, totalBytes: 1, retentionSeconds: 1, leaseSeconds: 1 },
      writes: { grants: { 'synthetic-user': ['OP-013'] }, maxQueryCredits: 1, maxRequests: 1 } },
    changes: [{ path: ['scans', 'grants', 'synthetic-user'], added: ['OP-010'], removed: ['OP-009'] },
      { path: ['sessions', 'grants', 'synthetic-user'], added: ['OP-047'], removed: ['OP-046'] }] },
] as const)('$tool credential replacement journals scoped settings changes', async ({ tool, initial, next, changes }) => {
  expect((await request('PATCH', `/${tool}`, { expectedRevision: 1, nativeSettings: initial })).status).toBe(200)
  db.exec('DELETE FROM audit')
  await replace(tool, { ...values[tool], ...next })
  const row = db.prepare("SELECT arguments FROM audit WHERE event = 'admin-change'").get() as { arguments: string }
  expect(JSON.parse(row.arguments)).toEqual({ settings: changes })
})

test('unrelated native settings are excluded from settings diffs', async () => {
  expect((await request('PATCH', '/az-axi', { expectedRevision: 1, nativeSettings: { description: 'synthetic' } })).status).toBe(200)
  const row = db.prepare("SELECT arguments FROM audit WHERE event = 'admin-change'").get() as { arguments: string | null }
  expect(row.arguments).toBeNull()
})

test.each([
  { tool: 'kubernetes-axi', initial: { sessions: { grants: { 'synthetic-user': ['exec'] }, lifetimeSeconds: 1 } },
    limits: { sessions: { grants: { 'synthetic-user': ['exec'] }, lifetimeSeconds: 2 } },
    changed: { sessions: { grants: { 'synthetic-user': ['logs'] }, lifetimeSeconds: 2 } },
    changes: [{ path: ['sessions', 'grants', 'synthetic-user'], added: ['logs'], removed: ['exec'] }] },
  { tool: 'shodan-axi', initial: { scans: { grants: { 'synthetic-user': ['OP-009'] }, maxScanCredits: 1, maxRequests: 1 },
    sessions: { grants: { 'synthetic-user': ['OP-046'] }, perUser: 1, perCredential: 1, total: 1, sessionEvents: 1, totalEvents: 1,
      sessionBytes: 1, totalBytes: 1, retentionSeconds: 1, leaseSeconds: 1 } },
    limits: { scans: { grants: { 'synthetic-user': ['OP-009'] }, maxScanCredits: 2, maxRequests: 2 },
      sessions: { grants: { 'synthetic-user': ['OP-046'] }, perUser: 2, perCredential: 2, total: 2, sessionEvents: 2, totalEvents: 2,
        sessionBytes: 2, totalBytes: 2, retentionSeconds: 2, leaseSeconds: 2 } },
    changed: { scans: { grants: { 'synthetic-user': ['OP-010'] }, maxScanCredits: 2, maxRequests: 2 },
      sessions: { grants: { 'synthetic-user': ['OP-047'] }, perUser: 2, perCredential: 2, total: 2, sessionEvents: 2, totalEvents: 2,
        sessionBytes: 2, totalBytes: 2, retentionSeconds: 2, leaseSeconds: 2 } },
    changes: [{ path: ['scans', 'grants', 'synthetic-user'], added: ['OP-010'], removed: ['OP-009'] },
      { path: ['sessions', 'grants', 'synthetic-user'], added: ['OP-047'], removed: ['OP-046'] }] },
] as const)('$tool policy limits do not appear in grant diffs', async ({ tool, initial, limits, changed, changes }) => {
  expect((await request('PATCH', `/${tool}`, { expectedRevision: 1, nativeSettings: initial })).status).toBe(200)
  db.exec('DELETE FROM audit')
  await replace(tool, { ...values[tool], ...limits })
  expect((await request('PATCH', `/${tool}`, { expectedRevision: 3, nativeSettings: changed })).status).toBe(200)
  const rows = db.prepare("SELECT arguments FROM audit WHERE event = 'admin-change' ORDER BY id").all() as { arguments: string | null }[]
  expect(rows.map(row => row.arguments && JSON.parse(row.arguments))).toEqual([null, { settings: changes }])
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

test('Proxmox offers independent exact native and host write grants off by default', async () => {
  const list = await (await request('GET', '')).json() as { tools: unknown[] }
  const tool = list.tools.map(item => adminToolSchema.parse(item)).find(item => item.name === 'proxmox-axi')!
  expect(tool.writeAccess).toMatchObject({ capable: true, enabled: false, allowedOperations: [] })
  expect(tool.writeAccess.supportedOperations).toContain('OP-POST-f879c7c9f8')
  const saved = await request('PATCH', '/proxmox-axi/write-access', { enabled: true,
    operations: ['OP-POST-f879c7c9f8'], expectedRevision: tool.revision })
  expect(saved.status).toBe(200)
  expect(adminToolSchema.parse(await saved.json())).toMatchObject({ readOnly: false,
    nativeSettings: { hostWrites: { allowWrites: true, operations: ['OP-POST-f879c7c9f8'] } } })
})

test('UniFi offers exact native write grants with execution off by default', async () => {
  const list = await (await request('GET', '')).json() as { tools: unknown[] }
  const tool = list.tools.map(item => adminToolSchema.parse(item)).find(item => item.name === 'unifi-axi')!
  expect(tool.writeAccess).toMatchObject({ capable: true, enabled: false, allowedOperations: [] })
  expect(tool.writeAccess.supportedOperations).toEqual(expect.arrayContaining(['createNetwork', 'createNetwork:UNMANAGED']))
  const saved = await request('PATCH', '/unifi-axi/write-access', { enabled: true,
    operations: ['createNetwork', 'createNetwork:UNMANAGED'], expectedRevision: tool.revision })
  expect(saved.status).toBe(200)
  expect(adminToolSchema.parse(await saved.json())).toMatchObject({ readOnly: false,
    nativeSettings: { writes: { allowWrites: true, operations: ['createNetwork', 'createNetwork:UNMANAGED'] } } })
})

test('Falcon discovery and health report the preserved legacy RTR grant', async () => {
  await replace('falcon-axi', { ...values['falcon-axi'], allowWrites: true })
  const tested = await request('POST', '/falcon-axi/test', {})
  expect(tested.status).toBe(200)
  expect(healthSchema.parse(await tested.json())).toMatchObject({ status: 'ok', readOnly: false })
  const admin = (await (await request('GET', '')).json() as { tools: unknown[] }).tools
    .map(tool => adminToolSchema.parse(tool)).find(tool => tool.name === 'falcon-axi')!
  expect(admin).toMatchObject({ nativeSettings: { allowWrites: true }, readOnly: false,
    health: { status: 'ok', readOnly: false }, writeAccess: { enabled: true, allowedOperations: ['rtr run'] } })
  const discovery = await fetch(`${url}/v1/tools`, { headers })
  expect(discovery.status).toBe(200)
  const tool = toolsResponseSchema.parse(await discovery.json()).tools.find(tool => tool.name === 'falcon-axi')!
  expect(tool).toMatchObject({ status: 'ok', readOnly: false })
  expect(toolView(tool)).toContain('readOnly: false\n')
  expect(toolsView([tool])).toContain('falcon-axi,ok,"1.0.1",false,1\n')
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const page = await app.inject({ method: 'GET', url: '/admin/tools/falcon-axi?tab=writes',
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('exact --execute/--confirm')
})

test('Kubernetes Advanced guidance describes admitted workflows and remaining exclusions', async () => {
  // Regression T1: the rendered guidance incorrectly excluded admitted byte sessions and workspaces.
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const page = await app.inject({ method: 'GET', url: '/admin/tools/kubernetes-axi?tab=advanced',
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('Caller-owned workspaces support file inputs.')
  expect(page.body).toContain('Bounded watch, logs, exec, attach, apply, create, cp and port-forward sessions require explicit per-user sessions.grants; no sessions are granted by default.')
  expect(page.body).toContain('Mutating sessions additionally require Allow writes and native exact-digest confirmation; watch and logs remain reads.')
  expect(page.body).toContain('Port forwarding uses authenticated tunnels with loopback-only client listeners.')
  expect(page.body).toContain('Service-account token issuance additionally requires {&quot;acquireCredential&quot;: true}; tokens are delivered once through credential --credential-fd to a private pipe.')
  expect(page.body).toContain('Interactive/editor/helper execution remains unavailable.')
  expect(page.body).not.toContain('File inputs, execution, credential issuance and streaming sessions remain unavailable.')
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
  { enabledPacks: ['security'] }, { enabledPacks: ['entra', 'unknown'] },
])('mg-axi rejects invalid pack selections without saving a credential: $enabledPacks', async ({ enabledPacks }) => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const value = { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId,
    auth: 'client-secret', clientSecret: 'CANARY-graph-secret', enabledPacks }
  await failure(await request('PUT', '/mg-axi/credential', { value, expectedRevision: 0, expectedToolRevision: 1 }), 'INVALID_INPUT')
  expect(store.findCredential('mg-axi')).toBeUndefined()
})

test.each([
  ['entra', 'security'], ['entra', 'mail'], ['entra', 'security', 'mail'],
])('mg-axi administrator can opt into packs %j and clear the opt-in', async (...enabledPacks) => {
  const enabled = await request('PATCH', '/mg-axi', { nativeSettings: { enabledPacks }, expectedRevision: 1 })
  expect(enabled.status).toBe(200)
  expect(await enabled.json()).toMatchObject({ nativeSettings: { enabledPacks }, readOnly: true })
  expect(store.readToolSettings!('mg-axi')).toEqual({ enabledPacks })
  const cleared = await request('PATCH', '/mg-axi', { nativeSettings: {}, expectedRevision: 2 })
  expect(cleared.status).toBe(200)
  expect(store.readToolSettings!('mg-axi')).toEqual({})
  expect(db.prepare("SELECT action FROM audit WHERE event = 'admin-change'").all())
    .toEqual([{ action: 'update-tool' }, { action: 'update-tool' }])
})

test.each([
  { mode: 'delegated', auth: undefined, token: 'CANARY-msal-cache', clientSecret: undefined,
    status: errors.INVALID_INPUT.status, revision: undefined },
  { mode: 'application', auth: 'client-secret', token: undefined, clientSecret: 'CANARY-graph-secret',
    status: 200, revision: 1 },
])('mg-axi saving $mode credentials with mail enabled returns $status', async ({ mode, auth, token, clientSecret, status, revision }) => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  vi.spyOn(adapter, 'prepare').mockRejectedValue(new Error('Synthetic credential check unavailable'))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  expect((await request('PATCH', '/mg-axi', { nativeSettings: { enabledPacks: ['entra', 'mail'] }, expectedRevision: 1 })).status).toBe(200)
  const response = await request('PATCH', '/mg-axi/credential', { value: {
    mode, auth, token, clientSecret, tenantId: azureTestTenant, clientId: values['mg-axi'].clientId,
  }, expectedRevision: 0, expectedToolRevision: 2 })
  expect(response.status).toBe(status)
  expect(store.findCredential('mg-axi')?.revision).toBe(revision)
  expect(store.readToolSettings!('mg-axi')).toEqual({ enabledPacks: ['entra', 'mail'] })
})

test('mg-axi refuses enabling mail for an existing delegated credential', async () => {
  await app.close()
  runner = await Runner.create(join(directory, 'calls'))
  const profile = loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'), profile)
  const prepare = vi.spyOn(adapter, 'prepare').mockRejectedValue(new Error('Unexpected credential execution'))
  store.replaceCredential('mg-axi', { mode: 'delegated', tenantId: azureTestTenant,
    clientId: values['mg-axi'].clientId, token: 'CANARY-msal-cache' }, 0, actor, 123)
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  await failure(await request('PATCH', '/mg-axi', {
    nativeSettings: { enabledPacks: ['entra', 'mail'] }, expectedRevision: 1,
  }), 'INVALID_INPUT')
  expect(store.readToolSettings!('mg-axi')).toEqual({})
  expect(store.findCredential('mg-axi')!.revision).toBe(1)
  expect(prepare).not.toHaveBeenCalled()
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
  { tool: 'mg-axi', value: { mode: 'application', tenantId: azureTestTenant, clientId: values['mg-axi'].clientId,
    auth: 'client-secret', clientSecret: 'CANARY-graph-secret', enabledPacks: ['security'] } },
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
  const page = await app.inject({ method: 'GET', url: '/admin/tools/mg-axi/instances/default',
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).not.toContain('CANARY-')
  expect(page.body).toContain('action="/v1/admin/tools/mg-axi/instances/default/credential"')
  const replacement = { mode: 'application', tenantId: value.tenantId, clientId: value.clientId,
    auth: 'client-secret', clientSecret: 'CANARY-replacement' }
  expect(await replace('mg-axi', replacement, 1)).toMatchObject({ revision: 2,
    metadata: { mode: 'application', tenantId: value.tenantId, clientId: value.clientId, auth: 'client-secret' } })
  expect(store.readCredential(store.findCredential('mg-axi')!)).toEqual(replacement)
  expect((await adapter.prepare(['entra', 'user', 'list'], store.findCredential('mg-axi')!)).secrets)
    .toEqual([replacement.clientSecret])
})

test.each([
  { tool: 'checkpoint-axi', help: 'Required region code for your tenant&#39;s regional gateway: us, eu, ca, au, uk, uae or in. Obtain it from your tenant administrator. There is no default; URLs are not accepted.', otherHelp: 'Falcon API region, for example us-1.' },
  { tool: 'falcon-axi', help: 'Falcon API region, for example us-1.', otherHelp: 'Required region code for your tenant' },
])('$tool credential page displays provider-specific region guidance', async ({ tool, help, otherHelp }) => {
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  const page = await app.inject({ method: 'GET', url: `/admin/tools/${tool}`,
    headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain(`${help}</p>`)
  expect(page.body).not.toContain(otherHelp)
  if (tool === 'checkpoint-axi') {
    const saas = /<div data-credential-field="saas">(.*?)<\/div>/s.exec(page.body)![1]!
    expect(saas).toContain('One non-blank SaaS application name for the tenant, not a gateway, host or authentication URL;')
    expect(saas).toContain(' Default: office365_emails.</p>')
    const downloads = /<div data-credential-field="downloads">(.*?)<\/div>/s.exec(page.body)![1]!
    expect(downloads).toContain('Artium manages download permissions. This value does not enable downloads. Use artium-axi download with Allow writes on and the exact download operation selected. Default: {&quot;allow&quot;:false}.</p>')
  }
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
  for (const path of ['/admin', '/admin/tools', '/admin/tools/az-axi', '/admin/tools/az-axi/instances/default', '/admin/tools/mg-axi', '/admin/tools/vectra-axi', '/admin/tools/vectra-axi?tab=writes', '/admin/roles']) {
    const page = await app.inject({ method: 'GET', url: path, headers: { cookie } })
    expect(page.statusCode).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.body).not.toContain(values['falcon-axi'].clientId)
    expect(page.body).not.toContain(values['falcon-axi'].clientSecret)
    expect(page.body).not.toContain(values['vectra-axi'].token)
    expect(page.body).not.toContain(values['az-axi'].clientSecret)
    if (path === '/admin/tools/vectra-axi?tab=writes') {
      expect(page.body).toContain('host/account close closes all active detections with no single inverse')
      expect(page.body).toContain('group delete orphans triage rule references')
      expect(page.body).toContain('syslog/Kafka redirects detection export (data egress)')
      expect(page.body).toContain('Match enablement changes cause a reboot')
    }
    if (path === '/admin/tools/az-axi/instances/default') {
      expect(page.body).toContain('data-test-tool="az-axi" action="/v1/admin/tools/az-axi/instances/default/test"')
      expect(page.body).toContain('data-profile-field="tenantId"')
      expect(page.body.match(/name="expectedToolRevision" data-type="number" value="2"/g)).toHaveLength(1)
      expect(page.body).toContain('Last changed by synthetic-user')
    }
    if (path === '/admin/tools/az-axi') {
      const forms = page.body.match(/<form\b[^>]*action="\/v1\/admin\/tools\/az-axi"[^>]*>[\s\S]*?<\/form>/g)!
      expect(forms).toEqual(expect.arrayContaining([expect.stringContaining(
        `<input type="hidden" name="enabled" data-type="boolean" value="${!enabled}"><button class="toggle" role="switch" aria-checked="${enabled}">`)]))
    }
    if (path === '/admin/tools/mg-axi') {
      const graphForms = page.body.match(/<form\b[^>]*action="\/v1\/admin\/tools\/mg-axi"[^>]*>[\s\S]*?<\/form>/g)!
      expect(graphForms).toEqual(expect.arrayContaining([expect.stringContaining(
        `<input type="hidden" name="enabled" data-type="boolean" value="${!enabled}"><button class="toggle" role="switch" aria-checked="${enabled}">`)]))
    }
  }
})
test('the tools list and Instances tab report every instance, with SSH hosts shown as instances', async () => {
  for (const name of ['lab', 'production']) {
    store.createInstance('falcon-axi', { name, description: `Synthetic ${name} tenant.` }, values['falcon-axi'], actor, Date.now())
  }
  db.prepare(`INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses, enabled)
    VALUES ('synthetic-host', 'host.example', 22, '[]', '[]', 1)`).run()
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  const cookie = login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  const list = (await app.inject({ method: 'GET', url: '/admin/tools', headers: { cookie } })).body
  const row = (body: string, tool: string) => new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*href="/admin/tools/${tool}"[\\s\\S]*?</tr>`).exec(body)![0]
  expect(row(list, 'falcon-axi')).toContain('2 instances')
  expect(row(list, 'ssh-axi')).toContain('1 host<')
  expect(row(list, 'vectra-axi')).toContain('0 instances')

  const tab = (await app.inject({ method: 'GET', url: '/admin/tools/falcon-axi', headers: { cookie } })).body
  expect(tab).toContain('href="/admin/tools/falcon-axi/instances/production"')
  expect(tab).toContain('Synthetic lab tenant.')
  expect(tab).toContain('action="/v1/admin/tools/falcon-axi/instances/lab/test"')
  expect(tab).toContain('action="/v1/admin/tools/falcon-axi/instances"')
  expect(tab).toContain('data-confirm-name="production"')
  expect(tab).not.toContain('CANARY-')

  const detail = (await app.inject({ method: 'GET', url: '/admin/tools/falcon-axi/instances/production', headers: { cookie } })).body
  expect(detail).toContain('<h1>production</h1>')
  expect(detail).toContain('Synthetic production tenant.')
  expect(detail).toContain('action="/v1/admin/tools/falcon-axi/instances/production/credential"')
  expect(detail).toContain('Danger zone')
  expect(detail).toContain('data-success-url="/admin/tools/falcon-axi"')
  expect(detail).not.toContain('CANARY-')

  const ssh = (await app.inject({ method: 'GET', url: '/admin/tools/ssh-axi', headers: { cookie } })).body
  expect(ssh).toContain('host.example:22')
  expect(ssh).toContain('href="/admin/ssh"')
  expect(ssh).not.toContain('action="/v1/admin/tools/ssh-axi/instances"')

  expect((await app.inject({ method: 'GET', url: '/admin/tools/falcon-axi/instances/missing', headers: { cookie } })).statusCode).toBe(404)
})
async function replace(tool: Exclude<ToolName, 'ssh-axi'>, value: unknown = values[tool], expectedRevision = 0) {
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

test.each([
  { name: 'ordinary binding and shell grant', enabled: 1, sudo: 0, shell: 1, configured: true, status: 'unknown' },
  { name: 'disabled host', enabled: 0, sudo: 0, shell: 1, configured: false, status: 'unconfigured' },
  { name: 'sudo-only binding', enabled: 1, sudo: 1, shell: 1, configured: false, status: 'unconfigured' },
  { name: 'missing shell grant', enabled: 1, sudo: 0, shell: 0, configured: true, status: 'unconfigured' },
])('SSH catalogue recognizes dedicated configuration for $name without claiming authentication', async ({ enabled, sudo, shell, configured, status }) => {
  adapters.push(createSshAdapter(new SshHosts(db, provider), join(directory, 'ssh-writes.log')))
  const plaintext = Buffer.from(JSON.stringify({ privateKey: 'CANARY-ssh-key' }))
  const encrypted = encryptCredential('synthetic-ssh-key', 'ssh-axi', plaintext, provider.getKey())
  plaintext.fill(0)
  db.prepare(`INSERT INTO ssh_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, updated_at)
    VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, 1)`).run(encrypted)
  db.prepare(`INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses, enabled)
    VALUES ('synthetic-host', '127.0.0.1', 22, '["ssh-ed25519 YWJj"]', '["127.0.0.1"]', ?)`).run(enabled)
  db.prepare(`INSERT INTO ssh_bindings (host_id, username, credential_id, sudo)
    VALUES ('synthetic-host', 'ordinary', 'synthetic-ssh-key', ?)`).run(sudo)
  db.prepare(`INSERT INTO ssh_grants (user_id, host_id, shell)
    VALUES ('synthetic-development-user', 'synthetic-host', ?)`).run(shell)

  const discovery = toolsResponseSchema.parse(await (await fetch(`${url}/v1/tools`, { headers })).json())
  expect(discovery.tools.find(tool => tool.name === 'ssh-axi')).toEqual({ name: 'ssh-axi', version: '0.1.2', readOnly: true, status, instances: [] })
  expect(adminCredentialSchema.parse(await (await request('GET', '/ssh-axi/credential')).json())).toEqual({
    tool: 'ssh-axi', configured, revision: 0, updatedAt: null, updatedBy: null, metadata: {},
  })
  expect(adminToolSchema.parse(await (await request('GET', '/ssh-axi')).json()).health).toEqual({
    status: configured ? 'unknown' : 'unconfigured', checkedAt: null, credentialRevision: null, errorCode: null, readOnly: true,
  })
  await failure(await request('POST', '/ssh-axi/test', {}), 'INVALID_INPUT')

  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  const cookie = login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  const page = await app.inject({ method: 'GET', url: '/admin/tools/ssh-axi', headers: { cookie } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain(configured ? 'Check per host' : 'Needs credential')
  expect(page.body).toContain('Check authentication per host')
  expect(page.body).not.toContain('Test passes')
  expect(page.body).not.toContain('Credential saved')
})

test('SSH write settings cannot create a generic credential or dedicated identity', async () => {
  for (const method of ['PUT', 'PATCH'] as const) {
    await failure(await request(method, '/ssh-axi/credential', { expectedRevision: 0, expectedToolRevision: 1,
      value: { privateKey: 'CANARY-not-a-tenant-credential' } }), 'INVALID_INPUT')
  }
  const settings = await request('PATCH', '/ssh-axi', { expectedRevision: 1, nativeSettings: { allowWrites: true } })
  expect(settings.status).toBe(200)
  expect((await settings.json()).writeAccess.enabled).toBe(true)
  expect(store.findCredential('ssh-axi')).toBeUndefined()
  expect(db.prepare('SELECT * FROM ssh_credentials').all()).toEqual([])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-not-a-tenant-credential')
})

test('Proxmox administrator stores one password credential without exposing its secret', async () => {
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('proxmox-axi')
  const credential = { origin: 'https://cluster.example', auth: 'password', userId: 'automation@pve', password: 'CANARY-proxmox-password' }
  const response = await replace('proxmox-axi', credential)
  expect(JSON.stringify(response)).not.toContain(credential.password)
  expect(store.readCredential(store.findCredential('proxmox-axi')!)).toEqual(credential)
  const { password: _password, ...identity } = credential
  expect((await save('proxmox-axi', identity, 1)).status).toBe(200)
  await failure(await save('proxmox-axi', { ...identity, userId: 'different@pve' }, 2), 'INVALID_INPUT')
  expect(store.readCredential(store.findCredential('proxmox-axi')!)).toEqual(credential)
})

test('Proxmox token identity changes require a replacement secret', async () => {
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('proxmox-axi')
  await replace('proxmox-axi')
  const { token: _token, ...identity } = values['proxmox-axi']
  expect((await save('proxmox-axi', identity, 1)).status).toBe(200)
  await failure(await save('proxmox-axi', { ...identity, tokenId: 'other@pve!automation' }, 2), 'INVALID_INPUT')
  expect(store.readCredential(store.findCredential('proxmox-axi')!)).toEqual(values['proxmox-axi'])
})

test('Kubernetes client certificate replacement requires a new private key', async () => {
  const credential = { origin: 'https://cluster.example', auth: 'certificate', certificateAuthority: 'CANARY-CA-PEM',
    clientCertificate: 'CANARY-original-certificate', privateKey: 'CANARY-original-key' }
  const previous = await replace('kubernetes-axi', credential)
  const response = await save('kubernetes-axi', { origin: credential.origin, auth: credential.auth,
    certificateAuthority: credential.certificateAuthority, clientCertificate: 'CANARY-replacement-certificate' }, previous.revision)
  expect(response.status).toBe(400)
  expect(store.readCredential(store.findCredential('kubernetes-axi')!)).toEqual(credential)
  const current = await request('GET', '/kubernetes-axi/credential')
  expect(JSON.stringify(await current.json())).not.toContain(credential.privateKey)
})

test('Technitium token-kind changes require a replacement secret', async () => {
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('technitium-axi')
  await replace('technitium-axi')
  const { token: _token, ...identity } = values['technitium-axi']
  expect((await save('technitium-axi', identity, 1)).status).toBe(200)
  await failure(await save('technitium-axi', { ...identity, tokenKind: 'session' }, 2), 'INVALID_INPUT')
  expect(store.readCredential(store.findCredential('technitium-axi')!)).toEqual(values['technitium-axi'])
})

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
  expect(db.prepare("SELECT instance, credential_id FROM audit WHERE action = 'replace-credential'").all())
    .toEqual([{ instance: 'default', credential_id: store.findCredential('az-axi')!.id }])
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

test('GitHub PAT save, rotation and health use private shared credentials and refuse write settings', async () => {
  db.exec("UPDATE tools SET enabled = 0 WHERE name = 'gh-axi'")
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  const calls = vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => {
    const call = await prepare(args, reference, input)
    return { ...call, executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'remaining: 4999'] }
  })
  adapters.push(adapter)
  const saved = await replace('gh-axi')
  expect(saved).toMatchObject({ metadata: { origin: 'https://github.com', auth: 'token' } })
  expect(JSON.stringify(saved)).not.toContain(values['gh-axi'].token)
  expect(JSON.stringify(db.prepare('SELECT * FROM credentials WHERE tool = ?').get('gh-axi'))).not.toContain(values['gh-axi'].token)
  const response = await request('POST', '/gh-axi/test', {})
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'ok', readOnly: true })
  expect(calls).toHaveBeenCalledWith(['api', '/rate_limit'], expect.objectContaining({ tool: 'gh-axi' }))
  const rotated = await save('gh-axi', { ...values['gh-axi'], token: 'github_pat_CANARY-rotated' }, 1)
  expect(rotated.status).toBe(200)
  expect(store.readCredential(store.findCredential('gh-axi')!)).toEqual({ ...values['gh-axi'], token: 'github_pat_CANARY-rotated' })
  const detail = await (await request('GET', '/gh-axi')).json()
  await failure(await request('PATCH', '/gh-axi/write-access', { enabled: true, expectedRevision: detail.revision }), 'INVALID_INPUT')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toMatch(/CANARY-github-token|github_pat_CANARY-rotated/)
})

test('GitHub App save encrypts the key, rotates tokens and requires a key for a new installation', async () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const value = { origin: 'https://github.com', auth: 'github-app', appId: '123', installationId: '456', privateKey,
    repositories: ['canary'], permissions: { contents: 'read' } }
  const mint = vi.fn(async () => new Response(JSON.stringify({ token: 'CANARY-app-installation',
    expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 }))
  const adapter = createGhAdapter(new EmbeddedSecretSource(store), new GithubAppTokenCache(mint))
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => {
    const call = await prepare(args, reference, input)
    return { ...call, executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'remaining: 4999'] }
  })
  adapters.push(adapter)
  const saved = await replace('gh-axi', value)
  const { privateKey: _key, ...metadata } = value
  expect(saved.metadata).toEqual(metadata)
  expect(JSON.stringify(db.prepare('SELECT * FROM credentials WHERE tool = ?').get('gh-axi'))).not.toContain('PRIVATE KEY')
  const old = store.findCredential('gh-axi')!
  await adapter.prepare(['api', '/rate_limit'], old)
  expect(mint).toHaveBeenCalledTimes(1)
  expect((await save('gh-axi', metadata, 1)).status).toBe(200)
  expect(store.readCredential(store.findCredential('gh-axi')!)).toEqual(value)
  await expect(adapter.prepare(['api', '/rate_limit'], old)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(mint).toHaveBeenCalledTimes(2)
  await failure(await save('gh-axi', { ...metadata, installationId: '789' }, 2), 'INVALID_INPUT')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toMatch(/PRIVATE KEY|CANARY-app-installation/)
})

function fakeGithubDevice() {
  return vi.mocked(credentialTls.credentialFetch).mockResolvedValueOnce(new Response(JSON.stringify({
    device_code: 'CANARY-private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
  }))).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'gho_CANARY-connected-token', token_type: 'bearer' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'synthetic-machine' })))
}

async function startGithubDevice(expectedRevision = 0) {
  const detail = await (await request('GET', '/gh-axi')).json()
  const response = await request('POST', '/gh-axi/device', { origin: 'https://github.com', expectedRevision, expectedToolRevision: detail.revision })
  expect(response.status).toBe(200)
  const { connectionId } = await response.json() as { connectionId: string }
  return { connectionId }
}

test('GitHub credential HTTP is denied by the fake installed before application creation', async () => {
  const detail = await (await request('GET', '/gh-axi')).json()
  await failure(await request('POST', '/gh-axi/device', { origin: 'https://github.com', expectedRevision: 0,
    expectedToolRevision: detail.revision }), 'UPSTREAM_AUTH_FAILED')
  expect(credentialTls.credentialFetch).toHaveBeenCalledTimes(1)
  expect(vi.mocked(credentialTls.credentialFetch).mock.calls[0][0]).toBe('https://github.com/login/device/code')
  expect(store.findCredential('gh-axi')).toBeUndefined()
})

test('GitHub device approval stores a shared encrypted credential, audits once and runs health', async () => {
  const network = fakeGithubDevice()
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({ ...await prepare(args, reference, input),
    executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'remaining: 4999'] }))
  adapters.push(adapter)
  await replace('gh-axi')
  const started = await startGithubDevice(1)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 5000)
  const response = await request('POST', '/gh-axi/device/poll', started)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'connected', credential: { revision: 2,
    metadata: { origin: 'https://github.com', auth: 'device', login: 'synthetic-machine' } } })
  expect(store.readCredential(store.findCredential('gh-axi')!)).toEqual({ origin: 'https://github.com', auth: 'device',
    accessToken: 'gho_CANARY-connected-token', login: 'synthetic-machine' })
  expect(JSON.stringify(db.prepare('SELECT * FROM credentials').all())).not.toContain('gho_CANARY-connected-token')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toMatch(/gho_CANARY|CANARY-private-device-code|ABCD-EFGH/)
  expect(db.prepare("SELECT instance, credential_id FROM audit WHERE action = 'connect-github-device'").all())
    .toEqual([{ instance: 'default', credential_id: store.findCredential('gh-axi')!.id }])
  expect(await (await request('GET', '/gh-axi')).json()).toMatchObject({ health: { status: 'ok', credentialRevision: 2 } })
  expect(network).toHaveBeenCalledTimes(3)
  await failure(await request('POST', '/gh-axi/device/poll', started), 'NOT_FOUND')
  await failure(await save('gh-axi', { origin: 'https://github.com', auth: 'device', accessToken: 'gho_CANARY-forged', login: 'synthetic' }, 2), 'INVALID_INPUT')
})

test.each([
  { status: 'ok', errorCode: null, output: ['print', 'remaining: 4999'] },
  { status: 'error', errorCode: 'CREDENTIAL_EXPIRED', output: ['failure', 'error: Bad credentials (HTTP 401)\ncode: UNKNOWN'] },
])('first GitHub device connection records $status health while disabled', async ({ status, errorCode, output }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('gh-axi')
  const network = fakeGithubDevice()
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({ ...await prepare(args, reference, input),
    executable: fakeTool.executable, args: [...fakeTool.args, ...output] }))
  runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {}, adapters: [adapter],
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  expect(store.findCredential('gh-axi')).toBeUndefined()
  const started = await startGithubDevice()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 5000)
  const response = await request('POST', '/gh-axi/device/poll', started)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'connected', credential: { revision: 1,
    metadata: { auth: 'device', login: 'synthetic-machine' } } })
  expect(store.readCredential(store.findCredential('gh-axi')!)).toEqual({ origin: 'https://github.com', auth: 'device',
    accessToken: 'gho_CANARY-connected-token', login: 'synthetic-machine' })
  expect(db.prepare('SELECT status, error_code, credential_revision FROM tool_health WHERE tool = ?').get('gh-axi'))
    .toEqual({ status, error_code: errorCode, credential_revision: 1 })
  expect(await (await request('GET', '/gh-axi')).json()).toMatchObject({ enabled: false,
    health: { status: 'disabled', credentialRevision: 1, checkedAt: expect.any(Number), errorCode } })
  expect(db.prepare("SELECT outcome, credential_revision FROM audit WHERE event = 'credential-test' AND tool = 'gh-axi'").all())
    .toEqual([{ outcome: errorCode ?? 'success', credential_revision: 1 }])
  expect(db.prepare("SELECT action FROM audit WHERE action = 'connect-github-device'").all()).toEqual([{ action: 'connect-github-device' }])
  expect(JSON.stringify(db.prepare('SELECT * FROM credentials').all())).not.toContain('gho_CANARY-connected-token')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toMatch(/gho_CANARY|CANARY-private-device-code|ABCD-EFGH/)
  expect(network).toHaveBeenCalledTimes(3)
})

test('disabled GitHub device connection checks its revision once runner capacity returns', async () => {
  await app.close()
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('gh-axi')
  fakeGithubDevice()
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({ ...await prepare(args, reference, input),
    executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'remaining: 4999'] }))
  runner = await Runner.create(join(directory, 'calls'))
  let completed!: () => void
  const terminal = new Promise<void>(resolve => { completed = resolve })
  const audit = new Audit(db, Date.now, line => {
    const record = JSON.parse(line)
    if (record.event === 'health-check' && record.tool === 'gh-axi' && record.outcome === 'success') completed()
  })
  app = createApp({ db, runner, audit, credentialStore: store, environment: {}, adapters: [adapter],
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const controller = new AbortController()
  const calls = Array.from({ length: runnerLimits.globalCalls }, (_, index) =>
    runner.run(`synthetic-ordinary-${index}`, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, [],
      { signal: controller.signal }).catch(error => error))
  try {
    const started = await startGithubDevice()
    vi.setSystemTime(Date.now() + 5000)
    const response = await request('POST', '/gh-axi/device/poll', started)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'connected', credential: { revision: 1 } })
    expect(await (await request('GET', '/gh-axi')).json()).toMatchObject({ enabled: false, health: {
      credentialRevision: 1, errorCode: 'TOO_MANY_CALLS', diagnostic: { message: 'Credential check pending: runner busy.' },
    } })
    expect(db.prepare('SELECT credential_revision, error_code FROM tool_health WHERE tool = ?').get('gh-axi'))
      .toEqual({ credential_revision: 1, error_code: 'TOO_MANY_CALLS' })
    controller.abort()
    await Promise.all(calls)
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    await terminal
    expect(db.prepare('SELECT status, credential_revision, error_code FROM tool_health WHERE tool = ?').get('gh-axi'))
      .toEqual({ status: 'ok', credential_revision: 1, error_code: null })
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    expect(db.prepare("SELECT credential_revision FROM audit WHERE event = 'health-check' AND tool = 'gh-axi' AND outcome = 'success'").all())
      .toEqual([{ credential_revision: 1 }])
  } finally {
    controller.abort()
    await Promise.all(calls)
  }
})

test('GitHub reconnect during an in-flight check checks the new revision while disabled', async () => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 0 WHERE name = ?').run('gh-axi')
  store.replaceCredential('gh-axi', values['gh-axi'], 0, actor, Date.now())
  fakeGithubDevice()
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({ ...await prepare(args, reference, input),
    executable: fakeTool.executable, args: [...fakeTool.args, 'print', 'remaining: 4999'] }))
  runner = await Runner.create(join(directory, 'calls'))
  let admitted!: () => void
  let release!: () => void
  const running = new Promise<void>(resolve => { admitted = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(runner, 'run').mockImplementationOnce(async () => {
    admitted()
    await held
    return { stdout: 'error: Bad credentials (HTTP 401)\ncode: UNKNOWN', stderr: '', exitCode: 1, durationMs: 1,
      outputBytes: { stdout: 50, stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
  })
  let completed!: () => void
  const terminal = new Promise<void>(resolve => { completed = resolve })
  const audit = new Audit(db, Date.now, line => {
    const record = JSON.parse(line)
    if (record.event === 'health-check' && record.tool === 'gh-axi' && record.credential_revision === 2
      && record.outcome === 'success') completed()
  })
  app = createApp({ db, runner, audit, credentialStore: store, environment: {}, adapters: [adapter],
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const oldCheck = request('POST', '/gh-axi/test', {})
  await running
  try {
    const started = await startGithubDevice(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5000)
    const response = await request('POST', '/gh-axi/device/poll', started)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'connected', credential: { revision: 2 } })
    expect(db.prepare('SELECT credential_revision, error_code FROM tool_health WHERE tool = ?').get('gh-axi'))
      .toEqual({ credential_revision: 2, error_code: 'TOO_MANY_CALLS' })
    release()
    expect((await oldCheck).status).toBe(503)
    await terminal
    expect(db.prepare('SELECT status, credential_revision, error_code FROM tool_health WHERE tool = ?').get('gh-axi'))
      .toEqual({ status: 'ok', credential_revision: 2, error_code: null })
    expect(db.prepare("SELECT credential_revision FROM audit WHERE event = 'health-check' AND tool = 'gh-axi' AND outcome = 'success'").all())
      .toEqual([{ credential_revision: 2 }])
  } finally {
    release()
    await oldCheck
  }
})

test('GitHub pending connection cannot overwrite a credential deleted and recreated at the same revision', async () => {
  const network = fakeGithubDevice()
  await replace('gh-axi')
  const original = store.findCredential('gh-axi')!
  const started = await startGithubDevice(original.revision)
  db.prepare('DELETE FROM credentials WHERE id = ?').run(original.id)
  const recreated = store.replaceCredential('gh-axi', values['gh-axi'], 0, actor, Date.now())
  expect(recreated).toMatchObject({ revision: original.revision })
  await failure(await request('POST', '/gh-axi/device/poll', started), 'REVISION_CONFLICT')
  expect(network).toHaveBeenCalledTimes(1)
  expect(store.findCredential('gh-axi')).toEqual(recreated)
  expect(store.readCredential(recreated)).toEqual(values['gh-axi'])
})

test('GitHub pending connection cannot overwrite a concurrently rotated credential', async () => {
  const network = fakeGithubDevice()
  const started = await startGithubDevice()
  await replace('gh-axi')
  await failure(await request('POST', '/gh-axi/device/poll', started), 'REVISION_CONFLICT')
  expect(network).toHaveBeenCalledTimes(1)
  expect(store.readCredential(store.findCredential('gh-axi')!)).toEqual(values['gh-axi'])
})

test.each(['/gh-axi/device', '/gh-axi/device/poll', '/gh-axi/device/cancel'])(
  'GitHub connection %s requires an administrator and recent authentication', async path => {
    const network = fakeGithubDevice()
    const ordinary = await adminHeaders('synthetic-ordinary')
    await failure(await request('POST', path, {}, ordinary), 'ADMIN_REQUIRED')
    const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
    await failure(await request('POST', path, {}, missing), 'REAUTH_REQUIRED')
    expect(network).not.toHaveBeenCalled()
  })

test('GitHub revoked device credentials turn health red with reconnect guidance', async () => {
  store.replaceCredential('gh-axi', { origin: 'https://github.com', auth: 'device', accessToken: 'gho_CANARY-revoked',
    login: 'synthetic-machine' }, 0, actor, Date.now())
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference, input) => ({ ...await prepare(args, reference, input),
    executable: fakeTool.executable, args: [...fakeTool.args, 'failure', 'error: Bad credentials (HTTP 401)\ncode: UNKNOWN'] }))
  adapters.push(adapter)
  await failure(await request('POST', '/gh-axi/test', {}), 'CREDENTIAL_EXPIRED')
  expect(await (await request('GET', '/gh-axi')).json()).toMatchObject({ health: { status: 'error', errorCode: 'CREDENTIAL_EXPIRED' } })
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
      { name: 'hybrid-axi', capable: true, enabled: false, reason: null },
      { name: 'checkpoint-axi', capable: true, enabled: false, reason: null },
      { name: 'beyondtrust-axi', capable: true, enabled: false, reason: null },
      { name: 'gh-axi', capable: true, enabled: false, reason: null },
      { name: 'unifi-axi', capable: true, enabled: false, reason: null },
      { name: 'proxmox-axi', capable: true, enabled: false, reason: null },
      { name: 'technitium-axi', capable: true, enabled: false, reason: null },
      { name: 'shodan-axi', capable: false, enabled: false, reason: 'Only reads are available.' },
      { name: 'gitea-axi', capable: true, enabled: false, reason: null },
      { name: 'kubernetes-axi', capable: true, enabled: false, reason: null },
      { name: 'ssh-axi', capable: true, enabled: false, reason: null },
    ])
  for (const tool of tools) {
    const detail = await request('GET', `/${tool.name}`)
    expect(detail.status).toBe(200)
    expect((await detail.json()).writeAccess).toEqual(tool.writeAccess)
    expect(tool.writeAccess.unlocks.length).toBeGreaterThan(0)
    expect(tool.writeAccess.blocked.length).toBeGreaterThan(0)
  }
})

test('GitHub admin selects exact write operations and preserves them through disable and credential rotation', async () => {
  db.exec("UPDATE tools SET enabled = 0 WHERE name = 'gh-axi'")
  await replace('gh-axi')
  const selected = ['issue comment', 'workflow run']
  const enabled = await request('PATCH', '/gh-axi/write-access', { enabled: true, operations: selected, expectedRevision: 2 })
  expect(enabled.status).toBe(200)
  expect(await enabled.json()).toMatchObject({ readOnly: false, revision: 3,
    writeAccess: { capable: true, enabled: true, allowedOperations: selected } })
  const adapter = createGhAdapter(new EmbeddedSecretSource(store))
  const args = ['issue', 'comment', '1', '-R', 'canary/repo', '--body=synthetic private comment']
  expect(await adapter.prepare(args, store.findCredential('gh-axi')!)).toMatchObject({ preview: { operation: 'issue comment' } })
  await expect(adapter.prepare(['issue', 'close', '1', '-R', 'canary/repo'], store.findCredential('gh-axi')!))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  await failure(await request('PATCH', '/gh-axi/write-access', { enabled: true, operations: ['secret set'], expectedRevision: 3 }), 'INVALID_INPUT')
  expect((await request('PATCH', '/gh-axi/write-access', { enabled: false, expectedRevision: 3 })).status).toBe(200)
  await expect(adapter.prepare(args, store.findCredential('gh-axi')!)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect((await save('gh-axi', { ...values['gh-axi'], token: 'github_pat_CANARY-rotated' }, 3)).status).toBe(200)
  const detail = await (await request('GET', '/gh-axi')).json()
  expect(detail.writeAccess).toMatchObject({ enabled: false, allowedOperations: selected })
  expect((await request('PATCH', '/gh-axi/write-access', { enabled: true, expectedRevision: detail.revision })).status).toBe(200)
  expect(await adapter.prepare(args, store.findCredential('gh-axi')!)).toMatchObject({ preview: { operation: 'issue comment' } })
})

test('Falcon write switch activates only the selected saved MalQuery operation', async () => {
  await replace('falcon-axi', { ...values['falcon-axi'], writes: { allowWrites: false, operations: ['malquery search'] } })
  const enabled = await request('PATCH', '/falcon-axi/write-access', { enabled: true,
    operations: ['malquery search'], expectedRevision: 2 })
  expect(enabled.status).toBe(200)
  expect(store.readCredential(store.findCredential('falcon-axi')!)).toMatchObject({
    ...values['falcon-axi'], writes: { allowWrites: true, operations: ['malquery search'] } })
  const detail = await (await request('GET', '/falcon-axi')).json()
  expect(detail).toMatchObject({ readOnly: false, writeAccess: { capable: true, enabled: true, allowedOperations: ['malquery search'] } })
  expect([...detail.writeAccess.supportedOperations].sort()).toEqual(['host usb', 'identity activity', 'malquery search', 'raw write', 'rtr run', 'search start', 'search stop'])
})

test.each(['az-axi', 'ado-axi', 'awx-axi'] as const)('%s write switch preserves native settings and credentials', async tool => {
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
  { tool: 'mg-axi', operations: ['mail.message.tag', 'mail.message.flag', 'mail.message.mark', 'mail.message.move',
    'mail.message.copy', 'mail.message.trash', 'mail.folder.create', 'mail.folder.delete', 'mail.category.create',
    'mail.rule.create', 'mail.rule.update', 'mail.rule.delete'], settings: { enabledPacks: ['entra', 'mail'] } },
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
    'entra.user.update', 'mail.attachment.save', 'mail.category.create', 'mail.folder.create', 'mail.folder.delete',
    'mail.message.copy', 'mail.message.export', 'mail.message.flag', 'mail.message.mark', 'mail.message.move', 'mail.message.tag',
    'mail.message.trash', 'mail.rule.create', 'mail.rule.delete', 'mail.rule.update', 'mg.entra.group.member.add',
  ])
})

test('Vectra choices contain implemented QUX and RUX operations without placeholder names', async () => {
  const response = await request('GET', '/vectra-axi')
  const { writeAccess } = await response.json()
  expect(writeAccess.supportedOperations).toHaveLength(126)
  expect(writeAccess.supportedOperations).toEqual(expect.arrayContaining([
    'qux.detection.tag.bulk-set', 'qux.host.assignment.unassign', 'rux.account.note.delete',
    'rux.host.tag.set', 'qux.host.close', 'rux.account.close', 'qux.group.delete',
    'qux.setting.syslog.set', 'qux.setting.kafka.set', 'rux.match.enablement.set',
  ]))
  expect(writeAccess.supportedOperations).not.toContain('notes.set')
  expect(writeAccess).toMatchObject({ enabled: false, allowedOperations: [] })
  const granted = await request('PATCH', '/vectra-axi/write-access', {
    enabled: true, operations: writeAccess.supportedOperations, expectedRevision: 1,
  })
  expect(granted.status).toBe(200)
  expect((await granted.json()).writeAccess.allowedOperations).toEqual(writeAccess.supportedOperations)
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
  expect(store.findCredential('az-axi')).toEqual({ ...reference, revision: reference!.revision! + 1 })
  const records = db.prepare('SELECT * FROM audit').all()
  const changes = records.filter(record => (record as { event: string }).event === 'tool-write-access')
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ event: 'tool-write-access', tool: 'az-axi', user_id: actor,
    outcome: 'success', arguments: JSON.stringify({ enabled: false, operations: [], unsupportedOperationCount: 0 }) })
  expect(JSON.stringify(records)).not.toContain('CANARY')
  expect(JSON.stringify(records)).not.toContain('synthetic-subscription')
  await failure(await request('PATCH', '/az-axi/write-access', { enabled: true, expectedRevision: 2 }), 'REVISION_CONFLICT')
  expect((await (await request('GET', '/az-axi')).json()).writeAccess.enabled).toBe(false)
})
test('write-access change reports checking while its re-check runs, then ok without a manual test', async () => {
  await replace('az-axi')
  const current = await (await request('GET', '/az-axi')).json() as { revision: number }
  const heldResult = { stdout: 'synthetic', stderr: '', exitCode: 0, durationMs: 1,
    outputBytes: { stdout: 9, stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
  let started!: () => void
  let release!: (value: typeof heldResult) => void
  const admitted = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<typeof heldResult>(resolve => { release = resolve })
  const run = vi.spyOn(runner, 'run').mockImplementation(() => { started(); return held })
  const patching = request('PATCH', '/az-axi/write-access', { enabled: false, expectedRevision: current.revision })
  await admitted
  expect((await (await request('GET', '/az-axi')).json()).health.status).toBe('checking')
  const discovery = await fetch(`${url}/v1/tools`, { headers })
  expect(toolsResponseSchema.parse(await discovery.json()).tools.find(tool => tool.name === 'az-axi')!.status).toBe('checking')
  release(heldResult)
  const patched = await patching
  expect(patched.status).toBe(200)
  expect((await patched.json()).health.status).toBe('ok')
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0][0]).toBe('system:tool-health:az-axi')
})

test('a write-access check stays pending while ordinary calls fill the runner and succeeds on the next free tick', async () => {
  await replace('az-axi')
  const current = await (await request('GET', '/az-axi')).json() as { revision: number }
  await app.close()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  runner = await Runner.create(join(directory, 'calls'))
  let completed!: () => void
  const terminal = new Promise<void>(resolve => { completed = resolve })
  let rejectedAgain!: () => void
  let rejections = 0
  const retryRejected = new Promise<void>(resolve => { rejectedAgain = resolve })
  const audit = new Audit(db, Date.now, line => {
    const record = JSON.parse(line)
    if (record.event === 'health-check' && record.tool === 'az-axi' && record.outcome === 'success') completed()
    if (record.event === 'health-check' && record.tool === 'az-axi' && record.outcome === 'TOO_MANY_CALLS'
      && ++rejections === 2) rejectedAgain()
  })
  app = createApp({ db, runner, audit, credentialStore: store, environment: {}, adapters,
    resolver: new SharedIdentityResolver(store) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const controller = new AbortController()
  const calls = Array.from({ length: runnerLimits.globalCalls }, (_, index) =>
    runner.run(`synthetic-ordinary-${index}`, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, [],
      { signal: controller.signal }).catch(error => error))
  try {
    const response = await request('PATCH', '/az-axi/write-access', { enabled: false, expectedRevision: current.revision })
    expect(response.status).toBe(200)
    expect((await response.json()).health.status).toBe('checking')
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    await retryRejected
    expect((await (await request('GET', '/az-axi')).json()).health.status).toBe('checking')
    const discovery = await fetch(`${url}/v1/tools`, { headers })
    expect(toolsResponseSchema.parse(await discovery.json()).tools.find(tool => tool.name === 'az-axi')!.status).toBe('checking')
    expect(db.prepare("SELECT outcome FROM audit WHERE event = 'health-check' AND tool = 'az-axi' AND outcome = 'TOO_MANY_CALLS'").all())
      .toHaveLength(2)
    expect(db.prepare("SELECT status FROM tool_health WHERE tool = 'az-axi'").get()).toBeUndefined()
    controller.abort()
    await Promise.all(calls)
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    await terminal
    expect((await (await request('GET', '/az-axi')).json()).health.status).toBe('ok')
    const recovered = await fetch(`${url}/v1/tools`, { headers })
    expect(toolsResponseSchema.parse(await recovered.json()).tools.find(tool => tool.name === 'az-axi')!.status).toBe('ok')
  } finally {
    controller.abort()
    await Promise.all(calls)
    await app.close()
    vi.useRealTimers()
  }
})

test('removing a trusted certificate schedules one re-check for that tool', async () => {
  await replace('vectra-axi')
  createTestCertificates(directory, ['synthetic.invalid'])
  const pem = readFileSync(join(directory, 'server.crt'), 'utf8')
  const reference = store.findCredential('vectra-axi')!
  db.prepare(`INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pin', ?, ?)`)
    .run('synthetic-certificate', reference.id, 'https://synthetic.invalid', 'synthetic-fingerprint', 'synthetic-leaf', pem, pem, Date.now(), actor)
  const run = vi.spyOn(runner, 'run')
  const response = await request('DELETE', '/vectra-axi/certificates', { id: 'synthetic-certificate' })
  expect(response.status).toBe(200)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0][0]).toBe('system:tool-health:vectra-axi')
  expect((await (await request('GET', '/vectra-axi')).json()).health.status).toBe('ok')
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

test('Gitea administrator policy can select every admitted native write operation', async () => {
  const current = await request('GET', '/gitea-axi')
  const operations = (await current.json()).writeAccess.supportedOperations
  const response = await request('PATCH', '/gitea-axi/write-access', { enabled: true, operations, expectedRevision: 1 })
  expect(response.status).toBe(200)
  expect((await response.json()).writeAccess).toMatchObject({ enabled: true, allowedOperations: operations })
})

test.each(['mg-axi', 'vectra-axi', 'gitea-axi'] as const)('%s can clear the allow-list when disabling and audit a list-only edit', async tool => {
  const operation = tool === 'mg-axi' ? 'entra.user.update' : tool === 'gitea-axi' ? 'issueEditIssue' : 'qux.host.tag.set'
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
    { name: 'falcon-axi', version: '1.0.1', health: { status: 'unconfigured' } },
    { name: 'vectra-axi', version: '0.1.14', health: { status: 'unconfigured' } },
    { name: 'az-axi', version: '0.1.17', health: { status: 'unconfigured' } },
    { name: 'mg-axi', version: '0.1.21', health: { status: 'disabled' } },
    { name: 'ldap-axi', version: '0.3.4', health: { status: 'disabled' } },
    { name: 'ado-axi', version: '0.5.2', health: { status: 'disabled' } },
    { name: 'awx-axi', version: '0.1.14', health: { status: 'disabled' } },
    { name: 'tenable-axi', version: '0.1.7', health: { status: 'disabled' } },
    { name: 'hybrid-axi', version: '0.1.5', health: { status: 'disabled' } },
    { name: 'checkpoint-axi', version: '0.1.6', health: { status: 'disabled' } },
    { name: 'beyondtrust-axi', version: '0.1.8', health: { status: 'disabled' } },
    { name: 'gh-axi', version: '0.1.51', health: { status: 'disabled' } },
    { name: 'unifi-axi', version: '0.1.3', health: { status: 'disabled' } },
    { name: 'proxmox-axi', version: '0.1.3', health: { status: 'disabled' } },
    { name: 'technitium-axi', version: '0.1.1', health: { status: 'disabled' } },
    { name: 'shodan-axi', version: '0.1.2', health: { status: 'disabled' } },
    { name: 'gitea-axi', version: '0.1.4', health: { status: 'disabled' } },
    { name: 'kubernetes-axi', version: '0.1.3', health: { status: 'disabled' } },
    { name: 'ssh-axi', version: '0.1.2', health: { status: 'disabled' } },
  ])
  expect(read).not.toHaveBeenCalled()
  expect(network.requests).toEqual([])
  await failure(await request('POST', '', { executable: '/synthetic' }), 'NOT_FOUND')
})
test.each([
  { tool: 'az-axi', previousVersion: '0.1.7', version: '0.1.17' },
  { tool: 'mg-axi', previousVersion: '0.1.6', version: '0.1.21' },
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
  expect(tools).toEqual([{ name: tool, version, status: 'unknown', readOnly: true,
    instances: [{ name: 'default', description: '', status: 'unknown', readOnly: true }] }])
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
test.each([0, 7])('credential test logs exactly one correlated run for exit %s', async exitCode => {
  await replace('falcon-axi')
  vi.spyOn(runner, 'run').mockResolvedValueOnce({ stdout: 'CANARY-private-output', stderr: '', exitCode,
    durationMs: 1, outputBytes: { stdout: 21, stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } })
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const response = await request('POST', '/falcon-axi/test', {})
  expect(response.status).toBe(exitCode === 0 ? 200 : errors.TOOL_FAILED.status)
  expect(stderr.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
    expect.objectContaining({ event: 'run', tool: 'falcon-axi', requestId: response.headers.get('x-artium-request-id'), exitCode }),
  ])
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('CANARY')
})
test('manual tests share the administrator four-call quota and release it after completion', async () => {
  await replace('falcon-axi')
  expect((await request('POST', '/falcon-axi/test', {})).status).toBe(200)
  const health = db.prepare('SELECT * FROM tool_health').all()
  db.exec('DELETE FROM audit')
  const controller = new AbortController()
  const calls = Array.from({ length: 4 }, () => {
    let ready!: () => void
    const admitted = new Promise<void>(resolve => { ready = resolve })
    const result = runner.run(actor, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, [],
      { signal: controller.signal }, {}, [], ready)
    return { admitted, result }
  })
  const completed = Promise.allSettled(calls.map(call => call.result))
  try {
    await Promise.all(calls.map(call => call.admitted))
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
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const response = await request('POST', '/falcon-axi/test', {})
  await failure(response, code)
  expect(stderr.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
    expect.objectContaining({ event: 'run', tool: 'falcon-axi', requestId: response.headers.get('x-artium-request-id'),
      outcome: code, exitCode: null, durationMs: 17.25, stdoutBytes: 12, stderrBytes: 34 }),
  ])
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

async function toolRevision(tool: ToolName): Promise<number> {
  return (await (await request('GET', `/${tool}`)).json()).revision
}
async function createInstance(name: string, value: unknown = values['falcon-axi'], tool: ToolName = 'falcon-axi') {
  const response = await request('POST', `/${tool}/instances`, { name, description: `${name} region`, value, expectedToolRevision: await toolRevision(tool) })
  expect(response.status).toBe(200)
  return adminInstanceSchema.parse(await response.json())
}
async function instanceHeader(name: string, tool: ToolName = 'falcon-axi') {
  const instance = store.findInstance(tool, name)!
  return { expectedId: instance.id, expectedRevision: instance.revision }
}
const eastValue = { ...values['falcon-axi'], clientSecret: 'CANARY-east-secret' }
const westValue = { ...values['falcon-axi'], clientSecret: 'CANARY-west-secret', region: 'eu-1' }

test('a write access save bumps the revision of every instance', async () => {
  await createInstance('east', eastValue)
  await createInstance('west', westValue)
  const revisions = () => ['east', 'west'].map(name => store.findInstance('falcon-axi', name)!.revision)
  const before = revisions()
  expect((await request('PATCH', '/falcon-axi/write-access', { enabled: true, operations: ['malquery search'],
    expectedRevision: await toolRevision('falcon-axi') })).status).toBe(200)
  expect(revisions()).toEqual(before.map(revision => revision + 1))
})

test('an unchanged write access save bumps the revision of every instance', async () => {
  await createInstance('east', eastValue)
  await createInstance('west', westValue)
  const revisions = () => ['east', 'west'].map(name => store.findInstance('falcon-axi', name)!.revision)
  const before = revisions()
  expect((await request('PATCH', '/falcon-axi/write-access', { enabled: false,
    expectedRevision: await toolRevision('falcon-axi') })).status).toBe(200)
  expect(revisions()).toEqual(before.map(revision => revision + 1))
})

test('a native settings save bumps the revision of every instance', async () => {
  await createInstance('east', eastValue)
  await createInstance('west', westValue)
  const revisions = () => ['east', 'west'].map(name => store.findInstance('falcon-axi', name)!.revision)
  const before = revisions()
  expect((await request('PATCH', '/falcon-axi', { nativeSettings: { allowWrites: true },
    expectedRevision: await toolRevision('falcon-axi') })).status).toBe(200)
  expect(revisions()).toEqual(before.map(revision => revision + 1))
})

test('instance credential changes preserve shared write access', async () => {
  await createInstance('east', eastValue)
  expect((await request('PATCH', '/falcon-axi/write-access', { enabled: true, operations: ['malquery search'],
    expectedRevision: await toolRevision('falcon-axi') })).status).toBe(200)
  const west = await createInstance('west', westValue)
  expect((await request('PUT', '/falcon-axi/instances/west/credential', { value: westValue, expectedId: west.id,
    expectedRevision: west.revision, expectedToolRevision: await toolRevision('falcon-axi') })).status).toBe(200)
  expect((await request('PATCH', '/falcon-axi/instances/west/credential', { value: westValue, ...await instanceHeader('west'),
    expectedToolRevision: await toolRevision('falcon-axi') })).status).toBe(200)
  expect(await (await request('GET', '/falcon-axi')).json()).toMatchObject({ writeAccess: { enabled: true, allowedOperations: ['malquery search'] } })
  expect(healthSchema.parse(await (await request('POST', '/falcon-axi/instances/east/test', {})).json()).readOnly).toBe(true)
  expect((await request('PATCH', '/falcon-axi/instances/east', { ...await instanceHeader('east'), readOnly: false })).status).toBe(200)
  expect(healthSchema.parse(await (await request('POST', '/falcon-axi/instances/east/test', {})).json()).readOnly).toBe(false)
})

test('AWX summary aggregates configured instances and legacy credential requires a unique instance', async () => {
  adapters.push(createAwxAdapter(new EmbeddedSecretSource(store)))
  for (const instance of ['east', 'west']) {
    expect((await request('PUT', '/awx-axi/origin', { origin: `https://${instance}.example`, instance, expectedRevision: 0,
      expectedToolRevision: await toolRevision('awx-axi') })).status).toBe(200)
  }
  expect(await (await request('GET', '/awx-axi')).json()).toMatchObject({ health: { status: 'unconfigured' } })
  expect(adminCredentialSchema.parse(await (await request('GET', '/awx-axi/credential')).json()))
    .toMatchObject({ configured: false, revision: 0, updatedAt: null, updatedBy: null, metadata: {} })
  await createInstance('north', values['awx-axi'], 'awx-axi')
  expect((await (await request('GET', '/awx-axi')).json()).health.status).not.toBe('unconfigured')
})

test('AWX aggregate health excludes origin-only instances', async () => {
  adapters.push(createAwxAdapter(new EmbeddedSecretSource(store)))
  const configured = store.createInstance('awx-axi', { name: 'configured', description: '' }, values['awx-axi'], actor, Date.now())
  store.createInstance('awx-axi', { name: 'origin', description: '' }, { origin: 'https://origin.example' }, actor, Date.now())
  db.prepare("INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status, error_code) VALUES (?, 'awx-axi', ?, ?, 'ok', NULL)")
    .run(configured.id, configured.revision, Date.now())
  expect(await (await request('GET', '/awx-axi')).json()).toMatchObject({ health: { status: 'ok' } })
})

test('instance create stores an enabled read-only instance, hides secrets and audits it', async () => {
  const created = await createInstance('east', eastValue)
  expect(created).toMatchObject({ tool: 'falcon-axi', name: 'east', description: 'east region', enabled: true, readOnly: true,
    configured: true, revision: 1, metadata: { clientId: 'synthetic-client', region: 'us-2' }, health: { status: 'unknown' } })
  expect(store.readCredential(store.findInstance('falcon-axi', 'east')!)).toEqual(eastValue)
  expect(JSON.stringify(created)).not.toContain('CANARY-east-secret')
  const listed = await (await request('GET', '/falcon-axi/instances')).json()
  expect(listed.instances.map((instance: { id: string }) => instance.id)).toEqual([created.id])
  expect(db.prepare("SELECT user_id, action, tool, instance, credential_id, outcome FROM audit WHERE event = 'admin-change'").all())
    .toEqual([{ user_id: actor, action: 'create-instance', tool: 'falcon-axi', instance: 'east', credential_id: created.id, outcome: 'success' }])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-east-secret')
})

test.each([
  { name: 'duplicate name', body: { name: 'east' }, code: 'REVISION_CONFLICT' },
  { name: 'uppercase name', body: { name: 'East' }, code: 'INVALID_INPUT' },
  { name: 'incomplete credential', body: { name: 'west', value: { clientId: 'synthetic-client' } }, code: 'INVALID_INPUT' },
  { name: 'stale tool revision', body: { name: 'west', expectedToolRevision: 99 }, code: 'REVISION_CONFLICT' },
] as const)('instance create rejects $name without changing instances', async ({ body, code }) => {
  await createInstance('east', eastValue)
  const tool = await toolRevision('falcon-axi')
  await failure(await request('POST', '/falcon-axi/instances', { description: '', value: westValue, expectedToolRevision: tool, ...body }), code)
  expect(store.listInstances('falcon-axi').map(instance => instance.name)).toEqual(['east'])
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE action = 'create-instance'").get()).toEqual({ count: 1 })
})

test('instance edit retains the secret, advances only that instance and audits the revision-checked change', async () => {
  const east = await createInstance('east', eastValue)
  const west = await createInstance('west', westValue)
  const response = await request('PATCH', '/falcon-axi/instances/east/credential', {
    value: { clientId: 'synthetic-client', region: 'eu-2' }, expectedId: east.id, expectedRevision: 1, expectedToolRevision: await toolRevision('falcon-axi') })
  expect(response.status).toBe(200)
  expect(adminInstanceSchema.parse(await response.json())).toMatchObject({ name: 'east', revision: 2, metadata: { region: 'eu-2' } })
  expect(store.readCredential(store.findInstance('falcon-axi', 'east')!)).toEqual({ ...eastValue, region: 'eu-2' })
  expect(store.findInstance('falcon-axi', 'west')).toMatchObject({ id: west.id, revision: 1 })
  expect(store.readCredential(store.findInstance('falcon-axi', 'west')!)).toEqual(westValue)
  expect(db.prepare("SELECT instance, credential_id FROM audit WHERE action = 'replace-credential'").all())
    .toEqual([{ instance: 'east', credential_id: east.id }])
})

test.each([
  { name: 'stale instance revision', change: { expectedRevision: 5 } },
  { name: 'another instance identity', change: { expectedId: 'recreated-instance' } },
  { name: 'stale tool revision', change: { expectedToolRevision: 99 } },
])('instance edit rejects $name without mutation', async ({ change }) => {
  const east = await createInstance('east', eastValue)
  await failure(await request('PUT', '/falcon-axi/instances/east/credential', { value: westValue, expectedId: east.id, expectedRevision: 1,
    expectedToolRevision: await toolRevision('falcon-axi'), ...change }), 'REVISION_CONFLICT')
  expect(store.findInstance('falcon-axi', 'east')).toMatchObject({ id: east.id, revision: 1 })
  expect(store.readCredential(store.findInstance('falcon-axi', 'east')!)).toEqual(eastValue)
})

test('instance read-only and disable changes are audited per flag and revision checked', async () => {
  const east = await createInstance('east', eastValue)
  const response = await request('PATCH', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 1, readOnly: false, enabled: false })
  expect(response.status).toBe(200)
  expect(adminInstanceSchema.parse(await response.json())).toMatchObject({ readOnly: false, enabled: false, revision: 2, health: { status: 'disabled' } })
  expect(db.prepare("SELECT action, instance, credential_id FROM audit WHERE event = 'admin-change' AND action <> 'create-instance' ORDER BY id").all())
    .toEqual([{ action: 'disable-instance', instance: 'east', credential_id: east.id }, { action: 'set-instance-writable', instance: 'east', credential_id: east.id }])
  await failure(await request('PATCH', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 1, enabled: true }), 'REVISION_CONFLICT')
  expect(store.findInstance('falcon-axi', 'east')).toMatchObject({ enabled: false, readOnly: false, revision: 2 })
  const restored = await request('PATCH', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 2, enabled: true, readOnly: true })
  expect(adminInstanceSchema.parse(await restored.json())).toMatchObject({ enabled: true, readOnly: true, revision: 3 })
})

test('instance delete is revision checked, removes dependent state and is audited', async () => {
  const east = await createInstance('east', eastValue)
  await createInstance('west', westValue)
  await failure(await request('DELETE', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 9 }), 'REVISION_CONFLICT')
  await failure(await request('DELETE', '/falcon-axi/instances/east', { expectedId: 'recreated-instance', expectedRevision: 1 }), 'REVISION_CONFLICT')
  expect(store.findInstance('falcon-axi', 'east')).toBeDefined()
  expect((await request('POST', '/falcon-axi/instances/east/test', {})).status).toBe(200)
  const response = await request('DELETE', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 1 })
  expect(await response.json()).toEqual({ removed: true })
  expect(store.listInstances('falcon-axi').map(instance => instance.name)).toEqual(['west'])
  expect(db.prepare('SELECT COUNT(*) AS count FROM tool_health WHERE credential_id = ?').get(east.id)).toEqual({ count: 0 })
  await failure(await request('GET', '/falcon-axi/instances/east'), 'NOT_FOUND')
  await failure(await request('DELETE', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 1 }), 'NOT_FOUND')
  expect(db.prepare("SELECT user_id, instance, credential_id FROM audit WHERE action = 'delete-instance'").all())
    .toEqual([{ user_id: actor, instance: 'east', credential_id: east.id }])
})

const instanceRoutes = [
  { method: 'GET', path: '/falcon-axi/instances' },
  { method: 'POST', path: '/falcon-axi/instances', body: {} },
  { method: 'GET', path: '/falcon-axi/instances/east' },
  { method: 'PATCH', path: '/falcon-axi/instances/east', body: {} },
  { method: 'DELETE', path: '/falcon-axi/instances/east', body: {} },
  { method: 'PUT', path: '/falcon-axi/instances/east/credential', body: {} },
  { method: 'PATCH', path: '/falcon-axi/instances/east/credential', body: {} },
  { method: 'POST', path: '/falcon-axi/instances/east/test', body: {} },
  { method: 'GET', path: '/falcon-axi/instances/east/certificates' },
  { method: 'POST', path: '/falcon-axi/instances/east/certificates/inspect', body: {} },
  { method: 'POST', path: '/falcon-axi/instances/east/certificates/trust', body: {} },
  { method: 'DELETE', path: '/falcon-axi/instances/east/certificates', body: {} },
  { method: 'PUT', path: '/awx-axi/origin', body: { instance: 'lab' } },
  { method: 'POST', path: '/gh-axi/device', body: { instance: 'lab' } },
] as const
test.each(instanceRoutes)('instance route $method $path requires an administrator', async route => {
  await createInstance('east', eastValue)
  await failure(await request(route.method, route.path, 'body' in route ? route.body : undefined, await adminHeaders('synthetic-ordinary')), 'ADMIN_REQUIRED')
})
test.each(instanceRoutes)('instance route $method $path requires recent authentication', async route => {
  await createInstance('east', eastValue)
  const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
  await failure(await request(route.method, route.path, 'body' in route ? route.body : undefined, missing), 'REAUTH_REQUIRED')
  expect(store.listInstances('falcon-axi')).toHaveLength(1)
})

test('instance test checks and caches only the named instance', async () => {
  const east = await createInstance('east', eastValue)
  await createInstance('west', westValue)
  db.exec('DELETE FROM tool_health')
  const response = await request('POST', '/falcon-axi/instances/east/test', {})
  expect(healthSchema.parse(await response.json())).toMatchObject({ status: 'ok', credentialRevision: 1, errorCode: null })
  expect(db.prepare('SELECT credential_id FROM tool_health').all()).toEqual([{ credential_id: east.id }])
  expect(adminInstanceSchema.parse(await (await request('GET', '/falcon-axi/instances/east')).json()).health).toMatchObject({ status: 'ok' })
  expect(adminInstanceSchema.parse(await (await request('GET', '/falcon-axi/instances/west')).json()).health).toMatchObject({ status: 'unknown', checkedAt: null })
  expect(db.prepare("SELECT instance, credential_id, error_code FROM audit WHERE event = 'credential-test'").all())
    .toEqual([{ instance: 'east', credential_id: east.id, error_code: null }])
  await failure(await request('POST', '/falcon-axi/instances/missing/test', {}), 'NOT_FOUND')
})

test('instance certificates are scoped to the named instance', async () => {
  await createInstance('east', eastValue)
  const response = await request('GET', '/falcon-axi/instances/east/certificates')
  expect(await response.json()).toEqual({ certificates: [] })
  await failure(await request('GET', '/falcon-axi/instances/missing/certificates'), 'NOT_FOUND')
})

test('AWX origin save creates and then revision-checks a named instance', async () => {
  const body = (extra: object) => ({ origin: 'https://lab.example', instance: 'lab', expectedRevision: 0, expectedToolRevision: 1, ...extra })
  const created = await request('PUT', '/awx-axi/origin', body({}))
  expect(created.status).toBe(200)
  const lab = adminInstanceSchema.parse(await created.json())
  expect(lab).toMatchObject({ name: 'lab', configured: false, revision: 1, metadata: { origin: 'https://lab.example' } })
  const tool = await toolRevision('awx-axi')
  await failure(await request('PUT', '/awx-axi/origin', body({ origin: 'https://other.example', expectedRevision: 1, expectedToolRevision: tool })), 'REVISION_CONFLICT')
  const moved = await request('PUT', '/awx-axi/origin', body({ origin: 'https://other.example', expectedId: lab.id, expectedRevision: 1, expectedToolRevision: tool }))
  expect(adminInstanceSchema.parse(await moved.json())).toMatchObject({ id: lab.id, revision: 2, metadata: { origin: 'https://other.example' } })
  expect(db.prepare("SELECT action, instance, credential_id FROM audit WHERE action = 'save-awx-origin' ORDER BY id").all())
    .toEqual([{ action: 'save-awx-origin', instance: 'lab', credential_id: lab.id }, { action: 'save-awx-origin', instance: 'lab', credential_id: lab.id }])
})

test('GitHub device connection rotates the named instance and leaves its sibling untouched', async () => {
  const network = fakeGithubDevice()
  const enterprise = await createInstance('enterprise', values['gh-axi'], 'gh-axi')
  const sibling = await createInstance('other', { ...values['gh-axi'], token: 'CANARY-other-token' }, 'gh-axi')
  const start = await request('POST', '/gh-axi/device', { origin: 'https://github.com', instance: 'enterprise', expectedId: enterprise.id,
    expectedRevision: 1, expectedToolRevision: await toolRevision('gh-axi') })
  expect(start.status).toBe(200)
  const { connectionId } = await start.json() as { connectionId: string }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 5000)
  const response = await request('POST', '/gh-axi/device/poll', { connectionId })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'connected', credential: { id: enterprise.id, name: 'enterprise', revision: 2,
    metadata: { auth: 'device', login: 'synthetic-machine' } } })
  expect(store.readCredential(store.findInstance('gh-axi', 'enterprise')!)).toMatchObject({ auth: 'device', accessToken: 'gho_CANARY-connected-token' })
  expect(store.findInstance('gh-axi', 'other')).toMatchObject({ id: sibling.id, revision: 1 })
  expect(db.prepare("SELECT instance, credential_id FROM audit WHERE action = 'connect-github-device'").all())
    .toEqual([{ instance: 'enterprise', credential_id: enterprise.id }])
  expect(network).toHaveBeenCalledTimes(3)
})

test('GitHub device connection for an instance rejects an identity other than the observed one', async () => {
  const network = fakeGithubDevice()
  await createInstance('enterprise', values['gh-axi'], 'gh-axi')
  await failure(await request('POST', '/gh-axi/device', { origin: 'https://github.com', instance: 'enterprise', expectedId: 'recreated-instance',
    expectedRevision: 1, expectedToolRevision: await toolRevision('gh-axi') }), 'REVISION_CONFLICT')
  expect(network).not.toHaveBeenCalled()
})

test('instance description edit is revision checked and audited', async () => {
  const east = await createInstance('east', eastValue)
  const response = await request('PATCH', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 1, description: 'Primary region' })
  expect(adminInstanceSchema.parse(await response.json())).toMatchObject({ description: 'Primary region', revision: 2, enabled: true, readOnly: true })
  expect(db.prepare("SELECT action FROM audit WHERE action = 'edit-instance-description'").all()).toEqual([{ action: 'edit-instance-description' }])
  await failure(await request('PATCH', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: 2, description: 'x'.repeat(501) }), 'INVALID_INPUT')
})

test.each([{ description: 'Updated region' }, { readOnly: false }])('instance update refreshes health for %o', async change => {
  const east = await createInstance('east', eastValue)
  expect((await request('PATCH', '/falcon-axi/instances/east', { expectedId: east.id, expectedRevision: east.revision, ...change })).status).toBe(200)
  expect(adminInstanceSchema.parse(await (await request('GET', '/falcon-axi/instances/east')).json()).health)
    .toMatchObject({ status: 'ok', credentialRevision: 2 })
})

test('aggregate health includes the failing named instance diagnostic', async () => {
  await createInstance('east', eastValue)
  await createInstance('west', westValue)
  const adapter = adapters.find(item => item.name === 'falcon-axi')!
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementationOnce(async (args, reference) => ({ ...await prepare(args, reference),
    executable: fakeTool.executable, args: [...fakeTool.args, 'failure', 'code: AUTH_FAILED'] }))
  const failureResponse = await request('POST', '/falcon-axi/instances/west/test', {})
  const diagnostic = errorResponseSchema.parse(await failureResponse.json()).error.diagnostic
  expect(diagnostic).toMatchObject({ credentialRevision: 1 })
  expect((await (await request('GET', '/falcon-axi')).json()).health)
    .toMatchObject({ status: 'error', errorCode: 'UPSTREAM_AUTH_FAILED', diagnostic })
})

test('kubernetes-axi accepts a second instance', async () => {
  await createInstance('lab', values['kubernetes-axi'], 'kubernetes-axi')
  await createInstance('production', values['kubernetes-axi'], 'kubernetes-axi')
  expect(store.listInstances('kubernetes-axi').map(instance => instance.name)).toEqual(['lab', 'production'])
})

test('proxmox-axi accepts a second instance', async () => {
  await createInstance('lab', values['proxmox-axi'], 'proxmox-axi')
  await createInstance('production', values['proxmox-axi'], 'proxmox-axi')
  expect(store.listInstances('proxmox-axi').map(instance => instance.name).sort()).toEqual(['lab', 'production'])
})

test('shodan-axi accepts a second instance', async () => {
  await createInstance('lab', values['shodan-axi'], 'shodan-axi')
  await createInstance('production', values['shodan-axi'], 'shodan-axi')
  expect(store.listInstances('shodan-axi').map(instance => instance.name)).toEqual(['lab', 'production'])
})

test('a tool reports its failing enabled instance and recovers when that instance is disabled', async () => {
  await createInstance('east', eastValue)
  const west = await createInstance('west', westValue)
  expect((await (await request('GET', '/falcon-axi')).json()).health).toMatchObject({ status: 'ok' })
  db.prepare("UPDATE tool_health SET status = 'error', error_code = 'UPSTREAM_AUTH_FAILED' WHERE credential_id = ?").run(west.id)
  expect((await (await request('GET', '/falcon-axi')).json()).health).toMatchObject({ status: 'error', errorCode: 'UPSTREAM_AUTH_FAILED' })
  await request('PATCH', '/falcon-axi/instances/west', { expectedId: west.id, expectedRevision: 1, enabled: false })
  expect((await (await request('GET', '/falcon-axi')).json()).health).toMatchObject({ status: 'ok', errorCode: null })
})

function roleRequest(method: string, path: string, body?: unknown, proof = headers) {
  const { 'content-type': _contentType, ...withoutContentType } = proof
  return fetch(`${url}/v1/admin/roles${path}`, { method, headers: body === undefined ? withoutContentType : proof,
    body: body === undefined ? undefined : JSON.stringify(body) })
}
const adminChanges = () => db.prepare("SELECT action, target_id AS targetId, tool, user_id AS userId, outcome FROM audit WHERE event = 'admin-change' ORDER BY id").all()
const rawApiMode = (tool: string) => db.prepare('SELECT raw_api_mode AS mode, revision FROM tools WHERE name = ?').get(tool)

test('tools report the Raw API modes they can be set to', async () => {
  const source = new EmbeddedSecretSource(store)
  adapters.push(createAwxAdapter(source), createTenableAdapter(source, join(directory, 'tenable-writes.log')), createLdapAdapter(source))
  const { tools } = await (await request('GET', '')).json() as { tools: unknown[] }
  const rawApi = Object.fromEntries(tools.map(item => adminToolSchema.parse(item)).map(item => [item.name, item.rawApi]))
  expect(rawApi['az-axi']).toEqual({ mode: 'off', modes: ['off', 'read', 'read-writes'] })
  expect(rawApi['vectra-axi']).toEqual({ mode: 'off', modes: ['off', 'read', 'read-writes'] })
  for (const tool of ['falcon-axi', 'tenable-axi', 'awx-axi']) {
    expect(rawApi[tool]).toEqual({ mode: 'off', modes: ['off', 'read', 'read-writes'] })
  }
  expect(rawApi['ldap-axi']).toEqual({ mode: 'off', modes: [] })
})

test.each(['falcon-axi', 'tenable-axi', 'awx-axi'])('an administrator enables Raw API mode and role access for %s', async tool => {
  const source = new EmbeddedSecretSource(store)
  adapters.push(createAwxAdapter(source), createTenableAdapter(source, join(directory, 'tenable-writes.log')))
  const before = adminToolSchema.parse(await (await request('GET', `/${tool}`)).json())
  const changed = await request('PATCH', `/${tool}/raw-api`, { mode: 'read-writes', expectedRevision: before.revision })
  expect(changed.status).toBe(200)
  expect(adminToolSchema.parse(await changed.json()).rawApi.mode).toBe('read-writes')
  const role = adminRoleSchema.parse(await (await roleRequest('GET', '/synthetic-role')).json())
  const granted = await roleRequest('PUT', `/synthetic-role/tools/${tool}/raw-api`, { enabled: true, expectedRevision: role.revision })
  expect(granted.status).toBe(200)
  expect(adminRoleSchema.parse(await granted.json()).rawApiTools).toContain(tool)
})

test('an administrator changes a tool Raw API mode, the change is journaled and a repeat records nothing', async () => {
  const before = adminToolSchema.parse(await (await request('GET', '/az-axi')).json())
  const changed = await request('PATCH', '/az-axi/raw-api', { mode: 'read-writes', expectedRevision: before.revision })
  expect(changed.status).toBe(200)
  expect(adminToolSchema.parse(await changed.json())).toMatchObject({ rawApi: { mode: 'read-writes' }, revision: before.revision + 1, updatedBy: actor })
  expect(rawApiMode('az-axi')).toEqual({ mode: 'read-writes', revision: before.revision + 1 })
  expect(adminChanges()).toEqual([{ action: 'set-tool-raw-api-read-writes', targetId: 'az-axi', tool: 'az-axi', userId: actor, outcome: 'success' }])
  const repeated = await request('PATCH', '/az-axi/raw-api', { mode: 'read-writes', expectedRevision: before.revision + 1 })
  expect(repeated.status).toBe(200)
  expect(adminChanges()).toHaveLength(1)
  expect(rawApiMode('az-axi')).toEqual({ mode: 'read-writes', revision: before.revision + 1 })
  await request('PATCH', '/az-axi/raw-api', { mode: 'off', expectedRevision: before.revision + 1 })
  expect(adminChanges().map(change => (change as { action: string }).action)).toEqual(['set-tool-raw-api-read-writes', 'set-tool-raw-api-off'])
})

test.each([
  ['a tool without raw API routes', 'ldap-axi', { mode: 'read' }, 'INVALID_INPUT'],
  ['an unknown mode', 'az-axi', { mode: 'writes' }, 'INVALID_INPUT'],
  ['a stale revision', 'az-axi', { mode: 'off', expectedRevision: 99 }, 'REVISION_CONFLICT'],
] as const)('a tool Raw API change with %s is refused and recorded nowhere', async (_name, tool, body, code) => {
  adapters.push(createLdapAdapter(new EmbeddedSecretSource(store)))
  const current = adminToolSchema.parse(await (await request('GET', `/${tool}`)).json())
  const before = rawApiMode(tool)
  await failure(await request('PATCH', `/${tool}/raw-api`, { expectedRevision: current.revision, ...body }), code)
  expect(rawApiMode(tool)).toEqual(before)
  expect(adminChanges()).toEqual([])
})

test('only an administrator changes a tool Raw API mode', async () => {
  const ordinary = await adminHeaders('synthetic-ordinary')
  await failure(await request('PATCH', '/az-axi/raw-api', { mode: 'off', expectedRevision: 1 }, ordinary), 'ADMIN_REQUIRED')
  expect(rawApiMode('az-axi')).toMatchObject({ mode: 'off' })
})

test('an administrator allows and removes Raw API on a role grant, journaled against the tool', async () => {
  const before = adminRoleSchema.parse(await (await roleRequest('GET', '/synthetic-role')).json())
  expect(before.rawApiTools).toEqual([])
  const granted = await roleRequest('PUT', '/synthetic-role/tools/az-axi/raw-api', { enabled: true, expectedRevision: before.revision })
  expect(granted.status).toBe(200)
  expect(adminRoleSchema.parse(await granted.json())).toMatchObject({ rawApiTools: ['az-axi'], revision: before.revision + 1 })
  const repeated = await roleRequest('PUT', '/synthetic-role/tools/az-axi/raw-api', { enabled: true, expectedRevision: before.revision + 1 })
  expect(adminRoleSchema.parse(await repeated.json())).toMatchObject({ rawApiTools: ['az-axi'], revision: before.revision + 1 })
  const revoked = await roleRequest('PUT', '/synthetic-role/tools/az-axi/raw-api', { enabled: false, expectedRevision: before.revision + 1 })
  expect(adminRoleSchema.parse(await revoked.json())).toMatchObject({ rawApiTools: [], revision: before.revision + 2 })
  expect(adminChanges()).toEqual([
    { action: 'grant-role-raw-api', targetId: 'synthetic-role', tool: 'az-axi', userId: actor, outcome: 'success' },
    { action: 'revoke-role-raw-api', targetId: 'synthetic-role', tool: 'az-axi', userId: actor, outcome: 'success' },
  ])
})

test.each([
  ['a tool without raw API routes', 'ldap-axi', 1, 'INVALID_INPUT'],
  ['a tool the role does not grant', 'ado-axi', 1, 'INVALID_INPUT'],
  ['a stale revision', 'az-axi', 99, 'REVISION_CONFLICT'],
] as const)('a role Raw API change for %s is refused and recorded nowhere', async (_name, tool, expectedRevision, code) => {
  adapters.push(createLdapAdapter(new EmbeddedSecretSource(store)))
  db.exec("DELETE FROM role_tools WHERE tool = 'ado-axi'")
  await failure(await roleRequest('PUT', `/synthetic-role/tools/${tool}/raw-api`, { enabled: true, expectedRevision }), code)
  expect(db.prepare('SELECT COUNT(*) AS granted FROM role_tools WHERE raw_api = 1').get()).toEqual({ granted: 0 })
  expect(adminChanges()).toEqual([])
})

test('Raw API settings made through the admin routes decide raw calls', async () => {
  const az = adapters.find(adapter => adapter.name === 'az-axi')!
  const raw = (args: string[]) => () => checkRawApiPolicy(db, actor, az, args)
  const read = ['api', 'GET', '/subscriptions']
  const write = ['api', 'PUT', '/subscriptions/synthetic', '--execute']
  const setMode = async (mode: string) => {
    const { revision } = adminToolSchema.parse(await (await request('GET', '/az-axi')).json())
    expect((await request('PATCH', '/az-axi/raw-api', { mode, expectedRevision: revision })).status).toBe(200)
  }
  const setGrant = async (enabled: boolean) => {
    const { revision } = adminRoleSchema.parse(await (await roleRequest('GET', '/synthetic-role')).json())
    expect((await roleRequest('PUT', '/synthetic-role/tools/az-axi/raw-api', { enabled, expectedRevision: revision })).status).toBe(200)
  }
  await setGrant(true)
  await setMode('off')
  expect(raw(read)).toThrow(expect.objectContaining({ code: 'RAW_API_DENIED' }))
  await setMode('read')
  expect(raw(read)).not.toThrow()
  expect(raw(write)).toThrow(expect.objectContaining({ code: 'RAW_API_DENIED' }))
  await setMode('read-writes')
  expect(raw(write)).not.toThrow()
  await setGrant(false)
  expect(raw(read)).toThrow(expect.objectContaining({ code: 'RAW_API_DENIED' }))
})

test('read-writes mode on a read-only raw tool permits reads', async () => {
  const vectra = adapters.find(adapter => adapter.name === 'vectra-axi')!
  const tool = adminToolSchema.parse(await (await request('GET', '/vectra-axi')).json())
  const role = adminRoleSchema.parse(await (await roleRequest('GET', '/synthetic-role')).json())
  const changed = await request('PATCH', '/vectra-axi/raw-api', { mode: 'read-writes', expectedRevision: tool.revision })
  expect(adminToolSchema.parse(await changed.json()).rawApi.mode).toBe('read-writes')
  expect((await roleRequest('PUT', '/synthetic-role/tools/vectra-axi/raw-api', { enabled: true, expectedRevision: role.revision })).status).toBe(200)
  expect(() => checkRawApiPolicy(db, actor, vectra, ['api', 'get', '--path', '/detections'])).not.toThrow()
})

test('the tool and role pages offer the Raw API controls', async () => {
  const source = new EmbeddedSecretSource(store)
  adapters.push(createAwxAdapter(source), createTenableAdapter(source, join(directory, 'tenable-writes.log')), createLdapAdapter(source))
  const cookie = await browserCookie()
  const tool = await app.inject({ method: 'GET', url: '/admin/tools/az-axi?tab=raw-api', headers: { cookie } })
  expect(tool.statusCode).toBe(200)
  expect(tool.body).toContain('action="/v1/admin/tools/az-axi/raw-api"')
  expect(tool.body.match(/name="mode" value="(off|read|read-writes)"( checked)?/g)).toEqual([
    'name="mode" value="off" checked', 'name="mode" value="read"', 'name="mode" value="read-writes"'])
  const readOnly = await app.inject({ method: 'GET', url: '/admin/tools/vectra-axi?tab=raw-api', headers: { cookie } })
  expect(readOnly.body.match(/name="mode" value="(off|read|read-writes)"( checked)?/g)).toEqual([
    'name="mode" value="off" checked', 'name="mode" value="read"', 'name="mode" value="read-writes"'])
  const unavailable = await app.inject({ method: 'GET', url: '/admin/tools/ldap-axi?tab=raw-api', headers: { cookie } })
  expect(unavailable.body).not.toContain('/raw-api"')
  const role = await app.inject({ method: 'GET', url: '/admin/roles/synthetic-role', headers: { cookie } })
  expect(role.body).toContain('action="/v1/admin/roles/synthetic-role/tools/az-axi/raw-api"')
  expect(role.body).toContain('action="/v1/admin/roles/synthetic-role/tools/vectra-axi/raw-api"')
  for (const name of ['falcon-axi', 'tenable-axi', 'awx-axi']) {
    const page = await app.inject({ method: 'GET', url: `/admin/tools/${name}?tab=raw-api`, headers: { cookie } })
    expect(page.body).toContain(`action="/v1/admin/tools/${name}/raw-api"`)
    expect(role.body).toContain(`action="/v1/admin/roles/synthetic-role/tools/${name}/raw-api"`)
  }
  expect(role.body).not.toContain('/tools/ldap-axi/raw-api"')
})

async function browserCookie() {
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  expect(login.statusCode).toBe(303)
  return login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}
