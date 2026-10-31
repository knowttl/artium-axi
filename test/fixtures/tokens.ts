import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { hashToken } from '../../src/server/auth/tokens.js'
import argon2 from 'argon2'

export async function seedToolUser(db: Database.Database): Promise<void> {
  // Seed a real, inexpensive fixture hash without changing production defaults.
  const hash = await argon2.hash('CANARY-local-password', { type: argon2.argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 })
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, must_change)
    VALUES ('synthetic-development-user', 'synthetic-user', 'Synthetic User', ?, 0)`).run(hash)
  db.exec(`INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-development-user', 'synthetic-role');
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
