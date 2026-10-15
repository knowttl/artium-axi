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
