import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { decryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import type { KeyProvider } from './key-provider.js'
import { ArtiumError } from '../../shared/errors.js'
import type { CredentialStore } from './credential-store.js'
import { toolSchema } from '../../shared/api.js'

const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url))

export function createCredentialStore(db: Database.Database, provider: KeyProvider): CredentialStore {
  const key = provider.getKey()
  return {
    findCredential(tool) {
      return db.prepare('SELECT id, tool, revision FROM credentials WHERE tool = ?').get(tool) as ReturnType<CredentialStore['findCredential']>
    },
    readCredential(reference) {
      const row = db.prepare('SELECT * FROM credentials WHERE id = ? AND tool = ?').get(reference.id, reference.tool) as (EncryptedCredential & { revision: number }) | undefined
      if (!row) return undefined
      if (reference.revision !== undefined && row.revision !== reference.revision) return undefined
      const plaintext = decryptCredential(row, key)
      try {
        return JSON.parse(plaintext.toString('utf8')) as unknown
      } catch {
        throw new ArtiumError('CREDENTIAL_INVALID')
      } finally { plaintext.fill(0) }
    },
  }
}

export function migrate(db: Database.Database, directory = migrationsDirectory): void {
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)')
    const applied = new Set(db.prepare('SELECT version FROM migrations').all().map(row => (row as { version: number }).version))
    for (const file of readdirSync(directory).filter(file => /^\d+-.+\.sql$/.test(file)).sort()) {
      const version = Number(file.split('-')[0])
      if (applied.has(version)) continue
      db.exec(readFileSync(join(directory, file), 'utf8'))
      db.prepare('INSERT INTO migrations (version) VALUES (?)').run(version)
    }
  }).immediate()
}

// The returned connection is ready only after every stored credential authenticates.
export function openStore(file: string, provider: KeyProvider = new EnvironmentKeyProvider()): Database.Database {
  const key = provider.getKey()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  chmodSync(dirname(file), 0o700)
  const db = new Database(file)
  try {
    chmodSync(file, 0o600)
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.transaction(() => {
      migrate(db)
      const rotation = db.prepare('SELECT new_key_id FROM key_rotations ORDER BY rowid DESC LIMIT 1').get() as { new_key_id: string } | undefined
      if (rotation && rotation.new_key_id !== key.id) {
        throw new ArtiumError('CREDENTIAL_INVALID', undefined, `Restart with the master key whose SHA-256 ID is ${rotation.new_key_id}.`)
      }
      const insertTool = db.prepare("INSERT INTO tools (name, enabled, pinned_version) VALUES (?, 0, '') ON CONFLICT(name) DO NOTHING")
      for (const tool of toolSchema.options) insertTool.run(tool)
      const rows = db.prepare('SELECT * FROM credentials').all() as EncryptedCredential[]
      for (const row of rows) decryptCredential(row, key).fill(0)
    }).immediate()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
