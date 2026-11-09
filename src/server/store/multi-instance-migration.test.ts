import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { encryptCredential } from './crypto.js'
import { createCredentialStore, migrate, openStore, validateSchema } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'

const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
let directory: string
let file: string
let db: Database.Database

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-multi-instance-migration-'))
  const previous = join(directory, 'migrations')
  mkdirSync(previous)
  for (const name of readdirSync('src/server/store/migrations').filter(name => Number(name.split('-')[0]) < 32)) {
    copyFileSync(join('src/server/store/migrations', name), join(previous, name))
  }
  file = join(directory, 'populated.db')
  db = new Database(file)
  db.pragma('foreign_keys = ON')
  migrate(db, previous)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'unusable');
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO tools (name, pinned_version) VALUES ('falcon-axi', 'synthetic-version'), ('vectra-axi', 'synthetic-version');
    INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'falcon-axi');`)
  for (const tool of ['falcon-axi', 'vectra-axi']) {
    const row = encryptCredential(`${tool}-id`, tool, Buffer.from(JSON.stringify({ secret: `CANARY-${tool}` })), provider.getKey())
    db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision, updated_at, updated_by)
      VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, 3, 1000, 'synthetic-user')`).run(row)
  }
  db.exec(`INSERT INTO tool_health VALUES ('falcon-axi', 3, 2000, 'error', 'SYNTHETIC_FAILURE');
    INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
      VALUES ('synthetic-trust', 'falcon-axi-id', 'https://synthetic.invalid', 'ca-fingerprint', 'leaf-fingerprint', 'ca-pem', 'leaf-pem', 'ca', 1000, 'synthetic-user');
    INSERT INTO audit (occurred_at, event, tool, outcome, request_id) VALUES (1000, 'run-terminal', 'falcon-axi', 'completed', 'synthetic-request');`)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('upgrade keeps each credential id, revision and ciphertext readable as the default instance', () => {
  migrate(db)
  validateSchema(db)
  db.close()
  db = openStore(file, provider)
  expect(db.prepare('SELECT id, tool, name, description, enabled, read_only, revision, updated_by FROM credentials ORDER BY tool').all()).toEqual([
    { id: 'falcon-axi-id', tool: 'falcon-axi', name: 'default', description: '', enabled: 1, read_only: 0, revision: 3, updated_by: 'synthetic-user' },
    { id: 'vectra-axi-id', tool: 'vectra-axi', name: 'default', description: '', enabled: 1, read_only: 0, revision: 3, updated_by: 'synthetic-user' },
  ])
  const store = createCredentialStore(db, provider)
  expect(store.readCredential(store.findCredential('vectra-axi')!)).toEqual({ secret: 'CANARY-vectra-axi' })
  expect(store.replaceCredential('vectra-axi', { secret: 'CANARY-replaced' }, 3, 'synthetic-user', 3000)).toEqual({ id: 'vectra-axi-id', tool: 'vectra-axi', revision: 4 })
})

test('upgrade keeps certificate trust, health and role grants attached and leaves audit attribution empty', () => {
  migrate(db)
  expect(db.prepare('SELECT credential_id, tool, credential_revision, checked_at, status, error_code FROM tool_health').all())
    .toEqual([{ credential_id: 'falcon-axi-id', tool: 'falcon-axi', credential_revision: 3, checked_at: 2000, status: 'error', error_code: 'SYNTHETIC_FAILURE' }])
  expect(db.prepare('SELECT credential_id FROM trusted_certificates').all()).toEqual([{ credential_id: 'falcon-axi-id' }])
  expect(db.prepare('SELECT role_id, tool, all_instances FROM role_tools').all()).toEqual([{ role_id: 'synthetic-role', tool: 'falcon-axi', all_instances: 1 }])
  expect(db.prepare('SELECT tool, credential_id, instance FROM audit').all()).toEqual([{ tool: 'falcon-axi', credential_id: null, instance: null }])
})

test('a tool can hold several named credentials but never two with the same name', () => {
  migrate(db)
  const insert = db.prepare(`INSERT INTO credentials (id, tool, name, schema_version, key_id, nonce, ciphertext, authentication_tag)
    SELECT ?, tool, ?, schema_version, key_id, nonce, ciphertext, authentication_tag FROM credentials WHERE id = 'falcon-axi-id'`)
  insert.run('falcon-axi-lab', 'lab')
  expect(() => insert.run('falcon-axi-duplicate', 'lab')).toThrow(/UNIQUE/)
})
