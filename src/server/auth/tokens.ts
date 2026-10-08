import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { LoginResponse } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { authDefaults, tokenDefaults } from '../config.js'
import type { Audit } from '../audit/audit.js'

type TokenPair = Extract<LoginResponse, { status: 'authenticated' }>
type AuditContext = { requestId: string, clientAddress: string }

function issueToken(db: Database.Database, type: string, familyId: string, userId: string, expiresAt: number): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), type, familyId, userId, expiresAt)
  return token
}

function issuePair(db: Database.Database, familyId: string, userId: string, familyExpiresAt: number, now: number): TokenPair {
  const accessExpiresAt = Math.min(now + tokenDefaults.accessMs, familyExpiresAt)
  return { status: 'authenticated', accessToken: issueToken(db, 'access', familyId, userId, accessExpiresAt),
    refreshToken: issueToken(db, 'refresh', familyId, userId, familyExpiresAt), accessExpiresAt, familyExpiresAt }
}

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
    SELECT tokens.user_id, tokens.family_id, tokens.type, tokens.expires_at, users.disabled, session_families.expires_at AS family_expires_at FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id
    JOIN users ON users.id = tokens.user_id
    WHERE tokens.hash = ?
      AND tokens.revoked_at IS NULL AND tokens.consumed_at IS NULL
      AND session_families.revoked_at IS NULL
  `).get(hashToken(token)) as { user_id: string, family_id: string, type: string, expires_at: number, family_expires_at: number, disabled: number } | undefined
  if (!row || !types.includes(row.type)) throw new ArtiumError('TOKEN_INVALID')
  if (row.expires_at <= now || row.family_expires_at <= now) throw new ArtiumError('TOKEN_EXPIRED')
  if (row.disabled) throw new ArtiumError('USER_DISABLED')
  return row
}

export function issueRecentAuthTicket(db: Database.Database, accessToken: string, now = Date.now()) {
  const row = verifyToken(db, accessToken, ['access'], now)
  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = Math.min(now + authDefaults.recentAuthMs, row.family_expires_at)
  db.prepare(`INSERT INTO recent_auth_tickets (family_id, hash, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(family_id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at`)
    .run(row.family_id, hashToken(ticket), expiresAt)
  return { ticket, expiresAt }
}

export function requireRecentAuth(db: Database.Database, accessToken: string, ticket: string, now = Date.now()): string {
  const row = verifyToken(db, accessToken, ['access'], now)
  const proof = db.prepare('SELECT expires_at FROM recent_auth_tickets WHERE family_id = ? AND hash = ?')
    .get(row.family_id, hashToken(ticket)) as { expires_at: number } | undefined
  if (!proof || proof.expires_at <= now) throw new ArtiumError('REAUTH_REQUIRED')
  return row.user_id
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
    if (user.must_change) {
      const passwordChangeExpiresAt = now + tokenDefaults.passwordChangeMs
      return { status: 'password-change-required', passwordChangeToken: issueToken(db, 'password-change', familyId, userId, passwordChangeExpiresAt), passwordChangeExpiresAt }
    }
    return issuePair(db, familyId, userId, familyExpiresAt, now)
  }).immediate()
}

function findSessionToken(db: Database.Database, token: string, types: readonly string[]) {
  const row = db.prepare(`SELECT tokens.type, tokens.family_id, tokens.user_id, tokens.expires_at,
    tokens.consumed_at, tokens.revoked_at, session_families.expires_at AS family_expires_at,
    session_families.revoked_at AS family_revoked_at, users.disabled FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id JOIN users ON users.id = tokens.user_id
    WHERE tokens.hash = ?`).get(hashToken(token)) as {
      type: string, family_id: string, user_id: string, expires_at: number, consumed_at: number | null,
      revoked_at: number | null, family_expires_at: number, family_revoked_at: number | null, disabled: number,
    } | undefined
  if (!row || !types.includes(row.type) || row.revoked_at !== null || row.family_revoked_at !== null) {
    throw new ArtiumError('TOKEN_INVALID')
  }
  return row
}

function revokeFamily(db: Database.Database, familyId: string, now: number): void {
  db.prepare('UPDATE session_families SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, familyId)
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now, familyId)
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now, familyId)
}

export function refreshTokens(db: Database.Database, token: string, audit: Audit, context: AuditContext, now = Date.now()): TokenPair {
  const result = db.transaction(() => {
    const row = findSessionToken(db, token, ['refresh'])
    if (row.expires_at <= now || row.family_expires_at <= now) throw new ArtiumError('TOKEN_EXPIRED')
    if (row.consumed_at !== null) return { reused: row }
    if (row.disabled) throw new ArtiumError('USER_DISABLED')
    db.prepare('UPDATE tokens SET consumed_at = ? WHERE hash = ?').run(now, hashToken(token))
    return { pair: issuePair(db, row.family_id, row.user_id, row.family_expires_at, now) }
  }).immediate()
  if (result.reused) {
    // Commit revocation with its audit event before returning the reuse failure.
    audit.change({ ...context, event: 'token-reuse', userId: result.reused.user_id, tool: null, outcome: 'TOKEN_INVALID' },
      () => revokeFamily(db, result.reused.family_id, now))
    throw new ArtiumError('TOKEN_INVALID')
  }
  return result.pair!
}

export function logout(db: Database.Database, token: string, audit: Audit, context: AuditContext, now = Date.now()): void {
  const row = findSessionToken(db, token, ['access', 'refresh'])
  audit.change({ ...context, event: 'sign-out', userId: row.user_id, tool: null, outcome: 'success' },
    () => revokeFamily(db, row.family_id, now))
}

export function revokeUserSessions(db: Database.Database, userId: string, now: number): void {
  db.prepare('UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
}
