import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { hashToken } from './tokens.js'

export function readDevelopmentToken(environment: NodeJS.ProcessEnv): string {
  try {
    if (environment.ARTIUM_AXI_DEV !== '1' || !environment.ARTIUM_AXI_DEV_TOKEN_FILE) throw new Error()
    const token = readFileSync(environment.ARTIUM_AXI_DEV_TOKEN_FILE, 'utf8').trim()
    if (!token || /\s/.test(token)) throw new Error()
    return token
  } catch { throw new ArtiumError('DEV_AUTH_INVALID') }
}

// Static development authentication is separate from production token issuance and verification.
export function developmentAuthentication(db: Database.Database, token: string) {
  const userId = 'synthetic-development-user'
  db.transaction(() => {
    const { changes } = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, must_change)
      VALUES (?, ?, 'Synthetic Development User', 'unusable', 0)
      ON CONFLICT(id) DO NOTHING`).run(userId, userId)
    if (!changes) {
      db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
      return
    }
    db.prepare("INSERT INTO roles (id, name) VALUES ('synthetic-development-role', 'Synthetic Development Role') ON CONFLICT(id) DO NOTHING").run()
    db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES (?, 'synthetic-development-role') ON CONFLICT DO NOTHING").run(userId)
    for (const tool of toolSchema.options) {
      db.prepare("INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-development-role', ?) ON CONFLICT DO NOTHING").run(tool)
    }
  }).immediate()
  const expected = Buffer.from(hashToken(token), 'hex')
  return (_db: Database.Database, candidate: string): string => {
    if (!timingSafeEqual(expected, Buffer.from(hashToken(candidate), 'hex'))) throw new ArtiumError('TOKEN_INVALID')
    const user = db.prepare('SELECT disabled FROM users WHERE id = ?').get(userId) as { disabled: number } | undefined
    if (!user || user.disabled) throw new ArtiumError('USER_DISABLED')
    return userId
  }
}
