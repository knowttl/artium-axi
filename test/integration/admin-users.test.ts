import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { adminAuditRoute, adminRoleRoutes, adminRoleSchema, adminRolesResponseSchema, adminUserRoutes, adminUserSchema, adminUsersResponseSchema, loginResponseSchema } from '../../src/shared/api.js'
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

function auditRequest(query = '', proof = headers, method = 'GET') {
  const { 'content-type': _contentType, ...withoutContentType } = proof
  return fetch(`${url}/v1/admin/audit${query ? '?' + query : ''}`, { method, headers: withoutContentType })
}

function seedAudit() {
  const audit = new Audit(db, () => Date.parse('2026-01-01T00:00:00Z'))
  audit.record({ event: 'admin-change', userId: administrator, tool: null, outcome: 'success',
    requestId: 'first', clientAddress: null, action: 'create-user', targetId: 'synthetic-new' })
  audit.record({ event: 'credential-test', userId: 'synthetic-ordinary', tool: 'falcon-axi', outcome: 'failure',
    requestId: 'second', clientAddress: null, checkedAt: null, credentialRevision: 1, errorCode: 'CREDENTIAL_UNAVAILABLE' })
  new Audit(db, () => Date.parse('2026-01-02T00:00:00Z')).record({ event: 'denial', userId: administrator,
    tool: 'vectra-axi', outcome: 'TOOL_NOT_GRANTED', requestId: 'third', clientAddress: null })
}

test('audit pages stay newest first with time ties and exclude newer and backdated inserts', async () => {
  seedAudit()
  const first = adminAuditRoute.response.parse(await (await auditRequest('limit=1')).json())
  expect(first.records.map(record => record.request_id)).toEqual(['third'])
  expect(first.nextCursor).not.toBeNull()
  new Audit(db).record({ event: 'sign-in', userId: administrator, tool: null, outcome: 'success', requestId: 'new', clientAddress: null })
  new Audit(db, () => 0).record({ event: 'sign-in', userId: administrator, tool: null, outcome: 'success', requestId: 'backdated', clientAddress: null })
  const second = adminAuditRoute.response.parse(await (await auditRequest('limit=1&cursor=' + first.nextCursor)).json())
  expect(second.records.map(record => record.request_id)).toEqual(['second'])
  const third = adminAuditRoute.response.parse(await (await auditRequest('limit=1&cursor=' + second.nextCursor)).json())
  expect(third.records.map(record => record.request_id)).toEqual(['first'])
  expect(third.nextCursor).toBeNull()
  const fresh = adminAuditRoute.response.parse(await (await auditRequest()).json())
  expect(fresh.records.map(record => record.request_id)).toEqual(['new', 'third', 'second', 'first', 'backdated'])
})

test.each([
  { query: 'user=synthetic-development-user', requests: ['third', 'first'] },
  { query: 'tool=falcon-axi', requests: ['second'] },
  { query: 'outcome=TOOL_NOT_GRANTED', requests: ['third'] },
  { query: 'from=2026-01-02T00:00:00Z', requests: ['third'] },
  { query: 'to=2026-01-01T00:00:00Z', requests: ['second', 'first'] },
  { query: 'from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', requests: ['second', 'first'] },
  { query: 'user=synthetic-ordinary&tool=falcon-axi&outcome=failure&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z', requests: ['second'] },
  { query: 'user=missing', requests: [] },
  { query: 'user=synthetic-development-user&tool=falcon-axi', requests: [] },
])('audit filters $query return matching records without changing them', async ({ query, requests }) => {
  seedAudit()
  const before = db.prepare('SELECT * FROM audit ORDER BY id').all()
  const response = await auditRequest(query)
  expect(response.status).toBe(200)
  const page = adminAuditRoute.response.parse(await response.json())
  expect(page.records.map(record => record.request_id)).toEqual(requests)
  expect(page.nextCursor).toBeNull()
  expect(db.prepare('SELECT * FROM audit ORDER BY id').all()).toEqual(before)
})

test('audit query caps default and maximum pages', async () => {
  const audit = new Audit(db, () => 0)
  for (let id = 0; id < 101; id++) audit.record({ event: 'sign-in', userId: administrator, tool: null,
    outcome: 'success', requestId: String(id), clientAddress: null })
  expect(adminAuditRoute.response.parse(await (await auditRequest()).json()).records).toHaveLength(50)
  const first = adminAuditRoute.response.parse(await (await auditRequest('limit=100')).json())
  expect(first.records).toHaveLength(100)
  const last = adminAuditRoute.response.parse(await (await auditRequest('limit=100&cursor=' + first.nextCursor)).json())
  expect(last.records.map(record => record.request_id)).toEqual(['0'])
  expect(last.nextCursor).toBeNull()
})

test.each(['limit=0', 'limit=101', 'limit=1.5', 'cursor=x', 'cursor=1:0:2', 'cursor=0:0:0',
  'cursor=9007199254740992:0:1', 'cursor=1:8640000000000001:1', 'cursor=' + '1'.repeat(200),
  'tool=unknown', 'from=invalid', 'to=2026-01-01T00:00:00', 'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z'])
('audit rejects malformed or unbounded query %s', async query => {
  await failure(await auditRequest(query), 'INVALID_INPUT')
})

test('audit query rejects non-admins even with all tool grants and audits the denial', async () => {
  const ordinary = await adminHeaders('synthetic-ordinary')
  await failure(await auditRequest('', ordinary), 'ADMIN_REQUIRED')
  expect(db.prepare("SELECT outcome, user_id FROM audit WHERE event = 'denial'").get())
    .toEqual({ outcome: 'ADMIN_REQUIRED', user_id: 'synthetic-ordinary' })
})

test('bearer audit query requires a session-bound recent password ticket', async () => {
  const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
  await failure(await auditRequest('', missing), 'REAUTH_REQUIRED')
})

test.each(['POST', 'PATCH', 'DELETE'])('audit has no %s mutation route', async method => {
  seedAudit()
  const before = db.prepare('SELECT * FROM audit').all()
  expect((await auditRequest('', headers, method)).status).toBe(404)
  expect(db.prepare('SELECT * FROM audit').all()).toEqual(before)
})

const routes = [
  { method: 'GET', path: '', body: undefined },
  { method: 'GET', path: '/synthetic-ordinary', body: undefined },
  { method: 'GET', path: '/synthetic-ordinary/sessions', body: undefined },
  { method: 'POST', path: '/synthetic-ordinary/sessions/revoke', body: {} },
  { method: 'POST', path: '/synthetic-ordinary/archive', body: { expectedRevision: 1 } },
  { method: 'POST', path: '', body: createInput },
  { method: 'PATCH', path: '/synthetic-ordinary', body: { enabled: false, expectedRevision: 1 } },
  { method: 'POST', path: '/synthetic-ordinary/unlock', body: {} },
  { method: 'POST', path: '/synthetic-ordinary/password-reset', body: { temporaryPassword: 'CANARY-reset-password' } },
  { method: 'PUT', path: '/synthetic-ordinary/roles', body: { roleIds: [], expectedRevision: 1 } },
]

const authorizationRoutes = [...routes, { method: 'POST', path: '/synthetic-ordinary/sessions/missing/revoke', body: {} }]

test.each(authorizationRoutes)('$method $path requires administrator capability even with tool grants and reauth', async route => {
  const ordinary = await adminHeaders('synthetic-ordinary')
  await failure(await request(route.method, route.path, route.body, ordinary), 'ADMIN_REQUIRED')
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 0 })
  expect(db.prepare("SELECT user_id, outcome FROM audit WHERE event = 'denial'").get())
    .toEqual({ user_id: 'synthetic-ordinary', outcome: 'ADMIN_REQUIRED' })
})

test.each(authorizationRoutes)('$method $path rejects missing recent-auth ticket', async route => {
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

function roleRequest(method: string, path: string, body?: unknown, proof = headers) {
  const { 'content-type': _contentType, ...withoutContentType } = proof
  return fetch(`${url}/v1/admin/roles${path}`, { method, headers: body === undefined ? withoutContentType : proof,
    body: body === undefined ? undefined : JSON.stringify(body) })
}

const roleRoutes = [
  { method: 'GET', path: '', body: undefined },
  { method: 'GET', path: '/synthetic-role', body: undefined },
  { method: 'GET', path: '/synthetic-role/members', body: undefined },
  { method: 'DELETE', path: '/synthetic-role', body: { expectedRevision: 1 } },
  { method: 'POST', path: '', body: { name: 'New Role' } },
  { method: 'PATCH', path: '/synthetic-role', body: { name: 'Renamed', expectedRevision: 1 } },
  { method: 'PUT', path: '/synthetic-role/tools', body: { tools: [], expectedRevision: 1 } },
]

test.each(roleRoutes)('$method roles$path rejects non-admins with all tool grants', async route => {
  const ordinary = await adminHeaders('synthetic-ordinary')
  await failure(await roleRequest(route.method, route.path, route.body, ordinary), 'ADMIN_REQUIRED')
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'denial'").get()).toEqual({ outcome: 'ADMIN_REQUIRED' })
  expect(db.prepare("SELECT * FROM audit WHERE event = 'admin-change'").all()).toEqual([])
})

test.each(roleRoutes)('$method roles$path requires recent auth', async route => {
  const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
  await failure(await roleRequest(route.method, route.path, route.body, missing), 'REAUTH_REQUIRED')
})

test('role creation, rename and grant replacement return current metadata and audit each change', async () => {
  const response = await roleRequest('POST', '', { name: 'New Role' })
  expect(response.status).toBe(201)
  const created = adminRoleSchema.parse(await response.json())
  expect(created).toMatchObject({ name: 'New Role', tools: [], revision: 1, updatedBy: administrator, updatedAt: expect.any(Number) })
  const renamed = await roleRequest('PATCH', `/${created.id}`, { name: 'Renamed', expectedRevision: 1 })
  expect(renamed.status).toBe(200)
  expect(adminRoleSchema.parse(await renamed.json())).toMatchObject({ name: 'Renamed', revision: 2 })
  const granted = await roleRequest('PUT', `/${created.id}/tools`, { tools: ['vectra-axi', 'falcon-axi'], expectedRevision: 2 })
  expect(granted.status).toBe(200)
  expect(adminRoleSchema.parse(await granted.json())).toMatchObject({ tools: ['falcon-axi', 'vectra-axi'], revision: 3, updatedBy: administrator })
  expect(db.prepare("SELECT action, target_id, user_id, arguments FROM audit WHERE event = 'admin-change' ORDER BY id").all()).toEqual([
    { action: 'create-role', target_id: created.id, user_id: administrator, arguments: null },
    { action: 'rename-role', target_id: created.id, user_id: administrator, arguments: null },
    { action: 'replace-role-tools', target_id: created.id, user_id: administrator, arguments: null },
  ])
})

test('role listing uses bounded stable pagination', async () => {
  db.exec("INSERT INTO roles (id, name) VALUES ('a', 'First')")
  const first = adminRolesResponseSchema.parse(await (await roleRequest('GET', '?limit=1')).json())
  expect(first.roles.map(role => role.id)).toEqual(['a'])
  expect(first.nextCursor).toBe('a')
  const second = adminRolesResponseSchema.parse(await (await roleRequest('GET', '?limit=1&cursor=a')).json())
  expect(second.roles[0]).toMatchObject({ id: 'synthetic-role', tools: ['az-axi', 'falcon-axi', 'mg-axi', 'vectra-axi'] })
  expect(second.nextCursor).toBeNull()
  await failure(await roleRequest('GET', '?limit=101'), 'INVALID_INPUT')
})

test.each(roleRoutes.filter(route => !['GET', 'DELETE'].includes(route.method)))('$method roles$path audit failure rolls back role and grants', async route => {
  const before = db.prepare('SELECT * FROM roles ORDER BY id').all()
  const grants = db.prepare('SELECT * FROM role_tools ORDER BY role_id, tool').all()
  db.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON audit WHEN NEW.event = 'admin-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await roleRequest(route.method, route.path, route.body), 'AUDIT_UNAVAILABLE')
  expect(db.prepare('SELECT * FROM roles ORDER BY id').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM role_tools ORDER BY role_id, tool').all()).toEqual(grants)
})

test.each([
  { method: 'POST', path: '', body: { name: 'Synthetic Role' }, code: 'INVALID_INPUT' },
  { method: 'PATCH', path: '/missing', body: { name: 'New', expectedRevision: 1 }, code: 'NOT_FOUND' },
  { method: 'PUT', path: '/missing/tools', body: { tools: [], expectedRevision: 1 }, code: 'NOT_FOUND' },
  { method: 'PUT', path: '/synthetic-role/tools', body: { tools: ['administrator'], expectedRevision: 1 }, code: 'INVALID_INPUT' },
  { method: 'PUT', path: '/synthetic-role/tools', body: { tools: ['falcon-axi', 'falcon-axi'], expectedRevision: 1 }, code: 'INVALID_INPUT' },
  { method: 'POST', path: '', body: { name: '' }, code: 'INVALID_INPUT' },
] as const)('role invalid input $path returns $code without changes', async route => {
  const before = db.prepare('SELECT * FROM roles').all()
  const grants = db.prepare('SELECT * FROM role_tools').all()
  await failure(await roleRequest(route.method, route.path, route.body), route.code)
  expect(db.prepare('SELECT * FROM roles').all()).toEqual(before)
  expect(db.prepare('SELECT * FROM role_tools').all()).toEqual(grants)
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})

test('missing registered tool foreign key rolls back grant replacement', async () => {
  db.exec("DELETE FROM role_tools WHERE tool = 'az-axi'; DELETE FROM tools WHERE name = 'az-axi'")
  const before = db.prepare('SELECT * FROM role_tools').all()
  await failure(await roleRequest('PUT', '/synthetic-role/tools', { tools: ['az-axi'], expectedRevision: 1 }), 'INVALID_INPUT')
  expect(db.prepare('SELECT * FROM role_tools').all()).toEqual(before)
  expect(db.prepare('SELECT revision FROM roles').get()).toEqual({ revision: 1 })
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
})

test('assignment replaces roles and shares the account revision with other edits', async () => {
  const response = await request('PUT', '/synthetic-ordinary/roles', { roleIds: [], expectedRevision: 1 })
  expect(response.status).toBe(200)
  expect(adminUserSchema.parse(await response.json())).toMatchObject({ roleIds: [], revision: 2, updatedBy: administrator })
  await failure(await request('PATCH', '/synthetic-ordinary', { enabled: false, expectedRevision: 1 }), 'REVISION_CONFLICT')
  await failure(await request('PUT', '/synthetic-ordinary/roles', { roleIds: ['synthetic-role'], expectedRevision: 1 }), 'REVISION_CONFLICT')
  await failure(await request('PUT', '/synthetic-ordinary/roles', { roleIds: ['missing'], expectedRevision: 2 }), 'INVALID_INPUT')
  await failure(await request('PUT', '/missing/roles', { roleIds: [], expectedRevision: 1 }), 'NOT_FOUND')
  await failure(await request('PUT', '/synthetic-ordinary/roles', { roleIds: ['synthetic-role', 'synthetic-role'], expectedRevision: 2 }), 'INVALID_INPUT')
  expect(db.prepare("SELECT role_id FROM user_roles WHERE user_id = 'synthetic-ordinary'").all()).toEqual([])
  expect(db.prepare("SELECT action FROM audit WHERE event = 'admin-change'").all()).toEqual([{ action: 'assign-user-roles' }])
})

test('role rename and grant edits share a revision and reject concurrent stale changes', async () => {
  const results = await Promise.all([
    roleRequest('PATCH', '/synthetic-role', { name: 'Changed', expectedRevision: 1 }),
    roleRequest('PUT', '/synthetic-role/tools', { tools: [], expectedRevision: 1 }),
  ])
  expect(results.map(result => result.status).sort()).toEqual([200, 409])
  await failure(results.find(result => result.status === 409)!, 'REVISION_CONFLICT')
  await failure(await roleRequest('PATCH', '/synthetic-role', { name: 'Stale', expectedRevision: 1 }), 'REVISION_CONFLICT')
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'admin-change'").get()).toEqual({ count: 1 })
})

test('user filters combine literal search, source, status and role with matching counts across pages', async () => {
  db.exec("UPDATE users SET display_name = 'Shared % analyst' WHERE id IN ('synthetic-ordinary', 'synthetic-development-user')")
  const filters = '?q=%25&source=local&status=enabled&role=synthetic-role&limit=1'
  const first = adminUsersResponseSchema.parse(await (await request('GET', filters)).json())
  expect(first).toMatchObject({ totalCount: 2, nextCursor: administrator })
  expect(first.users.map(user => user.id)).toEqual([administrator])
  const next = adminUsersResponseSchema.parse(await (await request('GET', filters + '&cursor=' + first.nextCursor)).json())
  expect(next).toMatchObject({ totalCount: 2, nextCursor: null })
  expect(next.users.map(user => user.id)).toEqual(['synthetic-ordinary'])
  db.exec("UPDATE users SET disabled = 1 WHERE id = 'synthetic-ordinary'")
  const disabled = adminUsersResponseSchema.parse(await (await request('GET', '?q=SHARED&status=disabled&role=synthetic-role')).json())
  expect(disabled.users.map(user => user.id)).toEqual(['synthetic-ordinary'])
  expect(disabled.totalCount).toBe(1)
  expect(adminUsersResponseSchema.parse(await (await request('GET', '?role=missing')).json()).totalCount).toBe(0)
})

test.each(['ÉMILIE', 'émilie'])('user search folds Unicode consistently for both fields and paginated counts: %s', async q => {
  db.exec(`UPDATE users SET username = 'émilie', display_name = 'Analyst' WHERE id = 'synthetic-ordinary';
    UPDATE users SET display_name = 'Émilie' WHERE id = 'synthetic-development-user'`)
  const filters = '?q=' + encodeURIComponent(q) + '&source=local&status=enabled&role=synthetic-role&limit=1'
  const first = adminUsersResponseSchema.parse(await (await request('GET', filters)).json())
  expect(first).toMatchObject({ totalCount: 2, nextCursor: administrator })
  expect(first.users.map(user => user.id)).toEqual([administrator])
  const next = adminUsersResponseSchema.parse(await (await request('GET', filters + '&cursor=' + first.nextCursor)).json())
  expect(next).toMatchObject({ totalCount: 2, nextCursor: null })
  expect(next.users.map(user => user.id)).toEqual(['synthetic-ordinary'])
})

test('user detail combines overlapping role grants and reports disabled access without granting admin tools', async () => {
  db.exec(`INSERT INTO roles (id, name) VALUES ('extra', 'Extra');
    INSERT INTO role_tools VALUES ('extra', 'falcon-axi');
    INSERT INTO user_roles VALUES ('synthetic-ordinary', 'extra');
    UPDATE tools SET enabled = CASE WHEN name = 'falcon-axi' THEN 1 ELSE 0 END;`)
  const detail = adminUserRoutes.get.response.parse(await (await request('GET', '/synthetic-ordinary')).json())
  expect(detail.effectiveTools).toEqual([
    { name: 'az-axi', enabled: false, roleIds: ['synthetic-role'] },
    { name: 'falcon-axi', enabled: true, roleIds: ['extra', 'synthetic-role'] },
    { name: 'mg-axi', enabled: false, roleIds: ['synthetic-role'] },
    { name: 'vectra-axi', enabled: false, roleIds: ['synthetic-role'] },
  ])
  db.exec("UPDATE users SET disabled = 1 WHERE id = 'synthetic-ordinary'; DELETE FROM user_roles WHERE user_id = 'synthetic-second'")
  const disabled = adminUserRoutes.get.response.parse(await (await request('GET', '/synthetic-ordinary')).json())
  expect(disabled.effectiveTools.every(tool => !tool.enabled)).toBe(true)
  expect(adminUserRoutes.get.response.parse(await (await request('GET', '/synthetic-second')).json()).effectiveTools).toEqual([])
  await failure(await request('GET', '/missing'), 'NOT_FOUND')
})

test('role members include disabled users and page independently of the role list', async () => {
  db.exec("UPDATE users SET disabled = 1 WHERE id = 'synthetic-ordinary'")
  const first = adminRoleRoutes.members.response.parse(await (await roleRequest('GET', '/synthetic-role/members?limit=1')).json())
  expect(first).toMatchObject({ totalCount: 2, nextCursor: administrator })
  expect(first.users.map(user => user.id)).toEqual([administrator])
  const last = adminRoleRoutes.members.response.parse(await (await roleRequest('GET', '/synthetic-role/members?limit=1&cursor=' + first.nextCursor)).json())
  expect(last).toMatchObject({ totalCount: 2, nextCursor: null })
  expect(last.users[0]).toMatchObject({ id: 'synthetic-ordinary', enabled: false })
  await failure(await roleRequest('GET', '/missing/members'), 'NOT_FOUND')
})

test('role deletion refuses members and stale revisions then removes an empty role and its grants with audit', async () => {
  await failure(await roleRequest('DELETE', '/synthetic-role', { expectedRevision: 1 }), 'INVALID_INPUT')
  db.exec("DELETE FROM user_roles WHERE role_id = 'synthetic-role'")
  await failure(await roleRequest('DELETE', '/synthetic-role', { expectedRevision: 2 }), 'REVISION_CONFLICT')
  const deleted = await roleRequest('DELETE', '/synthetic-role', { expectedRevision: 1 })
  expect(deleted.status).toBe(200)
  expect(adminRoleRoutes.delete.response.parse(await deleted.json())).toEqual({ id: 'synthetic-role', deleted: true })
  expect(db.prepare("SELECT * FROM role_tools WHERE role_id = 'synthetic-role'").all()).toEqual([])
  await failure(await roleRequest('GET', '/synthetic-role'), 'NOT_FOUND')
  expect(db.prepare("SELECT action, target_id FROM audit WHERE event = 'admin-change'").all())
    .toEqual([{ action: 'delete-role', target_id: 'synthetic-role' }])
})

test('role deletion rolls back the role and grants when audit cannot be saved', async () => {
  db.exec("DELETE FROM user_roles WHERE role_id = 'synthetic-role'")
  const role = db.prepare("SELECT * FROM roles WHERE id = 'synthetic-role'").get()
  const grants = db.prepare("SELECT * FROM role_tools WHERE role_id = 'synthetic-role' ORDER BY tool").all()
  db.exec("CREATE TRIGGER fail_admin BEFORE INSERT ON audit WHEN NEW.event = 'admin-change' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await roleRequest('DELETE', '/synthetic-role', { expectedRevision: 1 }), 'AUDIT_UNAVAILABLE')
  expect(db.prepare("SELECT * FROM roles WHERE id = 'synthetic-role'").get()).toEqual(role)
  expect(db.prepare("SELECT * FROM role_tools WHERE role_id = 'synthetic-role' ORDER BY tool").all()).toEqual(grants)
})

test('session listing exposes active browser and CLI families and revocation is scoped to the requested user', async () => {
  const session = await signIn('synthetic-ordinary')
  browserSession(session.accessToken, 'synthetic-browser')
  const listing = await request('GET', '/synthetic-ordinary/sessions')
  const { sessions } = adminUserRoutes.sessions.response.parse(await listing.json())
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ kind: 'browser', current: false, lastSeenAt: expect.any(Number) })
  expect(JSON.stringify(sessions)).not.toContain(session.accessToken)
  const other = await signIn('synthetic-second')
  const family = db.prepare('SELECT family_id FROM tokens WHERE hash = ?').get(hashToken(other.accessToken)) as { family_id: string }
  await failure(await request('POST', '/synthetic-ordinary/sessions/' + family.family_id + '/revoke', {}), 'NOT_FOUND')
  expect(verifyAccessToken(db, other.accessToken)).toBe('synthetic-second')
  expect((await request('POST', '/synthetic-ordinary/sessions/' + sessions[0]!.id + '/revoke', {})).status).toBe(200)
  expect(() => verifyAccessToken(db, session.accessToken)).toThrowError('token is invalid')
  const refresh = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: session.refreshToken } })
  expect(refresh.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } })
  expect(adminUserRoutes.sessions.response.parse(await (await request('GET', '/synthetic-ordinary/sessions')).json()).sessions).toEqual([])
  expect(db.prepare("SELECT action, target_id FROM audit WHERE action = 'revoke-user-session'").get())
    .toEqual({ action: 'revoke-user-session', target_id: sessions[0]!.id })
})

test('archive persists, retains membership and history, hides list results and prevents enabling the user', async () => {
  const session = await signIn('synthetic-ordinary')
  await failure(await request('POST', '/synthetic-ordinary/archive', { expectedRevision: 2 }), 'REVISION_CONFLICT')
  const archived = adminUserSchema.parse(await (await request('POST', '/synthetic-ordinary/archive', { expectedRevision: 1 })).json())
  expect(archived).toMatchObject({ enabled: false, archivedAt: expect.any(Number), revision: 2, roleIds: ['synthetic-role'] })
  expect(() => verifyAccessToken(db, session.accessToken)).toThrow()
  await failure(await request('PATCH', '/synthetic-ordinary', { enabled: true, expectedRevision: 2 }), 'INVALID_INPUT')
  expect(adminUsersResponseSchema.parse(await (await request('GET', '?q=synthetic-ordinary&status=disabled')).json()))
    .toMatchObject({ users: [], totalCount: 0 })
  await app.close()
  db.close()
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  const started = await start(db)
  app = started.server
  url = started.address
  expect(adminUserRoutes.get.response.parse(await (await request('GET', '/synthetic-ordinary')).json()).archivedAt).toBe(archived.archivedAt)
  expect(db.prepare("SELECT action, target_id FROM audit WHERE action = 'archive-user'").get())
    .toEqual({ action: 'archive-user', target_id: 'synthetic-ordinary' })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-ordinary', password } })
  expect(login.json()).toMatchObject({ error: { code: 'SIGN_IN_FAILED' } })
})

test('archive refuses the last enabled administrator without changing its revision or sessions', async () => {
  db.exec("UPDATE users SET administrator = 0 WHERE id = 'synthetic-second'")
  await failure(await request('POST', '/' + administrator + '/archive', { expectedRevision: 1 }), 'LAST_ADMINISTRATOR')
  expect(adminUserRoutes.get.response.parse(await (await request('GET', '/' + administrator)).json())).toMatchObject({ enabled: true, archivedAt: null, revision: 1 })
})

test('session list excludes idle browsers and expired or revoked CLI families', async () => {
  const browser = await signIn('synthetic-ordinary')
  browserSession(browser.accessToken, 'synthetic-idle-browser')
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now() - 1_800_000, 'synthetic-idle-browser')
  const expired = await signIn('synthetic-ordinary')
  db.prepare('UPDATE session_families SET expires_at = ? WHERE id = (SELECT family_id FROM tokens WHERE hash = ?)')
    .run(Date.now(), hashToken(expired.accessToken))
  const revoked = await signIn('synthetic-ordinary')
  db.prepare('UPDATE session_families SET revoked_at = ? WHERE id = (SELECT family_id FROM tokens WHERE hash = ?)')
    .run(Date.now(), hashToken(revoked.accessToken))
  const active = await signIn('synthetic-ordinary')
  const family = db.prepare('SELECT family_id FROM tokens WHERE hash = ?').get(hashToken(active.accessToken)) as { family_id: string }
  const listed = adminUserRoutes.sessions.response.parse(await (await request('GET', '/synthetic-ordinary/sessions')).json())
  expect(listed.sessions).toEqual([{ id: family.family_id, kind: 'cli', createdAt: expect.any(Number),
    lastSeenAt: null, expiresAt: active.familyExpiresAt, current: false }])
})

test('session listing reports the temporary-password token expiry', async () => {
  db.exec("UPDATE users SET must_change = 1 WHERE id = 'synthetic-ordinary'")
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-ordinary', password } })
  const session = loginResponseSchema.parse(login.json())
  if (session.status !== 'password-change-required') throw new Error('Expected restricted local login')
  const listed = adminUserRoutes.sessions.response.parse(await (await request('GET', '/synthetic-ordinary/sessions')).json())
  expect(listed.sessions).toEqual([expect.objectContaining({ kind: 'cli', expiresAt: session.passwordChangeExpiresAt })])
})

test.each(['revoked_at', 'consumed_at'] as const)('session listing ignores refresh tokens marked %s', async field => {
  const session = await signIn('synthetic-ordinary')
  const family = db.prepare('SELECT family_id FROM tokens WHERE hash = ?').get(hashToken(session.accessToken)) as { family_id: string }
  db.prepare(`UPDATE tokens SET ${field} = ? WHERE hash = ?`).run(Date.now(), hashToken(session.refreshToken))
  const listed = adminUserRoutes.sessions.response.parse(await (await request('GET', '/synthetic-ordinary/sessions')).json())
  expect(listed.sessions).toEqual([expect.objectContaining({ id: family.family_id, kind: 'cli',
    expiresAt: session.accessExpiresAt })])
})

test('session listing caps CLI token expiry at family expiry', async () => {
  const session = await signIn('synthetic-ordinary')
  db.prepare('UPDATE tokens SET expires_at = ? WHERE hash = ?').run(session.familyExpiresAt + 60_000, hashToken(session.refreshToken))
  const listed = adminUserRoutes.sessions.response.parse(await (await request('GET', '/synthetic-ordinary/sessions')).json())
  expect(listed.sessions).toEqual([expect.objectContaining({ kind: 'cli', expiresAt: session.familyExpiresAt })])
})

test('single-session revocation rolls back when its audit cannot be persisted', async () => {
  const session = await signIn('synthetic-ordinary')
  const { sessions } = adminUserRoutes.sessions.response.parse(await (await request('GET', '/synthetic-ordinary/sessions')).json())
  db.exec("CREATE TRIGGER fail_revoke BEFORE INSERT ON audit WHEN NEW.action = 'revoke-user-session' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await failure(await request('POST', '/synthetic-ordinary/sessions/' + sessions[0]!.id + '/revoke', {}), 'AUDIT_UNAVAILABLE')
  expect(verifyAccessToken(db, session.accessToken)).toBe('synthetic-ordinary')
})
