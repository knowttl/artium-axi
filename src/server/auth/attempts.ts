import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { authDefaults } from '../config.js'
import { canonicalUsername, LocalAuthProvider } from './local.js'
import { hashToken } from './tokens.js'

type Counter = { count: number, expiresAt: number }
type Context = { requestId: string, clientAddress: string }
type Account = { id: string, failed_attempts: number, locked_until: number | null }

// One instance per server; active counters are never evicted to admit fresh keys.
export class AuthAttempts {
  private readonly limits = new AuthRateLimits()
  private readonly provider: LocalAuthProvider

  constructor(private readonly db: Database.Database, private readonly audit: Audit) {
    this.provider = new LocalAuthProvider(db)
  }

  async signIn(username: string, password: string, context: Context) {
    const canonical = canonicalUsername(username)
    const now = Date.now()
    this.limits.admit(canonical, context.clientAddress, now)
    const account = this.account(canonical)
    if (account?.locked_until && account.locked_until > now) throw new ArtiumError('ACCOUNT_LOCKED')
    try {
      const identity = await this.provider.signIn(canonical, password)
      const current = this.account(canonical)
      if (current?.locked_until && current.locked_until > Date.now()) throw new ArtiumError('ACCOUNT_LOCKED')
      this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(identity.userId)
      return identity
    } catch (error) {
      if (error instanceof ArtiumError && error.code === 'SIGN_IN_FAILED' && account) {
        const current = this.account(canonical)!
        if (current.locked_until !== null && current.locked_until > Date.now()) throw error
        const failed = current.locked_until !== null && current.locked_until <= Date.now() ? 1 : current.failed_attempts + 1
        const update = () => this.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
          .run(failed, failed >= authDefaults.usernameAttempts ? Date.now() + authDefaults.windowMs : null, account.id)
        if (failed === authDefaults.usernameAttempts) {
          this.audit.change({ ...context, event: 'lockout', userId: account.id, tool: null, outcome: 'ACCOUNT_LOCKED' }, update)
        } else update()
      }
      throw error
    }
  }

  private account(username: string): Account | undefined {
    return this.db.prepare('SELECT id, failed_attempts, locked_until FROM users WHERE username = ?').get(username) as Account | undefined
  }
}

export class AuthRateLimits {
  private readonly usernames = new Map<string, Counter>()
  private readonly addresses = new Map<string, Counter>()

  admit(username: string, address: string, now = Date.now()): void {
    this.prune(this.usernames, now)
    this.prune(this.addresses, now)
    this.consume(this.addresses, hashToken(address), authDefaults.addressAttempts, now)
    this.consume(this.usernames, hashToken(canonicalUsername(username)), authDefaults.usernameAttempts, now)
  }

  private prune(counters: Map<string, Counter>, now: number): void {
    for (const [key, counter] of counters) if (counter.expiresAt <= now) counters.delete(key)
  }

  private consume(counters: Map<string, Counter>, key: string, limit: number, now: number): void {
    const counter = counters.get(key)
    if (counter) {
      if (counter.count >= limit) throw new ArtiumError('AUTH_RATE_LIMITED')
      counter.count++
    } else {
      if (counters.size >= authDefaults.counterKeys) throw new ArtiumError('AUTH_RATE_LIMITED')
      counters.set(key, { count: 1, expiresAt: now + authDefaults.windowMs })
    }
  }
}
