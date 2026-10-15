import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { seedToolUser } from '../../../test/fixtures/tokens.js'
import { backupStore, restoreStore } from './backup.js'
import { createCredentialStore, migrate, openStore, validateSchema } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import { ProviderCredentials } from './provider-credentials.js'
import { rotateKey } from './rotate-key.js'

let directory: string
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const replacementKey = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
const actor = 'synthetic-development-user'
const value = { clientSecret: 'CANARY-provider-secret' }

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'artium-provider-store-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function seedProvider(db: Database.Database) {
  db.prepare("INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('provider', 'Synthetic provider', 'entra', 'https://identity.example')").run()
}

test('migration upgrades a copy of populated P2a data without changing it and safely reruns', async () => {
  const migrations = join(directory, 'migrations')
  mkdirSync(migrations)
  for (const file of readdirSync('src/server/store/migrations').filter(file => Number(file.split('-')[0]) <= 13)) {
    copyFileSync(join('src/server/store/migrations', file), join(migrations, file))
  }
  const original = new Database(join(directory, 'original.db'))
  try {
    migrate(original, migrations)
    original.prepare('INSERT INTO store_metadata VALUES (1, ?)').run(key.getKey().id)
    original.exec("INSERT INTO tools (name, pinned_version) VALUES ('falcon-axi', 'synthetic')")
    await seedToolUser(original)
    seedProvider(original)
    original.exec(`INSERT INTO users (id, username, display_name, source, must_change) VALUES ('sso-person', 'synthetic-sso', 'SSO person', 'sso', 0);
      INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at) VALUES ('identity', 'sso-person', 'provider', 'https://identity.example', 'synthetic-subject', 1000);
      INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES ('rule', 'provider', 'roles', 'Reader', 'synthetic-role');
      INSERT INTO user_roles (user_id, role_id, origin) VALUES ('sso-person', 'synthetic-role', 'rule');
      INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, created_at, created_by, expires_at)
        VALUES ('invitation', 'CANARY-invitation-hash', 'provider', 'synthetic-invited', 'Invited', 1000, 'synthetic-development-user', 2000);`)
    createCredentialStore(original, key).replaceCredential('falcon-axi', { clientSecret: 'CANARY-tool-secret' }, 0, actor, 1000)
    const tables = ['users', 'identities', 'sso_providers', 'role_rules', 'user_roles', 'invitations', 'credentials']
    const snapshot = (db: Database.Database) => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = snapshot(original)
    const copy = join(directory, 'copy.db')
    await original.backup(copy)
    const upgraded = openStore(copy, key)
    try {
      expect(snapshot(upgraded)).toMatchObject(before)
      expect(upgraded.prepare('SELECT claim_values, claims_at FROM identities').get()).toEqual({ claim_values: '{"roles":[]}', claims_at: null })
      expect(upgraded.prepare('SELECT break_glass FROM users ORDER BY rowid').all())
        .toEqual([{ break_glass: 0 }, { break_glass: 0 }])
      new ProviderCredentials(upgraded, key).replace('provider', value, 0, actor, 2000)
      migrate(upgraded)
      validateSchema(upgraded)
      expect(snapshot(upgraded)).toMatchObject(before)
      expect(new ProviderCredentials(upgraded, key).read('provider')).toMatchObject({ value, revision: 1 })
      expect(upgraded.pragma('foreign_key_check')).toEqual([])
      expect(snapshot(original)).toEqual(before)
      expect(original.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version: 13 })
    } finally { upgraded.close() }
  } finally { original.close() }
})

test('provider credentials survive master key rotation and backup restoration', async () => {
  const file = join(directory, 'artium.db')
  const db = openStore(file, key)
  try {
    await seedToolUser(db)
    seedProvider(db)
    new ProviderCredentials(db, key).replace('provider', value, 0, actor, 1000)
  } finally { db.close() }
  rotateKey(file, key, replacementKey)
  await backupStore(file, join(directory, 'backup.db'), replacementKey)
  restoreStore(join(directory, 'backup.db'), join(directory, 'restored', 'artium.db'), replacementKey)
  const restored = openStore(join(directory, 'restored', 'artium.db'), replacementKey)
  try {
    expect(new ProviderCredentials(restored, replacementKey).read('provider')).toEqual({ value, revision: 1, updatedAt: 1000, updatedBy: actor })
  } finally { restored.close() }
  expect(() => openStore(file, key)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
})

test('named claim migration preserves saved claims and grants on a populated copy and safely reruns', async () => {
  const migrations = join(directory, 'migrations')
  mkdirSync(migrations)
  for (const file of readdirSync('src/server/store/migrations').filter(file => Number(file.split('-')[0]) <= 18)) {
    copyFileSync(join('src/server/store/migrations', file), join(migrations, file))
  }
  const original = new Database(join(directory, 'original.db'))
  try {
    migrate(original, migrations)
    original.prepare('INSERT INTO store_metadata VALUES (1, ?)').run(key.getKey().id)
    await seedToolUser(original)
    seedProvider(original)
    original.exec(`INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at, role_claims, claims_at)
      VALUES ('identity', 'synthetic-development-user', 'provider', 'https://identity.example', 'subject', 1000, '["Readers","Writers"]', 2000);
      INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES ('rule', 'provider', 'roles', 'Readers', 'synthetic-role');
      INSERT INTO user_roles (user_id, role_id, origin) VALUES ('synthetic-development-user', 'synthetic-role', 'rule');`)
    const rules = original.prepare('SELECT * FROM role_rules').all()
    const grants = original.prepare('SELECT * FROM user_roles').all()
    await original.backup(join(directory, 'copy.db'))
    const copy = openStore(join(directory, 'copy.db'), key)
    try {
      expect(copy.prepare('SELECT claim_values, claims_at FROM identities').get())
        .toEqual({ claim_values: '{"roles":["Readers","Writers"]}', claims_at: 2000 })
      migrate(copy)
      validateSchema(copy)
      expect(copy.prepare('SELECT * FROM role_rules').all()).toEqual(rules)
      expect(copy.prepare('SELECT * FROM user_roles').all()).toEqual(grants)
      expect(copy.pragma('foreign_key_check')).toEqual([])
      expect(original.prepare('SELECT role_claims, claims_at FROM identities').get())
        .toEqual({ role_claims: '["Readers","Writers"]', claims_at: 2000 })
    } finally { copy.close() }
  } finally { original.close() }
})

test('tampered provider credentials are refused at startup and backup validation', async () => {
  const file = join(directory, 'artium.db')
  const db = openStore(file, key)
  try {
    await seedToolUser(db)
    seedProvider(db)
    new ProviderCredentials(db, key).replace('provider', value, 0, actor, 1000)
    db.exec("UPDATE provider_credentials SET ciphertext = zeroblob(length(ciphertext))")
  } finally { db.close() }
  expect(() => openStore(file, key)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  await expect(backupStore(file, join(directory, 'backup.db'), key)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})
