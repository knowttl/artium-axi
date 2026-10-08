import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { hashToken } from '../../src/server/auth/tokens.js'
import { hashPassword } from '../../src/server/auth/local.js'

export async function seedToolUser(db: Database.Database): Promise<void> {
  const hash = await hashPassword('CANARY-local-password')
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, must_change)
    VALUES ('synthetic-development-user', 'synthetic-user', 'Synthetic User', ?, 0)`).run(hash)
  db.exec(`INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles VALUES ('synthetic-development-user', 'synthetic-role');
    INSERT INTO role_tools SELECT 'synthetic-role', name FROM tools`)
}

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
