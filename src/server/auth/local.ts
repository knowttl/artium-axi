import argon2 from 'argon2'
import type Database from 'better-sqlite3'
import { passwordSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { passwordDefaults } from '../config.js'
import type { AuthProvider } from './auth-provider.js'
import commonPasswords from './common-passwords.v1.json' with { type: 'json' }

const common = new Set(commonPasswords.passwords)
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
  if (!passwordSchema.safeParse(password).success || common.has(password)) throw new ArtiumError('PASSWORD_INVALID')
  return hashing(() => argon2.hash(password, { type: argon2.argon2id,
    memoryCost: passwordDefaults.memoryCost, timeCost: passwordDefaults.timeCost, parallelism: passwordDefaults.parallelism }))
}

interface LocalUser {
  id: string
  password_hash: string
  must_change: number
  disabled: number
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
    return { userId: current.id, mustChange: Boolean(current.must_change) }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, audit: Audit,
    context: { requestId: string, clientAddress: string | null }, now = Date.now()): Promise<void> {
    const user = this.readUser(userId)
    const matches = await verifyPassword(user?.password_hash, currentPassword)
    if (!user || !matches || user.disabled) throw new ArtiumError('SIGN_IN_FAILED')
    const hash = await hashPassword(newPassword)
    audit.change({ event: 'password-change', userId, tool: null, outcome: 'success', ...context }, () => {
      const { changes } = this.db.prepare(`UPDATE users SET password_hash = ?, must_change = 0, revision = revision + 1
        WHERE id = ? AND password_hash = ? AND disabled = 0`).run(hash, userId, user.password_hash)
      if (!changes) throw new ArtiumError('SIGN_IN_FAILED')
      this.db.prepare('UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
      this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
    })
  }

  private readUser(userId: string): LocalUser | undefined {
    return this.db.prepare("SELECT id, password_hash, must_change, disabled FROM users WHERE id = ? AND source = 'local'")
      .get(userId) as LocalUser | undefined
  }
}
