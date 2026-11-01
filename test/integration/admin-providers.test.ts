import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
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
  vi.restoreAllMocks()
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

test('generic provider settings retain secrets only for the same client and clear credentials on issuer change', async () => {
  const created = await app.inject({ method: 'POST', url: base, headers,
    payload: { name: 'Synthetic OIDC', kind: 'oidc', issuer: 'https://identity.example' } })
  expect(created.statusCode).toBe(200)
  const provider = created.json()
  expect(provider).toMatchObject({ kind: 'oidc', enabled: false, issuer: 'https://identity.example' })
  const credential = { clientId: 'synthetic-web-client', auth: 'secret', clientSecret: 'CANARY-oidc-secret' }
  expect((await save(provider.id, credential)).statusCode).toBe(200)
  const metadata = await app.inject({ url: base + '/' + provider.id + '/credential', headers })
  expect(metadata.json().metadata).toEqual({ clientId: credential.clientId, auth: 'secret' })
  expect(metadata.body).not.toContain(credential.clientSecret)
  expect((await save(provider.id, { clientId: credential.clientId, auth: 'secret' }, 1, 2)).statusCode).toBe(200)
  expect(credentials.read(provider.id)!.value.clientSecret).toBe(credential.clientSecret)
  expect((await save(provider.id, { clientId: 'another-client', auth: 'secret' }, 2, 3)).statusCode).toBe(400)
  const changed = await app.inject({ method: 'PATCH', url: base + '/' + provider.id, headers,
    payload: { name: provider.name, kind: 'oidc', issuer: 'https://second.example', expectedRevision: 3 } })
  expect(changed.statusCode).toBe(200)
  expect(credentials.read(provider.id)).toBeUndefined()
  expect(db.prepare('SELECT action FROM audit ORDER BY id').all()).toEqual([
    { action: 'create-provider' }, { action: 'replace-provider-credential' },
    { action: 'replace-provider-credential' }, { action: 'update-provider' },
  ])
})

test.each(['http://identity.example', 'https://user:password@identity.example', 'https://identity.example?other=1', 'https://identity.example#other'])
  ('generic provider rejects unsuitable discovery issuer %s', async issuer => {
    const response = await app.inject({ method: 'POST', url: base, headers, payload: { name: 'Synthetic', kind: 'oidc', issuer } })
    expect(response.statusCode).toBe(400)
    expect(db.prepare('SELECT count(*) AS count FROM sso_providers').get()).toEqual({ count: 0 })
  })

test('generic provider activation requires a usable credential and break-glass administrator', async () => {
  const created = await app.inject({ method: 'POST', url: base, headers,
    payload: { name: 'Synthetic OIDC', kind: 'oidc', issuer: 'https://identity.example' } })
  const provider = created.json()
  db.exec('UPDATE users SET break_glass = 1')
  expect((await activation(provider.id, true, 1)).statusCode).toBe(400)
  expect((await save(provider.id, { clientId: 'synthetic-client', auth: 'secret', clientSecret: 'CANARY-oidc-secret' })).statusCode).toBe(200)
  expect((await activation(provider.id)).json()).toMatchObject({ kind: 'oidc', enabled: true })
})

test('setup guide Users link opens the users page', async () => {
  const provider = await create()
  const session = createBrowserSession(db, 'synthetic-development-user', 'CANARY-csrf')
  const browserHeaders = { cookie: `${browserCookie}=${session.id}` }
  const guide = await app.inject({ url: '/admin/settings/sign-in/' + provider.id, headers: browserHeaders })
  expect(guide.statusCode).toBe(200)
  const setupGuide = guide.body.split('<h2>Entra setup guide</h2>')[1]!
  const usersLink = setupGuide.match(/<a href="([^"]+)">Users<\/a>/)![1]!
  const users = await app.inject({ url: usersLink, headers: browserHeaders })
  expect(users.statusCode).toBe(200)
  expect(users.body).toContain('<h1>People</h1>')
})

async function activation(id: string, enabled = true, expectedRevision = 2, authorization = headers) {
  return app.inject({ method: 'PATCH', url: base + '/' + id + '/activation', headers: authorization,
    payload: { enabled, expectedRevision } })
}

test.each([
  { label: 'missing credential', credential: undefined, account: 'break_glass = 1' },
  { label: 'wrong tenant', credential: { ...value, tenantId: clientId }, account: 'break_glass = 1' },
  { label: 'blank secret', credential: { ...value, clientSecret: '   ' }, account: 'break_glass = 1' },
  { label: 'invalid private key', credential: { tenantId, clientId, auth: 'certificate', privateKey: 'CANARY-invalid', thumbprintSha256: '11'.repeat(32) }, account: 'break_glass = 1' },
  { label: 'no designation', credential: value, account: 'break_glass = 0' },
  { label: 'temporary password', credential: value, account: 'break_glass = 1, must_change = 1' },
  { label: 'locked administrator', credential: value, account: 'break_glass = 1, locked_until = 9999999999999' },
  { label: 'unusable password', credential: value, account: "break_glass = 1, password_hash = 'unusable'" },
  { label: 'disabled administrator', credential: value, account: 'break_glass = 1, disabled = 1' },
  { label: 'archived administrator', credential: value, account: 'break_glass = 1, disabled = 1, archived_at = 1' },
])('activation refuses $label without changing policy', async ({ credential, account }) => {
  const provider = await create()
  if (credential) credentials.replace(provider.id, credential, 0, 'synthetic-development-user', Date.now())
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change, administrator)
    SELECT 'synthetic-other-admin', 'synthetic-other-admin', 'Other administrator', password_hash, 0, 1 FROM users LIMIT 1`)
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-other-admin', password: 'CANARY-local-password' } })
  const otherHeaders = { authorization: 'Bearer ' + login.json().accessToken, 'x-artium-reauth-ticket': '' }
  const proof = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers: otherHeaders, payload: { password: 'CANARY-local-password' } })
  otherHeaders['x-artium-reauth-ticket'] = proof.json().ticket
  db.exec("UPDATE users SET " + account + " WHERE id = 'synthetic-development-user'")
  const response = await activation(provider.id, true, 1, otherHeaders)
  expect(response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect(db.prepare('SELECT enabled, revision FROM sso_providers').get()).toEqual({ enabled: 0, revision: 1 })
})

test('activation and deactivation are revision checked and audited; saving a credential disables sign-in again', async () => {
  const provider = await create()
  await save(provider.id, value)
  db.exec('UPDATE users SET break_glass = 1')
  expect((await activation(provider.id)).json()).toMatchObject({ enabled: true, revision: 3 })
  expect((await app.inject({ method: 'GET', url: base, headers })).json().providers[0].enabled).toBe(true)
  expect((await activation(provider.id, false, 2)).json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  expect((await activation(provider.id, false, 3)).json()).toMatchObject({ enabled: false, revision: 4 })
  expect((await activation(provider.id, true, 4)).statusCode).toBe(200)
  expect((await save(provider.id, value, 1, 5)).statusCode).toBe(200)
  expect(db.prepare('SELECT enabled, revision FROM sso_providers').get()).toEqual({ enabled: 0, revision: 6 })
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE action = 'update-local-policy'").get()).toEqual({ count: 3 })
})

test('activation rolls policy back if audit persistence fails', async () => {
  const provider = await create()
  await save(provider.id, value)
  db.exec("UPDATE users SET break_glass = 1; CREATE TRIGGER synthetic_policy_audit BEFORE INSERT ON audit WHEN NEW.action = 'update-local-policy' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  expect((await activation(provider.id)).json()).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } })
  expect(db.prepare('SELECT enabled, revision FROM sso_providers').get()).toEqual({ enabled: 0, revision: 2 })
})

test('activation requires recent administrator authentication', async () => {
  const provider = await create()
  await save(provider.id, value)
  expect((await activation(provider.id, true, 2, {})).json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } })
  expect((await activation(provider.id, true, 2, { authorization: headers.authorization! })).json()).toMatchObject({ error: { code: 'REAUTH_REQUIRED' } })
  db.exec(`INSERT INTO users (id, username, display_name, source, must_change, administrator)
    VALUES ('synthetic-other-admin', 'synthetic-other-admin', 'Other administrator', 'sso', 0, 1);
    UPDATE users SET administrator = 0 WHERE id = 'synthetic-development-user'`)
  expect((await activation(provider.id)).json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
})

const invitationsBase = '/v1/admin/sso/invitations'
async function invite(extra: Record<string, unknown> = {}) {
  const provider = await create()
  return app.inject({ method: 'POST', url: invitationsBase, headers, payload: {
    providerId: provider.id, expectedUsername: 'synthetic@identity.example', displayName: 'Synthetic invited user',
    roleIds: ['synthetic-role'], ...extra } })
}

test('invitation creation stores only a hash, direct roles and a seven-day expiry without granting access', async () => {
  const response = await invite()
  expect(response.statusCode).toBe(201)
  expect(response.headers['cache-control']).toBe('no-store')
  const { invitation, claimPath } = response.json()
  expect(invitation).toMatchObject({ status: 'pending', userId: null, roleIds: ['synthetic-role'], revision: 1 })
  expect(invitation.expiresAt - invitation.createdAt).toBe(7 * 86_400_000)
  const token = new URL(claimPath, 'https://artium.example').searchParams.get('invitation')!
  const { hashToken } = await import('../../src/server/auth/tokens.js')
  expect(db.prepare('SELECT token_hash FROM invitations WHERE id = ?').get(invitation.id)).toEqual({ token_hash: hashToken(token) })
  expect(db.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
  const list = await app.inject({ method: 'GET', url: invitationsBase, headers })
  expect(list.json().invitations).toEqual([invitation])
  expect(list.body).not.toContain(token)
  expect(list.body).not.toContain(hashToken(token))
  const audit = JSON.stringify(db.prepare("SELECT * FROM audit WHERE event = 'invite-create'").all())
  expect(audit).toContain(invitation.id)
  expect(audit).not.toContain(token)
  expect(audit).not.toContain(hashToken(token))
  expect(db.prepare('SELECT DISTINCT enabled FROM sso_providers').all()).toEqual([{ enabled: 0 }])
})

test('link invitations retain a local account and its grants until claim', async () => {
  const before = db.prepare('SELECT * FROM users').all()
  const grants = db.prepare('SELECT * FROM user_roles').all()
  const response = await invite({ userId: 'synthetic-development-user' })
  expect(response.statusCode).toBe(201)
  expect(response.json().invitation.userId).toBe('synthetic-development-user')
  expect(db.prepare('SELECT * FROM users').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM user_roles').all()).toEqual(grants)
  expect(db.prepare('SELECT * FROM identities').all()).toEqual([])
})

test('resend rotates the stored link and revoke ends it with revision checks and audit', async () => {
  const { invitation, claimPath } = (await invite()).json()
  const original = db.prepare('SELECT token_hash FROM invitations WHERE id = ?').get(invitation.id)
  const resend = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/resend', headers,
    payload: { expectedRevision: 1, expiresInDays: 2 } })
  expect(resend.statusCode).toBe(200)
  expect(resend.json().claimPath).not.toBe(claimPath)
  expect(resend.json().invitation).toMatchObject({ revision: 2, status: 'pending' })
  expect(db.prepare('SELECT token_hash FROM invitations WHERE id = ?').get(invitation.id)).not.toEqual(original)
  const stale = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/revoke', headers,
    payload: { expectedRevision: 1 } })
  expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  const revoked = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/revoke', headers,
    payload: { expectedRevision: 2 } })
  expect(revoked.json()).toMatchObject({ status: 'revoked', revision: 3 })
  const refused = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/resend', headers,
    payload: { expectedRevision: 3 } })
  expect(refused.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect(db.prepare("SELECT event, target_id FROM audit WHERE event LIKE 'invite-%' ORDER BY id").all()).toEqual([
    { event: 'invite-create', target_id: invitation.id }, { event: 'invite-resend', target_id: invitation.id },
    { event: 'invite-revoke', target_id: invitation.id },
  ])
})

test('expiry is inclusive and an expired invitation can be resent with a fresh lifetime', async () => {
  const { invitation } = (await invite({ expiresInDays: 1 })).json()
  vi.spyOn(Date, 'now').mockReturnValue(invitation.expiresAt)
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  headers = { authorization: 'Bearer ' + login.json().accessToken }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  headers['x-artium-reauth-ticket'] = reauth.json().ticket
  const list = await app.inject({ method: 'GET', url: invitationsBase, headers })
  expect(list.json().invitations[0].status).toBe('expired')
  const resent = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/resend', headers,
    payload: { expectedRevision: 1, expiresInDays: 3 } })
  expect(resent.json().invitation).toMatchObject({ status: 'pending', expiresAt: invitation.expiresAt + 3 * 86_400_000 })
})

test.each([
  { providerId: 'missing' }, { roleIds: ['missing'] }, { roleIds: ['synthetic-role', 'synthetic-role'] },
  { userId: 'missing' }, { expiresInDays: 0 }, { expiresInDays: 31 }, { expectedUsername: ' ' },
])('invalid invitation input leaves no invitation or audit behind: %j', async extra => {
  const response = await invite(extra)
  expect(response.statusCode).toBeGreaterThanOrEqual(400)
  expect(db.prepare('SELECT * FROM invitations').all()).toEqual([])
  expect(db.prepare("SELECT * FROM audit WHERE event = 'invite-create'").all()).toEqual([])
})

test.each(['disabled', 'sso', 'archived'])('cannot invite a %s account for local linking', async kind => {
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
    SELECT 'link-user', 'synthetic-link', 'Link user', password_hash, 0 FROM users LIMIT 1`)
  if (kind === 'disabled') db.exec("UPDATE users SET disabled = 1 WHERE id = 'link-user'")
  if (kind === 'archived') db.exec("UPDATE users SET disabled = 1, archived_at = 1 WHERE id = 'link-user'")
  if (kind === 'sso') db.exec("UPDATE users SET source = 'sso', password_hash = NULL WHERE id = 'link-user'")
  expect((await invite({ userId: 'link-user' })).json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
})

test('invitation mutations roll back when audit persistence fails', async () => {
  const { invitation } = (await invite()).json()
  const before = db.prepare('SELECT * FROM invitations').all()
  db.exec("CREATE TRIGGER synthetic_invite_audit_failure BEFORE INSERT ON audit WHEN NEW.event LIKE 'invite-%' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const response = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/resend', headers,
    payload: { expectedRevision: 1 } })
  expect(response.json()).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } })
  expect(db.prepare('SELECT * FROM invitations').all()).toEqual(before)
})

test.each(['resend', 'revoke'])('a claimed invitation refuses %s', async action => {
  const { invitation } = (await invite({ userId: 'synthetic-development-user' })).json()
  db.prepare('UPDATE invitations SET claimed_at = ? WHERE id = ?').run(Date.now(), invitation.id)
  const response = await app.inject({ method: 'POST', url: invitationsBase + '/' + invitation.id + '/' + action,
    headers, payload: { expectedRevision: 1 } })
  expect(response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect((await app.inject({ method: 'GET', url: invitationsBase, headers })).json().invitations[0]).toMatchObject({ status: 'claimed', revision: 1 })
})

test('invitation lists paginate without losing retained records', async () => {
  const first = (await invite()).json().invitation.id
  const second = (await invite({ expectedUsername: 'other@identity.example' })).json().invitation.id
  const page = (await app.inject({ method: 'GET', url: invitationsBase + '?limit=1', headers })).json()
  const next = (await app.inject({ method: 'GET', url: invitationsBase + '?limit=1&cursor=' + page.nextCursor, headers })).json()
  expect([page.invitations[0].id, next.invitations[0].id]).toEqual([first, second].sort())
  expect(next.nextCursor).toBeNull()
})

test('invitation role references prevent deleting a role even when it has no members', async () => {
  await invite()
  db.exec('DELETE FROM user_roles')
  const response = await app.inject({ method: 'DELETE', url: '/v1/admin/roles/synthetic-role', headers, payload: { expectedRevision: 1 } })
  expect(response.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'This role is retained by an invitation.' } })
  expect(db.prepare('SELECT role_id FROM invitation_roles').all()).toEqual([{ role_id: 'synthetic-role' }])
})

test('invitation operations require administrator capability and recent auth', async () => {
  const { invitation } = (await invite()).json()
  const routes = [
    { method: 'GET' as const, url: invitationsBase },
    { method: 'POST' as const, url: invitationsBase, payload: { providerId: invitation.providerId, expectedUsername: 'synthetic@identity.example', displayName: 'Invited', roleIds: [] } },
    { method: 'POST' as const, url: invitationsBase + '/' + invitation.id + '/resend', payload: { expectedRevision: 1 } },
    { method: 'POST' as const, url: invitationsBase + '/' + invitation.id + '/revoke', payload: { expectedRevision: 1 } },
  ]
  for (const route of routes) {
    const response = await app.inject({ ...route, headers: { authorization: headers.authorization! } })
    expect(response.json()).toMatchObject({ error: { code: 'REAUTH_REQUIRED' } })
  }
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
    SELECT 'ordinary', 'synthetic-ordinary', 'Ordinary', password_hash, 0 FROM users LIMIT 1`)
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-ordinary', password: 'CANARY-local-password' } })
  for (const route of routes) {
    const response = await app.inject({ ...route, headers: { authorization: 'Bearer ' + login.json().accessToken } })
    expect(response.json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
  }
})

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

test('generic claim name changes remove only their own grants and are audited', async () => {
  const provider = await app.inject({ method: 'POST', url: base, headers,
    payload: { kind: 'oidc', name: 'Synthetic generic', issuer: 'https://identity.example' } })
  expect(provider.statusCode).toBe(200)
  const input = { providerId: provider.json().id, claim: 'groups', value: 'Readers', roleId: 'synthetic-role' }
  const created = await app.inject({ method: 'POST', url: rulesBase, headers, payload: input })
  expect(created.statusCode).toBe(200)
  const rule = created.json()
  db.prepare('INSERT INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)')
    .run('synthetic-development-user', input.roleId, rule.id)
  const updated = await app.inject({ method: 'PATCH', url: rulesBase + '/' + rule.id, headers,
    payload: { ...input, claim: 'custom.claim', expectedRevision: 1 } })
  expect(updated.json()).toMatchObject({ claim: 'custom.claim', revision: 2 })
  expect(db.prepare('SELECT origin FROM user_roles').all()).toEqual([{ origin: 'direct' }])
  expect(db.prepare('SELECT action FROM audit WHERE target_id = ? ORDER BY id').all(rule.id))
    .toEqual([{ action: 'create-role-rule' }, { action: 'update-role-rule' }])
})

test.each(['PATCH', 'DELETE'] as const)('stale %s of a rule preserves the current mapping and audit', async method => {
  const { rule, input } = await createRule()
  const url = rulesBase + '/' + rule.id
  expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...input, value: 'Artium.Analysts', expectedRevision: 1 } })).statusCode).toBe(200)
  db.prepare('INSERT INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)').run('synthetic-development-user', input.roleId, rule.id)
  const grants = db.prepare('SELECT * FROM user_roles').all()
  const response = await app.inject({ method, url, headers, payload: method === 'PATCH' ? { ...input, expectedRevision: 1 } : { expectedRevision: 1 } })
  expect(response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  expect(db.prepare('SELECT value, revision FROM role_rules WHERE id = ?').get(rule.id)).toEqual({ value: 'Artium.Analysts', revision: 2 })
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE action LIKE '%role-rule'").get()).toEqual({ count: 2 })
  expect(db.prepare('SELECT * FROM user_roles').all()).toEqual(grants)
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
  db.prepare('INSERT INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)').run('synthetic-development-user', input.roleId, rule.id)
  const grants = db.prepare('SELECT * FROM user_roles').all()
  db.exec("CREATE TRIGGER synthetic_rule_audit_failure BEFORE INSERT ON audit WHEN NEW.action LIKE '%role-rule' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const response = await app.inject({ method, url: rulesBase + (method === 'POST' ? '' : '/' + rule.id), headers,
    payload: method === 'DELETE' ? { expectedRevision: 1 } : { ...input, value: 'Artium.Other', ...(method === 'PATCH' ? { expectedRevision: 1 } : {}) } })
  expect(response.json()).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } })
  expect(db.prepare('SELECT value, revision FROM role_rules').all()).toEqual([{ value: input.value, revision: 1 }])
  expect(db.prepare('SELECT * FROM user_roles').all()).toEqual(grants)
})

test.each(['POST', 'PATCH', 'DELETE'] as const)('rule %s requires administrator capability and recent authentication', async method => {
  const { rule, input } = await createRule()
  db.prepare('INSERT INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)').run('synthetic-development-user', input.roleId, rule.id)
  const grants = db.prepare('SELECT * FROM user_roles').all()
  const request = { method, url: rulesBase + (method === 'POST' ? '' : '/' + rule.id),
    payload: method === 'DELETE' ? { expectedRevision: 1 } : { ...input, value: 'Artium.Other', ...(method === 'PATCH' ? { expectedRevision: 1 } : {}) } }
  expect((await app.inject({ ...request, headers: { authorization: headers.authorization } })).json())
    .toMatchObject({ error: { code: 'REAUTH_REQUIRED' } })
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator)
    SELECT 'synthetic-other-admin', 'synthetic-other-admin', 'Other admin', password_hash, 1 FROM users LIMIT 1;
    UPDATE users SET administrator = 0 WHERE id = 'synthetic-development-user'`)
  expect((await app.inject({ ...request, headers })).json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
  expect(db.prepare('SELECT value, revision FROM role_rules').all()).toEqual([{ value: input.value, revision: 1 }])
  expect(db.prepare('SELECT * FROM user_roles').all()).toEqual(grants)
})

test('a role referenced by a rule cannot be removed', async () => {
  const { input } = await createRule()
  const tools = db.prepare('SELECT * FROM role_tools WHERE role_id = ?').all(input.roleId)
  db.exec("DELETE FROM user_roles WHERE origin = 'direct'")
  const role = await app.inject({ method: 'DELETE', url: '/v1/admin/roles/' + input.roleId, headers, payload: { expectedRevision: 1 } })
  expect(role.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'This role is used by an SSO rule.' } })
  expect(db.prepare('SELECT * FROM role_tools WHERE role_id = ?').all(input.roleId)).toEqual(tools)
})

test.each([
  { label: 'deletion', method: 'DELETE', patch: {}, clears: true },
  { label: 'role change', method: 'PATCH', patch: { roleId: 'synthetic-other-role' }, clears: true },
  { label: 'provider change', method: 'PATCH', patch: { providerId: 'synthetic-other-provider' }, clears: true },
  { label: 'claim value change', method: 'PATCH', patch: { value: 'Artium.Other' }, clears: true },
  { label: 'unchanged mapping', method: 'PATCH', patch: {}, clears: false },
] as const)('rule $label preserves unrelated grants on archived users', async ({ method, patch, clears }) => {
  const { rule, input } = await createRule()
  db.exec(`INSERT INTO roles (id, name) VALUES ('synthetic-other-role', 'Other role');
    INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-other-provider', 'Other provider', 'entra', 'https://login.microsoftonline.com/44444444-4444-4444-8444-444444444444/v2.0');
    INSERT INTO users (id, username, display_name, source, must_change) VALUES ('synthetic-archived', 'synthetic-archived', 'Archived user', 'sso', 0)`)
  const sibling = await app.inject({ method: 'POST', url: rulesBase, headers, payload: { ...input, value: 'Artium.Sibling' } })
  const other = await app.inject({ method: 'POST', url: rulesBase, headers, payload: { ...input, providerId: 'synthetic-other-provider', value: 'Artium.Foreign' } })
  expect(sibling.statusCode).toBe(200)
  expect(other.statusCode).toBe(200)
  const grant = db.prepare('INSERT INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)')
  grant.run('synthetic-archived', input.roleId, 'direct')
  grant.run('synthetic-archived', input.roleId, sibling.json().id)
  grant.run('synthetic-archived', input.roleId, other.json().id)
  const retained = db.prepare('SELECT * FROM user_roles ORDER BY user_id, role_id, origin').all()
  grant.run('synthetic-archived', input.roleId, rule.id)
  grant.run('synthetic-development-user', input.roleId, rule.id)
  const original = db.prepare('SELECT * FROM user_roles ORDER BY user_id, role_id, origin').all()
  const archived = await app.inject({ method: 'POST', url: '/v1/admin/users/synthetic-archived/archive', headers, payload: { expectedRevision: 1 } })
  expect(archived.statusCode).toBe(200)
  expect(archived.json()).toMatchObject({ archivedAt: expect.any(Number) })
  const response = await app.inject({ method, url: rulesBase + '/' + rule.id, headers,
    payload: method === 'DELETE' ? { expectedRevision: 1 } : { ...input, ...patch, expectedRevision: 1 } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject(method === 'DELETE' ? { id: rule.id, deleted: true } : { ...input, ...patch, revision: 2 })
  expect(db.prepare('SELECT * FROM user_roles ORDER BY user_id, role_id, origin').all()).toEqual(clears ? retained : original)
  expect(db.prepare('SELECT action FROM audit WHERE target_id = ? ORDER BY id DESC LIMIT 1').get(rule.id))
    .toEqual({ action: method === 'DELETE' ? 'delete-role-rule' : 'update-role-rule' })
})
