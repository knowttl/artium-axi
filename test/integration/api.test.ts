import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { SessionStore } from '../../src/cli/session.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { Audit } from '../../src/server/audit/audit.js'
import { checkAuthSettings } from '../../src/server/auth/settings.js'
import { certificateDetailsSchema, errorResponseSchema, runSuccessSchema, toolsResponseSchema, inputLimits, loginResponseSchema } from '../../src/shared/api.js'
import { hashToken, requireRecentAuth, verifyAccessToken } from '../../src/server/auth/tokens.js'
import { ArtiumError, errors } from '../../src/shared/errors.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { fakeTool } from '../fake-tool/tool.js'
import { hashPassword, LocalAuthProvider } from '../../src/server/auth/local.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let url: string
let token: string
let headers: { authorization: string, 'content-type': string }
const getCredential = vi.fn(async () => ({ clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }))
let environment: NodeJS.ProcessEnv
let options: Parameters<typeof createApp>[0]

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-api-'))
  environment = {}
  db = openStore(join(directory, 'data', 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.6.0' WHERE name = 'falcon-axi'")
  const runner = await Runner.create(join(directory, 'calls'))
  const adapter = createFalconAdapter({ getCredential })
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference) => {
    const prepared = await prepare(args, reference)
    return { ...prepared, executable: fakeTool.executable, args: [...fakeTool.args, ...args], limits: { timeoutMs: 5000 },
      environment: { ...prepared.environment, ARTIUM_TEST_CANARY: prepared.environment.FALCON_AXI_CLIENT_SECRET } }
  })
  getCredential.mockClear()
  options = { db, runner, audit: new Audit(db), environment, adapters: [adapter],
    resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference: { id: 'synthetic-credential', tool: 'falcon-axi' }, value: {} }])) }
  app = createApp(options)
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const login = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic-user', password: 'CANARY-local-password' }) })
  expect(login.status).toBe(200)
  const session = loginResponseSchema.parse(await login.json())
  if (session.status !== 'authenticated') throw new Error('Expected ordinary local login')
  token = session.accessToken
  db.exec('DELETE FROM audit')
  headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  new SessionStore(url, join(directory, 'artium-axi', 'session.json')).write(session)
  environment.XDG_CONFIG_HOME = directory
  options.environment = {}
})
afterEach(async () => {
  await app.close()
  if (db.open) db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function run(body: unknown, requestHeaders = headers) {
  return fetch(`${url}/v1/tools/falcon-axi/run`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
}

async function expectFailure(response: Response, code: keyof typeof errors) {
  expect(response.status).toBe(errors[code].status)
  const body = errorResponseSchema.parse(await response.json())
  expect(body).toEqual({ error: { code, source: 'artium-axi', message: errors[code].message,
    next: errors[code].next, requestId: expect.any(String) } })
  return body.error.requestId
}

async function login(password = 'CANARY-local-password', username = 'synthetic-user') {
  return fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) })
}

test('the server handler maps every catalogue error to its HTTP envelope', async () => {
  await app.close()
  const runner = await Runner.create(join(directory, 'catalogue-calls'))
  app = createApp({ ...options, runner })
  app.get<{ Params: { code: keyof typeof errors } }>('/v1/catalogue/:code', async request => {
    throw new ArtiumError(request.params.code)
  })
  for (const [code, definition] of Object.entries(errors)) {
    const response = await app.inject(`/v1/catalogue/${code}`)
    expect(response.statusCode).toBe(definition.status)
    expect(response.json()).toEqual({ error: { code, source: 'artium-axi', message: definition.message,
      next: definition.next, requestId: expect.any(String) } })
  }
})

test('unexpected errors log only a request ID, error class and route template', async () => {
  await app.close()
  app = createApp(options)
  app.post('/v1/failure/:secret', async () => { throw new TypeError('CANARY-error-secret') })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const response = await app.inject({ method: 'POST', url: '/v1/failure/CANARY-path?token=CANARY-query',
    headers: { authorization: 'Bearer CANARY-header' }, payload: { secret: 'CANARY-body' } })
  expect(response.statusCode).toBe(500)
  expect(response.json().error.code).toBe('INTERNAL_ERROR')
  expect(stderr.mock.calls).toEqual([[JSON.stringify({ requestId: response.json().error.requestId,
    errorClass: 'TypeError', route: '/v1/failure/:secret' }) + '\n']])
})

test('response validation logs the missing certificate field without certificate contents', async () => {
  await app.close()
  app = createApp(options)
  app.get('/v1/invalid-response', async () => certificateDetailsSchema.pick({ subject: true }).parse({
    'CANARY-dynamic-field': 'CANARY-certificate-contents' }))
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const response = await app.inject('/v1/invalid-response')
  expect(response.statusCode).toBe(500)
  expect(response.json().error.code).toBe('INTERNAL_ERROR')
  expect(stderr.mock.calls).toEqual([[JSON.stringify({ requestId: response.json().error.requestId,
    errorClass: 'ZodError', route: '/v1/invalid-response', validationFields: ['subject'] }) + '\n']])
})

test.each([
  { path: '/users/synthetic-development-user/roles', body: { roleIds: [], expectedRevision: 1 }, action: 'assign-user-roles' },
  { path: '/roles/synthetic-role/tools', body: { tools: [], expectedRevision: 1 }, action: 'replace-role-tools' },
])('role change through $path denies the next call using the existing local token and audits both', async route => {
  db.exec('UPDATE users SET administrator = 1')
  const reauth = await fetch(`${url}/v1/auth/reauth`, { method: 'POST', headers,
    body: JSON.stringify({ password: 'CANARY-local-password' }) })
  expect(reauth.status).toBe(200)
  const { ticket } = await reauth.json() as { ticket: string }
  expect((await run({ args: ['success'] })).status).toBe(200)
  getCredential.mockClear()
  const changed = await fetch(`${url}/v1/admin${route.path}`, { method: 'PUT',
    headers: { ...headers, 'x-artium-reauth-ticket': ticket }, body: JSON.stringify(route.body) })
  expect(changed.status).toBe(200)
  const requestId = await expectFailure(await run({ args: ['success'] }), 'TOOL_NOT_GRANTED')
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare("SELECT action, user_id FROM audit WHERE event = 'admin-change'").get())
    .toEqual({ action: route.action, user_id: 'synthetic-development-user' })
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'denial' AND request_id = ?").get(requestId))
    .toEqual({ outcome: 'TOOL_NOT_GRANTED' })
  const restored = await fetch(`${url}/v1/admin${route.path}`, { method: 'PUT',
    headers: { ...headers, 'x-artium-reauth-ticket': ticket },
    body: JSON.stringify(route.action === 'assign-user-roles'
      ? { roleIds: ['synthetic-role'], expectedRevision: 2 }
      : { tools: ['falcon-axi'], expectedRevision: 2 }) })
  expect(restored.status).toBe(200)
  expect((await run({ args: ['success'] })).status).toBe(200)
})

async function ordinarySession() {
  const session = loginResponseSchema.parse(await (await login()).json())
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  return session
}

async function refresh(refreshToken: string) {
  return fetch(`${url}/v1/auth/refresh`, { method: 'POST', headers,
    body: JSON.stringify({ refreshToken }) })
}

test('five wrong passwords lock the account with an audit event until the exact expiry', async () => {
  const start = Date.now() + 900_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  for (let attempt = 0; attempt < 5; attempt++) await expectFailure(await login('CANARY-wrong'), 'SIGN_IN_FAILED')
  expect(db.prepare('SELECT failed_attempts, locked_until FROM users').get()).toEqual({ failed_attempts: 5, locked_until: start + 900_000 })
  expect(db.prepare("SELECT user_id, outcome, client_address FROM audit WHERE event = 'lockout'").all()).toEqual([
    { user_id: 'synthetic-development-user', outcome: 'ACCOUNT_LOCKED', client_address: '127.0.0.1' },
  ])
  clock.mockReturnValue(start + 899_999)
  const limited = await login()
  expect(limited.status).toBe(429)
  const limitedRequestId = await expectFailure(limited, 'AUTH_RATE_LIMITED')
  expect(db.prepare("SELECT event, outcome FROM audit WHERE request_id = ?").get(limitedRequestId))
    .toEqual({ event: 'sign-in', outcome: 'AUTH_RATE_LIMITED' })
  // The attempt window starts before the fifth failure; the persisted lock still applies after that window.
  await app.close()
  app = createApp(options)
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const locked = await login()
  expect(locked.status).toBe(429)
  await expectFailure(locked, 'ACCOUNT_LOCKED')
  clock.mockReturnValue(start + 900_000)
  expect((await login()).status).toBe(200)
  expect(db.prepare('SELECT failed_attempts, locked_until FROM users').get()).toEqual({ failed_attempts: 0, locked_until: null })
})

test('successful logins reset failed-password counts without consuming the username failure limit', async () => {
  await expectFailure(await login('CANARY-wrong'), 'SIGN_IN_FAILED')
  expect((await login()).status).toBe(200)
  expect(db.prepare('SELECT failed_attempts FROM users').get()).toEqual({ failed_attempts: 0 })
  expect((await login()).status).toBe(200)
  expect((await login()).status).toBe(200)
  expect((await login(undefined, ' Synthetic-USER ')).status).toBe(200)
})

test('lockout audit failure rolls back the fifth failure and lock deadline', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_000)
  for (let attempt = 0; attempt < 4; attempt++) await expectFailure(await login('CANARY-wrong'), 'SIGN_IN_FAILED')
  db.exec("CREATE TRIGGER fail_lockout BEFORE INSERT ON audit WHEN NEW.event = 'lockout' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await login('CANARY-wrong'), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT failed_attempts, locked_until FROM users').get()).toEqual({ failed_attempts: 4, locked_until: null })
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'lockout'").get()).toEqual({ count: 0 })
})

test('reauth requires an access token and strict password input', async () => {
  const post = (proof: string, body: unknown) => fetch(`${url}/v1/auth/reauth`, { method: 'POST',
    headers: { ...headers, authorization: `Bearer ${proof}` }, body: JSON.stringify(body) })
  const session = await ordinarySession()
  await expectFailure(await post(session.refreshToken, { password: 'CANARY-local-password' }), 'TOKEN_INVALID')
  db.exec('UPDATE users SET must_change = 1')
  const restricted = loginResponseSchema.parse(await (await login()).json())
  if (restricted.status !== 'password-change-required') throw new Error('Expected restricted session')
  await expectFailure(await post(restricted.passwordChangeToken, { password: 'CANARY-local-password' }), 'TOKEN_INVALID')
  await expectFailure(await post(token, { password: 'CANARY-local-password', username: 'someone-else' }), 'INVALID_INPUT')
  expect(db.prepare('SELECT COUNT(*) AS count FROM recent_auth_tickets').get()).toEqual({ count: 0 })
})

test('address limit bounds distinct unknown usernames and ignores spoofed forwarding', async () => {
  await app.close()
  const start = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  // Start with empty counters instead of expiring the fixture login using wall time.
  app = createApp(options)
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  for (let attempt = 0; attempt < 30; attempt++) await expectFailure(await login('CANARY-wrong', `unknown-${attempt}`), 'SIGN_IN_FAILED')
  await expectFailure(await login('CANARY-wrong', 'another-unknown'), 'AUTH_RATE_LIMITED')
  await expectFailure(await fetch(`${url}/v1/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.1' },
    body: JSON.stringify({ username: 'synthetic-user', password: 'CANARY-local-password' }) }), 'PROXY_HEADERS_UNTRUSTED')
  clock.mockReturnValue(start + 900_000)
  expect((await login()).status).toBe(200)
  expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 })
}, 60_000)

test('reauth issues a hashed session-bound ticket valid through refresh until its exact expiry', async () => {
  const start = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  const other = await ordinarySession()
  const response = await fetch(`${url}/v1/auth/reauth`, { method: 'POST', headers, body: JSON.stringify({ password: 'CANARY-local-password' }) })
  expect(response.status).toBe(200)
  const proof = await response.json() as { ticket: string, expiresAt: number }
  expect(db.prepare("SELECT event, user_id, outcome FROM audit WHERE event = 'reauth'").all()).toEqual([
    { event: 'reauth', user_id: 'synthetic-development-user', outcome: 'success' },
  ])
  expect(Buffer.from(proof.ticket, 'base64url')).toHaveLength(32)
  expect(proof.expiresAt).toBe(start + 900_000)
  expect(db.prepare('SELECT hash, expires_at FROM recent_auth_tickets').get()).toEqual({ hash: hashToken(proof.ticket), expires_at: proof.expiresAt })
  expect(requireRecentAuth(db, token, proof.ticket)).toBe('synthetic-development-user')
  expect(() => requireRecentAuth(db, other.accessToken, proof.ticket)).toThrow(expect.objectContaining({ code: 'REAUTH_REQUIRED' }))
  const rotated = loginResponseSchema.parse(await (await refresh(other.refreshToken)).json())
  if (rotated.status !== 'authenticated') throw new Error('Expected ordinary session')
  expect(() => requireRecentAuth(db, rotated.accessToken, proof.ticket)).toThrow(expect.objectContaining({ code: 'REAUTH_REQUIRED' }))
  clock.mockReturnValue(proof.expiresAt - 1)
  expect(requireRecentAuth(db, token, proof.ticket)).toBe('synthetic-development-user')
  clock.mockReturnValue(proof.expiresAt)
  expect(() => requireRecentAuth(db, token, proof.ticket)).toThrow(expect.objectContaining({ code: 'REAUTH_REQUIRED' }))
})

test('reauth shares username limits with login and rejects incorrect passwords without issuing tickets', async () => {
  const reauth = (password: string) => fetch(`${url}/v1/auth/reauth`, { method: 'POST', headers, body: JSON.stringify({ password }) })
  await expectFailure(await reauth('CANARY-wrong'), 'SIGN_IN_FAILED')
  expect(db.prepare('SELECT COUNT(*) AS count FROM recent_auth_tickets').get()).toEqual({ count: 0 })
  expect((await reauth('CANARY-local-password')).status).toBe(200)
  expect((await login()).status).toBe(200)
  expect((await reauth('CANARY-local-password')).status).toBe(200)
  expect((await reauth('CANARY-local-password')).status).toBe(200)
  for (let attempt = 0; attempt < 4; attempt++) await expectFailure(await reauth('CANARY-wrong'), 'SIGN_IN_FAILED')
  const requestId = await expectFailure(await reauth('CANARY-local-password'), 'AUTH_RATE_LIMITED')
  expect(db.prepare("SELECT event, outcome FROM audit WHERE request_id = ?").get(requestId))
    .toEqual({ event: 'sign-in', outcome: 'AUTH_RATE_LIMITED' })
})

test('identity returns the fixed session deadline after token rotation', async () => {
  const session = await ordinarySession()
  vi.spyOn(Date, 'now').mockReturnValue(session.accessExpiresAt - 1)
  const rotated = loginResponseSchema.parse(await (await refresh(session.refreshToken)).json())
  if (rotated.status !== 'authenticated') throw new Error('Expected ordinary session')
  const response = await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${rotated.accessToken}` } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ accessExpiresAt: rotated.accessExpiresAt, sessionExpiresAt: session.familyExpiresAt })
})

test('security: concurrent refresh consumes once and reuse revokes the complete family', async () => {
  const session = await ordinarySession()
  const other = await ordinarySession()
  const responses = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)])
  expect(responses.map(response => response.status).sort()).toEqual([200, 401])
  const rotated = loginResponseSchema.parse(await responses.find(response => response.status === 200)!.json())
  if (rotated.status !== 'authenticated') throw new Error('Expected ordinary session')
  await expectFailure(await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${rotated.accessToken}` } }), 'TOKEN_INVALID')
  await expectFailure(await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${session.accessToken}` } }), 'TOKEN_INVALID')
  await expectFailure(await refresh(rotated.refreshToken), 'TOKEN_INVALID')
  expect((await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${other.accessToken}` } })).status).toBe(200)
  expect(db.prepare("SELECT event, user_id, outcome FROM audit WHERE event = 'token-reuse'").all()).toEqual([
    { event: 'token-reuse', user_id: 'synthetic-development-user', outcome: 'TOKEN_INVALID' },
  ])
  expect(getCredential).not.toHaveBeenCalled()
})

test('security: rotation preserves old access expiry and the fixed family deadline', async () => {
  const session = await ordinarySession()
  vi.spyOn(Date, 'now').mockReturnValue(session.accessExpiresAt - 1)
  const rotated = loginResponseSchema.parse(await (await refresh(session.refreshToken)).json())
  if (rotated.status !== 'authenticated') throw new Error('Expected ordinary session')
  expect(rotated.familyExpiresAt).toBe(session.familyExpiresAt)
  expect(rotated.accessExpiresAt).toBe(session.accessExpiresAt - 1 + 3_600_000)
  expect(verifyAccessToken(db, session.accessToken)).toBe('synthetic-development-user')
  vi.spyOn(Date, 'now').mockReturnValue(session.accessExpiresAt)
  expect(() => verifyAccessToken(db, session.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }))
  expect(verifyAccessToken(db, rotated.accessToken)).toBe('synthetic-development-user')
  vi.spyOn(Date, 'now').mockReturnValue(session.familyExpiresAt - 1)
  const final = loginResponseSchema.parse(await (await refresh(rotated.refreshToken)).json())
  if (final.status !== 'authenticated') throw new Error('Expected ordinary session')
  expect(final.accessExpiresAt).toBe(session.familyExpiresAt)
  expect(final.familyExpiresAt).toBe(session.familyExpiresAt)
  vi.spyOn(Date, 'now').mockReturnValue(session.familyExpiresAt)
  await expectFailure(await refresh(final.refreshToken), 'TOKEN_EXPIRED')
  expect(() => verifyAccessToken(db, final.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }))
})

test.each(['access', 'refresh'] as const)('security: logout with expired %s revokes only its family', async type => {
  const session = await ordinarySession()
  const other = await ordinarySession()
  const rotated = loginResponseSchema.parse(await (await refresh(session.refreshToken)).json())
  if (rotated.status !== 'authenticated') throw new Error('Expected ordinary session')
  db.prepare('UPDATE tokens SET expires_at = 0 WHERE hash = ?').run(hashToken(type === 'access' ? session.accessToken : session.refreshToken))
  const response = await fetch(`${url}/v1/auth/logout`, { method: 'POST',
    headers: { authorization: `Bearer ${type === 'access' ? session.accessToken : session.refreshToken}` } })
  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
  await expectFailure(await refresh(rotated.refreshToken), 'TOKEN_INVALID')
  expect(() => verifyAccessToken(db, rotated.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  expect(verifyAccessToken(db, other.accessToken)).toBe('synthetic-development-user')
  expect(db.prepare("SELECT user_id, outcome FROM audit WHERE event = 'sign-out'").all())
    .toEqual([{ user_id: 'synthetic-development-user', outcome: 'success' }])
})

test('reuse audit failure rolls back revocation and permits a durable retry', async () => {
  const session = await ordinarySession()
  const rotated = loginResponseSchema.parse(await (await refresh(session.refreshToken)).json())
  if (rotated.status !== 'authenticated') throw new Error('Expected ordinary session')
  db.exec("CREATE TRIGGER fail_reuse BEFORE INSERT ON audit WHEN NEW.event = 'token-reuse' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await refresh(session.refreshToken), 'AUDIT_UNAVAILABLE')
  expect(verifyAccessToken(db, rotated.accessToken)).toBe('synthetic-development-user')
  db.exec('DROP TRIGGER fail_reuse')
  await expectFailure(await refresh(session.refreshToken), 'TOKEN_INVALID')
  expect(() => verifyAccessToken(db, rotated.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
})

test('refresh rejects invalid types and strict input without rotating', async () => {
  await expectFailure(await refresh(token), 'TOKEN_INVALID')
  await expectFailure(await refresh('CANARY-unknown'), 'TOKEN_INVALID')
  await expectFailure(await fetch(`${url}/v1/auth/refresh`, { method: 'POST', headers,
    body: JSON.stringify({ refreshToken: token, extra: true }) }), 'INVALID_INPUT')
  expect(verifyAccessToken(db, token)).toBe('synthetic-development-user')
})

test('login issues distinct random token types with hashes and fixed deadlines', async () => {
  const response = await login(undefined, ' Synthetic-User ')
  expect(response.status).toBe(200)
  const session = loginResponseSchema.parse(await response.json())
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  expect(session.accessToken).not.toBe(session.refreshToken)
  expect(Buffer.from(session.accessToken, 'base64url')).toHaveLength(32)
  expect(Buffer.from(session.refreshToken, 'base64url')).toHaveLength(32)
  const family = db.prepare('SELECT id, created_at, expires_at FROM session_families WHERE id = (SELECT family_id FROM tokens WHERE hash = ?)')
    .get(hashToken(session.accessToken)) as { id: string, created_at: number, expires_at: number }
  expect(session.accessExpiresAt).toBe(family.created_at + 3_600_000)
  expect(session.familyExpiresAt).toBe(family.created_at + 43_200_000)
  expect(db.prepare('SELECT hash, type, expires_at FROM tokens WHERE family_id = ? ORDER BY type').all(family.id)).toEqual([
    { hash: hashToken(session.accessToken), type: 'access', expires_at: session.accessExpiresAt },
    { hash: hashToken(session.refreshToken), type: 'refresh', expires_at: session.familyExpiresAt },
  ])
  await expectFailure(await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${session.refreshToken}` } }), 'TOKEN_INVALID')
})

test.each([['CANARY-wrong-password', 'synthetic-user'], ['CANARY-local-password', 'unknown-user']])(
  'security: failed login returns the same safe response for password %s and username %s', async (password, username) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM tokens').get()
    await expectFailure(await login(password, username), 'SIGN_IN_FAILED')
    expect(db.prepare('SELECT COUNT(*) AS count FROM tokens').get()).toEqual(count)
    expect(db.prepare("SELECT user_id, outcome FROM audit WHERE event = 'sign-in'").all())
      .toEqual([{ user_id: null, outcome: 'SIGN_IN_FAILED' }])
  })

test('login rejects unknown fields and non-JSON input without issuing a session', async () => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM session_families').get()
  await expectFailure(await fetch(`${url}/v1/auth/login`, { method: 'POST', headers,
    body: JSON.stringify({ username: 'synthetic-user', password: 'CANARY-local-password', administrator: true }) }), 'INVALID_INPUT')
  await expectFailure(await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), 'INVALID_INPUT')
  expect(db.prepare('SELECT COUNT(*) AS count FROM session_families').get()).toEqual(count)
})

test('security: restricted token denies tools and admin authentication and changes password only once', async () => {
  db.exec('UPDATE users SET must_change = 1, administrator = 1')
  const response = await login()
  const session = loginResponseSchema.parse(await response.json())
  if (session.status !== 'password-change-required') throw new Error('Expected restricted session')
  const proof = session.passwordChangeToken
  expect(Buffer.from(proof, 'base64url')).toHaveLength(32)
  const family = db.prepare('SELECT created_at FROM session_families WHERE id = (SELECT family_id FROM tokens WHERE hash = ?)')
    .get(hashToken(proof)) as { created_at: number }
  expect(session.passwordChangeExpiresAt).toBe(family.created_at + 600_000)
  expect(() => verifyAccessToken(db, proof)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  const restrictedHeaders = { ...headers, authorization: `Bearer ${proof}` }
  await expectFailure(await fetch(`${url}/v1/tools`, { headers: restrictedHeaders }), 'TOKEN_INVALID')
  await expectFailure(await run({ args: ['print', 'synthetic'] }, restrictedHeaders), 'TOKEN_INVALID')
  await expectFailure(await fetch(`${url}/v1/admin/users`, { headers: restrictedHeaders }), 'TOKEN_INVALID')
  expect(getCredential).not.toHaveBeenCalled()
  db.prepare(`INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at)
    SELECT 'synthetic-browser', id, user_id, 'CANARY-csrf', created_at, created_at, expires_at FROM session_families LIMIT 1`).run()
  const change = (newPassword: string) => fetch(`${url}/v1/auth/password`, {
    method: 'POST', headers: restrictedHeaders, body: JSON.stringify({ newPassword }),
  })
  await expectFailure(await change(''), 'PASSWORD_INVALID')
  expect((await change('CANARY-changed-password')).status).toBe(204)
  await expectFailure(await change('CANARY-another-password'), 'TOKEN_INVALID')
  await expectFailure(await fetch(`${url}/v1/tools`, { headers }), 'TOKEN_INVALID')
  expect(db.prepare('SELECT COUNT(*) AS count FROM session_families WHERE revoked_at IS NULL').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens WHERE revoked_at IS NULL').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NULL').get()).toEqual({ count: 0 })
  await expectFailure(await login(), 'SIGN_IN_FAILED')
  const next = await login('CANARY-changed-password')
  const authenticated = loginResponseSchema.parse(await next.json())
  expect(authenticated.status).toBe('authenticated')
  if (authenticated.status !== 'authenticated') throw new Error('Expected ordinary session')
  expect((await fetch(`${url}/v1/tools`, { headers: { authorization: `Bearer ${authenticated.accessToken}` } })).status).toBe(200)
})

test('security: concurrent restricted password changes commit exactly once', async () => {
  db.exec('UPDATE users SET must_change = 1')
  const session = loginResponseSchema.parse(await (await login()).json())
  if (session.status !== 'password-change-required') throw new Error('Expected restricted session')
  const change = () => fetch(`${url}/v1/auth/password`, { method: 'POST',
    headers: { ...headers, authorization: `Bearer ${session.passwordChangeToken}` },
    body: JSON.stringify({ newPassword: 'CANARY-concurrent-password' }) })
  const results = await Promise.all([change(), change()])
  expect(results.map(response => response.status).sort()).toEqual([204, 401])
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'password-change'").get()).toEqual({ count: 1 })
})

test.each(['access', 'password-change'] as const)('security: expired %s token cannot authorize a request', async type => {
  db.prepare('UPDATE users SET must_change = ?').run(type === 'password-change' ? 1 : 0)
  const session = loginResponseSchema.parse(await (await login()).json())
  const proof = session.status === 'authenticated' ? session.accessToken : session.passwordChangeToken
  db.prepare('UPDATE tokens SET expires_at = 0 WHERE hash = ?').run(hashToken(proof))
  const response = type === 'access' ? await run({ args: [] }, { ...headers, authorization: `Bearer ${proof}` })
    : await fetch(`${url}/v1/auth/password`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${proof}` },
      body: JSON.stringify({ newPassword: 'CANARY-changed-password' }) })
  await expectFailure(response, 'TOKEN_EXPIRED')
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['tokens', 'session_families'] as const)('security: revoked %s rejects the next request', async table => {
  db.exec(`UPDATE ${table} SET revoked_at = 1`)
  await expectFailure(await run({ args: [] }), 'TOKEN_INVALID')
  expect(getCredential).not.toHaveBeenCalled()
})

test('audit failure rolls back login issuance and restricted password change', async () => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM tokens').get()
  db.exec("CREATE TRIGGER fail_signin BEFORE INSERT ON audit WHEN NEW.event = 'sign-in' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await login(), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens').get()).toEqual(count)
  db.exec('DROP TRIGGER fail_signin; UPDATE users SET must_change = 1')
  const session = loginResponseSchema.parse(await (await login()).json())
  if (session.status !== 'password-change-required') throw new Error('Expected restricted session')
  db.exec("CREATE TRIGGER fail_password BEFORE INSERT ON audit WHEN NEW.event = 'password-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  const change = () => fetch(`${url}/v1/auth/password`, { method: 'POST',
    headers: { ...headers, authorization: `Bearer ${session.passwordChangeToken}` }, body: JSON.stringify({ newPassword: 'CANARY-changed-password' }) })
  await expectFailure(await change(), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT must_change FROM users').get()).toEqual({ must_change: 1 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens WHERE revoked_at IS NOT NULL').get()).toEqual({ count: 0 })
  db.exec('DROP TRIGGER fail_password')
  expect((await change()).status).toBe(204)
})

test('password endpoint changes only the access-token owner and requires a fresh sign-in', async () => {
  const password = 'CANARY-local-password'
  const hash = await hashPassword(password)
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-password-user', 'synthetic-password-user', 'Synthetic Password User', ?)").run(hash)
  const access = issueTestAccessToken(db, 'synthetic-password-user')
  const change = (body: unknown, proof = access) => fetch(`${url}/v1/auth/password`, {
    method: 'POST', headers: { ...headers, authorization: `Bearer ${proof}` }, body: JSON.stringify(body),
  })
  await expectFailure(await change({ newPassword: 'CANARY-new-password' }), 'SIGN_IN_FAILED')
  await expectFailure(await change({ newPassword: 'CANARY-new-password', currentPassword: 'wrong' }), 'SIGN_IN_FAILED')
  await expectFailure(await change({ newPassword: '', currentPassword: password }), 'PASSWORD_INVALID')
  await expectFailure(await change({ newPassword: 'CANARY-new-password', currentPassword: password, userId: 'other' }), 'INVALID_INPUT')
  await expectFailure(await change({ newPassword: 'CANARY-new-password', currentPassword: password }, 'CANARY-invalid'), 'TOKEN_INVALID')
  const result = await change({ newPassword: 'CANARY-new-password', currentPassword: password })
  expect(result.status).toBe(204)
  expect(await result.text()).toBe('')
  expect(await new LocalAuthProvider(db).signIn('synthetic-password-user', 'CANARY-new-password'))
    .toEqual({ userId: 'synthetic-password-user', mustChange: false })
  await expectFailure(await change({ newPassword: 'CANARY-another-password', currentPassword: 'CANARY-new-password' }), 'TOKEN_INVALID')
  expect(db.prepare("SELECT user_id, event, client_address FROM audit WHERE event = 'password-change'").all())
    .toEqual([{ user_id: 'synthetic-password-user', event: 'password-change', client_address: '127.0.0.1' }])
})

test('real requests list tools without retrieving credentials and preserve the completed upstream envelope', async () => {
  const listing = await fetch(`${url}/v1/tools`, { headers })
  expect(listing.status).toBe(200)
  expect(toolsResponseSchema.parse(await listing.json())).toEqual({ tools: [{ name: 'falcon-axi', version: '0.7.3', status: 'unconfigured', readOnly: true }] })
  expect(getCredential).not.toHaveBeenCalled()
  const response = await run({ args: ['upstream', 'vectra-axi', 'error'] })
  expect(response.status).toBe(200)
  const result = runSuccessSchema.parse(await response.json())
  expect(result.exitCode).not.toBe(0)
  expect(result.source).toBe('falcon-axi')
  expect(result.outputBytes).toEqual({ stdout: Buffer.byteLength(result.stdout), stderr: Buffer.byteLength(result.stderr) })
  expect(result.truncated).toEqual({ stdout: false, stderr: false })
})

test('audit is durable before credential preparation and child admission and identifies the socket address', async () => {
  const runChild = options.runner.run.bind(options.runner)
  vi.spyOn(options.runner, 'run').mockImplementation(async (...args) => {
    expect(db.prepare('SELECT event FROM audit').all()).toEqual([{ event: 'run-start' }])
    return runChild(...args)
  })
  getCredential.mockImplementationOnce(async () => {
    expect(db.prepare('SELECT event, user_id, client_address FROM audit').all()).toEqual([
      { event: 'run-start', user_id: 'synthetic-development-user', client_address: '127.0.0.1' },
    ])
    return { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }
  })
  const response = await run({ args: ['print', 'synthetic-output'], stdin: 'synthetic-input',
    files: [{ name: 'input.txt', contentBase64: Buffer.from('synthetic-file').toString('base64') }] })
  expect(response.status).toBe(200)
  expect(runSuccessSchema.parse(await response.json()).stdout).toBe('synthetic-output')
  expect(db.prepare('SELECT event, request_id FROM audit ORDER BY id').all()).toEqual([
    { event: 'run-start', request_id: expect.any(String) }, { event: 'run-terminal', request_id: expect.any(String) },
  ])
  expect(db.prepare('SELECT COUNT(DISTINCT request_id) AS count FROM audit').get()).toEqual({ count: 1 })
  expect(db.prepare('SELECT administrator FROM users').get()).toEqual({ administrator: 0 })
  await expectFailure(await fetch(`${url}/v1/admin/users`, { headers }), 'ADMIN_REQUIRED')
})

test.each([
  [{ args: ['--region=synthetic'] }, 'FLAG_BLOCKED'],
  [{ args: ['print'], environment: {} }, 'INVALID_INPUT'],
  [{ args: ['print'], files: [{ name: '../input', contentBase64: 'YQ==' }] }, 'INVALID_INPUT'],
  [{ args: ['print'], files: [{ name: 'input', contentBase64: 'YQ=' }] }, 'INVALID_INPUT'],
  [{ args: ['print'], files: [{ name: 'input', contentBase64: 'YQ==' }, { name: 'input', contentBase64: 'YQ==' }] }, 'INVALID_INPUT'],
  [{ args: ['print'], stdin: 'x'.repeat(inputLimits.stdinBytes + 1) }, 'INVALID_INPUT'],
] as const)('invalid body is rejected before credentials: %j', async (body, code) => {
  const requestId = await expectFailure(await run(body), code)
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare('SELECT event, outcome FROM audit WHERE request_id = ?').all(requestId)).toEqual([{ event: 'denial', outcome: code }])
})

test('current role removal denies the next request and produces an empty tools list', async () => {
  db.exec('DELETE FROM role_tools')
  await expectFailure(await run({ args: ['exit', '0'] }), 'TOOL_NOT_GRANTED')
  expect(await (await fetch(`${url}/v1/tools`, { headers })).json()).toEqual({ tools: [] })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['role_tools', 'user_roles'])('restart preserves revoked development policy in %s', async table => {
  db.exec(`DELETE FROM ${table}`)
  await expectFailure(await run({ args: ['exit', '0'] }), 'TOOL_NOT_GRANTED')
  await app.close()
  db.close()
  db = openStore(join(directory, 'data', 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  options = { ...options, db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')) }
  app = createApp(options)
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  await expectFailure(await run({ args: ['exit', '0'] }), 'TOOL_NOT_GRANTED')
  expect(await (await fetch(`${url}/v1/tools`, { headers })).json()).toEqual({ tools: [] })
  expect(getCredential).not.toHaveBeenCalled()
})

test('HTTP shutdown cancels an active child before draining requests and closing storage', async () => {
  await app.close()
  options.runner = await Runner.create(join(directory, 'calls'))
  app = createApp(options)
  const readyFile = join(directory, 'ready.json')
  const runChild = options.runner.run.bind(options.runner)
  vi.spyOn(options.runner, 'run').mockImplementation((userId, executable, args, environment, secrets, limits, input) =>
    runChild(userId, executable, args, { ...environment, ARTIUM_TEST_READY_FILE: readyFile }, secrets, limits, input))
  let watcher: ReturnType<typeof watch>
  const ready = new Promise<number>((resolve, reject) => {
    watcher = watch(directory, (_event, name) => {
      if (name !== 'ready.json') return
      watcher.close()
      try { resolve(JSON.parse(readFileSync(readyFile, 'utf8')).parent) } catch (error) { reject(error) }
    })
  })
  let terminal: unknown
  app.addHook('onClose', async () => {
    terminal = db.prepare("SELECT event, outcome FROM audit ORDER BY id").all()
    db.close()
  })
  try {
    url = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = run({ args: ['sleep', '60000'] })
    const pid = await ready
    const closing = app.close()
    await expectFailure(await response, 'CANCELLED')
    await closing
    expect(terminal).toEqual([{ event: 'run-start', outcome: 'started' }, { event: 'run-terminal', outcome: 'CANCELLED' }])
    expect(db.open).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally { watcher!.close() }
}, 10_000)

test('authentication failures use the exact envelope on both endpoints', async () => {
  await expectFailure(await fetch(`${url}/v1/tools`), 'TOKEN_INVALID')
  await expectFailure(await run({ args: ['exit', '0'] }, { ...headers, authorization: 'Bearer CANARY-wrong' }), 'TOKEN_INVALID')
  expect(getCredential).not.toHaveBeenCalled()
})

test('supported tools without an adapter still authenticate and audit their denial', async () => {
  const endpoint = `${url}/v1/tools/vectra-axi/run`
  await expectFailure(await fetch(endpoint, { method: 'POST', headers, body: '{"args":[]}' }), 'TOOL_DISABLED')
  await expectFailure(await fetch(endpoint, { method: 'POST', headers: { ...headers, authorization: 'Bearer CANARY-wrong' }, body: '{"args":[]}' }), 'TOKEN_INVALID')
  expect(db.prepare('SELECT tool, outcome FROM audit ORDER BY id').all()).toEqual([
    { tool: 'vectra-axi', outcome: 'TOOL_DISABLED' }, { tool: 'vectra-axi', outcome: 'TOKEN_INVALID' },
  ])
})

test.each([{ ARTIUM_AXI_DEV: '1' }, { ARTIUM_AXI_DEV_TOKEN_FILE: '/synthetic-missing-token' }])('startup rejects development settings', env => {
  expect(() => checkAuthSettings(env)).toThrow(expect.objectContaining({ code: 'DEV_AUTH_INVALID' }))
})

test('audit failure refuses child creation and terminal failure withholds completed output', async () => {
  db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await run({ args: ['print', 'synthetic-output'] }), 'AUDIT_UNAVAILABLE')
  expect(getCredential).not.toHaveBeenCalled()
  db.exec("DROP TRIGGER fail_start; CREATE TRIGGER fail_terminal BEFORE INSERT ON audit WHEN NEW.event = 'run-terminal' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await run({ args: ['print', 'synthetic-output'] }), 'AUDIT_UNAVAILABLE')
  expect(getCredential).toHaveBeenCalledOnce()
})

test('a known-secret child output returns only the safe failure envelope', async () => {
  await expectFailure(await run({ args: ['leak'] }), 'SECRET_IN_OUTPUT')
  expect(db.prepare("SELECT outcome, stdout_bytes FROM audit WHERE event = 'run-terminal'").get())
    .toEqual({ outcome: 'SECRET_IN_OUTPUT', stdout_bytes: 13 })
})

test('bundled CLI runs through the real API and withholds environment-mode canary output', async () => {
  const { build } = await import('esbuild')
  const bundle = join(directory, 'artium-axi.mjs')
  await build({ entryPoints: ['src/cli/main.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' } })
  const execute = promisify(execFile)
  const settings = { cwd: directory, timeout: 10_000,
    env: { PATH: process.env.PATH, ...environment, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }
  const result = await execute(process.execPath, [bundle, 'falcon-axi', 'print', 'synthetic output'], settings)
  expect(result).toEqual({ stdout: 'synthetic output', stderr: '' })
  await expect(execute(process.execPath, [bundle, 'falcon-axi', 'env'], settings))
    .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '' })
  const terminal = db.prepare("SELECT outcome, stdout_bytes FROM audit WHERE event = 'run-terminal' ORDER BY id").all()
  expect(terminal).toEqual([{ outcome: 'completed', stdout_bytes: 16 }, { outcome: 'SECRET_IN_OUTPUT', stdout_bytes: expect.any(Number) }])
})

test.each(['stdout', 'stderr'])('security: bundled CLI withholds every encoded canary in %s and records only safe metadata', async stream => {
  const { build } = await import('esbuild')
  const bundle = join(directory, 'artium-axi.mjs')
  await build({ entryPoints: ['src/cli/main.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' } })
  const execute = promisify(execFile)
  const canary = 'CANARY-☃ÿ?/+='
  for (const form of ['raw', 'base64', 'base64url', 'url']) {
    getCredential.mockResolvedValueOnce({ clientId: 'CANARY-client', clientSecret: canary, region: 'us-2' })
    await expect(execute(process.execPath, [bundle, 'falcon-axi', 'leak', form, stream], { cwd: directory, timeout: 10_000,
      env: { PATH: process.env.PATH, ...environment, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '' })
  }
  const records = db.prepare("SELECT tool, outcome, arguments FROM audit WHERE event = 'run-terminal'").all()
  expect(records).toEqual(Array(4).fill({ tool: 'falcon-axi', outcome: 'SECRET_IN_OUTPUT', arguments: null }))
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(canary)
})

test('malformed JSON, content type, unknown tool and body byte limit use safe errors', async () => {
  await expectFailure(await fetch(`${url}/v1/tools/falcon-axi/run`, { method: 'POST', headers, body: '{' }), 'INVALID_INPUT')
  await expectFailure(await run({ args: [] }, { ...headers, 'content-type': 'text/plain' }), 'INVALID_INPUT')
  await expectFailure(await fetch(`${url}/v1/tools/unknown/run`, { method: 'POST', headers, body: '{"args":[]}' }), 'INVALID_INPUT')
  await expectFailure(await run({ args: [], stdin: 'x'.repeat(inputLimits.requestBytes) }), 'INVALID_INPUT')
  expect(getCredential).not.toHaveBeenCalled()
})

test('health is public and checks local storage without retrieving credentials', async () => {
  for (const endpoint of ['live', 'ready']) {
    const response = await fetch(`${url}/health/${endpoint}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  }
  db.close()
  const response = await fetch(`${url}/health/ready`)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'unavailable' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'])('security rejects spoofed %s from untrusted sockets', async header => {
  await expectFailure(await run({ args: ['exit', '0'] }, { ...headers, [header]: '192.0.2.17' }), 'PROXY_HEADERS_UNTRUSTED')
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 })
})

test('a real trusted proxy replaces supplied forwarding headers and audits its verified client address', async () => {
  await app.close()
  options.runner = await Runner.create(join(directory, 'proxy-calls'))
  app = createApp({ ...options, environment: { ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' } })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const result = await fetch(`${url}${request.url}`, { method: request.method,
      headers: { ...headers, 'x-forwarded-for': '192.0.2.42' }, body: Buffer.concat(chunks) })
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(await result.text())
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const address = proxy.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/tools/falcon-axi/run`, {
      method: 'POST', headers: { ...headers, 'x-forwarded-for': '192.0.2.99' }, body: JSON.stringify({ args: ['exit', '0'] }) })
    expect(response.status).toBe(200)
    expect(db.prepare("SELECT client_address FROM audit WHERE event = 'run-start'").get()).toEqual({ client_address: '192.0.2.42' })
  } finally { await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) }
})

test.each(['0', '1', 'true', '01', ''])('production startup rejects development settings: %s', value => {
  expect(() => createApp({ ...options, environment: { NODE_ENV: 'production', ARTIUM_AXI_DEV: value } }))
    .toThrow(expect.objectContaining({ code: 'DEV_AUTH_INVALID' }))
})

test('the real server process exits at startup with a development setting', async () => {
  const { build } = await import('esbuild')
  const entry = join(directory, 'server.mjs')
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: ['src/server/main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(entry)})`], {
    cwd: process.cwd(), env: { ...process.env, ...environment, ARTIUM_AXI_DEV: '0' }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'DEV_AUTH_INVALID', requestId: 'startup' } })
})

test('the real server remains available after startup encounters a damaged native journal', async () => {
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator)
    VALUES ('synthetic-admin', 'synthetic-admin', 'Synthetic Admin', 'unusable', 1);
    INSERT INTO bootstrap_metadata VALUES (1, 1)`)
  const { build } = await import('esbuild')
  const entry = join(directory, 'server.mjs')
  const logDirectory = join(directory, 'data', 'tool-logs', 'vectra-axi')
  const journal = join(logDirectory, 'writes.log')
  const damaged = '{"kind":"intent","synthetic":"CANARY-partial'
  mkdirSync(logDirectory, { recursive: true })
  writeFileSync(journal, damaged, { mode: 0o600 })
  writeFileSync(`${journal}.lock`, '')
  writeFileSync(`${journal}.retention`, 'interrupted compaction')
  const expiredJournals = ['az-axi', 'mg-axi', 'vectra-axi'].map(tool => join(directory, 'data', 'tool-logs', tool, 'writes.log.runs', 'run-z-expired'))
  const validRecord = { kind: 'intent', intentKey: 'a'.repeat(64), time: '2026-01-01T00:00:00.000Z',
    profile: 'synthetic', identity: 'synthetic', class: 'safe-write', method: 'PATCH',
    url: 'https://synthetic.invalid/resource', outcome: 'success', httpStatus: 200 }
  for (const path of expiredJournals) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'writes.log'), `${JSON.stringify(validRecord)}\n`)
    utimesSync(path, new Date(0), new Date(0))
  }
  const malformedJournals = expiredJournals.flatMap(path => [damaged, '{invalid}\n', '{}\n', '[]\n'].map((content, index) => ({
    path: join(path, '..', `run-a-malformed-${index}`, 'writes.log'), content,
  })))
  for (const { path, content } of malformedJournals) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    utimesSync(join(path, '..'), new Date(0), new Date(0))
  }
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  cpSync('src/server/store/migrations', join(directory, 'migrations'), { recursive: true })
  await build({ stdin: { contents: `
    import { Server } from 'node:net';
    import { serverDefaults } from './src/server/config.ts';
    Object.assign(serverDefaults, { host: '127.0.0.1', port: 0, temporaryDirectory: ${JSON.stringify(join(directory, 'startup-calls'))} });
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => process.stdout.write(JSON.stringify(this.address()) + '\\n'));
      return listen.apply(this, args);
    };
    await import('./src/server/main.ts');
  `, resolveDir: process.cwd() }, outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const child = spawn(process.execPath, [entry], { cwd: directory,
    env: { ...process.env, ARTIUM_AXI_DATABASE_FILE: join(directory, 'data', 'artium.db'),
      ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const closed = once(child, 'close')
  try {
    const [output] = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error(stderr) })])
    const address = JSON.parse(output.toString()) as { port: number }
    const origin = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${origin}/health/ready`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(expiredJournals.map(existsSync)).toEqual([false, false, false])
    expect(malformedJournals.map(({ path }) => readFileSync(path, 'utf8')))
      .toEqual(malformedJournals.map(({ content }) => content))
    const listing = await fetch(`${origin}/v1/tools`, { headers })
    expect(listing.status).toBe(200)
    expect(toolsResponseSchema.parse(await listing.json()).tools).toContainEqual({ name: 'falcon-axi', version: '0.7.3', status: 'unconfigured', readOnly: true })
    db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.6' WHERE name = 'az-axi'")
    const azureListing = await fetch(`${origin}/v1/tools`, { headers })
    expect(toolsResponseSchema.parse(await azureListing.json()).tools).toContainEqual({ name: 'az-axi', version: '0.1.12', status: 'unconfigured', readOnly: true })
    db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.6' WHERE name = 'mg-axi'")
    const graphListing = await fetch(`${origin}/v1/tools`, { headers })
    expect(graphListing.status, await graphListing.clone().text()).toBe(200)
    expect(toolsResponseSchema.parse(await graphListing.json()).tools).toContainEqual({ name: 'mg-axi', version: '0.1.12', status: 'unconfigured', readOnly: true })
    expect(readFileSync(journal, 'utf8')).toBe(damaged)
  } finally {
    child.kill('SIGTERM')
    await closed
  }
  expect(stderr.trim().split('\n').map(line => JSON.parse(line))).toEqual(expect.arrayContaining([
    { error: { code: 'AUDIT_UNAVAILABLE', source: 'artium-axi', message: errors.AUDIT_UNAVAILABLE.message,
      next: errors.AUDIT_UNAVAILABLE.next, requestId: 'retention' } },
  ]))
  expect(stderr).not.toContain('CANARY-partial')
  expect(stderr.trim().split('\n').map(line => JSON.parse(line).error.code))
    .toEqual(Array(5).fill('AUDIT_UNAVAILABLE'))
}, 10_000)
