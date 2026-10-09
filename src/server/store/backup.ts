import { chmodSync, closeSync, copyFileSync, constants, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import { decryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { openStore, validateSchema } from './db.js'
import type { KeyProvider } from './key-provider.js'
import { acquireMaintenanceLock } from './maintenance-lock.js'

function validateBackup(db: Database.Database, provider: KeyProvider): string {
  validateSchema(db)
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) {
    throw new ArtiumError('STORE_SCHEMA_INVALID')
  }
  const key = provider.getKey()
  const metadata = db.prepare('SELECT master_key_id FROM store_metadata WHERE id = 1').get() as { master_key_id: string } | undefined
  const rotation = db.prepare('SELECT new_key_id FROM key_rotations ORDER BY rowid DESC LIMIT 1').get() as { new_key_id: string } | undefined
  if (!metadata || metadata.master_key_id !== key.id || (rotation && rotation.new_key_id !== key.id)) {
    throw new ArtiumError('MASTER_KEY_INVALID')
  }
  for (const row of db.prepare('SELECT * FROM credentials').all() as EncryptedCredential[]) decryptCredential(row, key).fill(0)
  return key.id
}

// Publish without replacing an existing file, only after durable validation.
function publish(file: string, destination: string): void {
  chmodSync(file, 0o600)
  const descriptor = openSync(file, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  linkSync(file, destination)
  const directory = openSync(dirname(destination), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

export async function backupStore(file: string, output: string, provider: KeyProvider) {
  const destination = resolve(output)
  let temporary: string | undefined
  let db: Database.Database | undefined
  try {
    temporary = mkdtempSync(join(dirname(destination), '.artium-backup-'))
    chmodSync(temporary, 0o700)
    const snapshot = join(temporary, 'artium.db')
    db = new Database(file, { readonly: true, fileMustExist: true })
    db.pragma('busy_timeout = 5000')
    // Pin a read snapshot so incremental backup never follows later writes.
    db.exec('BEGIN')
    const keyId = validateBackup(db, provider)
    await db.backup(snapshot)
    db.close()
    db = undefined
    publish(snapshot, destination)
    return { key_id: keyId }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('BACKUP_FAILED')
  } finally {
    if (db?.open) db.close()
    if (temporary) rmSync(temporary, { recursive: true, force: true })
  }
}

export function restoreStore(input: string, file: string, provider: KeyProvider) {
  const destination = resolve(file)
  let release: (() => void) | undefined
  let temporary: string | undefined
  let db: Database.Database | undefined
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    chmodSync(dirname(destination), 0o700)
    release = acquireMaintenanceLock(destination)
    const lockName = `${basename(destination)}.maintenance`
    if (readdirSync(dirname(destination)).some(name => name !== lockName && name !== `${lockName}-journal`)) {
      throw new ArtiumError('RESTORE_FAILED')
    }
    temporary = mkdtempSync(join(dirname(destination), '.artium-restore-'))
    chmodSync(temporary, 0o700)
    const restored = join(temporary, 'artium.db')
    copyFileSync(input, restored, constants.COPYFILE_EXCL)
    chmodSync(restored, 0o600)
    db = new Database(restored)
    const keyId = validateBackup(db, provider)
    db.close()
    db = openStore(restored, provider)
    db.transaction(() => {
      db!.exec('DELETE FROM recent_auth_tickets; DELETE FROM tokens; DELETE FROM sessions; DELETE FROM session_families;')
    }).immediate()
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    db = undefined
    publish(restored, destination)
    return { key_id: keyId }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('RESTORE_FAILED')
  } finally {
    if (db?.open) db.close()
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    release?.()
  }
}
