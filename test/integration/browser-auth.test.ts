import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { accountSessionRoutes } from '../../src/shared/api.js'
import { hashToken, issueLoginTokens, verifyAccessToken } from '../../src/server/auth/tokens.js'
import { browserDefaults, authDefaults, tokenDefaults } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'

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

test('administrators can inspect the loaded trusted CA metadata on Tools', async () => {
  await withFakeService(async ({ directory: certs }) => {
    await app.close()
    const bundle = loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(certs, 'ca.crt') })!
    app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls'), bundle), environment: {},
      adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([])) })
    expect((await request('GET', '/admin/tools')).statusCode).toBe(303)
    await signIn()
    const response = await request('GET', '/admin/tools')
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Read-only startup configuration')
    expect(response.body).toContain(bundle.certificates[0].subject)
    expect(response.body).toContain(bundle.certificates[0].issuer)
    expect(response.body).toContain(bundle.certificates[0].expiresAt)
    expect(response.body).toContain(bundle.certificates[0].fingerprint)
    expect(response.body).not.toContain('BEGIN CERTIFICATE')
  })
})

test('security: failure diagnostics appear only in administrator row details, never audit exports or streams', async () => {
  const lines: string[] = []
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const audit = new Audit(db, () => now, line => { lines.push(line) })
  const terminal = { userId, tool: 'falcon-axi' as const, clientAddress: null, event: 'run-terminal' as const,
    outcome: 'completed' as const, exitCode: 1, durationMs: 1, outputBytes: { stdout: 0, stderr: 40 } }
  audit.record({ ...terminal, requestId: 'safe-failure', failure: {
    diagnostic: { stage: 'tool run', message: '<script>Synthetic private failure</script>' }, secrets: [password] } })
  audit.record({ ...terminal, requestId: 'secret-failure', failure: {
    diagnostic: { stage: 'tool run', message: password }, secrets: [password] } })
  expect(JSON.stringify(db.prepare('SELECT * FROM run_diagnostics').all())).not.toContain(password)
  const anonymous = await request('GET', '/admin/audit')
  expect(anonymous.statusCode).toBe(303)
  expect(anonymous.body).not.toContain('Synthetic private failure')
  await signIn()
  const page = await request('GET', '/admin/audit')
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('Failure diagnostic')
  expect(page.body).toContain('&lt;script&gt;Synthetic private failure&lt;/script&gt;')
  expect(page.body).not.toContain(password)
  for (const path of ['/v1/admin/audit', '/v1/admin/audit/export?format=jsonl', '/v1/admin/audit/export?format=csv']) {
    const response = await request('GET', path)
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('Synthetic private failure')
    expect(response.body).not.toContain(password)
  }
  expect(lines.join('')).not.toContain('Synthetic private failure')
  expect(lines.join('')).not.toContain(password)
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(password)
  now += 14 * 24 * 60 * 60 * 1000
  expect((await request('GET', '/admin/audit')).body).not.toContain('Synthetic private failure')
})

test('security: an authenticated non-administrator cannot read retained failure diagnostics', async () => {
  new Audit(db).record({ userId, tool: 'falcon-axi', requestId: 'private-failure', clientAddress: null,
    event: 'run-terminal', outcome: 'completed', exitCode: 1, durationMs: 1, outputBytes: { stdout: 0, stderr: 1 },
    failure: { diagnostic: { stage: 'tool run', message: 'Synthetic private failure' }, secrets: [] } })
  await signIn()
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  const response = await request('GET', '/admin/audit')
  expect(response.statusCode).toBe(403)
  expect(response.body).not.toContain('Synthetic private failure')
})

test('browser sign-in creates an opaque secure server session and sign-out revokes it with audit', async () => {
  const response = await signIn()
  expect(response.headers.location).toBe('/admin')
  expect(response.cookies.find(cookie => cookie.name === browserCookie)).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' })
  expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: hashToken(cookies[browserCookie]!) })
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens').get()).toEqual({ count: 0 })
  expect((await request('GET', '/admin')).body).toContain('Signed in as </span><strong>Synthetic User</strong>')
  const csrf = await token('/admin')
  const signedIn = { ...cookies }
  expect((await request('POST', '/logout', { _csrf: csrf })).headers.location).toBe('/login')
  cookies = signedIn
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
  expect(db.prepare("SELECT event FROM audit WHERE event IN ('sign-in', 'sign-out') ORDER BY id").all())
    .toEqual([{ event: 'sign-in' }, { event: 'sign-out' }])
})

test('browser password sign-in and confirmation are flagged for a designated break-glass administrator', async () => {
  db.exec(`UPDATE users SET break_glass = 1 WHERE id = 'synthetic-development-user';
    INSERT INTO sso_providers (id, name, kind, issuer, enabled)
    VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://identity.example', 1)`)
  await signIn()
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/reauth', { _csrf: await token('/reauth'), password })).statusCode).toBe(303)
  expect(db.prepare("SELECT event, authentication_method FROM audit WHERE event IN ('sign-in', 'reauth') ORDER BY id").all())
    .toEqual([{ event: 'sign-in', authentication_method: 'break-glass' }, { event: 'reauth', authentication_method: 'break-glass' }])
  expect((await request('GET', '/admin/audit')).body).toContain('<strong>Break-glass</strong> sign-in')
  const exported = await request('GET', '/v1/admin/audit/export?format=jsonl')
  expect(exported.body.trim().split('\n').map(line => JSON.parse(line).authentication_method)).toEqual(['break-glass', 'break-glass'])
})

test('password confirmation after break-glass designation flags the password change in Audit and exports', async () => {
  await signIn()
  db.prepare('UPDATE users SET break_glass = 1 WHERE id = ?').run(userId)
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/password', { _csrf: await token('/password'), currentPassword: password, newPassword }))
    .headers.location).toBe('/login')
  await signIn(newPassword)
  expect((await request('GET', '/admin/audit')).body).toContain('<strong>Break-glass</strong> password-change')
  const exported = await request('GET', '/v1/admin/audit/export?format=jsonl&event=password-change')
  expect(exported.statusCode).toBe(200)
  expect(JSON.parse(exported.body.trim())).toMatchObject({ event: 'password-change', authentication_method: 'break-glass' })
})

test('an existing local browser session cannot confirm its password after SSO is enabled', async () => {
  await signIn()
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer, enabled)
    VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://identity.example', 1)`)
  now += authDefaults.recentAuthMs
  const response = await request('POST', '/v1/auth/reauth', { _csrf: await token('/reauth'), password })
  expect(response.statusCode).toBe(401)
  expect(response.body).toContain('SIGN_IN_FAILED')
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'reauth'").get()).toEqual({ count: 0 })
})

test.each([false, true])('browser local password sign-in with SSO enabled requires designation, administrator=%s', async administrator => {
  db.prepare('UPDATE users SET administrator = ? WHERE id = ?').run(Number(administrator), userId)
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer, enabled)
    VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://identity.example', 1)`)
  const response = await request('POST', '/login', { _csrf: await token('/login'), username: 'synthetic-user', password })
  expect(response.statusCode).toBe(401)
  expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test.each(['/login', '/logout', '/password', '/reauth', '/v1/auth/reauth', '/v1/admin/users', '/v1/admin/tools/falcon-axi/test', '/v1/account/sessions/revoke', '/v1/account/sessions/other/revoke'])
  ('security form mutation %s rejects a missing CSRF token', async path => {
    await signIn()
    const response = await request('POST', path, {})
    expect(response.statusCode).toBe(403)
    expect(response.body).toContain('form token or request origin is invalid')
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event IN ('admin-change', 'password-change', 'sign-out', 'credential-test')").get())
      .toEqual({ count: 0 })
  })

test('ordinary account sessions exclude expired families and refuse revoking another person before self revocation', async () => {
  db.exec('UPDATE users SET administrator = 0 WHERE id = \'synthetic-development-user\'')
  await signIn()
  const csrf = await token('/account')
  const other = issueLoginTokens(db, 'synthetic-second')
  expect(other.status).toBe('authenticated')
  const otherFamily = db.prepare("SELECT id FROM session_families WHERE user_id = 'synthetic-second'").get() as { id: string }
  const refused = await request('POST', '/v1/account/sessions/' + otherFamily.id + '/revoke', { _csrf: csrf })
  expect(refused.statusCode).toBe(404)
  now += browserDefaults.idleMs - 1
  const listed = accountSessionRoutes.list.response.parse((await request('GET', '/v1/account/sessions')).json())
  expect(listed.sessions).toHaveLength(1)
  expect(listed.sessions[0]).toMatchObject({ kind: 'browser', current: true, expiresAt: expect.any(Number) })
  expect((await request('POST', '/v1/account/sessions/' + listed.sessions[0]!.id + '/revoke', { _csrf: csrf })).statusCode).toBe(200)
  expect((await request('GET', '/account')).headers.location).toBe('/login')
  expect(db.prepare("SELECT action, target_id FROM audit WHERE event = 'sign-out'").get())
    .toEqual({ action: 'revoke-session', target_id: listed.sessions[0]!.id })
})

test.each(['/v1/account/sessions', '/v1/admin/users/synthetic-development-user/sessions'])('session listing at %s projects current browser renewal only', async path => {
  await signIn()
  const start = now
  createBrowserSession(db, userId, 'CANARY-other-csrf', now)
  now += browserDefaults.idleMs - 1
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now)
  const response = await request('GET', path)
  expect(response.statusCode).toBe(200)
  const listed = accountSessionRoutes.list.response.parse(response.json())
  expect(listed.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ current: true, lastSeenAt: now, expiresAt: now + browserDefaults.idleMs }),
    expect.objectContaining({ current: false, lastSeenAt: start, expiresAt: start + browserDefaults.idleMs }),
  ]))
})

test.each(['/account', '/admin/users/synthetic-development-user'])('session table at %s displays the renewed idle deadline', async path => {
  await signIn()
  now += browserDefaults.idleMs - 1
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now)
  const response = await request('GET', path)
  expect(response.statusCode).toBe(200)
  expect(response.body).toContain(`<time datetime="${new Date(now + browserDefaults.idleMs).toISOString()}"`)
})

test.each([
  { bound: 'family', sessionRemaining: 60_000, familyRemaining: 30_000 },
  { bound: 'session', sessionRemaining: 30_000, familyRemaining: 60_000 },
])('current browser renewal keeps the $bound expiry bound', async ({ sessionRemaining, familyRemaining }) => {
  await signIn()
  const deadline = now + browserDefaults.idleMs + 30_000
  const sessionExpiry = now + browserDefaults.idleMs + sessionRemaining
  const familyExpiry = now + browserDefaults.idleMs + familyRemaining
  db.prepare('UPDATE sessions SET expires_at = ?').run(sessionExpiry)
  db.prepare('UPDATE session_families SET expires_at = ?').run(familyExpiry)
  now += browserDefaults.idleMs - 1
  const listed = accountSessionRoutes.list.response.parse((await request('GET', '/v1/account/sessions')).json())
  expect(listed.sessions).toEqual([expect.objectContaining({ current: true, expiresAt: deadline })])
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
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'reauth'").all()).toEqual([{ outcome: 'success' }])
  expect((await request('POST', '/v1/admin/roles', action)).statusCode).toBe(201)
})

test('credential testing uses the same recent-auth challenge', async () => {
  await signIn()
  const csrf = await token('/admin')
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/v1/admin/tools/falcon-axi/test', { _csrf: csrf })).headers.location).toBe('/reauth')
})

test('Roles page escapes names and change actors and preserves bounded pagination', async () => {
  await signIn()
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>actor</b>', userId)
  db.prepare('UPDATE roles SET name = ?, updated_by = ?, updated_at = ?').run('<img src=x>', userId, now)
  db.exec("INSERT INTO roles (id, name) VALUES ('a', 'First')")
  const first = await request('GET', '/admin/roles?limit=1')
  expect(first.statusCode).toBe(200)
  expect(first.body).toContain('href="/admin/roles/a">First</a>')
  expect(first.body).toContain('/admin/roles?cursor=a&amp;limit=1')
  const second = await request('GET', '/admin/roles?cursor=a&limit=1')
  expect(second.body).toContain('&lt;img src=x&gt;</a>')
  const detail = await request('GET', '/admin/roles/synthetic-role')
  expect(detail.body).toContain('Last changed by &lt;b&gt;actor&lt;/b&gt;')
  expect(detail.body).toContain(new Date(now).toISOString())
  expect(detail.body).toContain('value="falcon-axi" checked')
  expect((await request('GET', '/admin/roles?limit=101')).statusCode).toBe(400)
})

test.each(['/admin/tools', '/admin/credentials', '/admin/roles', '/admin/roles/synthetic-role', '/admin/users/' + userId, '/admin/audit'])('page %s requires the current administrator capability', async path => {
  expect((await request('GET', path)).headers.location).toBe('/login')
  await signIn()
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await request('GET', path)).statusCode).toBe(403)
})

test('Audit screen escapes stored fields and retains all filters across pages', async () => {
  await signIn()
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>actor</b>', userId)
  const audit = new Audit(db)
  audit.record({ event: 'admin-change', userId, tool: 'falcon-axi', outcome: 'success',
    action: '<b>action</b>', targetId: '<b>target</b>', requestId: '<b>request</b>', clientAddress: '<b>address</b>' })
  audit.record({ event: 'admin-change', userId, tool: 'falcon-axi', outcome: 'success',
    action: 'second', targetId: 'second', requestId: 'second', clientAddress: null })
  const filters = new URLSearchParams({ user: userId, tool: 'falcon-axi', outcome: 'success',
    from: new Date(now).toISOString(), to: new Date(now).toISOString(), limit: '1' })
  const first = await request('GET', '/admin/audit?' + filters)
  expect(first.statusCode).toBe(200)
  expect(first.body).toContain('<dt>action</dt><dd>second</dd>')
  expect(first.body).not.toContain('&lt;b&gt;action&lt;/b&gt;')
  const next = /href="([^"]+)">Next page/.exec(first.body)![1]!.replaceAll('&amp;', '&')
  expect(Object.fromEntries(new URL('http://localhost' + next).searchParams)).toMatchObject(Object.fromEntries(filters))
  const second = await request('GET', next)
  expect(second.statusCode).toBe(200)
  expect(second.body).toContain('<dt>action</dt><dd>&lt;b&gt;action&lt;/b&gt;</dd>')
  expect(second.body).toContain('<dt>target_id</dt><dd>&lt;b&gt;target&lt;/b&gt;</dd>')
  expect(second.body).toContain('<dt>request_id</dt><dd>&lt;b&gt;request&lt;/b&gt;</dd>')
  expect(second.body).toContain('<dt>client_address</dt><dd>&lt;b&gt;address&lt;/b&gt;</dd>')
  expect(second.body).toContain('&lt;b&gt;actor&lt;/b&gt;')
  expect(second.body).not.toContain('<b>')
  expect(second.body).not.toContain('>Next page')
  expect(second.headers['cache-control']).toBe('no-store')
})

test('Audit filters handle empty form fields and show a useful empty state', async () => {
  await signIn()
  expect((await request('GET', '/admin/audit?user=&tool=&outcome=&from=&to=&limit=50')).statusCode).toBe(200)
  const empty = await request('GET', '/admin/audit?outcome=missing')
  expect(empty.body).toContain('No audit records match these filters.')
  expect(empty.body).toContain('name="outcome" value="missing"')
  const byErrorCode = await request('GET', '/admin/audit?errorCode=PERMISSION_DENIED')
  expect(byErrorCode.statusCode).toBe(200)
  expect(byErrorCode.body).toContain('name="errorCode" value="PERMISSION_DENIED"')
  expect((await request('GET', '/admin/audit?from=invalid')).statusCode).toBe(400)
  expect((await request('GET', '/admin/audit?limit=101')).statusCode).toBe(400)
})

test('Audit screen applies request ID and failed-run filters to rows and export links', async () => {
  await signIn()
  const audit = new Audit(db)
  const context = { userId, tool: 'falcon-axi' as const, clientAddress: null, durationMs: 1, outputBytes: { stdout: 0, stderr: 0 } }
  audit.record({ ...context, requestId: 'synthetic-failed', event: 'run-terminal', outcome: 'completed', exitCode: 1 })
  audit.record({ ...context, requestId: 'synthetic-success', event: 'run-terminal', outcome: 'completed', exitCode: 0 })
  const page = await request('GET', '/admin/audit?requestId=synthetic-failed&failed=1')
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('<dt>request_id</dt><dd>synthetic-failed</dd>')
  expect(page.body).not.toContain('synthetic-success')
  expect(page.body).toContain('name="requestId" value="synthetic-failed"')
  expect(page.body).toContain('name="failed" value="1" checked')
  const links = [...page.body.matchAll(/download href="([^"]+)"/g)].map(match => new URL('http://localhost' + match[1].replaceAll('&amp;', '&')))
  expect(links).toHaveLength(2)
  expect(links.map(link => Object.fromEntries(link.searchParams))).toEqual([
    { requestId: 'synthetic-failed', failed: '1', format: 'csv' },
    { requestId: 'synthetic-failed', failed: '1', format: 'jsonl' },
  ])
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

test('Users screen escapes HTML usernames, role names and change actors as text', async () => {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>synthetic</b>', 'synthetic-second')
  db.prepare('UPDATE users SET updated_by = ?, updated_at = ?, revision = 7 WHERE id = ?')
    .run('synthetic-second', now, userId)
  db.prepare('UPDATE roles SET name = ?').run('<img src=x onerror=alert(1)>')
  await signIn()
  const response = await request('GET', '/admin/users')
  expect(response.statusCode).toBe(200)
  expect(response.body).toContain('&lt;b&gt;synthetic&lt;/b&gt;')
  expect(response.body).not.toContain('<b>synthetic</b>')
  expect(response.body).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(response.body).not.toContain('<img')
  const detail = await request('GET', '/admin/users/' + userId)
  expect(detail.body).toContain(`Last changed by &lt;b&gt;synthetic&lt;/b&gt; at <time datetime="${new Date(now).toISOString()}"`)
  expect(detail.body).toContain('Revision 7.')
})

test('Users screen paginates accounts and retains role choices from later API pages', async () => {
  const insert = db.prepare('INSERT INTO roles (id, name) VALUES (?, ?)')
  for (let index = 0; index < 101; index++) insert.run(`role-${index.toString().padStart(3, '0')}`, `Role ${index}`)
  await signIn()
  const response = await request('GET', '/admin/users?limit=1')
  expect(response.body).toContain('Role 100')
  const next = /href="(\/admin\/users\?[^"]*cursor=[^"]+)">Next</.exec(response.body)![1]!.replaceAll('&amp;', '&')
  expect((await request('GET', next)).body).not.toMatch(/cursor=[^"]+">Next</)
  expect((await request('GET', '/admin/users?limit=101')).statusCode).toBe(400)
})

test('users-list bookmarks from before Overview still open the users list with their filters', async () => {
  await signIn()
  const response = await request('GET', '/admin?source=local&limit=1')
  expect(response.statusCode).toBe(301)
  expect(response.headers.location).toBe('/admin/users?source=local&limit=1')
  expect((await request('GET', '/admin')).body).toContain('<h1>Overview</h1>')
})

test('overview names each broken access link with the action that fixes it', async () => {
  db.exec(`UPDATE tools SET enabled = 1 WHERE name = 'vectra-axi';
    INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example');
    INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, created_at, created_by, expires_at)
      VALUES ('synthetic-invitation', 'synthetic-hash', 'synthetic-provider', 'synthetic@identity.example', 'Synthetic Invitee', ${now}, '${userId}', ${now + 86_400_000})`)
  await signIn()
  const body = (await request('GET', '/admin')).body
  expect(body).toMatch(/Vectra is enabled without a credential<\/strong>.*?href="\/admin\/tools\/vectra-axi">Add credential</s)
  expect(body).toMatch(/Synthetic Invitee can’t claim their invitation yet<\/strong>.*?href="\/admin\/invitations">Review</s)
  expect(body).toContain('2 things need you.')
})

test.each([
  ['/admin/users', 'sheet-add-user'],
  [`/admin/users/${userId}`, 'sheet-reset-password'],
])('%s renders its sheet open from the sheet query without JavaScript', async (path, id) => {
  await signIn()
  expect((await request('GET', `${path}?sheet=${id.slice('sheet-'.length)}`)).body).toContain(`id="${id}" aria-labelledby="${id}-title" open>`)
  expect((await request('GET', path)).body).toContain(`id="${id}" aria-labelledby="${id}-title">`)
})

test('invitation navigation opens the creation sheet without JavaScript', async () => {
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer) VALUES
    ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://entra.example'),
    ('synthetic-oidc', 'Synthetic OIDC', 'oidc', 'https://oidc.example')`)
  await signIn()
  const page = await request('GET', '/admin/invitations')
  expect(page.body).toContain('href="/admin/invitations?limit=50&amp;sheet=new-invitation"')
  const open = await request('GET', '/admin/invitations?sheet=new-invitation')
  expect(open.body).toContain('id="sheet-new-invitation" aria-labelledby="sheet-new-invitation-title" open>')
  expect(open.body).toContain('Synthetic Entra (not enabled yet)')
  expect(open.body).toContain('Synthetic OIDC (not enabled yet)')
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
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'reauth'").all()).toEqual([{ outcome: 'success' }])
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
