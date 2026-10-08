import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { migrate } from '../store/db.js'
import { hashToken, verifyAccessToken } from './tokens.js'
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

test('access expiry rejects at its exact deadline', () => {
  const token = issueTestAccessToken(db, 'synthetic-user', now)
  expect(verifyAccessToken(db, token, now + 3_599_999)).toBe('synthetic-user')
  expect(() => verifyAccessToken(db, token, now + 3_600_000)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
})

test.each([
  "UPDATE tokens SET revoked_at = 1",
  "UPDATE tokens SET consumed_at = 1",
  "UPDATE tokens SET type = 'refresh'",
  "UPDATE tokens SET type = 'password-change'",
  "UPDATE session_families SET revoked_at = 1",
  `UPDATE session_families SET expires_at = ${now}`,
])('verifier refuses invalid token state: %s', sql => {
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
