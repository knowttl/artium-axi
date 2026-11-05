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
  return verifyUndelegated(db, token, ['access'], now).user_id
}

export function verifyAccessFamily(db: Database.Database, token: string): string {
  return verifyUndelegated(db, token, ['access'], Date.now()).family_id
}

export function verifyPasswordToken(db: Database.Database, token: string, now = Date.now()) {
  return verifyUndelegated(db, token, ['access', 'password-change'], now)
}

export function verifyPrincipal(db: Database.Database, token: string, now = Date.now()) {
  const row = verifyToken(db, token, ['access'], now)
  return { userId: row.user_id, familyId: row.family_id, delegation: row.delegation_id === null ? null : {
    id: row.delegation_id, scopeJson: row.scope_json!, readOnly: !!row.read_only, expiresAt: row.delegation_expires_at!,
  } }
}

function verifyUndelegated(db: Database.Database, token: string, types: readonly string[], now: number) {
  const row = verifyToken(db, token, types, now)
  if (row.delegation_id !== null) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
  return row
}

function verifyToken(db: Database.Database, token: string, types: readonly string[], now: number) {
  const row = db.prepare(`
    SELECT tokens.user_id, tokens.family_id, tokens.type, tokens.expires_at, users.disabled, session_families.expires_at AS family_expires_at,
      session_families.delegation_id, delegations.scope_json, delegations.read_only,
      delegations.expires_at AS delegation_expires_at, delegations.revoked_at AS delegation_revoked_at,
      delegations.creator_id FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id
    JOIN users ON users.id = tokens.user_id
    LEFT JOIN delegations ON delegations.id = session_families.delegation_id
    WHERE tokens.hash = ?
      AND tokens.revoked_at IS NULL AND tokens.consumed_at IS NULL
      AND session_families.revoked_at IS NULL
  `).get(hashToken(token)) as { user_id: string, family_id: string, type: string, expires_at: number, family_expires_at: number, disabled: number,
    delegation_id: string | null, scope_json: string | null, read_only: number | null, delegation_expires_at: number | null,
    delegation_revoked_at: number | null, creator_id: string | null } | undefined
  if (!row || !types.includes(row.type)) throw new ArtiumError('TOKEN_INVALID')
  if (row.delegation_id !== null && (row.creator_id !== row.user_id || row.delegation_revoked_at !== null)) throw new ArtiumError('TOKEN_INVALID')
  if (row.expires_at <= now || row.family_expires_at <= now || (row.delegation_expires_at !== null && row.delegation_expires_at <= now)) throw new ArtiumError('TOKEN_EXPIRED')
  if (row.disabled) throw new ArtiumError('USER_DISABLED')
  return row
}

export function issueRecentAuthTicket(db: Database.Database, accessToken: string, now = Date.now()) {
  const row = verifyUndelegated(db, accessToken, ['access'], now)
  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = Math.min(now + authDefaults.recentAuthMs, row.family_expires_at)
  db.prepare(`INSERT INTO recent_auth_tickets (family_id, hash, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(family_id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at`)
    .run(row.family_id, hashToken(ticket), expiresAt)
  return { ticket, expiresAt }
}

export function requireRecentAuth(db: Database.Database, accessToken: string, ticket: string, now = Date.now()): string {
  const row = verifyUndelegated(db, accessToken, ['access'], now)
  const proof = db.prepare('SELECT expires_at FROM recent_auth_tickets WHERE family_id = ? AND hash = ?')
    .get(row.family_id, hashToken(ticket)) as { expires_at: number } | undefined
  if (!proof || proof.expires_at <= now) throw new ArtiumError('REAUTH_REQUIRED')
  return row.user_id
}

export function issueLoginTokens(db: Database.Database, userId: string, now = Date.now()): LoginResponse {
  return db.transaction((): LoginResponse => {
    const user = db.prepare('SELECT disabled, must_change, source FROM users WHERE id = ?').get(userId) as
      { disabled: number, must_change: number, source: string } | undefined
    if (!user || user.disabled) throw new ArtiumError('SIGN_IN_FAILED')
    const familyId = randomUUID()
    const familyExpiresAt = now + (user.source === 'sso' ? tokenDefaults.ssoFamilyMs : tokenDefaults.familyMs)
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
    session_families.revoked_at AS family_revoked_at, users.disabled, session_families.delegation_id,
    delegations.creator_id, delegations.expires_at AS delegation_expires_at, delegations.revoked_at AS delegation_revoked_at FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id JOIN users ON users.id = tokens.user_id
    LEFT JOIN delegations ON delegations.id = session_families.delegation_id
    WHERE tokens.hash = ?`).get(hashToken(token)) as {
      type: string, family_id: string, user_id: string, expires_at: number, consumed_at: number | null,
      revoked_at: number | null, family_expires_at: number, family_revoked_at: number | null, disabled: number,
      delegation_id: string | null, creator_id: string | null, delegation_expires_at: number | null, delegation_revoked_at: number | null,
    } | undefined
  if (!row || !types.includes(row.type) || row.revoked_at !== null || row.family_revoked_at !== null) {
    throw new ArtiumError('TOKEN_INVALID')
  }
  if (row.delegation_id !== null && (row.creator_id !== row.user_id || row.delegation_revoked_at !== null)) throw new ArtiumError('TOKEN_INVALID')
  return row
}

export function revokeFamily(db: Database.Database, familyId: string, now: number): void {
  db.prepare('UPDATE session_families SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, familyId)
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now, familyId)
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now, familyId)
}

export function refreshTokens(db: Database.Database, token: string, audit: Audit, context: AuditContext, now = Date.now()): TokenPair {
  const delegation = db.prepare(`SELECT delegations.id, delegations.creator_id FROM tokens
    JOIN session_families ON session_families.id = tokens.family_id
    JOIN delegations ON delegations.id = session_families.delegation_id
    WHERE tokens.hash = ? AND tokens.type = 'refresh'`).get(hashToken(token)) as { id: string, creator_id: string } | undefined
  if (delegation) audit.record({ ...context, event: 'delegation-access', userId: delegation.creator_id,
    delegationId: delegation.id, tool: null, outcome: 'success' })
  const result = db.transaction(() => {
    const row = findSessionToken(db, token, ['refresh'])
    if (row.expires_at <= now || row.family_expires_at <= now || (row.delegation_expires_at !== null && row.delegation_expires_at <= now)) throw new ArtiumError('TOKEN_EXPIRED')
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
  audit.change({ ...context, event: 'sign-out', userId: row.user_id, delegationId: row.delegation_id, tool: null, outcome: 'success' },
    () => revokeFamily(db, row.family_id, now))
}

export function revokeUserSessions(db: Database.Database, userId: string, now: number): void {
  db.prepare('UPDATE delegations SET revoked_at = ? WHERE creator_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
}

// The caller owns the transaction so exchange and its audit record commit together.
export function exchangeDelegation(db: Database.Database, token: string, now = Date.now()): TokenPair {
  const row = db.prepare(`SELECT delegations.id, delegations.creator_id, delegations.expires_at,
    delegations.revoked_at, delegations.single_use, delegations.consumed_at, users.disabled, users.must_change
    FROM delegations JOIN users ON users.id = delegations.creator_id WHERE token_hash = ?`).get(hashToken(token)) as
    { id: string, creator_id: string, expires_at: number, revoked_at: number | null, single_use: number,
      consumed_at: number | null, disabled: number, must_change: number } | undefined
  if (!row || row.revoked_at !== null || row.disabled || row.must_change || (row.single_use && row.consumed_at !== null)) {
    throw new ArtiumError('TOKEN_INVALID')
  }
  if (row.expires_at <= now) throw new ArtiumError('TOKEN_EXPIRED')
  if (row.single_use) db.prepare('UPDATE delegations SET consumed_at = ? WHERE id = ?').run(now, row.id)
  const familyId = randomUUID()
  db.prepare('INSERT INTO session_families (id, user_id, created_at, expires_at, delegation_id) VALUES (?, ?, ?, ?, ?)')
    .run(familyId, row.creator_id, now, row.expires_at, row.id)
  return issuePair(db, familyId, row.creator_id, row.expires_at, now)
}
