import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate } from '../store/db.js'
import { exchangeDelegation, hashToken, issueLoginTokens, issueRecentAuthTicket, logout, refreshTokens, requireRecentAuth, revokeUserSessions, verifyAccessFamily, verifyAccessToken, verifyPasswordToken, verifyPrincipal } from './tokens.js'
import { Audit } from '../audit/audit.js'
import { issueTestAccessToken } from '../../../test/fixtures/tokens.js'
import { createBrowserSession, readBrowserSession } from './sessions.js'

let db: Database.Database
const now = 1_800_000_000_000

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash')").run()
})
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

test('SSO inactivity pauses exchange, verification and refresh without consuming credentials, and sign-in resumes them', () => {
  const day = 86400000
  db.prepare("UPDATE users SET source = 'sso', password_hash = NULL, must_change = 0, last_sso_sign_in_at = ?").run(now - 7 * day + 1)
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', ?, 'Synthetic', '{}', 1, 0, ?, ?)`).run(hashToken('synthetic-delegation'), now, now + day)
  const session = exchangeDelegation(db, 'synthetic-delegation', now)
  expect(verifyPrincipal(db, session.accessToken, now).delegation?.id).toBe('delegation')
  const audit = new Audit(db)
  const context = { requestId: 'synthetic-refresh', clientAddress: '192.0.2.1' }
  for (const action of [() => exchangeDelegation(db, 'synthetic-delegation', now + 1),
    () => verifyPrincipal(db, session.accessToken, now + 1), () => refreshTokens(db, session.refreshToken, audit, context, now + 1)]) {
    expect(action).toThrow('paused until its creator signs in again via SSO')
  }
  db.prepare('UPDATE users SET last_sso_sign_in_at = ?').run(now + 1)
  expect(exchangeDelegation(db, 'synthetic-delegation', now + 1).status).toBe('authenticated')
  expect(verifyPrincipal(db, session.accessToken, now + 1).delegation?.id).toBe('delegation')
  expect(refreshTokens(db, session.refreshToken, audit, context, now + 1).status).toBe('authenticated')
})

test('the configured SSO window applies to SSO creators but not local creators', () => {
  const day = 86400000
  db.exec('UPDATE users SET must_change = 0; UPDATE delegation_settings SET sso_window_ms = 86400000')
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', ?, 'Synthetic', '{}', 1, 0, ?, ?)`).run(hashToken('synthetic-delegation'), now, now + day)
  expect(exchangeDelegation(db, 'synthetic-delegation', now).status).toBe('authenticated')
  db.prepare("UPDATE users SET source = 'sso', password_hash = NULL, last_sso_sign_in_at = ?").run(now - day)
  expect(() => exchangeDelegation(db, 'synthetic-delegation', now)).toThrow('paused until its creator signs in again via SSO')
  db.exec('UPDATE delegation_settings SET sso_window_ms = 172800000')
  expect(exchangeDelegation(db, 'synthetic-delegation', now).status).toBe('authenticated')
})

test('fixture stores only a SHA-256 hash and verifier returns the owning user', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  expect(verifyAccessToken(db, token, now)).toBe('synthetic-user')
  expect(db.prepare('SELECT hash, expires_at FROM tokens').get()).toEqual({ hash: hashToken(token), expires_at: now + 3_600_000 })
  expect(db.prepare('SELECT created_at, expires_at FROM session_families').get()).toEqual({ created_at: now, expires_at: now + 43_200_000 })
  expect(hashToken(token)).not.toBe(token)
})

test('delegated sessions expose a principal but refuse ordinary verification and recent authentication', () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?)`).run(now, now + 10000)
  db.exec("UPDATE session_families SET delegation_id = 'delegation'")
  expect(verifyPrincipal(db, token, now)).toEqual({ userId: 'synthetic-user', familyId: expect.any(String),
    delegation: { id: 'delegation', scopeJson: '{}', readOnly: true, expiresAt: now + 10000 } })
  for (const verify of [() => verifyAccessToken(db, token, now), () => verifyAccessFamily(db, token),
    () => verifyPasswordToken(db, token, now), () => issueRecentAuthTicket(db, token, now),
    () => requireRecentAuth(db, token, 'synthetic-ticket', now)]) {
    expect(verify).toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
  }
})

test.each([
  ['revoked', 'UPDATE delegations SET revoked_at = 1', 'TOKEN_INVALID'],
  ['expired', `UPDATE delegations SET expires_at = ${now}`, 'TOKEN_EXPIRED'],
  ['disabled creator', 'UPDATE users SET disabled = 1', 'USER_DISABLED'],
] as const)('principal rejects a %s delegation', (_label, sql, code) => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?)`).run(now, now + 10000)
  db.exec("UPDATE session_families SET delegation_id = 'delegation'")
  db.exec(sql)
  expect(() => verifyPrincipal(db, token, now)).toThrow(expect.objectContaining({ code }))
})

test('browser sessions cannot use a delegated family', () => {
  const session = createBrowserSession(db, 'synthetic-user', 'synthetic-csrf', now)
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?)`).run(now, now + 10000)
  db.exec("UPDATE session_families SET delegation_id = 'delegation'")
  expect(() => readBrowserSession(db, session.id, now)).toThrow(expect.objectContaining({ code: 'DELEGATED_SCOPE_DENIED' }))
})

test.each([
  ['revoked', 'UPDATE delegations SET revoked_at = 1', 'TOKEN_INVALID'],
  ['expired', `UPDATE delegations SET expires_at = ${now}`, 'TOKEN_EXPIRED'],
] as const)('a %s delegation records a rejected refresh', (_label, sql, code) => {
  db.exec('UPDATE users SET must_change = 0')
  const session = issueLoginTokens(db, 'synthetic-user', now)
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at, revoked_at)
    VALUES ('delegation', 'synthetic-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?, NULL)`).run(now, now + 10000)
  db.exec("UPDATE session_families SET delegation_id = 'delegation'")
  db.exec(sql)
  expect(() => refreshTokens(db, session.refreshToken, new Audit(db), { requestId: 'synthetic-refresh', clientAddress: '192.0.2.1' }, now))
    .toThrow(expect.objectContaining({ code }))
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'delegation-access'").all()).toEqual([{ outcome: code }])
})

test('delegated refresh records success only for the first use', () => {
  db.exec('UPDATE users SET must_change = 0')
  const session = issueLoginTokens(db, 'synthetic-user', now)
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?)`).run(now, now + 10000)
  db.exec("UPDATE session_families SET delegation_id = 'delegation'")
  const audit = new Audit(db)
  const context = { requestId: 'synthetic-refresh', clientAddress: '192.0.2.1' }
  const rotated = refreshTokens(db, session.refreshToken, audit, context, now)
  expect(verifyPrincipal(db, rotated.accessToken, now).delegation?.id).toBe('delegation')
  expect(() => refreshTokens(db, session.refreshToken, audit, context, now)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'delegation-access' ORDER BY id").all())
    .toEqual([{ outcome: 'success' }, { outcome: 'TOKEN_INVALID' }])
})

test('delegated refresh audit failure rolls back rotation and permits retry (R7)', () => {
  db.exec('UPDATE users SET must_change = 0')
  const session = issueLoginTokens(db, 'synthetic-user', now)
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  db.prepare(`INSERT INTO delegations (id, creator_id, token_hash, label, scope_json, read_only, single_use, created_at, expires_at)
    VALUES ('delegation', 'synthetic-user', 'synthetic-hash', 'Synthetic', '{}', 1, 1, ?, ?)`).run(now, now + 10000)
  db.exec(`UPDATE session_families SET delegation_id = 'delegation';
    CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit
      WHEN NEW.event = 'delegation-access' AND NEW.outcome = 'success'
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
  const lines: string[] = []
  const audit = new Audit(db, () => now, line => lines.push(line))
  const context = { requestId: 'synthetic-refresh', clientAddress: '192.0.2.1' }
  expect(() => refreshTokens(db, session.refreshToken, audit, context, now))
    .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }))
  expect(db.prepare('SELECT consumed_at, revoked_at FROM tokens WHERE hash = ?').get(hashToken(session.refreshToken)))
    .toEqual({ consumed_at: null, revoked_at: null })
  expect(db.prepare('SELECT count(*) AS count FROM tokens').get()).toEqual({ count: 2 })
  expect(db.prepare('SELECT revoked_at FROM session_families').get()).toEqual({ revoked_at: null })
  expect(lines.map(line => JSON.parse(line).outcome)).toEqual(['AUDIT_UNAVAILABLE'])
  db.exec('DROP TRIGGER synthetic_audit_failure')
  const rotated = refreshTokens(db, session.refreshToken, audit, context, now)
  expect(verifyPrincipal(db, rotated.accessToken, now).delegation?.id).toBe('delegation')
  expect(lines.map(line => JSON.parse(line).outcome)).toEqual(['AUDIT_UNAVAILABLE', 'success'])
})

test('recent-auth confirmation replaces the previous ticket and survives refresh within its family', () => {
  db.exec('UPDATE users SET must_change = 0')
  const session = issueLoginTokens(db, 'synthetic-user', now)
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  const first = issueRecentAuthTicket(db, session.accessToken, now)
  const second = issueRecentAuthTicket(db, session.accessToken, now + 1)
  expect(() => requireRecentAuth(db, session.accessToken, first.ticket, now + 1)).toThrow(expect.objectContaining({ code: 'REAUTH_REQUIRED' }))
  const rotated = refreshTokens(db, session.refreshToken, new Audit(db), { requestId: 'synthetic-refresh', clientAddress: '192.0.2.1' }, now + 1)
  expect(requireRecentAuth(db, rotated.accessToken, second.ticket, now + 1)).toBe('synthetic-user')
  expect(db.prepare('SELECT COUNT(*) AS count FROM recent_auth_tickets').get()).toEqual({ count: 1 })
})

test.each(['logout', 'password-change', 'disable', 'reuse'] as const)('recent-auth ticket cannot outlive %s revocation', action => {
  db.exec('UPDATE users SET must_change = 0')
  const session = issueLoginTokens(db, 'synthetic-user', now)
  if (session.status !== 'authenticated') throw new Error('Expected ordinary session')
  const proof = issueRecentAuthTicket(db, session.accessToken, now)
  const audit = new Audit(db)
  const context = { requestId: 'synthetic-revoke', clientAddress: '192.0.2.1' }
  if (action === 'logout') logout(db, session.accessToken, audit, context, now)
  if (action === 'password-change') revokeUserSessions(db, 'synthetic-user', now)
  if (action === 'disable') db.exec('UPDATE users SET disabled = 1')
  if (action === 'reuse') {
    refreshTokens(db, session.refreshToken, audit, context, now)
    expect(() => refreshTokens(db, session.refreshToken, audit, context, now)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
  }
  expect(() => requireRecentAuth(db, session.accessToken, proof.ticket, now)).toThrow(expect.objectContaining({ code: action === 'disable' ? 'USER_DISABLED' : 'TOKEN_INVALID' }))
})

test('recent-auth ticket expiry is capped by its session family deadline', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  db.prepare('UPDATE session_families SET expires_at = ?').run(now + 100)
  expect(issueRecentAuthTicket(db, token, now).expiresAt).toBe(now + 100)
})

test('security: access expiry rejects at its exact deadline', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  expect(verifyAccessToken(db, token, now + 3_599_999)).toBe('synthetic-user')
  expect(() => verifyAccessToken(db, token, now + 3_600_000)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }))
})

test('security: family deadline rejects an otherwise unexpired access token', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  db.prepare('UPDATE session_families SET expires_at = ?').run(now)
  expect(() => verifyAccessToken(db, token, now)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }))
})

test('security: disabling an owner immediately denies token verification', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  db.exec('UPDATE users SET disabled = 1')
  expect(() => verifyAccessToken(db, token, now)).toThrow(expect.objectContaining({ code: 'USER_DISABLED' }))
})

test.each([
  "UPDATE tokens SET revoked_at = 1",
  "UPDATE tokens SET consumed_at = 1",
  "UPDATE tokens SET type = 'refresh'",
  "UPDATE tokens SET type = 'password-change'",
  "UPDATE session_families SET revoked_at = 1",
])('security: verifier refuses invalid token state: %s', sql => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  db.exec(sql)
  expect(() => verifyAccessToken(db, token, now)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
})

test.each(['', 'CANARY-unknown-token'])('verifier refuses unknown token %j', token => {
  expect(() => verifyAccessToken(db, token, now)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
})

test.each(['production', 'development', ''])('fixture issuer refuses NODE_ENV=%j without storing tokens', environment => {
  vi.stubEnv('NODE_ENV', environment)
  expect(() => issueTestAccessToken(db, 'synthetic-user', now)).toThrow('Token fixture issuance requires NODE_ENV=test')
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens').get()).toEqual({ count: 0 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM session_families').get()).toEqual({ count: 0 })
})
