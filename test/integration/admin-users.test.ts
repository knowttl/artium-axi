import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { adminUserSchema, adminUsersResponseSchema, loginResponseSchema } from '../../src/shared/api.js'
import { errors, type ErrorCode } from '../../src/shared/errors.js'
import { hashToken, verifyAccessToken } from '../../src/server/auth/tokens.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let url: string
let headers: Record<string, string>
const password = 'CANARY-local-password'
const administrator = 'synthetic-development-user'
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const createInput = { username: ' Synthetic-New ', displayName: 'Synthetic New', temporaryPassword: 'CANARY-temporary-password',
  administrator: false, roleIds: ['synthetic-role'] }

async function start(connection: Database.Database) {
  const runner = await Runner.create(join(directory, 'calls'))
  const server = createApp({ db: connection, runner, audit: new Audit(connection), environment: {}, adapters: [],
    resolver: new SharedIdentityResolver(new FakeCredentialStore([])) })
  return { server, address: await server.listen({ host: '127.0.0.1', port: 0 }) }
}

async function signIn(username: string, address = url) {
  const response = await fetch(`${address}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }) })
  expect(response.status).toBe(200)
  const session = loginResponseSchema.parse(await response.json())
  if (session.status !== 'authenticated') throw new Error('Expected ordinary local login')
  return session
}

async function adminHeaders(username = 'synthetic-user', address = url) {
  const session = await signIn(username, address)
  const authorization = { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }
  const response = await fetch(`${address}/v1/auth/reauth`, { method: 'POST', headers: authorization, body: JSON.stringify({ password }) })
  expect(response.status).toBe(200)
  const { ticket } = await response.json() as { ticket: string }
  return { ...authorization, 'x-artium-reauth-ticket': ticket }
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-admin-users-'))
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  await seedToolUser(db)
  db.exec(`UPDATE users SET administrator = 1;
    INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
      SELECT 'synthetic-second', 'synthetic-second', 'Second', password_hash, 1, 0 FROM users LIMIT 1;
    INSERT INTO users (id, username, display_name, password_hash, must_change)
      SELECT 'synthetic-ordinary', 'synthetic-ordinary', 'Ordinary', password_hash, 0 FROM users LIMIT 1;
    INSERT INTO user_roles VALUES ('synthetic-ordinary', 'synthetic-role');`)
  const started = await start(db)
  app = started.server
  url = started.address
  headers = await adminHeaders()
  db.exec('DELETE FROM audit')
})

afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function request(method: string, path: string, body?: unknown, proof = headers, address = url) {
  const { 'content-type': _contentType, ...withoutContentType } = proof
  return fetch(`${address}/v1/admin/users${path}`, { method, headers: body === undefined ? withoutContentType : proof,
    body: body === undefined ? undefined : JSON.stringify(body) })
}

async function failure(response: Response, code: ErrorCode) {
  expect(response.status).toBe(errors[code].status)
  expect(await response.json()).toMatchObject({ error: { code } })
}

const routes = [
  { method: 'GET', path: '', body: undefined },
  { method: 'POST', path: '', body: createInput },
  { method: 'PATCH', path: '/synthetic-ordinary', body: { enabled: false, expectedRevision: 1 } },
  { method: 'POST', path: '/synthetic-ordinary/unlock', body: {} },
  { method: 'POST', path: '/synthetic-ordinary/password-reset', body: { temporaryPassword: 'CANARY-reset-password' } },
]

test.each(routes)('$method $path requires administrator capability even with tool grants and reauth', async route => {
  const ordinary = await adminHeaders('synthetic-ordinary')
  await failure(await request(route.method, route.path, route.body, ordinary), 'ADMIN_REQUIRED')
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 0 })
  expect(db.prepare("SELECT user_id, outcome FROM audit WHERE event = 'denial'").get())
    .toEqual({ user_id: 'synthetic-ordinary', outcome: 'ADMIN_REQUIRED' })
})

test.each(routes)('$method $path rejects missing recent-auth ticket', async route => {
  const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
  await failure(await request(route.method, route.path, route.body, missing), 'REAUTH_REQUIRED')
})

test('admin listing has bounded stable cursors and only public account fields', async () => {
  const first = adminUsersResponseSchema.parse(await (await request('GET', '?limit=2')).json())
  expect(first.users.map(user => user.id)).toEqual([administrator, 'synthetic-ordinary'])
  expect(first.nextCursor).toBe('synthetic-ordinary')
  const second = adminUsersResponseSchema.parse(await (await request('GET', `?limit=2&cursor=${first.nextCursor}`)).json())
  expect(second.users.map(user => user.id)).toEqual(['synthetic-second'])
  expect(second.nextCursor).toBeNull()
  expect(first.users[0]).toMatchObject({ roleIds: ['synthetic-role'], source: 'local', revision: 1 })
  await failure(await request('GET', '?limit=101'), 'INVALID_INPUT')
})

test('create canonicalizes the username, assigns roles, forces password change and records its actor', async () => {
  const response = await request('POST', '', createInput)
  expect(response.status).toBe(201)
  const user = adminUserSchema.parse(await response.json())
  expect(user).toMatchObject({ username: 'synthetic-new', displayName: 'Synthetic New', enabled: true,
    administrator: false, mustChange: true, revision: 1, updatedBy: administrator, updatedAt: expect.any(Number), roleIds: ['synthetic-role'] })
  const login = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: createInput.username, password: createInput.temporaryPassword }) })
  expect(loginResponseSchema.parse(await login.json()).status).toBe('password-change-required')
  expect(db.prepare("SELECT action, target_id, user_id, arguments, outcome FROM audit WHERE event = 'admin-change'").all())
    .toEqual([{ action: 'create-user', target_id: user.id, user_id: administrator, arguments: null, outcome: 'success' }])
})

test.each([
  { input: { ...createInput, roleIds: ['missing-role'] }, code: 'INVALID_INPUT' },
  { input: { ...createInput, username: ' SYNTHETIC-SECOND ' }, code: 'INVALID_INPUT' },
  { input: { ...createInput, username: 'bad username' }, code: 'USERNAME_INVALID' },
  { input: { ...createInput, temporaryPassword: 'too-short' }, code: 'PASSWORD_INVALID' },
  { input: { ...createInput, temporaryPassword: 'passwordpassword' }, code: 'PASSWORD_INVALID' },
] as const)('invalid create returns $code without inserting an account or audit', async ({ input, code }) => {
  await failure(await request('POST', '', input), code)
  expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 3 })
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})

function browserSession(accessToken: string, id: string) {
  const token = db.prepare('SELECT family_id, user_id FROM tokens WHERE hash = ?').get(hashToken(accessToken)) as { family_id: string, user_id: string }
  db.prepare(`INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, 'CANARY-csrf', ?, ?, ?)`).run(id, token.family_id, token.user_id, Date.now(), Date.now(), Date.now() + 60_000)
}

test('disable revokes CLI and browser sessions atomically and stale edits preserve the new state', async () => {
  const session = await signIn('synthetic-ordinary')
  browserSession(session.accessToken, 'synthetic-browser')
  const response = await request('PATCH', '/synthetic-ordinary', { enabled: false, displayName: 'Changed', expectedRevision: 1 })
  expect(response.status).toBe(200)
  expect(adminUserSchema.parse(await response.json())).toMatchObject({ enabled: false, displayName: 'Changed', revision: 2, updatedBy: administrator })
  expect(() => verifyAccessToken(db, session.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  expect(db.prepare('SELECT revoked_at FROM sessions').get()).toEqual({ revoked_at: expect.any(Number) })
  await failure(await request('PATCH', '/synthetic-ordinary', { enabled: true, expectedRevision: 1 }), 'REVISION_CONFLICT')
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})

async function exhaustUsername() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await failure(await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ' SYNTHETIC-ORDINARY ', password: 'CANARY-wrong-password' }) }), 'SIGN_IN_FAILED')
  }
  await failure(await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic-ordinary', password }) }), 'AUTH_RATE_LIMITED')
}

test('unlock restores sign-in immediately after five wrong passwords and records metadata and revision', async () => {
  await exhaustUsername()
  const response = await request('POST', '/synthetic-ordinary/unlock')
  expect(response.status).toBe(200)
  expect(adminUserSchema.parse(await response.json())).toMatchObject({ failedAttempts: 0, lockedUntil: null, revision: 2, updatedBy: administrator })
  expect((await signIn('synthetic-ordinary')).status).toBe('authenticated')
  expect(db.prepare("SELECT action FROM audit WHERE event = 'admin-change'").get()).toEqual({ action: 'unlock-user' })
})

test('password reset restores restricted sign-in immediately after five wrong passwords', async () => {
  await exhaustUsername()
  const temporaryPassword = 'CANARY-reset-password'
  const response = await request('POST', '/synthetic-ordinary/password-reset', { temporaryPassword })
  expect(response.status).toBe(200)
  expect(adminUserSchema.parse(await response.json())).toMatchObject({ failedAttempts: 0, lockedUntil: null, mustChange: true })
  const login = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic-ordinary', password: temporaryPassword }) })
  expect(login.status).toBe(200)
  expect(loginResponseSchema.parse(await login.json()).status).toBe('password-change-required')
})

test.each([
  { path: '/synthetic-ordinary/unlock', body: {} },
  { path: '/synthetic-ordinary/password-reset', body: { temporaryPassword: 'CANARY-reset-password' } },
])('$path audit failure preserves the exhausted username counter', async route => {
  await exhaustUsername()
  db.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON audit WHEN NEW.event = 'admin-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request('POST', route.path, route.body), 'AUDIT_UNAVAILABLE')
  await failure(await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic-ordinary', password }) }), 'AUTH_RATE_LIMITED')
})

test('enable and administrator capability edits apply to the next request', async () => {
  const ordinary = await adminHeaders('synthetic-ordinary')
  const promoted = await request('PATCH', '/synthetic-ordinary', { administrator: true, expectedRevision: 1 })
  expect(promoted.status).toBe(200)
  expect((await request('GET', '', undefined, ordinary)).status).toBe(200)
  const demoted = await request('PATCH', '/synthetic-ordinary', { administrator: false, expectedRevision: 2 })
  expect(demoted.status).toBe(200)
  await failure(await request('GET', '', undefined, ordinary), 'ADMIN_REQUIRED')
  db.exec("UPDATE users SET disabled = 1 WHERE id = 'synthetic-ordinary'")
  const enabled = await request('PATCH', '/synthetic-ordinary', { enabled: true, expectedRevision: 3 })
  expect(enabled.status).toBe(200)
  expect(adminUserSchema.parse(await enabled.json())).toMatchObject({ enabled: true, administrator: false, revision: 4 })
})

test('concurrent edits of the same revision commit one change and reject the stale edit', async () => {
  const results = await Promise.all([
    request('PATCH', '/synthetic-ordinary', { displayName: 'First edit', expectedRevision: 1 }),
    request('PATCH', '/synthetic-ordinary', { displayName: 'Second edit', expectedRevision: 1 }),
  ])
  expect(results.map(result => result.status).sort()).toEqual([200, 409])
  await failure(results.find(result => result.status === 409)!, 'REVISION_CONFLICT')
  expect(db.prepare("SELECT revision FROM users WHERE id = 'synthetic-ordinary'").get()).toEqual({ revision: 2 })
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})

test('reset forces a restricted login with the exact new password and revokes all prior sessions', async () => {
  const session = await signIn('synthetic-ordinary')
  browserSession(session.accessToken, 'synthetic-browser')
  const temporaryPassword = ' CANARY-reset-password 🐦 '
  const response = await request('POST', '/synthetic-ordinary/password-reset', { temporaryPassword })
  expect(response.status).toBe(200)
  expect(adminUserSchema.parse(await response.json())).toMatchObject({ mustChange: true, revision: 2, updatedBy: administrator })
  expect(() => verifyAccessToken(db, session.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  expect(db.prepare('SELECT revoked_at FROM sessions').get()).toEqual({ revoked_at: expect.any(Number) })
  const login = await fetch(`${url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'synthetic-ordinary', password: temporaryPassword }) })
  expect(loginResponseSchema.parse(await login.json()).status).toBe('password-change-required')
  expect(db.prepare("SELECT action FROM audit WHERE event = 'admin-change'").get()).toEqual({ action: 'reset-user-password' })
  await failure(await request('POST', '/synthetic-ordinary/password-reset', { temporaryPassword: 'short' }), 'PASSWORD_INVALID')
})

test.each(routes.filter(route => route.method !== 'GET'))('$method $path audit failure rolls back the whole mutation', async route => {
  const session = await signIn('synthetic-ordinary')
  browserSession(session.accessToken, 'synthetic-browser')
  db.exec("UPDATE users SET failed_attempts = 5, locked_until = 9999999999999 WHERE id = 'synthetic-ordinary'")
  const before = db.prepare('SELECT * FROM users ORDER BY id').all()
  const roles = db.prepare('SELECT * FROM user_roles ORDER BY user_id, role_id').all()
  db.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON audit WHEN NEW.event = 'admin-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request(route.method, route.path, route.body), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM user_roles ORDER BY user_id, role_id').all()).toEqual(roles)
  expect(verifyAccessToken(db, session.accessToken)).toBe('synthetic-ordinary')
  expect(db.prepare('SELECT revoked_at FROM sessions').get()).toEqual({ revoked_at: null })
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 0 })
})

test.each([
  { method: 'PATCH', path: '/missing', body: { enabled: false, expectedRevision: 1 } },
  { method: 'POST', path: '/missing/unlock', body: {} },
  { method: 'POST', path: '/missing/password-reset', body: { temporaryPassword: 'CANARY-reset-password' } },
])('$method $path returns 404 without audit', async route => {
  await failure(await request(route.method, route.path, route.body), 'NOT_FOUND')
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})

test.each([{ enabled: false }, { administrator: false }])('last administrator cannot be removed with $enabled $administrator', async edit => {
  db.exec("UPDATE users SET administrator = 0 WHERE id = 'synthetic-second'")
  await failure(await request('PATCH', `/${administrator}`, { ...edit, expectedRevision: 1 }), 'LAST_ADMINISTRATOR')
  expect(db.prepare('SELECT revision FROM users WHERE id = ?').get(administrator)).toEqual({ revision: 1 })
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})

test('concurrent last-admin disables on separate connections commit exactly one audited change', async () => {
  const otherDb = openStore(join(directory, 'data', 'artium.db'), provider)
  const other = await start(otherDb)
  try {
    const otherHeaders = await adminHeaders('synthetic-second', other.address)
    const results = await Promise.all([
      request('PATCH', `/${administrator}`, { enabled: false, expectedRevision: 1 }),
      request('PATCH', '/synthetic-second', { enabled: false, expectedRevision: 1 }, otherHeaders, other.address),
    ])
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    const denied = results.find(result => result.status === 409)!
    await failure(denied, 'LAST_ADMINISTRATOR')
    expect(db.prepare('SELECT COUNT(*) AS count FROM users WHERE administrator = 1 AND disabled = 0').get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
  } finally { await other.server.close(); otherDb.close() }
})

test('expired and other-session reauth tickets cannot administer accounts', async () => {
  const other = await adminHeaders()
  await failure(await request('GET', '', undefined, { ...other, 'x-artium-reauth-ticket': headers['x-artium-reauth-ticket']! }), 'REAUTH_REQUIRED')
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_000)
  await failure(await request('GET', ''), 'REAUTH_REQUIRED')
})
