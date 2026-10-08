import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { decryptCredential, encryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { createCredentialStore, migrate, openStore } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'

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
  expect(() => openStore(file, wrong)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
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
