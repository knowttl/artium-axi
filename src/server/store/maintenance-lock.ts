import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'

// A separate SQLite writer lock spans the server lifetime without blocking store writes.
// SQLite releases it on process death. Never delete the lock database while in use.
export function acquireMaintenanceLock(file: string): () => void {
  const directory = dirname(resolve(file))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lockFile = join(realpathSync(directory), `${basename(file)}.maintenance`)
  const lock = new Database(lockFile)
  try {
    chmodSync(lockFile, 0o600)
    lock.pragma('busy_timeout = 0')
    lock.exec('BEGIN IMMEDIATE')
  } catch (error) {
    lock.close()
    if ((error as { code?: string }).code === 'SQLITE_BUSY') throw new ArtiumError('MAINTENANCE_BUSY')
    throw new ArtiumError('MAINTENANCE_UNAVAILABLE')
  }
  return () => { if (lock.open) lock.close() }
}
