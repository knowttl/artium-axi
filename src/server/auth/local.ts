import argon2 from 'argon2'
import type Database from 'better-sqlite3'
import { passwordSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit, AuditEvent } from '../audit/audit.js'
import { passwordDefaults } from '../config.js'
import type { AuthProvider } from './auth-provider.js'
import { revokeUserSessions, verifyPasswordToken } from './tokens.js'
import { readBrowserSession, recentBrowserAuth } from './sessions.js'

const dummyHash = '$argon2id$v=19$m=65536,p=1,t=3$vNZ3Sa+H+g+67iTEmnJxbQ$4dkx0/sgcEmrkpSfYhnbOS9a/6SskDG33I0aMQmBdCI'
let activeHashes = 0

async function hashing<T>(operation: () => Promise<T>): Promise<T> {
  if (activeHashes >= passwordDefaults.concurrentHashes) throw new ArtiumError('AUTH_BUSY')
  activeHashes++
  try { return await operation() } finally { activeHashes-- }
}

async function verifyPassword(hash: string | undefined, password: string): Promise<boolean> {
  const usable = hash !== undefined && hash !== 'unusable'
  const matches = await hashing(() => argon2.verify(usable ? hash : dummyHash, password))
  return usable && matches
}

export function canonicalUsername(username: string): string {
  return username.trim().toLowerCase()
}

// All account creation, reset and change producers share this validation and hash boundary.
export function hashPassword(password: string): Promise<string> {
  if (!passwordSchema.safeParse(password).success) throw new ArtiumError('PASSWORD_INVALID')
  return hashing(() => argon2.hash(password, { type: argon2.argon2id,
    memoryCost: passwordDefaults.memoryCost, timeCost: passwordDefaults.timeCost, parallelism: passwordDefaults.parallelism }))
}

interface LocalUser {
  id: string
  password_hash: string
  must_change: number
  disabled: number
}

// Shared by password login, confirmation and changes, including their audit boundaries.
export function localAuthenticationMethod(db: Database.Database, userId: string): 'local' | 'break-glass' {
  const user = db.prepare("SELECT break_glass, administrator FROM users WHERE id = ? AND source = 'local' AND disabled = 0")
    .get(userId) as { break_glass: number, administrator: number } | undefined
  if (!user) throw new ArtiumError('SIGN_IN_FAILED')
  const breakGlass = Boolean(user.break_glass && user.administrator)
  if (!breakGlass && db.prepare('SELECT 1 FROM sso_providers WHERE enabled = 1').get()) throw new ArtiumError('SIGN_IN_FAILED')
  return breakGlass ? 'break-glass' : 'local'
}

export class LocalAuthProvider implements AuthProvider {
  constructor(private readonly db: Database.Database) {}

  async signIn(username: string, password: string) {
    const user = this.db.prepare("SELECT id, password_hash, must_change, disabled FROM users WHERE username = ? AND source = 'local'")
      .get(canonicalUsername(username)) as LocalUser | undefined
    const matches = await verifyPassword(user?.password_hash, password)
    if (!user || !matches || user.disabled) throw new ArtiumError('SIGN_IN_FAILED')
    const current = this.readUser(user.id)
    if (!current || current.disabled || current.password_hash !== user.password_hash) throw new ArtiumError('SIGN_IN_FAILED')
    localAuthenticationMethod(this.db, current.id)
    return { userId: current.id, mustChange: Boolean(current.must_change) }
  }

  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string, audit: Audit,
    context: { requestId: string, clientAddress: string | null }, now = Date.now(), proof?: string | { sessionId: string }): Promise<void> {
    const user = this.readUser(userId)
    localAuthenticationMethod(this.db, userId)
    const verifyProof = () => {
      if (typeof proof === 'string') {
        const token = verifyPasswordToken(this.db, proof)
        if (token.user_id !== userId) throw new ArtiumError('TOKEN_INVALID')
        return { restricted: token.type === 'password-change', recent: false }
      }
      if (proof) {
        const session = readBrowserSession(this.db, proof.sessionId)
        if (session.user_id !== userId) throw new ArtiumError('TOKEN_INVALID')
        return { restricted: Boolean(session.must_change), recent: recentBrowserAuth(session) }
      }
      return { restricted: false, recent: false }
    }
    const { restricted, recent } = verifyProof()
    let passwordConfirmed = false
    if (!restricted && !recent) {
      if (currentPassword === undefined) throw new ArtiumError('SIGN_IN_FAILED')
      const matches = await verifyPassword(user?.password_hash, currentPassword)
      if (!matches) throw new ArtiumError('SIGN_IN_FAILED')
      passwordConfirmed = true
    }
    if (!user || user.disabled || (restricted && !user.must_change)) throw new ArtiumError('SIGN_IN_FAILED')
    const hash = await hashPassword(newPassword)
    const event: AuditEvent = { event: 'password-change', userId, tool: null, outcome: 'success', ...context }
    audit.change(event, () => {
      event.authenticationMethod = localAuthenticationMethod(this.db, userId)
      const current = verifyProof()
      if (!current.restricted && !current.recent && !passwordConfirmed) throw new ArtiumError('SIGN_IN_FAILED')
      const { changes } = this.db.prepare(`UPDATE users SET password_hash = ?, must_change = 0, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE id = ? AND password_hash = ? AND disabled = 0`).run(hash, now, userId, userId, user.password_hash)
      if (!changes) throw new ArtiumError('SIGN_IN_FAILED')
      revokeUserSessions(this.db, userId, now)
    })
  }

  private readUser(userId: string): LocalUser | undefined {
    return this.db.prepare("SELECT id, password_hash, must_change, disabled FROM users WHERE id = ? AND source = 'local'")
      .get(userId) as LocalUser | undefined
  }
}
