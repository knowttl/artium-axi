import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import { authDefaults, browserDefaults, tokenDefaults } from '../config.js'
import { hashToken } from './tokens.js'

export interface BrowserSession {
  id: string
  family_id: string
  user_id: string
  csrf_token: string
  username: string
  display_name: string
  administrator: number
  break_glass: number
  must_change: number
  source: 'local' | 'sso'
  identity_id: string | null
  reauthenticated_at: number | null
  created_at: number
  last_seen_at: number
  expires_at: number
}

export function browserIdentity(db: Database.Database, session: BrowserSession) {
  const identity = db.prepare('SELECT id, provider_id, issuer, subject FROM identities WHERE id = ? AND user_id = ?')
    .get(session.identity_id, session.user_id) as { id: string, provider_id: string, issuer: string, subject: string } | undefined
  if (session.source !== 'sso' || !identity) throw new ArtiumError('SSO_STATE_INVALID')
  return identity
}

export function createBrowserSession(db: Database.Database, userId: string, csrfSecret: string, now = Date.now()) {
  return db.transaction(() => {
    const user = db.prepare('SELECT disabled, must_change, administrator FROM users WHERE id = ?').get(userId) as
      { disabled: number, must_change: number, administrator: number } | undefined
    if (!user || user.disabled) throw new ArtiumError('SIGN_IN_FAILED')
    const id = randomBytes(32).toString('base64url')
    const family = randomUUID()
    const expiry = now + (user.must_change ? tokenDefaults.passwordChangeMs : browserDefaults.absoluteMs)
    db.prepare('INSERT INTO session_families (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(family, userId, now, expiry)
    db.prepare(`INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at, reauthenticated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(hashToken(id), family, userId, csrfSecret, now, now, expiry, now)
    return { id, mustChange: Boolean(user.must_change), administrator: Boolean(user.administrator) }
  }).immediate()
}

export function readBrowserSession(db: Database.Database, id: string, now = Date.now()): BrowserSession {
  const session = db.prepare(`SELECT sessions.*, users.username, users.display_name, users.administrator, users.break_glass, users.must_change, users.source
    FROM sessions JOIN users ON users.id = sessions.user_id JOIN session_families ON session_families.id = sessions.family_id
    WHERE sessions.id = ? AND sessions.revoked_at IS NULL AND session_families.revoked_at IS NULL AND users.disabled = 0
      AND session_families.expires_at > ?`).get(hashToken(id), now) as BrowserSession | undefined
  if (!session) throw new ArtiumError('TOKEN_INVALID')
  if (session.expires_at <= now || session.last_seen_at + browserDefaults.idleMs <= now) throw new ArtiumError('TOKEN_EXPIRED')
  return session
}

export function requireBrowserAdmin(db: Database.Database, id: string, mutation: boolean): string {
  const session = readBrowserSession(db, id)
  if (session.must_change) throw new ArtiumError('PASSWORD_CHANGE_REQUIRED')
  if (!session.administrator) throw new ArtiumError('ADMIN_REQUIRED')
  if (mutation && !recentBrowserAuth(session)) throw new ArtiumError('REAUTH_REQUIRED')
  return session.user_id
}

export function recentBrowserAuth(session: BrowserSession, now = Date.now()): boolean {
  return session.reauthenticated_at !== null && session.reauthenticated_at + authDefaults.recentAuthMs > now
}
