import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { ProviderCredentials } from '../../src/server/store/provider-credentials.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { createTestCertificates } from '../fake-service/certificates.mjs'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
let credentials: ProviderCredentials
const tenantId = '11111111-1111-4111-8111-111111111111'
const clientId = '22222222-2222-4222-8222-222222222222'
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const base = '/v1/admin/sso/providers'

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-admin-providers-'))
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  const store = createCredentialStore(db, key)
  credentials = new ProviderCredentials(db, key)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db),
    adapters: [], credentialStore: store, providerCredentials: credentials, resolver: new SharedIdentityResolver(store), environment: {} })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  headers = { authorization: 'Bearer ' + login.json().accessToken }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  headers['x-artium-reauth-ticket'] = reauth.json().ticket
  db.exec('DELETE FROM audit')
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

async function create() {
  const response = await app.inject({ method: 'POST', url: base, headers, payload: { name: 'Synthetic provider', tenantId } })
  expect(response.statusCode).toBe(200)
  return response.json()
}
async function save(id: string, value: Record<string, unknown>, expectedRevision = 0, expectedProviderRevision = 1) {
  return app.inject({ method: 'PATCH', url: base + '/' + id + '/credential', headers,
    payload: { value, expectedRevision, expectedProviderRevision } })
}
const value = { tenantId, clientId, auth: 'secret', clientSecret: 'CANARY-provider-secret' }

test('provider changes are audited, revision checked and cannot enable SSO', async () => {
  const provider = await create()
  expect(provider).toMatchObject({ kind: 'entra', enabled: false, revision: 1,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, tenantId })
  const url = base + '/' + provider.id
  const payload = { name: 'Renamed provider', tenantId, expectedRevision: 1 }
  expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...payload, enabled: true } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'PATCH', url, headers, payload })).statusCode).toBe(200)
  const stale = await app.inject({ method: 'PATCH', url, headers, payload })
  expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  const list = await app.inject({ method: 'GET', url: base, headers })
  expect(list.json().providers).toEqual([expect.objectContaining({ name: payload.name, enabled: false, revision: 2 })])
  expect(db.prepare("SELECT action FROM audit WHERE outcome = 'success' ORDER BY rowid").all())
    .toEqual([{ action: 'create-provider' }, { action: 'update-provider' }])
})

test('encrypted provider secrets never appear in responses or audit and omitted secrets are retained', async () => {
  const provider = await create()
  const saved = await save(provider.id, value)
  expect(saved.statusCode).toBe(200)
  expect(saved.json()).toMatchObject({ configured: true, revision: 1, metadata: { tenantId, clientId, auth: 'secret' } })
  expect(saved.body).not.toContain(value.clientSecret)
  const { clientSecret: _, ...publicValue } = value
  expect((await save(provider.id, publicValue, 1, 2)).statusCode).toBe(200)
  expect(credentials.read(provider.id)?.value).toEqual(value)
  const read = await app.inject({ method: 'GET', url: base + '/' + provider.id + '/credential', headers })
  expect(read.body).not.toContain('clientSecret')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(value.clientSecret)
  const row = db.prepare('SELECT ciphertext, enabled FROM provider_credentials JOIN sso_providers USING (id)').get() as { ciphertext: Buffer, enabled: number }
  expect(row.ciphertext.includes(Buffer.from(value.clientSecret))).toBe(false)
  expect(row.enabled).toBe(0)
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE action = 'replace-provider-credential' AND outcome = 'success'").get()).toEqual({ count: 2 })
})

test.each([
  { change: 'client', patch: { clientId: '33333333-3333-4333-8333-333333333333' } },
  { change: 'authentication', patch: { auth: 'certificate', thumbprintSha256: 'a'.repeat(64) } },
  { change: 'empty secret', patch: { clientSecret: '' } },
  { change: 'tenant mismatch', patch: { tenantId: '33333333-3333-4333-8333-333333333333', clientSecret: 'CANARY-replacement' } },
])('rejects $change without changing the stored credential', async ({ patch }) => {
  const provider = await create()
  expect((await save(provider.id, value)).statusCode).toBe(200)
  const { clientSecret: _, ...publicValue } = value
  expect((await save(provider.id, { ...publicValue, ...patch }, 1, 2)).statusCode).toBe(400)
  expect(credentials.read(provider.id)).toMatchObject({ value, revision: 1 })
})

test('tenant changes clear the old credential and stale editors cannot restore it', async () => {
  const provider = await create()
  expect((await save(provider.id, value)).statusCode).toBe(200)
  expect((await app.inject({ method: 'PATCH', url: base + '/' + provider.id, headers,
    payload: { name: provider.name, tenantId: '33333333-3333-4333-8333-333333333333', expectedRevision: 2 } })).statusCode).toBe(200)
  expect(credentials.read(provider.id)).toBeUndefined()
  expect((await save(provider.id, value, 1, 2)).json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
})

test('credential replacement checks both revisions before mutating', async () => {
  const provider = await create()
  expect((await save(provider.id, value)).statusCode).toBe(200)
  expect((await save(provider.id, { ...value, clientSecret: 'CANARY-replacement' }, 0, 2)).json())
    .toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  expect((await save(provider.id, { ...value, clientSecret: 'CANARY-replacement' }, 1, 1)).json())
    .toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  expect(credentials.read(provider.id)).toMatchObject({ value, revision: 1 })
})

test('combined certificate PEM preserves private key newlines and rejects mismatched keys', async () => {
  const provider = await create()
  createTestCertificates(directory, ['synthetic.example'])
  const certificate = readFileSync(join(directory, 'server.crt'), 'utf8')
  const privateKey = readFileSync(join(directory, 'server.key'), 'utf8')
  const saved = await save(provider.id, { tenantId, clientId, auth: 'certificate', certificatePem: certificate + privateKey })
  expect(saved.statusCode).toBe(200)
  expect(credentials.read(provider.id)?.value.privateKey).toBe(privateKey)
  expect(saved.body).not.toContain('PRIVATE KEY')
  const mismatched = await save(provider.id, { tenantId, clientId, auth: 'certificate',
    certificatePem: certificate + readFileSync(join(directory, 'ca.key'), 'utf8') }, 1, 2)
  expect(mismatched.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect(credentials.read(provider.id)?.revision).toBe(1)
})

test('credential save rolls back when its audit cannot persist', async () => {
  const provider = await create()
  db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit WHEN NEW.action = 'replace-provider-credential' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  expect((await save(provider.id, value)).json()).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } })
  expect(credentials.read(provider.id)).toBeUndefined()
  expect(db.prepare('SELECT revision FROM sso_providers WHERE id = ?').get(provider.id)).toEqual({ revision: 1 })
})

test('provider mutation requires administrator capability and recent authentication', async () => {
  const payload = { name: 'Synthetic provider', tenantId }
  const authorization = { authorization: headers.authorization }
  expect((await app.inject({ method: 'POST', url: base, headers: authorization, payload })).json())
    .toMatchObject({ error: { code: 'REAUTH_REQUIRED' } })
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator)
    SELECT 'synthetic-other-admin', 'synthetic-other-admin', 'Other admin', password_hash, 1 FROM users LIMIT 1;
    UPDATE users SET administrator = 0 WHERE id = 'synthetic-development-user'`)
  expect((await app.inject({ method: 'POST', url: base, headers, payload })).json())
    .toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
})

const rulesBase = '/v1/admin/sso/role-rules'
async function createRule() {
  const provider = await create()
  const input = { providerId: provider.id, claim: 'roles', value: 'Artium.Readers', roleId: 'synthetic-role' }
  const response = await app.inject({ method: 'POST', url: rulesBase, headers, payload: input })
  expect(response.statusCode).toBe(200)
  return { rule: response.json(), input }
}

test('rule create, edit and remove are audited without enabling providers or changing user grants', async () => {
  const grants = db.prepare('SELECT * FROM user_roles').all()
  const { rule, input } = await createRule()
  expect(rule).toMatchObject({ ...input, revision: 1, updatedBy: 'synthetic-development-user', updatedAt: expect.any(Number) })
  db.exec("INSERT INTO roles (id, name) VALUES ('synthetic-other-role', 'Other role')")
  const payload = { ...input, value: 'Artium.Analysts', roleId: 'synthetic-other-role', expectedRevision: 1 }
  const edited = await app.inject({ method: 'PATCH', url: rulesBase + '/' + rule.id, headers, payload })
  expect(edited.json()).toMatchObject({ ...input, value: 'Artium.Analysts', roleId: 'synthetic-other-role', revision: 2 })
  const list = await app.inject({ method: 'GET', url: rulesBase + '?providerId=' + input.providerId, headers })
  expect(list.json().rules).toEqual([edited.json()])
  const other = await create()
  expect((await app.inject({ method: 'GET', url: rulesBase + '?providerId=' + other.id, headers })).json()).toEqual({ rules: [] })
  const removed = await app.inject({ method: 'DELETE', url: rulesBase + '/' + rule.id, headers, payload: { expectedRevision: 2 } })
  expect(removed.json()).toEqual({ id: rule.id, deleted: true })
  expect((await app.inject({ method: 'GET', url: rulesBase + '?providerId=' + input.providerId, headers })).json()).toEqual({ rules: [] })
  expect(db.prepare('SELECT * FROM user_roles').all()).toEqual(grants)
  expect(db.prepare('SELECT DISTINCT enabled FROM sso_providers').all()).toEqual([{ enabled: 0 }])
  expect(db.prepare("SELECT action, target_id, user_id FROM audit WHERE action LIKE '%role-rule' ORDER BY id").all()).toEqual([
    { action: 'create-role-rule', target_id: rule.id, user_id: 'synthetic-development-user' },
    { action: 'update-role-rule', target_id: rule.id, user_id: 'synthetic-development-user' },
    { action: 'delete-role-rule', target_id: rule.id, user_id: 'synthetic-development-user' },
  ])
})

test.each(['PATCH', 'DELETE'] as const)('stale %s of a rule preserves the current mapping and audit', async method => {
  const { rule, input } = await createRule()
  const url = rulesBase + '/' + rule.id
  expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...input, value: 'Artium.Analysts', expectedRevision: 1 } })).statusCode).toBe(200)
  const response = await app.inject({ method, url, headers, payload: method === 'PATCH' ? { ...input, expectedRevision: 1 } : { expectedRevision: 1 } })
  expect(response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  expect(db.prepare('SELECT value, revision FROM role_rules WHERE id = ?').get(rule.id)).toEqual({ value: 'Artium.Analysts', revision: 2 })
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE action LIKE '%role-rule'").get()).toEqual({ count: 2 })
})

test.each([
  { label: 'duplicate mapping', patch: {}, code: 'INVALID_INPUT' },
  { label: 'missing role', patch: { roleId: 'missing' }, code: 'NOT_FOUND' },
  { label: 'missing provider', patch: { providerId: 'missing' }, code: 'NOT_FOUND' },
  { label: 'unsupported claim', patch: { claim: 'administrator' }, code: 'INVALID_INPUT' },
  { label: 'empty value', patch: { value: '  ' }, code: 'INVALID_INPUT' },
])('rejects $label on rule creation and editing', async ({ patch, code }) => {
  const { input } = await createRule()
  const second = await app.inject({ method: 'POST', url: rulesBase, headers, payload: { ...input, value: 'Artium.Other' } })
  const createResponse = await app.inject({ method: 'POST', url: rulesBase, headers, payload: { ...input, ...patch } })
  expect(createResponse.json()).toMatchObject({ error: { code } })
  const editResponse = await app.inject({ method: 'PATCH', url: rulesBase + '/' + second.json().id, headers, payload: { ...input, ...patch, expectedRevision: 1 } })
  expect(editResponse.json()).toMatchObject({ error: { code } })
  expect(db.prepare('SELECT count(*) AS count FROM role_rules').get()).toEqual({ count: 2 })
  expect(db.prepare('SELECT value, revision FROM role_rules WHERE id = ?').get(second.json().id)).toEqual({ value: 'Artium.Other', revision: 1 })
})

test.each(['POST', 'PATCH', 'DELETE'] as const)('rule %s rolls back when audit cannot persist', async method => {
  const { rule, input } = await createRule()
  db.exec("CREATE TRIGGER synthetic_rule_audit_failure BEFORE INSERT ON audit WHEN NEW.action LIKE '%role-rule' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const response = await app.inject({ method, url: rulesBase + (method === 'POST' ? '' : '/' + rule.id), headers,
    payload: method === 'DELETE' ? { expectedRevision: 1 } : { ...input, value: 'Artium.Other', ...(method === 'PATCH' ? { expectedRevision: 1 } : {}) } })
  expect(response.json()).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } })
  expect(db.prepare('SELECT value, revision FROM role_rules').all()).toEqual([{ value: input.value, revision: 1 }])
})

test.each(['POST', 'PATCH', 'DELETE'] as const)('rule %s requires administrator capability and recent authentication', async method => {
  const { rule, input } = await createRule()
  const request = { method, url: rulesBase + (method === 'POST' ? '' : '/' + rule.id),
    payload: method === 'DELETE' ? { expectedRevision: 1 } : { ...input, value: 'Artium.Other', ...(method === 'PATCH' ? { expectedRevision: 1 } : {}) } }
  expect((await app.inject({ ...request, headers: { authorization: headers.authorization } })).json())
    .toMatchObject({ error: { code: 'REAUTH_REQUIRED' } })
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator)
    SELECT 'synthetic-other-admin', 'synthetic-other-admin', 'Other admin', password_hash, 1 FROM users LIMIT 1;
    UPDATE users SET administrator = 0 WHERE id = 'synthetic-development-user'`)
  expect((await app.inject({ ...request, headers })).json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
  expect(db.prepare('SELECT value, revision FROM role_rules').all()).toEqual([{ value: input.value, revision: 1 }])
})

test('referenced rules and roles cannot be removed or retargeted while preserving existing grants', async () => {
  const { rule, input } = await createRule()
  const tools = db.prepare('SELECT * FROM role_tools WHERE role_id = ?').all(input.roleId)
  db.prepare('INSERT INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)').run('synthetic-development-user', input.roleId, rule.id)
  db.exec("INSERT INTO roles (id, name) VALUES ('synthetic-other-role', 'Other role')")
  const changed = await app.inject({ method: 'PATCH', url: rulesBase + '/' + rule.id, headers,
    payload: { ...input, roleId: 'synthetic-other-role', expectedRevision: 1 } })
  expect(changed.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  const removed = await app.inject({ method: 'DELETE', url: rulesBase + '/' + rule.id, headers, payload: { expectedRevision: 1 } })
  expect(removed.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect(db.prepare('SELECT origin FROM user_roles').all()).toEqual(expect.arrayContaining([{ origin: 'direct' }, { origin: rule.id }]))
  db.prepare('DELETE FROM user_roles WHERE origin = ?').run(rule.id)
  db.exec("DELETE FROM user_roles WHERE origin = 'direct'")
  const role = await app.inject({ method: 'DELETE', url: '/v1/admin/roles/' + input.roleId, headers, payload: { expectedRevision: 1 } })
  expect(role.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'This role is used by an SSO rule.' } })
  expect(db.prepare('SELECT * FROM role_tools WHERE role_id = ?').all(input.roleId)).toEqual(tools)
})
