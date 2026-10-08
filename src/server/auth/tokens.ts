import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function verifyAccessToken(db: Database.Database, token: string, now = Date.now()): string {
  const row = db.prepare(`
    SELECT tokens.user_id FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id
    WHERE tokens.hash = ? AND tokens.type = 'access'
      AND tokens.expires_at > ? AND session_families.expires_at > ?
      AND tokens.revoked_at IS NULL AND tokens.consumed_at IS NULL
      AND session_families.revoked_at IS NULL
  `).get(hashToken(token), now, now) as { user_id: string } | undefined
  if (!row) throw new ArtiumError('TOKEN_INVALID')
  return row.user_id
}
