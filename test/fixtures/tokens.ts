import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { hashToken } from '../../src/server/auth/tokens.js'

// Fixture issuance is excluded from server source and refuses non-test execution.
export function issueTestAccessToken(db: Database.Database, userId: string, now = Date.now()): string {
  if (process.env.NODE_ENV !== 'test') throw new Error('Token fixture issuance requires NODE_ENV=test')
  const token = randomBytes(32).toString('base64url')
  const familyId = randomUUID()
  db.transaction(() => {
    db.prepare('INSERT INTO session_families (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(familyId, userId, now, now + 12 * 60 * 60 * 1000)
    db.prepare("INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES (?, 'access', ?, ?, ?)")
      .run(hashToken(token), familyId, userId, now + 60 * 60 * 1000)
  })()
  return token
}
