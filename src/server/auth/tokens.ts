import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { LoginResponse } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { tokenDefaults } from '../config.js'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function verifyAccessToken(db: Database.Database, token: string, now = Date.now()): string {
  return verifyToken(db, token, ['access'], now).user_id
}

export function verifyPasswordToken(db: Database.Database, token: string, now = Date.now()) {
  return verifyToken(db, token, ['access', 'password-change'], now)
}

function verifyToken(db: Database.Database, token: string, types: readonly string[], now: number) {
  const row = db.prepare(`
    SELECT tokens.user_id, tokens.type, tokens.expires_at, users.disabled, session_families.expires_at AS family_expires_at FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id
    JOIN users ON users.id = tokens.user_id
    WHERE tokens.hash = ?
      AND tokens.revoked_at IS NULL AND tokens.consumed_at IS NULL
      AND session_families.revoked_at IS NULL
  `).get(hashToken(token)) as { user_id: string, type: string, expires_at: number, family_expires_at: number, disabled: number } | undefined
  if (!row || !types.includes(row.type)) throw new ArtiumError('TOKEN_INVALID')
  if (row.expires_at <= now || row.family_expires_at <= now) throw new ArtiumError('TOKEN_EXPIRED')
  if (row.disabled) throw new ArtiumError('USER_DISABLED')
  return row
}

export function issueLoginTokens(db: Database.Database, userId: string, now = Date.now()): LoginResponse {
  return db.transaction((): LoginResponse => {
    const user = db.prepare('SELECT disabled, must_change FROM users WHERE id = ?').get(userId) as
      { disabled: number, must_change: number } | undefined
    if (!user || user.disabled) throw new ArtiumError('SIGN_IN_FAILED')
    const familyId = randomUUID()
    const familyExpiresAt = now + tokenDefaults.familyMs
    db.prepare('INSERT INTO session_families (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(familyId, userId, now, familyExpiresAt)
    const issue = (type: string, expiresAt: number) => {
      const token = randomBytes(32).toString('base64url')
      db.prepare('INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(hashToken(token), type, familyId, userId, expiresAt)
      return token
    }
    if (user.must_change) {
      const passwordChangeExpiresAt = now + tokenDefaults.passwordChangeMs
      return { status: 'password-change-required', passwordChangeToken: issue('password-change', passwordChangeExpiresAt), passwordChangeExpiresAt }
    }
    const accessExpiresAt = now + tokenDefaults.accessMs
    return { status: 'authenticated', accessToken: issue('access', accessExpiresAt), refreshToken: issue('refresh', familyExpiresAt),
      accessExpiresAt, familyExpiresAt }
  }).immediate()
}

export function revokeUserSessions(db: Database.Database, userId: string, now: number): void {
  db.prepare('UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
}
