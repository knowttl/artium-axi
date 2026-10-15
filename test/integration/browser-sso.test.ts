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
import { seedToolUser } from '../fixtures/tokens.js'
import { seedBrowserSso, ssoStart, syntheticObject, syntheticTenant } from '../fixtures/sso.js'

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

async function start() {
  const response = await app.inject({ url: ssoStart, headers })
  expect(response.statusCode).toBe(302)
  const authorization = new URL(response.headers.location!)
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  const issued = await fetch(fake.url + '/authorize' + authorization.search, { redirect: 'manual' })
  expect(issued.status).toBe(302)
  const cookie = response.cookies.find(cookie => cookie.name === 'artium-sso')!
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600 })
  return { url: issued.headers.get('location')!, cookie: `${cookie.name}=${cookie.value}` }
}

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
