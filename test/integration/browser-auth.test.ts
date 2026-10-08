import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { hashToken, issueLoginTokens, verifyAccessToken } from '../../src/server/auth/tokens.js'
import { browserDefaults, authDefaults, tokenDefaults } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let cookies: Record<string, string>
let now: number
const password = 'CANARY-local-password'
const newPassword = 'CANARY-changed-password'
const userId = 'synthetic-development-user'

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-browser-'))
  db = openStore(join(directory, 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  await seedToolUser(db)
  db.prepare('UPDATE users SET administrator = 1').run()
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
    SELECT 'synthetic-second', 'synthetic-second', 'Second', password_hash, 1, 0 FROM users LIMIT 1`)
  now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: {},
    adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([])) })
  cookies = {}
})

afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, input?: Record<string, string>, extra: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { host: 'localhost', origin: 'http://localhost',
    cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
    ...(input ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...extra },
  payload: input ? new URLSearchParams(input).toString() : undefined })
  for (const cookie of response.cookies) cookies[cookie.name] = cookie.value
  return response
}

async function token(path: string) {
  const response = await request('GET', path)
  expect(response.statusCode).toBe(200)
  return /name="_csrf" value="([^"]+)"/.exec(response.body)![1]!
}

async function signIn(secret = password) {
  const response = await request('POST', '/login', { _csrf: await token('/login'), username: 'synthetic-user', password: secret })
  expect(response.statusCode).toBe(303)
  return response
}

test('browser sign-in creates an opaque secure server session and sign-out revokes it with audit', async () => {
  const response = await signIn()
  expect(response.headers.location).toBe('/admin')
  expect(response.cookies.find(cookie => cookie.name === browserCookie)).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' })
  expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: hashToken(cookies[browserCookie]!) })
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens').get()).toEqual({ count: 0 })
  expect((await request('GET', '/admin')).body).toContain('Signed in as Synthetic User.')
  const csrf = await token('/admin')
  const signedIn = { ...cookies }
  expect((await request('POST', '/logout', { _csrf: csrf })).headers.location).toBe('/login')
  cookies = signedIn
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
  expect(db.prepare("SELECT event FROM audit WHERE event IN ('sign-in', 'sign-out') ORDER BY id").all())
    .toEqual([{ event: 'sign-in' }, { event: 'sign-out' }])
})

test.each(['/login', '/logout', '/password', '/reauth', '/v1/auth/reauth', '/v1/admin/users', '/v1/admin/tools/falcon-axi/test'])
  ('security form mutation %s rejects a missing CSRF token', async path => {
    await signIn()
    const response = await request('POST', path, {})
    expect(response.statusCode).toBe(403)
    expect(response.body).toContain('form token or request origin is invalid')
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event IN ('admin-change', 'password-change', 'sign-out', 'credential-test')").get())
      .toEqual({ count: 0 })
  })

test('security sign-in requires a same-origin CSRF-protected form', async () => {
  const csrf = await token('/login')
  expect((await request('POST', '/login', { _csrf: csrf, username: 'synthetic-user', password }, { origin: 'https://other.invalid' })).statusCode).toBe(403)
  expect((await request('POST', '/login', { username: 'synthetic-user', password })).statusCode).toBe(403)
  expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('admin mutation after 15 minutes challenges for the password and succeeds after browser API reauthentication', async () => {
  await signIn()
  const csrf = await token('/admin')
  now += authDefaults.recentAuthMs
  const action = { _csrf: csrf, name: 'Synthetic Browser Role' }
  expect((await request('POST', '/v1/admin/roles', action)).headers.location).toBe('/reauth')
  expect((await request('GET', '/reauth')).body).toContain('Confirm password')
  expect(db.prepare("SELECT COUNT(*) AS count FROM roles WHERE name = 'Synthetic Browser Role'").get()).toEqual({ count: 0 })
  expect((await request('POST', '/v1/auth/reauth', { _csrf: csrf, password })).statusCode).toBe(204)
  expect((await request('POST', '/v1/admin/roles', action)).statusCode).toBe(201)
})

test('credential testing uses the same recent-auth challenge', async () => {
  await signIn()
  const csrf = await token('/admin')
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/v1/admin/tools/falcon-axi/test', { _csrf: csrf })).headers.location).toBe('/reauth')
})

test.each([
  { method: 'PATCH', path: '/v1/admin/users/synthetic-development-user' },
  { method: 'PUT', path: '/v1/admin/users/synthetic-development-user/roles' },
  { method: 'PATCH', path: '/v1/admin/roles/synthetic-role' },
  { method: 'PUT', path: '/v1/admin/roles/synthetic-role/tools' },
  { method: 'PATCH', path: '/v1/admin/tools/falcon-axi' },
  { method: 'PUT', path: '/v1/admin/tools/falcon-axi/credential' },
] as const)('security $method $path requires CSRF before editing', async ({ method, path }) => {
  await signIn()
  expect((await request(method, path, {})).statusCode).toBe(403)
})

test('a CSRF token from another browser cannot mutate an existing session', async () => {
  await signIn()
  const first = { ...cookies }
  cookies = {}
  const otherToken = await token('/login')
  const otherSecret = cookies._csrf!
  cookies = first
  expect((await request('POST', '/logout', { _csrf: otherToken })).statusCode).toBe(403)
  cookies._csrf = otherSecret
  expect((await request('POST', '/logout', { _csrf: otherToken })).statusCode).toBe(403)
})

test('an ordinary browser user can change their password and sign out without administrator access', async () => {
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await signIn()).headers.location).toBe('/account')
  expect((await request('GET', '/account')).body).toContain('Change password')
  expect((await request('GET', '/admin')).statusCode).toBe(403)
  expect((await request('POST', '/logout', { _csrf: await token('/account') })).headers.location).toBe('/login')
})

test('browser pages escape the signed-in display name', async () => {
  db.prepare('UPDATE users SET display_name = ?').run('<script>synthetic</script>')
  await signIn()
  const response = await request('GET', '/admin')
  expect(response.body).toContain('&lt;script&gt;synthetic&lt;/script&gt;')
  expect(response.body).not.toContain('<script>')
  expect(response.headers['content-security-policy']).toContain("form-action 'self'")
  expect(response.headers['cache-control']).toBe('no-store')
})

test.each([
  { name: 'idle', elapsed: browserDefaults.idleMs, lastSeenAgo: browserDefaults.idleMs },
  { name: 'absolute', elapsed: browserDefaults.absoluteMs, lastSeenAgo: 1 },
])('$name expiry rejects browser requests at the deadline', async ({ elapsed, lastSeenAgo }) => {
  await signIn()
  now += elapsed
  db.prepare('UPDATE sessions SET last_seen_at = ?').run(now - lastSeenAgo)
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
})

test('successful requests extend idle time without extending the absolute deadline', async () => {
  await signIn()
  const start = now
  now += browserDefaults.idleMs - 1
  expect((await request('GET', '/admin')).statusCode).toBe(200)
  expect(db.prepare('SELECT last_seen_at, expires_at FROM sessions').get())
    .toEqual({ last_seen_at: now, expires_at: start + browserDefaults.absoluteMs })
  now += browserDefaults.idleMs - 1
  expect((await request('GET', '/admin')).statusCode).toBe(200)
})

test('forced change redirects admin and reauth, revokes every session and requires a new login', async () => {
  const cli = issueLoginTokens(db, userId)
  await signIn()
  const oldCookies = { ...cookies }
  db.prepare('UPDATE users SET must_change = 1').run()
  cookies = {}
  expect((await signIn()).headers.location).toBe('/password')
  expect((await request('GET', '/admin')).headers.location).toBe('/password')
  expect((await request('GET', '/reauth')).headers.location).toBe('/password')
  expect((await request('POST', '/password', { _csrf: await token('/password'), newPassword })).headers.location).toBe('/login')
  if (cli.status !== 'authenticated') throw new Error('Expected ordinary login')
  expect(() => verifyAccessToken(db, cli.accessToken)).toThrow()
  cookies = oldCookies
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
  expect((await signIn(newPassword)).headers.location).toBe('/admin')
})

test('temporary browser sign-in expires after ten minutes', async () => {
  db.prepare('UPDATE users SET must_change = 1').run()
  await signIn()
  now += tokenDefaults.passwordChangeMs
  expect((await request('GET', '/password')).headers.location).toBe('/login')
})

test('ordinary password change accepts recent browser confirmation and requires current password when stale', async () => {
  await signIn()
  const csrf = await token('/password')
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/password', { _csrf: csrf, newPassword })).statusCode).toBe(401)
  expect((await request('POST', '/password', { _csrf: csrf, currentPassword: 'CANARY-wrong-password', newPassword })).statusCode).toBe(401)
  expect((await request('POST', '/reauth', { _csrf: csrf, password })).headers.location).toBe('/admin')
  expect((await request('POST', '/password', { _csrf: csrf, newPassword })).headers.location).toBe('/login')
  expect((await signIn(newPassword)).headers.location).toBe('/admin')
})

test('current administrator capability and enabled state govern every browser request', async () => {
  await signIn()
  const csrf = await token('/admin')
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await request('GET', '/admin')).statusCode).toBe(403)
  expect((await request('POST', '/v1/admin/roles', { _csrf: csrf, name: 'Denied' })).statusCode).toBe(403)
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId)
  expect((await request('GET', '/password')).headers.location).toBe('/login')
})
