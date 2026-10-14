import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { decryptCredential, encryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { createCredentialStore, migrate, openStore } from './db.js'
import { EnvironmentKeyProvider, saveMasterKey } from './key-provider.js'

let directory: string
let file: string
const bytes = Buffer.alloc(32, 1)
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: bytes.toString('base64') })
const key = provider.getKey()
const plaintext = Buffer.from('CANARY-persisted-synthetic')

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-store-'))
  file = join(directory, 'artium.db')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function seed(value = plaintext) {
  const db = openStore(file, provider)
  db.prepare('UPDATE tools SET pinned_version = ? WHERE name = ?').run('synthetic-version', 'falcon-axi')
  const row = encryptCredential('synthetic-id', 'falcon-axi', value, key)
  db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag)
    VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag)`).run(row)
  db.close()
}

it('a resolved revision cannot read a replacement credential', () => {
  seed(Buffer.from('{"synthetic":true}'))
  const db = openStore(file, provider)
  try {
    const store = createCredentialStore(db, provider)
    const reference = store.findCredential('falcon-axi')!
    expect(reference.revision).toBe(1)
    expect(store.readCredential(reference)).toEqual({ synthetic: true })
    db.prepare('UPDATE credentials SET revision = revision + 1').run()
    expect(store.readCredential(reference)).toBeUndefined()
    expect(store.findCredential('falcon-axi')!.revision).toBe(2)
  } finally { db.close() }
})

it('opens an unconfigured store with every supported tool disabled', () => {
  const db = openStore(file, provider)
  try {
    expect(db.prepare('SELECT name, enabled, pinned_version FROM tools ORDER BY name').all()).toEqual([
      { name: 'az-axi', enabled: 0, pinned_version: '' },
      { name: 'falcon-axi', enabled: 0, pinned_version: '' },
      { name: 'ldap-axi', enabled: 0, pinned_version: '' },
      { name: 'mg-axi', enabled: 0, pinned_version: '' },
      { name: 'vectra-axi', enabled: 0, pinned_version: '' },
    ])
  } finally { db.close() }
})

it('startup restores missing tools without changing existing tool settings', () => {
  let db = openStore(file, provider)
  db.exec(`UPDATE tools SET enabled = 1, pinned_version = 'synthetic-falcon', native_settings = '{"synthetic":true}', revision = 3 WHERE name = 'falcon-axi';
    UPDATE tools SET pinned_version = 'synthetic-vectra', revision = 2 WHERE name = 'vectra-axi';
    DELETE FROM tools WHERE name = 'az-axi';`)
  const configured = db.prepare('SELECT * FROM tools ORDER BY name').all()
  db.close()
  db = openStore(file, provider)
  try {
    expect(db.prepare("SELECT * FROM tools WHERE name != 'az-axi' ORDER BY name").all()).toEqual(configured)
    expect(db.prepare("SELECT name, enabled, pinned_version FROM tools WHERE name = 'az-axi'").get())
      .toEqual({ name: 'az-axi', enabled: 0, pinned_version: '' })
  } finally { db.close() }
})

it('reopens a real database and authenticates its persisted credential', () => {
  seed()
  const db = openStore(file, provider)
  try {
    const row = db.prepare('SELECT * FROM credentials').get() as EncryptedCredential
    expect(decryptCredential(row, key)).toEqual(plaintext)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(() => db.prepare('INSERT INTO credentials SELECT ?, ?, schema_version, key_id, nonce, ciphertext, authentication_tag, revision FROM credentials').run('other-id', 'missing-tool')).toThrow()
  } finally { db.close() }
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readFileSync(file).includes(plaintext)).toBe(false)
})

it.each(['ciphertext', 'id'] as const)('refuses startup after persisted %s corruption', field => {
  seed()
  const db = new Database(file)
  if (field === 'id') db.prepare('UPDATE credentials SET id = ?').run('moved-id')
  else db.prepare('UPDATE credentials SET ciphertext = ?').run(Buffer.from('CANARY-corrupt'))
  db.close()
  expect(() => openStore(file, provider)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
})

it('refuses startup with a different valid master key', () => {
  seed()
  const wrong = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

it('binds an unconfigured store to its creation key', () => {
  openStore(file, provider).close()
  const wrong = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
  openStore(file, provider).close()
})

it('refuses an unbound legacy store without key evidence and rolls back migration', () => {
  const db = openStore(file, provider)
  db.exec('DROP TABLE store_metadata; DELETE FROM migrations WHERE version = 6')
  db.close()
  expect(() => openStore(file, provider)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
  const unchanged = new Database(file)
  try {
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'store_metadata'").get()).toBeUndefined()
    expect(unchanged.prepare('SELECT version FROM migrations WHERE version = 6').get()).toBeUndefined()
  } finally { unchanged.close() }
})

it('binds a legacy store only after its credentials authenticate', () => {
  seed()
  const db = new Database(file)
  db.exec('DROP TABLE store_metadata; DELETE FROM migrations WHERE version = 6')
  db.close()
  const wrong = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  openStore(file, provider).close()
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

it('binds an empty legacy store to its latest rotation key', () => {
  const db = openStore(file, provider)
  db.prepare('INSERT INTO key_rotations (old_key_id, new_key_id) VALUES (?, ?)').run('synthetic-old-key', key.id)
  db.exec('DROP TABLE store_metadata; DELETE FROM migrations WHERE version = 6')
  db.close()
  const wrong = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
  openStore(file, provider).close()
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

it('rejects authenticated plaintext that is not credential JSON with a safe error', () => {
  seed()
  const db = openStore(file, provider)
  try {
    const store = createCredentialStore(db, provider)
    expect(() => store.readCredential({ id: 'synthetic-id', tool: 'falcon-axi' }))
      .toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  } finally { db.close() }
})

it('rolls back schema changes and version records when a migration fails', () => {
  writeFileSync(join(directory, '001-first.sql'), 'CREATE TABLE synthetic (id TEXT);')
  writeFileSync(join(directory, '002-failure.sql'), 'CREATE TABLE partial (id TEXT); INVALID SQL;')
  const db = new Database(file)
  try {
    expect(() => migrate(db, directory)).toThrow()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([])
    writeFileSync(join(directory, '002-failure.sql'), 'CREATE TABLE complete (id TEXT);')
    migrate(db, directory)
    migrate(db, directory)
    expect(db.prepare('SELECT version FROM migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }])
  } finally { db.close() }
})

it('reads raw key files before the environment fallback and hashes the full key', () => {
  const keyFile = join(directory, 'synthetic-key')
  writeFileSync(keyFile, bytes)
  const supplied = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY_FILE: keyFile, ARTIUM_AXI_MASTER_KEY: 'invalid' }).getKey()
  expect(supplied.bytes).toEqual(bytes)
  expect(supplied.id).toBe(createHash('sha256').update(bytes).digest('hex'))
})

it('reopens encrypted credentials using the owner-only key beside the database', () => {
  seed(Buffer.from('{"synthetic":true}'))
  saveMasterKey(file, key)
  expect(statSync(join(directory, '.env')).mode & 0o777).toBe(0o600)
  const saved = new EnvironmentKeyProvider({ ARTIUM_AXI_DATABASE_FILE: file })
  const db = openStore(file, saved)
  try {
    expect(createCredentialStore(db, saved).readCredential({ id: 'synthetic-id', tool: 'falcon-axi' }))
      .toEqual({ synthetic: true })
  } finally { db.close() }
})

it.each([
  ['single-line', 'SYNTHETIC_SETTING=retained\n', 'ARTIUM_AXI_MASTER_KEY=obsolete\n'],
  ['double-quoted', 'SYNTHETIC_NOTE="first\nARTIUM_AXI_MASTER_KEY=keep\nlast"\n', 'ARTIUM_AXI_MASTER_KEY="obsolete\nkey"\n'],
  ['single-quoted', "SYNTHETIC_NOTE='first\nexport ARTIUM_AXI_MASTER_KEY=keep\nlast'\n", "  export ARTIUM_AXI_MASTER_KEY = 'obsolete\nkey'\nARTIUM_AXI_MASTER_KEY=duplicate\n"],
  ['backtick-quoted with CRLF', 'SYNTHETIC_NOTE=`first\r\nARTIUM_AXI_MASTER_KEY=keep\r\nlast`\r\n', '\texport ARTIUM_AXI_MASTER_KEY = `obsolete\r\nkey`\r\n'],
  ['comments and unquoted values', '# SYNTHETIC_NOTE="\nSYNTHETIC_SETTING=retained # "\n# ARTIUM_AXI_MASTER_KEY=keep\n', 'ARTIUM_AXI_MASTER_KEY=obsolete # "\n'],
])('updates the saved key and permissions while preserving %s environment settings', (_name, unrelated, assignments) => {
  const envFile = join(directory, '.env')
  writeFileSync(envFile, `${assignments}${unrelated}`, { mode: 0o644 })
  saveMasterKey(file, key)
  expect(readFileSync(envFile, 'utf8')).toBe(`${unrelated}ARTIUM_AXI_MASTER_KEY=${bytes.toString('base64')}\n`)
  expect(parseEnv(readFileSync(envFile, 'utf8'))).toEqual({ ...parseEnv(unrelated), ARTIUM_AXI_MASTER_KEY: bytes.toString('base64') })
  expect(statSync(envFile).mode & 0o777).toBe(0o600)
  expect(new EnvironmentKeyProvider({ ARTIUM_AXI_DATABASE_FILE: file }).getKey().id).toBe(key.id)
})

it('keeps explicit key settings ahead of the saved key', () => {
  saveMasterKey(file, key)
  const explicit = Buffer.alloc(32, 2)
  expect(new EnvironmentKeyProvider({ ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY: explicit.toString('base64') }).getKey().bytes)
    .toEqual(explicit)
})

it('refuses a malformed saved key with the generic key error', () => {
  writeFileSync(join(directory, '.env'), 'ARTIUM_AXI_MASTER_KEY=invalid\n')
  expect(() => new EnvironmentKeyProvider({ ARTIUM_AXI_DATABASE_FILE: file }).getKey())
    .toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

it.each([undefined, '', 'invalid', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')])('refuses a missing or malformed environment key', encoded => {
  expect(() => openStore(file, new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: encoded }))).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

it.each([0, 31, 33])('refuses a %s-byte key file', length => {
  const keyFile = join(directory, 'synthetic-key')
  writeFileSync(keyFile, Buffer.alloc(length))
  expect(() => new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY_FILE: keyFile }).getKey()).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

it('reports an unreadable key file without exposing its path', () => {
  expect(() => new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY_FILE: join(directory, 'missing') }).getKey()).toThrow('The master key is missing or invalid.')
})
