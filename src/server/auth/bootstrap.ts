import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import { canonicalUsername, hashPassword } from './local.js'

export function readPasswordFile(file: string | undefined): string {
  try {
    if (!file) throw new Error()
    return readFileSync(file, 'utf8')
  } catch { throw new ArtiumError('PASSWORD_FILE_INVALID') }
}

export function readUsername(value: string | undefined): string {
  const username = canonicalUsername(value ?? '')
  if (!username || /[\s\p{Cc}]/u.test(username)) throw new ArtiumError('USERNAME_INVALID')
  return username
}

function needsBootstrap(db: Database.Database): boolean {
  if (db.prepare('SELECT id FROM bootstrap_metadata').get()) return false
  const data = db.prepare(`SELECT 1 FROM users UNION ALL SELECT 1 FROM roles
    UNION ALL SELECT 1 FROM credentials UNION ALL SELECT 1 FROM audit
    UNION ALL SELECT 1 FROM key_rotations UNION ALL
    SELECT 1 FROM tools WHERE enabled != 0 OR pinned_version != '' OR native_settings != '{}' OR revision != 1
    LIMIT 1`).get()
  if (data) throw new ArtiumError('BOOTSTRAP_INCONSISTENT')
  return true
}

export async function bootstrapAdministrator(db: Database.Database, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!needsBootstrap(db)) return
  const displayName = environment.ARTIUM_AXI_ADMIN_USERNAME
  const username = readUsername(displayName)
  const hash = await hashPassword(readPasswordFile(environment.ARTIUM_AXI_ADMIN_PASSWORD_FILE))
  db.transaction(() => {
    if (!needsBootstrap(db)) return
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
      VALUES (?, ?, ?, ?, 1, 1)`).run(randomUUID(), username, displayName!, hash)
    db.prepare('INSERT INTO bootstrap_metadata (id, bootstrapped_at) VALUES (1, ?)').run(Date.now())
  }).immediate()
}
