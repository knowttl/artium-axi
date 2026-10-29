import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { decryptCredential, encryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { migrate, openStore } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'

let directory: string
let file: string
let db: Database.Database
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-auth-schema-'))
  file = join(directory, 'artium.db')
  db = openStore(file, provider)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function seedIdentity() {
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('person', 'synthetic', 'Synthetic', 'CANARY-hash');
    INSERT INTO users (id, username, display_name, password_hash) VALUES ('other', 'other', 'Other', 'CANARY-hash');
    INSERT INTO roles (id, name) VALUES ('reader', 'Reader');
    UPDATE tools SET pinned_version = 'synthetic-version' WHERE name = 'falcon-axi';
    INSERT INTO session_families (id, user_id, created_at, expires_at) VALUES ('family', 'person', 1000, 43201000);
  `)
}

it('migrates an empty store and persists the identity relationships on reopen', () => {
  seedIdentity()
  db.exec(`
    INSERT INTO role_tools (role_id, tool) VALUES ('reader', 'falcon-axi');
    INSERT INTO user_roles (user_id, role_id) VALUES ('person', 'reader');
    INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES ('CANARY-token-hash', 'refresh', 'family', 'person', 43201000);
    INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at)
      VALUES ('browser', 'family', 'person', 'CANARY-csrf', 1000, 1000, 43201000);
    INSERT INTO bootstrap_metadata (id, bootstrapped_at) VALUES (1, 1000);
    INSERT INTO recent_auth_tickets (family_id, hash, expires_at) VALUES ('family', 'CANARY-ticket-hash', 901000);
    INSERT INTO audit (occurred_at, event, user_id, tool, outcome) VALUES (1000, 'sign-in', 'person', 'falcon-axi', 'success');
    UPDATE users SET updated_at = 1000, updated_by = 'other' WHERE id = 'person';
  `)
  db.close()
  db = openStore(file, provider)
  expect(db.prepare('SELECT version FROM migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }, { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 }, { version: 22 }, { version: 23 }])
  expect(db.prepare(`SELECT tool FROM user_roles JOIN role_tools USING (role_id) WHERE user_id = 'person'`).all())
    .toEqual([{ tool: 'falcon-axi' }])
  expect(db.prepare('SELECT source, administrator, revision FROM users WHERE id = ?').get('person'))
    .toEqual({ source: 'local', administrator: 0, revision: 1 })
  expect(db.prepare('SELECT updated_at, updated_by FROM users WHERE id = ?').get('person'))
    .toEqual({ updated_at: 1000, updated_by: 'other' })
  expect(db.prepare('SELECT type FROM tokens').get()).toEqual({ type: 'refresh' })
  expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: 'browser' })
  expect(db.prepare('SELECT family_id, hash, expires_at FROM recent_auth_tickets').get())
    .toEqual({ family_id: 'family', hash: 'CANARY-ticket-hash', expires_at: 901000 })
  expect(db.prepare('SELECT bootstrapped_at FROM bootstrap_metadata').get()).toEqual({ bootstrapped_at: 1000 })
  expect(db.prepare('SELECT outcome FROM audit').get()).toEqual({ outcome: 'success' })
})

it('upgrades a Phase 2 store without changing its encrypted credential or tool settings', () => {
  db.close()
  rmSync(file)
  // A directory containing only the original migration reproduces the Phase 2 store.
  const priorFile = fileURLToPath(new URL('./migrations/001-credentials.sql', import.meta.url))
  copyFileSync(priorFile, join(directory, '001-credentials.sql'))
  db = new Database(file)
  migrate(db, directory)
  db.prepare('INSERT INTO tools (name, pinned_version, native_settings, revision) VALUES (?, ?, ?, ?)')
    .run('falcon-axi', 'synthetic-version', '{"synthetic":true}', 3)
  const row = encryptCredential('credential', 'falcon-axi', Buffer.from('CANARY-preserved'), provider.getKey())
  db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision)
    VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, 4)`).run(row)
  const previousCredential = db.prepare('SELECT * FROM credentials').get() as Record<string, unknown>
  const previousTool = db.prepare('SELECT * FROM tools').get() as Record<string, unknown>
  db.close()
  db = openStore(file, provider)
  expect(db.prepare('SELECT * FROM credentials').get()).toEqual({ ...previousCredential, updated_at: null, updated_by: null })
  expect(db.prepare("SELECT * FROM tools WHERE name = 'falcon-axi'").get()).toEqual({ ...previousTool, updated_at: null, updated_by: null })
  expect(decryptCredential(db.prepare('SELECT * FROM credentials').get() as EncryptedCredential, provider.getKey()))
    .toEqual(Buffer.from('CANARY-preserved'))
  db.prepare('INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)')
    .run('person', 'synthetic', 'Synthetic', 'CANARY-hash')
  expect(db.prepare('SELECT revision FROM users').get()).toEqual({ revision: 1 })
})

it('rejects duplicate canonical usernames while retaining separate display names', () => {
  seedIdentity()
  expect(() => db.prepare('INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)')
    .run('duplicate', 'synthetic', 'SYNTHETIC', 'CANARY-hash')).toThrow(/UNIQUE/)
  expect(db.prepare('SELECT display_name FROM users WHERE username = ?').get('synthetic')).toEqual({ display_name: 'Synthetic' })
})

it('keeps administrator capability separate from tool grants', () => {
  seedIdentity()
  db.exec("UPDATE users SET administrator = 1 WHERE id = 'other'; INSERT INTO user_roles (user_id, role_id) VALUES ('person', 'reader'); INSERT INTO role_tools VALUES ('reader', 'falcon-axi');")
  expect(db.prepare("SELECT administrator FROM users WHERE id = 'person'").get()).toEqual({ administrator: 0 })
  expect(db.prepare("SELECT tool FROM user_roles JOIN role_tools USING (role_id) WHERE user_id = 'other'").all()).toEqual([])
})

it.each([
  "INSERT INTO role_tools VALUES ('missing', 'falcon-axi')",
  "INSERT INTO role_tools VALUES ('reader', 'missing')",
  "INSERT INTO user_roles (user_id, role_id) VALUES ('missing', 'reader')",
  "INSERT INTO user_roles (user_id, role_id) VALUES ('person', 'missing')",
  "INSERT INTO session_families (id, user_id, created_at, expires_at) VALUES ('missing', 'missing', 1000, 2000)",
  "INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES ('hash', 'access', 'missing', 'person', 2000)",
  "INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES ('hash', 'access', 'family', 'other', 2000)",
  "INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES ('browser', 'missing', 'person', 'CANARY', 1000, 1000, 2000)",
  "INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES ('browser', 'family', 'other', 'CANARY', 1000, 1000, 2000)",
  "INSERT INTO audit (occurred_at, event, user_id, outcome) VALUES (1000, 'sign-in', 'missing', 'denied')",
  "INSERT INTO audit (occurred_at, event, tool, outcome) VALUES (1000, 'run', 'missing', 'denied')",
])('enforces foreign keys for %s', sql => {
  seedIdentity()
  expect(() => db.exec(sql)).toThrow(/FOREIGN KEY/)
})

it.each(['access', 'refresh', 'password-change'])('stores the distinct %s token type', type => {
  seedIdentity()
  db.prepare('INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run('CANARY-hash', type, 'family', 'person', 2000)
  expect(db.prepare('SELECT type FROM tokens').get()).toEqual({ type })
})

it.each([
  "UPDATE users SET source = 'directory'",
  'UPDATE users SET revision = 0',
  'UPDATE roles SET revision = 0',
  'UPDATE users SET administrator = 2',
  "INSERT INTO tokens (hash, type, family_id, user_id, expires_at) VALUES ('hash', 'administrator', 'family', 'person', 2000)",
  'INSERT INTO bootstrap_metadata (id, bootstrapped_at) VALUES (2, 1000)',
])('rejects invalid stored state for %s', sql => {
  seedIdentity()
  expect(() => db.exec(sql)).toThrow(/CHECK/)
})
