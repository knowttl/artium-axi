import type Database from 'better-sqlite3'
import { userSessionsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserDefaults } from '../config.js'
import { revokeFamily } from './tokens.js'

export function listUserSessions(db: Database.Database, userId: string, currentFamily: string | null = null, now = Date.now()) {
  const rows = db.prepare(`SELECT f.id, f.created_at AS createdAt,
    CASE WHEN s.id IS NULL THEN 'cli' ELSE 'browser' END AS kind,
    CASE WHEN s.id IS NOT NULL AND f.id = ? THEN ? ELSE s.last_seen_at END AS lastSeenAt,
    CASE WHEN s.id IS NULL THEN min(f.expires_at, t.expires_at)
      ELSE min(f.expires_at, s.expires_at, (CASE WHEN f.id = ? THEN ? ELSE s.last_seen_at END) + ?) END AS expiresAt
    FROM session_families f LEFT JOIN sessions s ON s.family_id = f.id
    LEFT JOIN (SELECT family_id, max(expires_at) AS expires_at FROM tokens
      WHERE revoked_at IS NULL AND consumed_at IS NULL GROUP BY family_id) t ON t.family_id = f.id
    WHERE f.user_id = ? AND f.revoked_at IS NULL AND f.expires_at > ?
      AND ((s.id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at + ? > ?)
        OR (s.id IS NULL AND t.expires_at > ?))
    ORDER BY f.created_at DESC, f.id`).all(currentFamily, now, currentFamily, now, browserDefaults.idleMs, userId, now, now, browserDefaults.idleMs, now, now) as
      { id: string, kind: string, createdAt: number, lastSeenAt: number | null, expiresAt: number }[]
  return userSessionsSchema.parse({ sessions: rows.map(row => ({ ...row, current: row.id === currentFamily })) })
}

export function revokeUserSession(db: Database.Database, userId: string, familyId: string, now: number): void {
  if (!db.prepare('SELECT 1 FROM session_families WHERE id = ? AND user_id = ?').get(familyId, userId)) {
    throw new ArtiumError('NOT_FOUND')
  }
  revokeFamily(db, familyId, now)
}
