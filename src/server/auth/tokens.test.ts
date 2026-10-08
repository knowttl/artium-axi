import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate } from '../store/db.js'
import { hashToken, issueLoginTokens, issueRecentAuthTicket, logout, refreshTokens, requireRecentAuth, revokeUserSessions, verifyAccessToken } from './tokens.js'
import { Audit } from '../audit/audit.js'
import { issueTestAccessToken } from '../../../test/fixtures/tokens.js'

let db: Database.Database
const now = 1_800_000_000_000

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash')").run()
})
afterEach(() => { db.close(); vi.unstubAllEnvs() })

test('fixture stores only a SHA-256 hash and verifier returns the owning user', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  expect(verifyAccessToken(db, token, now)).toBe('synthetic-user')
  expect(db.prepare('SELECT hash, expires_at FROM tokens').get()).toEqual({ hash: hashToken(token), expires_at: now + 3_600_000 })
  expect(db.prepare('SELECT created_at, expires_at FROM session_families').get()).toEqual({ created_at: now, expires_at: now + 43_200_000 })
  expect(hashToken(token)).not.toBe(token)
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
