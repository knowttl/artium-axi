import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { encryptCredential } from './crypto.js'
import { createCredentialStore, openStore } from './db.js'
import { EnvironmentKeyProvider } from './key-provider.js'
import { acquireMaintenanceLock } from './maintenance-lock.js'
import { rotateKey } from './rotate-key.js'

let directory: string
let file: string
let newFile: string
const oldProvider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const newProvider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-rotation-'))
  file = join(directory, 'artium.db')
  newFile = join(directory, 'new-key')
  writeFileSync(newFile, newProvider.getKey().bytes)
  const db = openStore(file, oldProvider)
  for (const tool of ['az-axi', 'falcon-axi', 'vectra-axi']) {
    const row = encryptCredential(tool, tool, Buffer.from(JSON.stringify({ secret: `CANARY-${tool}` })), oldProvider.getKey())
    db.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag)
      VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag)`).run(row)
  }
  db.close()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

test('rotation preserves credential identities and revisions and durably records only key IDs', () => {
  const receipt = rotateKey(file, oldProvider, newProvider)
  expect(receipt).toEqual({ old_key_id: oldProvider.getKey().id, new_key_id: newProvider.getKey().id })
  const db = openStore(file, newProvider)
  try {
    const store = createCredentialStore(db, newProvider)
    expect(store.findCredential('falcon-axi')).toEqual({ id: 'falcon-axi', tool: 'falcon-axi', revision: 1 })
    expect(store.readCredential(store.findCredential('falcon-axi')!)).toEqual({ secret: 'CANARY-falcon-axi' })
    expect(db.prepare('SELECT * FROM key_rotations').all()).toEqual([receipt])
    expect(db.prepare("SELECT action, target_id, outcome FROM audit WHERE action = 'rotate-key'").all())
      .toEqual([{ action: 'rotate-key', target_id: newProvider.getKey().id, outcome: 'success' }])
  } finally { db.close() }
  expect(() => openStore(file, oldProvider)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID',
    next: `Restart with the master key whose SHA-256 ID is ${newProvider.getKey().id}.` }))
})

test.each(['credential-update', 'metadata', 'receipt', 'audit'])('failure at %s rolls back all rows and the receipt', boundary => {
  const db = openStore(file, oldProvider)
  const rows = db.prepare('SELECT * FROM credentials ORDER BY id').all()
  const trigger = boundary === 'credential-update'
    ? "BEFORE UPDATE ON credentials WHEN OLD.tool = 'vectra-axi'"
    : boundary === 'metadata' ? 'BEFORE UPDATE ON store_metadata'
    : boundary === 'receipt' ? 'BEFORE INSERT ON key_rotations' : "BEFORE INSERT ON audit WHEN NEW.action = 'rotate-key'"
  db.exec(`CREATE TRIGGER synthetic_failure ${trigger} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
  db.close()
  expect(() => rotateKey(file, oldProvider, newProvider)).toThrow()
  const reopened = openStore(file, oldProvider)
  try {
    expect(reopened.prepare('SELECT * FROM credentials ORDER BY id').all()).toEqual(rows)
    expect(reopened.prepare('SELECT * FROM key_rotations').all()).toEqual([])
    expect(reopened.prepare("SELECT * FROM audit WHERE action = 'rotate-key'").all()).toEqual([])
  } finally { reopened.close() }
})

test('an empty rotated store still rejects the old key', () => {
  const db = openStore(file, oldProvider)
  db.exec('DELETE FROM credentials')
  db.close()
  rotateKey(file, oldProvider, newProvider)
  expect(() => openStore(file, oldProvider)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
  openStore(file, newProvider).close()
})

test('using the old key as the new key fails without changing the store', () => {
  expect(() => rotateKey(file, oldProvider, oldProvider)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
  openStore(file, oldProvider).close()
})

test('maintenance excludes another owner until release', () => {
  const release = acquireMaintenanceLock(file)
  try {
    expect(() => rotateKey(file, oldProvider, newProvider)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_BUSY' }))
    expect(() => acquireMaintenanceLock(file)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_BUSY' }))
  } finally { release() }
  rotateKey(file, oldProvider, newProvider)
})

async function bundle(contents: string, name: string) {
  const entry = join(directory, `${name}.mjs`)
  if (name === 'maintenance') {
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
    cpSync('src/server/store/migrations', join(directory, 'migrations'), { recursive: true })
  }
  await build({ stdin: { contents, resolveDir: process.cwd() }, outfile: entry,
    bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  return entry
}

test('the maintenance command validates usage and rotates without development authentication', async () => {
  const entry = await bundle("import './src/server/maintenance.ts'", 'maintenance')
  const env = { ...process.env, ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY_FILE: '',
    ARTIUM_AXI_MASTER_KEY: oldProvider.getKey().bytes.toString('base64'), ARTIUM_AXI_DEV: '0', ARTIUM_AXI_AUDIT_STDOUT: '0' }
  const help = spawnSync(process.execPath, [entry, 'rotate-key', '--help'], { env, encoding: 'utf8' })
  expect(help.status).toBe(0)
  expect(help.stdout).toContain('--new-key-file')
  const usage = spawnSync(process.execPath, [entry, 'rotate-key', '--unknown'], { env, encoding: 'utf8' })
  expect(usage.status).toBe(2)
  expect(usage.stdout).toContain('INVALID_INPUT')
  const result = spawnSync(process.execPath, [entry, 'rotate-key', '--new-key-file', newFile], { env, encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain(newProvider.getKey().id)
  expect(result.stdout).toContain('Switch the mounted startup key')
  openStore(file, newProvider).close()
})

test('a process crash after commit and before receipt output recovers with the new key', async () => {
  const entry = await bundle(`
    process.stdout.write = () => { process.kill(process.pid, 'SIGKILL'); return true };
    await import('./src/server/maintenance.ts');
  `, 'maintenance')
  const result = spawnSync(process.execPath, [entry, 'rotate-key', '--new-key-file', newFile], {
    env: { ...process.env, ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY_FILE: '',
      ARTIUM_AXI_MASTER_KEY: oldProvider.getKey().bytes.toString('base64'), ARTIUM_AXI_AUDIT_STDOUT: '1' }, encoding: 'utf8',
  })
  expect(result.signal).toBe('SIGKILL')
  expect(result.stdout).toBe('')
  const db = openStore(file, newProvider)
  try { expect(db.prepare('SELECT new_key_id FROM key_rotations').get()).toEqual({ new_key_id: newProvider.getKey().id }) }
  finally { db.close() }
  expect(() => openStore(file, oldProvider)).toThrow(expect.objectContaining({ code: 'MASTER_KEY_INVALID' }))
  const release = acquireMaintenanceLock(file)
  release()
})

test('a running real server blocks rotation and releases maintenance after a crash', async () => {
  const seeded = openStore(file, oldProvider)
  seeded.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator)
    VALUES ('synthetic-admin', 'synthetic-admin', 'Synthetic Admin', 'unusable', 1);
    INSERT INTO bootstrap_metadata VALUES (1, 1)`)
  seeded.close()
  await bundle("import './src/server/maintenance.ts'", 'maintenance')
  const tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'CANARY-development-token', { mode: 0o600 })
  const entry = await bundle(`
    import { Server } from 'node:net';
    import { serverDefaults } from './src/server/config.ts';
    Object.assign(serverDefaults, { host: '127.0.0.1', port: 0, temporaryDirectory: ${JSON.stringify(join(directory, 'calls'))} });
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => process.stdout.write(JSON.stringify(this.address()) + '\\n'));
      return listen.apply(this, args);
    };
    await import('./src/server/main.ts');
  `, 'server')
  const environment = { ...process.env, ARTIUM_AXI_DEV: '1',
    ARTIUM_AXI_DEV_TOKEN_FILE: tokenFile, ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY_FILE: '',
    ARTIUM_AXI_MASTER_KEY: oldProvider.getKey().bytes.toString('base64'), ARTIUM_AXI_AUDIT_STDOUT: '0' }
  const release = acquireMaintenanceLock(file)
  try {
    const refused = spawnSync(process.execPath, [entry], { env: environment, encoding: 'utf8', timeout: 10_000 })
    expect(refused.status).toBe(1)
    expect(JSON.parse(refused.stderr).error.code).toBe('MAINTENANCE_BUSY')
  } finally { release() }
  const child = spawn(process.execPath, [entry], { env: environment })
  const closed = once(child, 'close')
  try {
    const ready = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('server exited before listening') })])
    const address = JSON.parse(ready[0].toString())
    expect((await fetch(`http://127.0.0.1:${address.port}/health/ready`)).status).toBe(200)
    expect(() => rotateKey(file, oldProvider, newProvider)).toThrow(expect.objectContaining({ code: 'MAINTENANCE_BUSY' }))
  } finally { child.kill('SIGKILL'); await closed }
  rotateKey(file, oldProvider, newProvider)
})
