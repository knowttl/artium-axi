import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { backupStore, restoreStore } from './backup.js'
import { createCredentialStore, migrate, openStore } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import { acquireMaintenanceLock } from './maintenance-lock.js'
import { issueLoginTokens, issueRecentAuthTicket, logout, refreshTokens, verifyAccessToken, verifyPasswordToken } from '../auth/tokens.js'
import { createBrowserSession, readBrowserSession } from '../auth/sessions.js'
import { Audit } from '../audit/audit.js'
import { build } from 'esbuild'

let directory: string
let file: string
let output: string
let restored: string
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-backup-'))
  file = join(directory, 'source', 'artium.db')
  output = join(directory, 'backup.db')
  restored = join(directory, 'new-volume', 'artium.db')
  const db = openStore(file, provider)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change, administrator)
    VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'synthetic-hash', 0, 1);
    INSERT INTO bootstrap_metadata VALUES (1, 1);
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles VALUES ('synthetic-user', 'synthetic-role');
    INSERT INTO role_tools VALUES ('synthetic-role', 'falcon-axi');`)
  createCredentialStore(db, provider).replaceCredential('falcon-axi', { secret: 'CANARY-backup' }, 0, 'synthetic-user', 1)
  db.close()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

test('online backup stays consistent while the live owner commits paired changes', async () => {
  const release = acquireMaintenanceLock(file)
  const writer = openStore(file, provider)
  try {
    const insert = writer.prepare("INSERT INTO audit (occurred_at, event, outcome, arguments) VALUES (1, 'synthetic', 'success', ?)")
    writer.transaction(() => { for (let index = 0; index < 500; index++) insert.run('x'.repeat(4096)) })()
    let completed = false
    let concurrentWrites = 0
    const backup = backupStore(file, output, provider).then(receipt => { completed = true; return receipt })
    for (let index = 0; index < 10; index++) {
      await setImmediate()
      writer.transaction(() => {
        writer.exec("UPDATE tools SET revision = revision + 1 WHERE name = 'falcon-axi'; UPDATE credentials SET revision = revision + 1 WHERE tool = 'falcon-axi'")
      })()
      if (!completed) concurrentWrites++
    }
    expect(await backup).toEqual({ key_id: provider.getKey().id })
    expect(concurrentWrites).toBeGreaterThan(0)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    const snapshot = new Database(output, { readonly: true })
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(snapshot.pragma('foreign_key_check')).toEqual([])
      expect(snapshot.prepare("SELECT revision FROM credentials WHERE tool = 'falcon-axi'").get())
        .toEqual(snapshot.prepare("SELECT revision FROM tools WHERE name = 'falcon-axi'").get())
      expect(snapshot.prepare('SELECT count(*) AS count FROM audit').get()).toEqual({ count: 500 })
    } finally { snapshot.close() }
  } finally { writer.close(); release() }
})

test('restore preserves credentials, roles and audit while invalidating every saved login proof', async () => {
  const source = openStore(file, provider)
  const pair = issueLoginTokens(source, 'synthetic-user')
  if (pair.status !== 'authenticated') throw new Error('Expected ordinary login')
  const browser = createBrowserSession(source, 'synthetic-user', 'synthetic-csrf')
  issueRecentAuthTicket(source, pair.accessToken)
  source.exec("UPDATE users SET must_change = 1 WHERE id = 'synthetic-user'")
  const temporary = issueLoginTokens(source, 'synthetic-user')
  if (temporary.status !== 'password-change-required') throw new Error('Expected temporary login')
  await backupStore(file, output, provider)
  const audit = new Audit(source, Date.now, () => {})
  logout(source, pair.accessToken, audit, { requestId: 'synthetic-request', clientAddress: '127.0.0.1' })
  source.close()
  expect(restoreStore(output, restored, provider)).toEqual({ key_id: provider.getKey().id })
  const db = openStore(restored, provider)
  try {
    expect(() => verifyAccessToken(db, pair.accessToken)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
    expect(() => refreshTokens(db, pair.refreshToken, new Audit(db, Date.now, () => {}), { requestId: 'synthetic', clientAddress: '127.0.0.1' }))
      .toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
    expect(() => verifyPasswordToken(db, temporary.passwordChangeToken)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
    expect(() => readBrowserSession(db, browser.id)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
    expect(db.prepare('SELECT count(*) AS count FROM recent_auth_tickets').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT role_id, tool FROM role_tools').all()).toEqual([{ role_id: 'synthetic-role', tool: 'falcon-axi' }])
    const store = createCredentialStore(db, provider)
    expect(store.readCredential(store.findCredential('falcon-axi')!)).toEqual({ secret: 'CANARY-backup' })
    db.exec('UPDATE users SET must_change = 0')
    const fresh = issueLoginTokens(db, 'synthetic-user')
    if (fresh.status !== 'authenticated') throw new Error('Expected fresh login')
    expect(verifyAccessToken(db, fresh.accessToken)).toBe('synthetic-user')
  } finally { db.close() }
})

test('backup refuses to replace an existing destination', async () => {
  writeFileSync(output, 'sentinel')
  await expect(backupStore(file, output, provider)).rejects.toMatchObject({ code: 'BACKUP_FAILED' })
  expect(readFileSync(output, 'utf8')).toBe('sentinel')
})

test.each(['key', 'credential', 'schema', 'missing-table', 'foreign-key', 'corrupt-file'])('restore rejects %s failure without publishing a database', async failure => {
  await backupStore(file, output, provider)
  let supplied = provider
  if (failure === 'key') supplied = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') })
  else if (failure === 'corrupt-file') writeFileSync(output, 'not sqlite')
  else {
    const db = new Database(output)
    if (failure === 'credential') db.exec("UPDATE credentials SET ciphertext = x'00'")
    if (failure === 'schema') db.exec('INSERT INTO migrations VALUES (999)')
    if (failure === 'missing-table') db.exec('DROP TABLE audit')
    if (failure === 'foreign-key') {
      db.pragma('foreign_keys = OFF')
      db.exec("INSERT INTO user_roles VALUES ('missing-user', 'synthetic-role')")
    }
    db.close()
  }
  expect(() => restoreStore(output, restored, supplied)).toThrow()
  expect(existsSync(restored)).toBe(false)
})

test('restore refuses a running destination and an existing data volume', async () => {
  await backupStore(file, output, provider)
  const release = acquireMaintenanceLock(restored)
  try { expect(() => restoreStore(output, restored, provider)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_BUSY' })) }
  finally { release() }
  writeFileSync(join(directory, 'new-volume', 'existing-data'), 'sentinel')
  expect(() => restoreStore(output, restored, provider)).toThrow(expect.objectContaining({ code: 'RESTORE_FAILED' }))
  expect(readFileSync(join(directory, 'new-volume', 'existing-data'), 'utf8')).toBe('sentinel')
})

test('migration rehearsal changes only a copy and rollback restores the pre-upgrade schema', async () => {
  const source = openStore(file, provider)
  const { version } = source.prepare('SELECT max(version) AS version FROM migrations').get() as { version: number }
  source.close()
  await backupStore(file, output, provider)
  restoreStore(output, restored, provider)
  const migrations = join(directory, 'candidate-migrations')
  cpSync('src/server/store/migrations', migrations, { recursive: true })
  writeFileSync(join(migrations, `${String(version + 1).padStart(3, '0')}-synthetic-upgrade.sql`), 'ALTER TABLE roles ADD COLUMN synthetic_upgrade TEXT;')
  const candidate = new Database(restored)
  migrate(candidate, migrations)
  expect(candidate.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version: version + 1 })
  candidate.close()
  expect(() => openStore(restored, provider)).toThrow(expect.objectContaining({ code: 'STORE_SCHEMA_INVALID' }))
  const rollback = join(directory, 'rollback-volume', 'artium.db')
  restoreStore(output, rollback, provider)
  const old = openStore(rollback, provider)
  try {
    expect(old.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version })
    expect(() => old.prepare('SELECT synthetic_upgrade FROM roles')).toThrow()
    expect(old.prepare('SELECT name FROM roles').all()).toEqual([{ name: 'Synthetic Role' }])
  } finally { old.close() }
  const unchanged = openStore(file, provider)
  try { expect(unchanged.prepare('SELECT max(version) AS version FROM migrations').get()).toEqual({ version }) }
  finally { unchanged.close() }
})

test('public maintenance CLI backs up and restores with safe receipts and rejects unknown flags', async () => {
  const entry = join(directory, 'maintenance.mjs')
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  cpSync('src/server/store/migrations', join(directory, 'migrations'), { recursive: true })
  await build({ stdin: { contents: "import './src/server/maintenance.ts'", resolveDir: process.cwd() }, outfile: entry,
    bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const env = { ...process.env, ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY_FILE: '', ARTIUM_AXI_MASTER_KEY: provider.getKey().bytes.toString('base64') }
  const backup = spawnSync(process.execPath, [entry, 'backup', '--out', output], { env, encoding: 'utf8' })
  expect(backup.status).toBe(0)
  expect(backup.stdout).toContain(provider.getKey().id)
  const restore = spawnSync(process.execPath, [entry, 'restore', '--from', output], { env: { ...env, ARTIUM_AXI_DATABASE_FILE: restored }, encoding: 'utf8' })
  expect(restore.status).toBe(0)
  expect(restore.stdout).toContain('Every user must sign in again')
  const invalid = spawnSync(process.execPath, [entry, 'backup', '--unknown', output], { env, encoding: 'utf8' })
  expect(invalid.status).toBe(2)
  expect(invalid.stdout).toContain('INVALID_INPUT')
})
