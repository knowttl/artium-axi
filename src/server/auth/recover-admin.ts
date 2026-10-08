import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { ArtiumError } from '../../shared/errors.js'
import { Audit } from '../audit/audit.js'
import { openStore } from '../store/db.js'
import type { KeyProvider } from '../store/key-provider.js'
import { acquireMaintenanceLock } from '../store/maintenance-lock.js'
import { readPasswordFile, readUsername } from './bootstrap.js'
import { hashPassword } from './local.js'

export async function recoverAdministrator(file: string, provider: KeyProvider, enteredUsername: string, passwordFile: string): Promise<string> {
  const username = readUsername(enteredUsername)
  const release = acquireMaintenanceLock(file)
  try {
    if (!existsSync(file)) throw new ArtiumError('RECOVERY_FAILED')
    const db = openStore(file, provider)
    try {
      const user = db.prepare("SELECT id FROM users WHERE username = ? AND source = 'local'").get(username) as { id: string } | undefined
      if (!user || !db.prepare('SELECT id FROM bootstrap_metadata').get()) throw new ArtiumError('RECOVERY_FAILED')
      const hash = await hashPassword(readPasswordFile(passwordFile))
      const now = Date.now()
      new Audit(db, Date.now, () => {}).change({ event: 'admin-change', action: 'recover-admin', targetId: user.id,
        userId: null, tool: null, requestId: randomUUID(), clientAddress: null, outcome: 'success' }, () => {
        db.prepare(`UPDATE users SET password_hash = ?, administrator = 1, disabled = 0, must_change = 1,
          failed_attempts = 0, locked_until = NULL, revision = revision + 1 WHERE id = ?`).run(hash, user.id)
        db.prepare('UPDATE session_families SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id)
        db.prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id)
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, user.id)
      })
      return user.id
    } finally { db.close() }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('RECOVERY_FAILED')
  } finally { release() }
}
