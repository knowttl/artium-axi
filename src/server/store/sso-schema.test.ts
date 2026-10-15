import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { seedToolUser } from '../../../test/fixtures/tokens.js'
import { createBrowserSession, readBrowserSession } from '../auth/sessions.js'
import { checkToolPolicy } from '../policy/policy.js'
import { createCredentialStore, migrate, openStore, validateSchema } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import { toolSchema } from '../../shared/api.js'

let directory: string
let db: Database.Database
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-sso-schema-'))
  db = openStore(join(directory, 'current.db'), provider)
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function seedSso() {
  db.exec(`
    INSERT INTO users (id, username, display_name, source, must_change)
      VALUES ('person', 'synthetic-sso', 'Synthetic SSO', 'sso', 0);
    INSERT INTO sso_providers (id, name, kind, issuer)
      VALUES ('provider', 'Synthetic provider', 'entra', 'https://identity.example');
    INSERT INTO roles (id, name) VALUES ('reader', 'Reader'), ('other', 'Other');
    INSERT INTO role_rules (id, provider_id, claim, value, role_id)
      VALUES ('rule', 'provider', 'roles', 'Artium.Reader', 'reader');
  `)
}

test('upgrades a copy of a populated pre-SSO store atomically and safely reruns', async () => {
  const previousMigrations = join(directory, 'migrations')
  mkdirSync(previousMigrations)
  for (const file of readdirSync('src/server/store/migrations').filter(file => Number(file.split('-')[0]) <= 12)) {
    copyFileSync(join('src/server/store/migrations', file), join(previousMigrations, file))
  }
  const originalFile = join(directory, 'populated.db')
  const original = new Database(originalFile)
  original.pragma('foreign_keys = ON')
  try {
    migrate(original, previousMigrations)
    original.prepare('INSERT INTO store_metadata VALUES (1, ?)').run(provider.getKey().id)
    const insertTool = original.prepare("INSERT INTO tools (name, enabled, pinned_version) VALUES (?, 1, 'synthetic-version')")
    for (const tool of toolSchema.options) insertTool.run(tool)
    await seedToolUser(original)
    original.exec(`UPDATE users SET administrator = 1, updated_at = 1000, updated_by = id;
      UPDATE roles SET updated_at = 1000, updated_by = 'synthetic-development-user';
      UPDATE tools SET updated_by = 'synthetic-development-user';
      INSERT INTO bootstrap_metadata VALUES (1, 1000);
      INSERT INTO tool_health VALUES ('falcon-axi', 1, 1000, 'ok', NULL);`)
    const credential = createCredentialStore(original, provider)
    credential.replaceCredential('falcon-axi', { clientSecret: 'CANARY-preserved' }, 0, 'synthetic-development-user', 1000)
    const session = createBrowserSession(original, 'synthetic-development-user', 'CANARY-csrf')
    original.exec(`INSERT INTO tokens (hash, type, family_id, user_id, expires_at)
      SELECT 'CANARY-refresh-hash', 'refresh', id, user_id, expires_at FROM session_families;
      INSERT INTO recent_auth_tickets SELECT id, 'CANARY-ticket-hash', expires_at FROM session_families;`)
    original.exec(`INSERT INTO audit (occurred_at, event, user_id, outcome, request_id)
      VALUES (1000, 'sign-in', 'synthetic-development-user', 'success', 'synthetic-request')`)
    const tables = ['users', 'roles', 'role_tools', 'tools', 'credentials', 'tool_health', 'session_families',
      'tokens', 'sessions', 'bootstrap_metadata', 'recent_auth_tickets', 'audit', 'store_metadata', 'key_rotations']
    const snapshot = (connection: Database.Database) => Object.fromEntries(tables.map(table =>
      [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    const previous = snapshot(original)
    const copy = join(directory, 'copy.db')
    await original.backup(copy)
    const wrongKey = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
    expect(() => openStore(copy, wrongKey)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
    const refused = new Database(copy)
    try {
      expect(refused.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version: 12 })
      expect(snapshot(refused)).toEqual(previous)
    } finally { refused.close() }
    db.close()
    db = openStore(copy, provider)
    expect(snapshot(db)).toMatchObject(previous)
    expect(db.prepare('SELECT break_glass FROM users').all()).toEqual([{ break_glass: 0 }])
    expect(db.prepare('SELECT authentication_method, provider_id, subject FROM audit').get())
      .toEqual({ authentication_method: null, provider_id: null, subject: null })
    expect(db.prepare('SELECT user_id, role_id, origin FROM user_roles').all())
      .toEqual([{ user_id: 'synthetic-development-user', role_id: 'synthetic-role', origin: 'direct' }])
    expect(readBrowserSession(db, session.id).user_id).toBe('synthetic-development-user')
    expect(() => checkToolPolicy(db, 'synthetic-development-user', 'falcon-axi')).not.toThrow()
    const migrated = createCredentialStore(db, provider)
    expect(migrated.readCredential(migrated.findCredential('falcon-axi')!)).toEqual({ clientSecret: 'CANARY-preserved' })
    expect(() => db.exec('UPDATE users SET disabled = 1')).toThrow('LAST_ADMINISTRATOR')
    expect(() => db.exec('DELETE FROM users')).toThrow('LAST_ADMINISTRATOR')
    migrate(db)
    validateSchema(db)
    expect(snapshot(db)).toMatchObject(previous)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(snapshot(original)).toEqual(previous)
    expect(original.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version: 12 })
  } finally { original.close() }
})

test('SSO accounts have no password and providers start disabled', () => {
  seedSso()
  expect(db.prepare('SELECT source, password_hash, must_change, administrator FROM users').get())
    .toEqual({ source: 'sso', password_hash: null, must_change: 0, administrator: 0 })
  expect(db.prepare('SELECT enabled FROM sso_providers').get()).toEqual({ enabled: 0 })
  expect(() => db.exec("UPDATE users SET password_hash = 'CANARY-hash'")).toThrow(/CHECK/)
  expect(() => db.exec('UPDATE users SET must_change = 1')).toThrow(/CHECK/)
  expect(() => db.exec("UPDATE users SET source = 'local'")).toThrow(/CHECK/)
})

test('identity binding is unique within a provider and issuer, independent of display username', () => {
  seedSso()
  db.exec(`INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at) VALUES ('identity', 'person', 'provider', 'https://identity.example', '["synthetic-tenant","synthetic-object"]', 1000);
    UPDATE users SET username = 'renamed-sso' WHERE id = 'person';`)
  expect(db.prepare('SELECT subject FROM identities WHERE user_id = ?').get('person'))
    .toEqual({ subject: '["synthetic-tenant","synthetic-object"]' })
  expect(() => db.exec(`INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at) SELECT 'duplicate', user_id, provider_id, issuer, subject, created_at FROM identities`)).toThrow(/UNIQUE/)
  expect(() => db.exec("UPDATE identities SET user_id = 'missing'")).toThrow(/FOREIGN KEY/)
  expect(() => db.exec("UPDATE identities SET provider_id = 'missing'")).toThrow(/FOREIGN KEY/)
})

test('direct and rule grants coexist and rule grants must match their rule role', () => {
  seedSso()
  db.exec(`INSERT INTO user_roles (user_id, role_id) VALUES ('person', 'reader');
    INSERT INTO user_roles (user_id, role_id, origin) VALUES ('person', 'reader', 'rule');`)
  expect(db.prepare('SELECT origin FROM user_roles ORDER BY origin').all()).toEqual([{ origin: 'direct' }, { origin: 'rule' }])
  expect(() => db.exec("INSERT INTO user_roles (user_id, role_id, origin) VALUES ('person', 'other', 'rule')")).toThrow(/FOREIGN KEY/)
  expect(() => db.exec("UPDATE user_roles SET origin = 'missing' WHERE origin = 'rule'")).toThrow(/FOREIGN KEY/)
  expect(() => db.exec('DELETE FROM role_rules')).toThrow(/FOREIGN KEY/)
  expect(() => db.exec("UPDATE role_rules SET role_id = 'other'")).toThrow(/FOREIGN KEY/)
})

test('invitations persist hashed tokens, provider and direct role references with expiry', () => {
  seedSso()
  db.exec(`INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, user_id, created_at, created_by, expires_at)
    VALUES ('invite', 'CANARY-token-hash', 'provider', 'synthetic-sso', 'Synthetic SSO', 'person', 1000, 'person', 2000);
    INSERT INTO invitation_roles VALUES ('invite', 'reader');`)
  expect(db.prepare('SELECT claimed_at, revoked_at, revision FROM invitations').get())
    .toEqual({ claimed_at: null, revoked_at: null, revision: 1 })
  expect(() => db.exec('UPDATE invitations SET expires_at = created_at')).toThrow(/CHECK/)
  expect(() => db.exec("UPDATE invitations SET provider_id = 'missing'")).toThrow(/FOREIGN KEY/)
  expect(() => db.exec("UPDATE invitation_roles SET role_id = 'missing'")).toThrow(/FOREIGN KEY/)
})
