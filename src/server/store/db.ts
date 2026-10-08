import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { decryptCredential, encryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import type { KeyProvider } from './key-provider.js'
import { ArtiumError } from '../../shared/errors.js'
import type { CredentialStore, MutableCredentialStore } from './credential-store.js'
import { toolSchema } from '../../shared/api.js'

const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url))

export function createCredentialStore(db: Database.Database, provider: KeyProvider): MutableCredentialStore {
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
        const value = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
        const settings = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(reference.tool) as { native_settings: string }
        return { ...value, ...JSON.parse(settings.native_settings) }
      } catch {
        throw new ArtiumError('CREDENTIAL_INVALID')
      } finally { plaintext.fill(0) }
    },
    replaceCredential(tool, value, expectedRevision, actor, now) {
      const current = db.prepare('SELECT id, revision FROM credentials WHERE tool = ?').get(tool) as { id: string, revision: number } | undefined
      if ((current?.revision ?? 0) !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const id = current?.id ?? randomUUID()
      const plaintext = Buffer.from(JSON.stringify(value))
      try {
        const encrypted = encryptCredential(id, tool, plaintext, key)
        const revision = (current?.revision ?? 0) + 1
        db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision, updated_at, updated_by)
          VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, @revision, @now, @actor)
          ON CONFLICT(tool) DO UPDATE SET schema_version = excluded.schema_version, key_id = excluded.key_id,
          nonce = excluded.nonce, ciphertext = excluded.ciphertext, authentication_tag = excluded.authentication_tag,
          revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run({ ...encrypted, revision, now, actor })
        return { id, tool, revision }
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
      const existingStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()
      migrate(db)
      const metadata = db.prepare('SELECT master_key_id FROM store_metadata WHERE id = 1').get() as { master_key_id: string } | undefined
      const rotation = db.prepare('SELECT new_key_id FROM key_rotations ORDER BY rowid DESC LIMIT 1').get() as { new_key_id: string } | undefined
      if (metadata && metadata.master_key_id !== key.id) {
        throw new ArtiumError('MASTER_KEY_INVALID', undefined, `Restart with the master key whose SHA-256 ID is ${metadata.master_key_id}.`)
      }
      if (rotation && rotation.new_key_id !== key.id) {
        throw new ArtiumError('MASTER_KEY_INVALID', undefined, `Restart with the master key whose SHA-256 ID is ${rotation.new_key_id}.`)
      }
      const rows = db.prepare('SELECT * FROM credentials').all() as EncryptedCredential[]
      if (!metadata && existingStore && !rotation && rows.length === 0) throw new ArtiumError('MASTER_KEY_INVALID')
      for (const row of rows) decryptCredential(row, key).fill(0)
      if (!metadata) db.prepare('INSERT INTO store_metadata (id, master_key_id) VALUES (1, ?)').run(key.id)
      const insertTool = db.prepare("INSERT INTO tools (name, enabled, pinned_version) VALUES (?, 0, '') ON CONFLICT(name) DO NOTHING")
      for (const tool of toolSchema.options) insertTool.run(tool)
    }).immediate()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
