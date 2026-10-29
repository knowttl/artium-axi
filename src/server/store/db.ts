import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { randomUUID, X509Certificate } from 'node:crypto'
import { decryptCredential, encryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { EnvironmentKeyProvider, MasterKeyMismatch } from './key-provider.js'
import type { KeyProvider } from './key-provider.js'
import { ArtiumError } from '../../shared/errors.js'
import type { CredentialStore, MutableCredentialStore } from './credential-store.js'
import { nativeSettingsSchemas, toolSchema } from '../../shared/api.js'
import { readCredentialTrust } from './trusted-certificates.js'

const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url))

export function validateSchema(db: Database.Database, directory = migrationsDirectory): void {
  const files = readdirSync(directory).filter(file => /^\d+-.+\.sql$/.test(file)).sort()
  const supported = files.map(file => Number(file.split('-')[0]))
  const applied = db.prepare('SELECT version FROM migrations ORDER BY version').all() as { version: number }[]
  if (!applied.length || applied.some((row, index) => row.version !== supported[index])) {
    throw new ArtiumError('STORE_SCHEMA_INVALID')
  }
  const expected = new Database(':memory:')
  try {
    expected.exec('CREATE TABLE migrations (version INTEGER PRIMARY KEY)')
    for (const file of files.slice(0, applied.length)) expected.exec(readFileSync(join(directory, file), 'utf8'))
    const definition = db.prepare('SELECT sql FROM sqlite_master WHERE name = ? AND type = ?')
    for (const row of expected.prepare('SELECT name, type, sql FROM sqlite_master').all() as { name: string, type: string, sql: string | null }[]) {
      const actual = definition.get(row.name, row.type) as { sql: string | null } | undefined
      if (!actual || actual.sql !== row.sql) throw new ArtiumError('STORE_SCHEMA_INVALID')
    }
  } finally { expected.close() }
}

export function createCredentialStore(db: Database.Database, provider: KeyProvider): MutableCredentialStore {
  const key = provider.getKey()
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM credentials').all() as EncryptedCredential[]
    for (const row of rows) {
      const keys = Object.keys(nativeSettingsSchemas[toolSchema.parse(row.tool)].shape)
      if (keys.length === 0) continue
      const plaintext = decryptCredential(row, key)
      try {
        let value: Record<string, unknown>
        try { value = JSON.parse(plaintext.toString('utf8')) } catch { continue }
        if (!value || typeof value !== 'object') continue
        const settings = Object.fromEntries(Object.entries(value).filter(([name]) => keys.includes(name)))
        if (Object.keys(settings).length === 0) continue
        const current = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(row.tool) as { native_settings: string }
        db.prepare('UPDATE tools SET native_settings = ? WHERE name = ?')
          .run(JSON.stringify({ ...settings, ...JSON.parse(current.native_settings) }), row.tool)
        const credential = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([name]) => !keys.includes(name)))))
        try {
          const encrypted = encryptCredential(row.id, row.tool, credential, key)
          db.prepare(`UPDATE credentials SET schema_version = @schema_version, key_id = @key_id,
            nonce = @nonce, ciphertext = @ciphertext, authentication_tag = @authentication_tag WHERE id = @id`).run(encrypted)
        } finally { credential.fill(0) }
      } finally { plaintext.fill(0) }
    }
  }).immediate()
  return {
    readCredentialTrust: reference => readCredentialTrust(db, reference),
    readToolSettings(tool) {
      const row = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(tool) as { native_settings: string }
      return JSON.parse(row.native_settings)
    },
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
  // SQLite table rebuilds require FK enforcement off outside the transaction.
  // Check all references before commit, then restore the caller's enforcement.
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) === 1
  if (foreignKeys && db.inTransaction) throw new ArtiumError('STORE_SCHEMA_INVALID')
  if (foreignKeys) db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)')
      const applied = new Set(db.prepare('SELECT version FROM migrations').all().map(row => (row as { version: number }).version))
      const files = readdirSync(directory).filter(file => /^\d+-.+\.sql$/.test(file)).sort()
      const supported = new Set(files.map(file => Number(file.split('-')[0])))
      if ([...applied].some(version => !supported.has(version))) throw new ArtiumError('STORE_SCHEMA_INVALID')
      for (const file of files) {
        const version = Number(file.split('-')[0])
        if (applied.has(version)) continue
        db.exec(readFileSync(join(directory, file), 'utf8'))
        if (file === '021-ca-trust.sql') {
          const pins = db.prepare(`SELECT t.id, t.pem, t.fingerprint, t.leaf_fingerprint, c.tool FROM trusted_certificates t
            JOIN credentials c ON c.id = t.credential_id WHERE t.mode = 'pin'`).all() as
            { id: string, pem: string, fingerprint: string, leaf_fingerprint: string, tool: string }[]
          for (const pin of pins) {
            const anchor = new X509Certificate(pin.pem)
            const convert = anchor.ca && anchor.fingerprint256 !== pin.leaf_fingerprint
            const selfSigned = anchor.subject === anchor.issuer && anchor.verify(anchor.publicKey)
            if (convert) db.prepare("UPDATE trusted_certificates SET mode = 'ca' WHERE id = ?").run(pin.id)
            db.prepare(`INSERT INTO audit (occurred_at, event, tool, request_id, outcome, action, target_id, subject)
              VALUES (?, 'admin-change', ?, ?, 'success', ?, ?, ?)`).run(Date.now(), pin.tool, randomUUID(),
              convert ? 'migrate-certificate-to-ca-trust' : selfSigned ? 'keep-self-signed-certificate-pin'
                : 'keep-certificate-pin-no-issuing-ca-stored', pin.fingerprint, anchor.subject)
            db.prepare('DELETE FROM tool_health WHERE tool = ?').run(pin.tool)
          }
        }
        db.prepare('INSERT INTO migrations (version) VALUES (?)').run(version)
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length) throw new ArtiumError('STORE_SCHEMA_INVALID')
    }).immediate()
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON')
  }
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
    // Keep schema upgrades and key validation in one rollback boundary.
    db.pragma('foreign_keys = OFF')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.transaction(() => {
      const existingStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()
      migrate(db)
      const metadata = db.prepare('SELECT master_key_id FROM store_metadata WHERE id = 1').get() as { master_key_id: string } | undefined
      const rotation = db.prepare('SELECT new_key_id FROM key_rotations ORDER BY rowid DESC LIMIT 1').get() as { new_key_id: string } | undefined
      if (metadata && metadata.master_key_id !== key.id) {
        throw new MasterKeyMismatch(metadata.master_key_id)
      }
      if (rotation && rotation.new_key_id !== key.id) {
        throw new MasterKeyMismatch(rotation.new_key_id)
      }
      const rows = db.prepare('SELECT * FROM credentials UNION ALL SELECT * FROM provider_credentials').all() as EncryptedCredential[]
      if (!metadata && existingStore && !rotation && rows.length === 0) throw new ArtiumError('MASTER_KEY_INVALID')
      for (const row of rows) decryptCredential(row, key).fill(0)
      if (!metadata) db.prepare('INSERT INTO store_metadata (id, master_key_id) VALUES (1, ?)').run(key.id)
      const insertTool = db.prepare("INSERT INTO tools (name, enabled, pinned_version) VALUES (?, 0, '') ON CONFLICT(name) DO NOTHING")
      for (const tool of toolSchema.options) insertTool.run(tool)
    }).immediate()
    db.pragma('foreign_keys = ON')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
