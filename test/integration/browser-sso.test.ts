import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { readBrowserSession } from '../../src/server/auth/sessions.js'
import { authDefaults, ssoDefaults } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { ProviderCredentials } from '../../src/server/store/provider-credentials.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser, issueTestAccessToken } from '../fixtures/tokens.js'
import { seedBrowserSso, seedSsoInvitation, seedSsoRules, ssoStart, syntheticObject, syntheticTenant } from '../fixtures/sso.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { verifyAccessToken } from '../../src/server/auth/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let fake: Awaited<ReturnType<typeof seedBrowserSso>>
let credentials: ProviderCredentials
const headers = { host: 'localhost', 'x-forwarded-proto': 'https' }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-sso-'))
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  credentials = new ProviderCredentials(db, key)
  fake = await seedBrowserSso(db, credentials, 'https://localhost/auth/sso/synthetic-entra/callback')
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: { ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' },
    adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([])), providerCredentials: credentials,
    ssoFetch: fake.fetch })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  await fake.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

async function start(path = ssoStart, sessionToken?: string) {
  const response = await app.inject({ url: path, headers: { ...headers, ...(sessionToken ? { cookie: `${browserCookie}=${sessionToken}` } : {}) } })
  expect(response.statusCode).toBe(302)
  const authorization = new URL(response.headers.location!)
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  const issued = await fetch(fake.url + '/authorize' + authorization.search, { redirect: 'manual' })
  expect(issued.status).toBe(302)
  const cookie = response.cookies.find(cookie => cookie.name === 'artium-sso')!
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 })
  return { url: issued.headers.get('location')!, cookie: `${cookie.name}=${cookie.value}` }
}

async function signedIn() {
  const response = await finish(await start())
  return response.cookies.find(cookie => cookie.name === browserCookie)!.value
}

test('SSO reauth requires a new provider login and updates only the initiating session', async () => {
  const first = await signedIn()
  const second = await signedIn()
  const transaction = await start(ssoStart + '?reauth=1', first)
  expect(fake.authorizations.at(-1)).toMatchObject({ prompt: 'login' })
  const response = await finish(transaction)
  expect(response.statusCode).toBe(200)
  expect(response.body).toContain('/reauth?complete=1')
  expect(response.cookies.some(cookie => cookie.name === browserCookie || cookie.name === '_csrf')).toBe(false)
  expect(readBrowserSession(db, first).reauthenticated_at).not.toBeNull()
  expect(readBrowserSession(db, second).reauthenticated_at).toBeNull()
  expect(db.prepare("SELECT authentication_method, provider_id, subject, user_id FROM audit WHERE event = 'reauth'").get())
    .toEqual({ authentication_method: 'sso', provider_id: 'synthetic-entra', subject: `${syntheticTenant}:${syntheticObject}`, user_id: 'synthetic-browser-sso' })
  expect((await finish(transaction)).body).toContain('SSO_STATE_INVALID')
})

test.each([
  { label: 'missing', value: null }, { label: 'stale', value: 1 },
  { label: 'future', value: 9_999_999_999 }, { label: 'non-numeric', value: 'fresh' },
])('SSO reauth refuses $label auth_time', async ({ value }) => {
  const sessionToken = await signedIn()
  fake.token.claims = { auth_time: value }
  const response = await finish(await start(ssoStart + '?reauth=1', sessionToken))
  expect(response.body).toContain('SSO_TOKEN_INVALID')
  expect(readBrowserSession(db, sessionToken).reauthenticated_at).toBeNull()
  expect(db.prepare("SELECT event, outcome FROM audit ORDER BY id DESC LIMIT 1").get()).toEqual({ event: 'reauth', outcome: 'SSO_TOKEN_INVALID' })
})

test('SSO reauth refuses a different identity without changing the signed-in user', async () => {
  const sessionToken = await signedIn()
  fake.token.claims = { oid: '44444444-4444-4444-8444-444444444444' }
  expect((await finish(await start(ssoStart + '?reauth=1', sessionToken))).body).toContain('SSO_TOKEN_INVALID')
  expect(readBrowserSession(db, sessionToken)).toMatchObject({ user_id: 'synthetic-browser-sso', reauthenticated_at: null })
})

test.each(['revoked', 'expired', 'identity changed', 'user disabled', 'audit unavailable'])('SSO reauth cannot authorize a session after %s', async failure => {
  const sessionToken = await signedIn()
  const transaction = await start(ssoStart + '?reauth=1', sessionToken)
  if (failure === 'revoked') db.prepare('UPDATE sessions SET revoked_at = ?').run(Date.now())
  if (failure === 'expired') db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now())
  if (failure === 'identity changed') db.prepare('UPDATE identities SET subject = ?').run('changed-subject')
  if (failure === 'user disabled') db.exec("UPDATE users SET disabled = 1 WHERE id = 'synthetic-browser-sso'")
  if (failure === 'audit unavailable') db.exec("CREATE TRIGGER synthetic_reauth_audit_failure BEFORE INSERT ON audit WHEN NEW.event = 'reauth' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  expect((await finish(transaction)).statusCode).toBeGreaterThanOrEqual(400)
  expect(db.prepare('SELECT reauthenticated_at FROM sessions').get()).toEqual({ reauthenticated_at: null })
})

test('SSO reauth cannot start without its session or use an invitation', async () => {
  expect((await app.inject({ url: ssoStart + '?reauth=1', headers })).statusCode).toBe(401)
  expect((await app.inject({ url: seedSsoInvitation(db).claimPath + '&reauth=1', headers })).body).toContain('INVALID_INPUT')
})

async function signOut(sessionToken: string, providerLogout = false) {
  const cookie = `${browserCookie}=${sessionToken}; _csrf=${readBrowserSession(db, sessionToken).csrf_token}`
  const page = await app.inject({ url: '/account', headers: { ...headers, cookie } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!
  return app.inject({ method: 'POST', url: '/logout', headers: { ...headers, origin: 'https://localhost',
    cookie },
    payload: { _csrf: csrf, ...(providerLogout ? { providerLogout: 'true' } : {}) } })
}

test('optional provider sign-out revokes the local session before offering the discovered end-session endpoint', async () => {
  const sessionToken = await signedIn()
  const response = await signOut(sessionToken, true)
  expect(response.statusCode).toBe(200)
  const destination = new URL(/data-provider-signout href="([^"]+)"/.exec(response.body)![1]!.replaceAll('&amp;', '&'))
  expect(destination.pathname).toBe(`/${syntheticTenant}/v2.0/logout`)
  expect(destination.searchParams.get('post_logout_redirect_uri')).toBe('https://localhost/login')
  expect(destination.searchParams.get('client_id')).toBe('33333333-3333-4333-8333-333333333333')
  expect(() => readBrowserSession(db, sessionToken)).toThrow()
  expect(db.prepare('SELECT revoked_at FROM session_families').get()).toMatchObject({ revoked_at: expect.any(Number) })
  expect(db.prepare("SELECT event, outcome FROM audit ORDER BY id DESC LIMIT 1").get()).toEqual({ event: 'sign-out', outcome: 'success' })
})

test('ordinary sign-out stays in artium', async () => {
  const sessionToken = await signedIn()
  expect((await signOut(sessionToken)).headers.location).toBe('/login')
  expect(() => readBrowserSession(db, sessionToken)).toThrow()
})

test('provider failure leaves artium signed out and explains the remaining provider session', async () => {
  const sessionToken = await signedIn()
  db.exec('UPDATE sso_providers SET enabled = 0')
  const response = await signOut(sessionToken, true)
  expect(response.statusCode).toBe(200)
  expect(response.body).toContain('Microsoft session may still be active')
  expect(() => readBrowserSession(db, sessionToken)).toThrow()
})

async function finish(transaction: Awaited<ReturnType<typeof start>>) {
  return app.inject({ url: transaction.url, headers: { ...headers, cookie: transaction.cookie } })
}

test('certificate-authenticated SSO issues an artium session without persisting provider tokens or recent-auth privilege', async () => {
  const response = await finish(await start())
  expect(response.statusCode).toBe(200)
  const cookie = response.cookies.find(cookie => cookie.name === browserCookie)!
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' })
  expect(readBrowserSession(db, cookie.value)).toMatchObject({ user_id: 'synthetic-browser-sso', reauthenticated_at: null })
  expect(db.prepare('SELECT count(*) AS count FROM tokens').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT authentication_method, provider_id, subject, user_id, outcome FROM audit').all()).toEqual([
    { authentication_method: 'sso', provider_id: 'synthetic-entra', subject: `${syntheticTenant}:${syntheticObject}`, user_id: 'synthetic-browser-sso', outcome: 'success' },
  ])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
  const account = await app.inject({ url: '/account', headers: { ...headers, cookie: `${browserCookie}=${cookie.value}` } })
  expect(account.statusCode).toBe(200)
  expect(account.body).toContain('SSO sign-in')
  expect(account.body).not.toContain('href="/password"')
})

test('secret-authenticated SSO exchanges the code with the encrypted client secret', async () => {
  fake.configuration.authentication = { kind: 'secret', secret: 'CANARY-sso-secret' }
  const current = credentials.read('synthetic-entra')!
  credentials.replace('synthetic-entra', { tenantId: current.value.tenantId, clientId: current.value.clientId,
    auth: 'secret', clientSecret: 'CANARY-sso-secret' }, current.revision, 'synthetic-development-user', Date.now())
  const response = await finish(await start())
  expect(response.statusCode).toBe(200)
  expect(db.prepare('SELECT user_id FROM sessions').get()).toEqual({ user_id: 'synthetic-browser-sso' })
})

test.each([
  { label: 'wrong audience', claims: { aud: 'other-client' } },
  { label: 'wrong authorized party', claims: { azp: 'other-client' } },
  { label: 'wrong nonce', claims: { nonce: 'other-nonce' } },
  { label: 'expired token', claims: { exp: 1 } },
  { label: 'future issue time', claims: { iat: 9_999_999_999 } },
  { label: 'missing immutable object id', claims: { oid: null } },
  { label: 'wrong tenant', claims: { tid: '44444444-4444-4444-8444-444444444444' } },
])('rejects $label before issuing a session', async ({ claims }) => {
  fake.token.claims = claims
  const response = await finish(await start())
  expect(response.statusCode).toBe(401)
  expect(response.body).toContain('SSO_TOKEN_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT outcome FROM audit').get()).toEqual({ outcome: 'SSO_TOKEN_INVALID' })
})

test('an expired transaction cannot exchange its authorization code', async () => {
  const transaction = await start()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ssoDefaults.transactionMs)
  const response = await finish(transaction)
  expect(response.statusCode).toBe(400)
  expect(response.body).toContain('SSO_STATE_INVALID')
})

test('callback requires the initiating browser cookie', async () => {
  const transaction = await start()
  const response = await finish({ ...transaction, cookie: '' })
  expect(response.statusCode).toBe(400)
  expect(response.body).toContain('SSO_STATE_INVALID')
})

test('a transaction cannot be replayed even with its original browser cookie', async () => {
  const transaction = await start()
  expect((await finish(transaction)).statusCode).toBe(200)
  expect((await finish(transaction)).body).toContain('SSO_STATE_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 })
})

test('callback is bound to its original state', async () => {
  const transaction = await start()
  const url = new URL(transaction.url)
  url.searchParams.set('state', 'CANARY-wrong-state')
  expect((await finish({ ...transaction, url: url.href })).body).toContain('SSO_STATE_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('callback is bound to its original provider', async () => {
  const transaction = await start()
  const url = new URL(transaction.url)
  url.pathname = '/auth/sso/other-provider/callback'
  expect((await finish({ ...transaction, url: url.href })).body).toContain('SSO_STATE_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test.each(['disabled', 'settings changed', 'credential replaced'])('rejects a callback after provider is %s', async change => {
  const transaction = await start()
  if (change === 'disabled') db.exec('UPDATE sso_providers SET enabled = 0')
  if (change === 'settings changed') db.exec('UPDATE sso_providers SET revision = revision + 1')
  if (change === 'credential replaced') {
    const current = credentials.read('synthetic-entra')!
    credentials.replace('synthetic-entra', current.value, current.revision, 'synthetic-development-user', Date.now())
  }
  expect((await finish(transaction)).body).toContain('SSO_PROVIDER_ERROR')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('disabled provider has no login link and cannot start SSO', async () => {
  db.exec('UPDATE sso_providers SET enabled = 0')
  expect((await app.inject({ url: '/login', headers })).body).not.toContain(ssoStart)
  expect((await app.inject({ url: ssoStart, headers })).body).toContain('SSO_PROVIDER_ERROR')
})

test('disabled linked user cannot establish a session', async () => {
  db.exec("UPDATE users SET disabled = 1 WHERE id = 'synthetic-browser-sso'")
  expect((await finish(await start())).statusCode).toBe(403)
  expect(db.prepare('SELECT outcome, user_id FROM audit').get()).toEqual({ outcome: 'USER_DISABLED', user_id: 'synthetic-browser-sso' })
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('audit failure rolls back the SSO session', async () => {
  const transaction = await start()
  db.exec("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const response = await finish(transaction)
  expect(response.statusCode).toBe(503)
  expect(response.body).toContain('AUDIT_UNAVAILABLE')
  expect(response.cookies.some(cookie => cookie.name === browserCookie)).toBe(false)
  expect(db.prepare('SELECT count(*) AS count FROM session_families').get()).toEqual({ count: 0 })
})

test.each(['/auth/sso/synthetic-entra/callback', ssoStart + '?unsupported=true'])('%s is address-rate-limited and audited', async url => {
  const request = { url, headers }
  for (let index = 0; index < authDefaults.addressAttempts; index++) expect((await app.inject(request)).statusCode).toBe(400)
  const response = await app.inject(request)
  expect(response.statusCode).toBe(429)
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE outcome = 'AUTH_RATE_LIMITED'").get()).toEqual({ count: 1 })
})

function invitedIdentity() {
  fake.token.claims = { oid: '44444444-4444-4444-8444-444444444444', preferred_username: 'synthetic-invited' }
}

test('claim creates an SSO account with invitation roles and matching rule grants, never administrator access', async () => {
  invitedIdentity()
  seedSsoRules(db)
  const invite = seedSsoInvitation(db)
  expect((await finish(await start(invite.claimPath))).statusCode).toBe(200)
  const user = db.prepare("SELECT id, source, password_hash, administrator FROM users WHERE username = 'synthetic-invited'").get() as { id: string }
  expect(user).toMatchObject({ source: 'sso', password_hash: null, administrator: 0 })
  expect(db.prepare('SELECT role_id, origin FROM user_roles WHERE user_id = ? ORDER BY role_id, origin').all(user.id)).toEqual([
    { role_id: 'synthetic-role', origin: 'direct' }, { role_id: 'synthetic-role', origin: 'synthetic-overlap-rule' },
    { role_id: 'synthetic-rule-role', origin: 'synthetic-reader-rule' },
  ])
  expect(db.prepare('SELECT event FROM audit ORDER BY id').all()).toEqual([{ event: 'invite-claim' }, { event: 'role-sync' }, { event: 'sign-in' }])
})

test.each(['wrong username', 'expired during exchange', 'revoked during exchange', 'resent during exchange', 'already claimed'])('claim refuses %s without consuming a valid invitation or granting access', async failure => {
  invitedIdentity()
  const invite = seedSsoInvitation(db)
  if (failure === 'wrong username') fake.token.claims!.preferred_username = 'Synthetic-Invited'
  const transaction = await start(invite.claimPath)
  if (failure === 'expired during exchange') db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run(Date.now(), invite.id)
  if (failure === 'revoked during exchange') db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(Date.now(), invite.id)
  if (failure === 'resent during exchange') db.prepare('UPDATE invitations SET token_hash = ? WHERE id = ?').run('rotated', invite.id)
  if (failure === 'already claimed') expect((await finish(await start(invite.claimPath))).statusCode).toBe(200)
  expect((await finish(transaction)).body).toContain('SSO_INVITE_INVALID')
  expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: failure === 'already claimed' ? 1 : 0 })
  if (failure === 'wrong username') expect(db.prepare('SELECT claimed_at FROM invitations WHERE id = ?').get(invite.id)).toEqual({ claimed_at: null })
})

test('local link preserves user id, name, administrator and direct roles, removes password and revokes old sessions and tokens', async () => {
  invitedIdentity()
  const userId = 'synthetic-development-user'
  const session = createBrowserSession(db, userId, 'synthetic-csrf')
  const token = issueTestAccessToken(db, userId)
  const invite = seedSsoInvitation(db, { userId })
  expect((await finish(await start(invite.claimPath))).statusCode).toBe(200)
  expect(db.prepare('SELECT username, display_name, password_hash, source, must_change FROM users WHERE id = ?').get(userId))
    .toEqual({ username: 'synthetic-user', display_name: 'Synthetic User', password_hash: null, source: 'sso', must_change: 0 })
  expect(() => readBrowserSession(db, session.id)).toThrow()
  expect(() => verifyAccessToken(db, token)).toThrow()
  expect(db.prepare('SELECT user_id FROM identities WHERE subject = ?').get(`${syntheticTenant}:44444444-4444-4444-8444-444444444444`)).toEqual({ user_id: userId })
  expect(db.prepare("SELECT event FROM audit WHERE event = 'identity-link'").get()).toEqual({ event: 'identity-link' })
})

test('sign-in removes only this provider rule grants while retaining direct and other-provider grants', async () => {
  seedSsoRules(db)
  db.exec(`INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-browser-sso', 'synthetic-role');
    INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('other-provider', 'Synthetic other', 'oidc', 'https://other.example');
    INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES ('other-rule', 'other-provider', 'roles', 'Other', 'synthetic-role');
    INSERT INTO user_roles (user_id, role_id, origin) VALUES ('synthetic-browser-sso', 'synthetic-role', 'other-rule')`)
  expect((await finish(await start())).statusCode).toBe(200)
  fake.token.claims = { roles: [] }
  expect((await finish(await start())).statusCode).toBe(200)
  expect(db.prepare("SELECT origin FROM user_roles WHERE user_id = 'synthetic-browser-sso' ORDER BY origin").all())
    .toEqual([{ origin: 'direct' }, { origin: 'other-rule' }])
  expect(db.prepare("SELECT arguments FROM audit WHERE event = 'role-sync' ORDER BY id DESC LIMIT 1").get()).toEqual({
    arguments: JSON.stringify({ added: [], removed: ['synthetic-overlap-rule', 'synthetic-reader-rule'] }),
  })
})

test('claim audit failure rolls back invitation consumption, identity, account and grants', async () => {
  invitedIdentity()
  seedSsoRules(db)
  const invite = seedSsoInvitation(db)
  const transaction = await start(invite.claimPath)
  db.exec("CREATE TRIGGER synthetic_claim_audit_failure BEFORE INSERT ON audit WHEN NEW.event = 'invite-claim' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  expect((await finish(transaction)).body).toContain('AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT claimed_at, user_id FROM invitations WHERE id = ?').get(invite.id)).toEqual({ claimed_at: null, user_id: null })
  expect(db.prepare("SELECT id FROM users WHERE username = 'synthetic-invited'").get()).toBeUndefined()
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})
