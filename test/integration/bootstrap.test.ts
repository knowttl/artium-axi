import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { bootstrapAdministrator } from '../../src/server/auth/bootstrap.js'
import { developmentAuthentication } from '../../src/server/auth/development.js'
import { recoverAdministrator } from '../../src/server/auth/recover-admin.js'
import { LocalAuthProvider } from '../../src/server/auth/local.js'
import { verifyAccessToken } from '../../src/server/auth/tokens.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { acquireMaintenanceLock } from '../../src/server/store/maintenance-lock.js'
import { issueTestAccessToken } from '../fixtures/tokens.js'

let directory: string
let file: string
let passwordFile: string
const password = 'CANARY-bootstrap-password'
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const settings = () => ({ ARTIUM_AXI_ADMIN_USERNAME: ' Synthetic-Admin ', ARTIUM_AXI_ADMIN_PASSWORD_FILE: passwordFile })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-bootstrap-'))
  file = join(directory, 'data', 'artium.db')
  passwordFile = join(directory, 'password')
  writeFileSync(passwordFile, password, { mode: 0o600 })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

test('first start creates a canonical administrator with must-change and a durable marker, repeat ignores settings', async () => {
  const db = openStore(file, provider)
  await bootstrapAdministrator(db, settings())
  const user = db.prepare('SELECT * FROM users').get()
  expect(user).toMatchObject({ username: 'synthetic-admin', display_name: ' Synthetic-Admin ', administrator: 1, must_change: 1 })
  expect(await new LocalAuthProvider(db).signIn('synthetic-admin', password)).toMatchObject({ mustChange: true })
  expect(db.prepare('SELECT * FROM user_roles').all()).toEqual([])
  const marker = db.prepare('SELECT * FROM bootstrap_metadata').get()
  db.close()
  const reopened = openStore(file, provider)
  try {
    await bootstrapAdministrator(reopened, { ARTIUM_AXI_ADMIN_USERNAME: '', ARTIUM_AXI_ADMIN_PASSWORD_FILE: '/missing' })
    expect(reopened.prepare('SELECT * FROM users').all()).toEqual([user])
    expect(reopened.prepare('SELECT * FROM bootstrap_metadata').get()).toEqual(marker)
  } finally { reopened.close() }
})

test.each([
  "INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic', 'synthetic', 'Synthetic', 'unusable')",
  "INSERT INTO roles (id, name) VALUES ('synthetic', 'Synthetic')",
  "UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'",
  "INSERT INTO audit (occurred_at, event, outcome) VALUES (1, 'maintenance', 'success')",
])('missing marker with existing data refuses startup: %s', async sql => {
  const db = openStore(file, provider)
  try {
    db.exec(sql)
    await expect(bootstrapAdministrator(db, settings())).rejects.toMatchObject({ code: 'BOOTSTRAP_INCONSISTENT' })
    expect(db.prepare('SELECT * FROM bootstrap_metadata').all()).toEqual([])
  } finally { db.close() }
})

test.each(['user', 'marker'])('failure inserting %s rolls back administrator and marker together', async boundary => {
  const db = openStore(file, provider)
  db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${boundary === 'user' ? 'users' : 'bootstrap_metadata'}
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`)
  await expect(bootstrapAdministrator(db, settings())).rejects.toThrow('synthetic failure')
  db.close()
  const reopened = openStore(file, provider)
  try {
    expect(reopened.prepare('SELECT * FROM users').all()).toEqual([])
    expect(reopened.prepare('SELECT * FROM bootstrap_metadata').all()).toEqual([])
    reopened.exec('DROP TRIGGER synthetic_failure')
    await bootstrapAdministrator(reopened, settings())
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 })
  } finally { reopened.close() }
})

test.each([
  [{ ARTIUM_AXI_ADMIN_USERNAME: '' }, 'USERNAME_INVALID'],
  [{ ARTIUM_AXI_ADMIN_USERNAME: 'two names' }, 'USERNAME_INVALID'],
  [{ ARTIUM_AXI_ADMIN_USERNAME: 'synthetic-development-user' }, 'USERNAME_INVALID'],
  [{ ARTIUM_AXI_ADMIN_USERNAME: ' Synthetic-Development-User ' }, 'USERNAME_INVALID'],
  [{ ARTIUM_AXI_ADMIN_PASSWORD_FILE: '/missing' }, 'PASSWORD_FILE_INVALID'],
])('invalid first-start configuration fails without data: %j', async (override, code) => {
  const db = openStore(file, provider)
  try {
    await expect(bootstrapAdministrator(db, { ...settings(), ...override })).rejects.toMatchObject({ code })
    expect(db.prepare('SELECT * FROM users').all()).toEqual([])
    expect(db.prepare('SELECT * FROM bootstrap_metadata').all()).toEqual([])
  } finally { db.close() }
})

test.each(['short', 'passwordpassword'])('invalid bootstrap password %s leaves no marker', async value => {
  writeFileSync(passwordFile, value)
  const db = openStore(file, provider)
  try {
    await expect(bootstrapAdministrator(db, settings())).rejects.toMatchObject({ code: 'PASSWORD_INVALID' })
    expect(db.prepare('SELECT * FROM bootstrap_metadata').all()).toEqual([])
  } finally { db.close() }
})

test('malformed UTF-8 bootstrap password leaves no account or marker', async () => {
  writeFileSync(passwordFile, Buffer.concat([Buffer.from('CANARY-password-'), Buffer.from([0xe9])]))
  const db = openStore(file, provider)
  try {
    await expect(bootstrapAdministrator(db, settings())).rejects.toMatchObject({ code: 'PASSWORD_FILE_INVALID' })
    expect(db.prepare('SELECT * FROM users').all()).toEqual([])
    expect(db.prepare('SELECT * FROM bootstrap_metadata').all()).toEqual([])
  } finally { db.close() }
})

test('password files retain the leading BOM, spaces and Unicode', async () => {
  const exactPassword = '\ufeff CANARY-password-雪 '
  writeFileSync(passwordFile, exactPassword)
  const db = openStore(file, provider)
  try {
    await bootstrapAdministrator(db, settings())
    expect(await new LocalAuthProvider(db).signIn('synthetic-admin', exactPassword)).toMatchObject({ mustChange: true })
  } finally { db.close() }
  await recoverAdministrator(file, provider, 'synthetic-admin', passwordFile)
  const reopened = openStore(file, provider)
  try {
    expect(await new LocalAuthProvider(reopened).signIn('synthetic-admin', exactPassword)).toMatchObject({ mustChange: true })
  } finally { reopened.close() }
})

test.each(['UPDATE users SET disabled = 1', 'UPDATE users SET administrator = 0', 'DELETE FROM users'])
('last enabled administrator guard refuses %s and permits it after another administrator exists', async sql => {
  const db = openStore(file, provider)
  try {
    await bootstrapAdministrator(db, settings())
    expect(() => db.exec(sql)).toThrow('LAST_ADMINISTRATOR')
    db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator, disabled)
      VALUES ('synthetic-other', 'synthetic-other', 'Other', 'unusable', 1, 1)`)
    expect(() => db.exec(sql)).toThrow('LAST_ADMINISTRATOR')
    db.exec("UPDATE users SET disabled = 0 WHERE id = 'synthetic-other'")
    const id = (db.prepare("SELECT id FROM users WHERE username = 'synthetic-admin'").get() as { id: string }).id
    db.exec(`${sql} WHERE id = '${id}'`)
    expect(db.prepare('SELECT COUNT(*) AS count FROM users WHERE administrator = 1 AND disabled = 0').get()).toEqual({ count: 1 })
  } finally { db.close() }
})

async function bundle(contents: string) {
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  cpSync('src/server/store/migrations', join(directory, 'migrations'), { recursive: true })
  const entry = join(directory, 'entry.mjs')
  await build({ stdin: { contents, resolveDir: process.cwd() }, outfile: entry,
    bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  return entry
}

test.each(['Synthetic-Admin', '-Synthetic-Admin'])('offline executable recovery for %s on a copy is audited, restores must-change and revokes sessions without changing the source', async username => {
  const source = openStore(file, provider)
  await bootstrapAdministrator(source, { ...settings(), ARTIUM_AXI_ADMIN_USERNAME: username })
  const userId = (source.prepare('SELECT id FROM users').get() as { id: string }).id
  const token = issueTestAccessToken(source, userId)
  source.exec(`INSERT INTO sessions (id, family_id, user_id, csrf_token, created_at, last_seen_at, expires_at)
    SELECT 'synthetic-browser', id, user_id, 'CANARY-csrf', created_at, created_at, expires_at FROM session_families`)
  source.prepare('UPDATE users SET failed_attempts = 5, locked_until = ?').run(Date.now() + 900_000)
  const copy = join(directory, 'copy', 'artium.db')
  mkdirSync(join(directory, 'copy'))
  await source.backup(copy)
  const recoveryPassword = 'CANARY-recovery-password'
  const entry = await bundle("await import('./src/server/maintenance.ts')")
  writeFileSync(join(directory, '-password'), recoveryPassword)
  const result = spawnSync(process.execPath, [entry, 'recover-admin', '--username', username, '--password-file', '-password'],
    { cwd: directory, encoding: 'utf8', timeout: 10_000, env: { ...process.env, ARTIUM_AXI_DATABASE_FILE: copy,
      ARTIUM_AXI_MASTER_KEY_FILE: '', ARTIUM_AXI_MASTER_KEY: provider.getKey().bytes.toString('base64'), ARTIUM_AXI_AUDIT_STDOUT: '1' } })
  const recovered = openStore(copy, provider)
  try {
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('status: password-change-required')
    expect(result.stdout + result.stderr).not.toContain(recoveryPassword)
    expect(result.stderr).toBe('')
    expect(await new LocalAuthProvider(recovered).signIn(username, recoveryPassword)).toEqual({ userId, mustChange: true })
    expect(recovered.prepare('SELECT failed_attempts, locked_until FROM users').get()).toEqual({ failed_attempts: 0, locked_until: null })
    expect(() => verifyAccessToken(recovered, token)).toThrow(expect.objectContaining({ code: 'TOKEN_INVALID' }))
    expect(recovered.prepare('SELECT revoked_at FROM sessions').get()).toEqual({ revoked_at: expect.any(Number) })
    expect(recovered.prepare('SELECT action, target_id, user_id, arguments, outcome FROM audit').all())
      .toEqual([{ action: 'recover-admin', target_id: userId, user_id: null, arguments: null, outcome: 'success' }])
    expect(await new LocalAuthProvider(source).signIn(username, password)).toMatchObject({ userId })
    expect(verifyAccessToken(source, token)).toBe(userId)
    expect(source.prepare('SELECT * FROM audit').all()).toEqual([])
  } finally { source.close(); recovered.close() }
}, 15_000)

test.each(['synthetic-development-user', ' Synthetic-Development-User '])('recovery refuses reserved identity %s without mutation', async username => {
  const db = openStore(file, provider)
  await bootstrapAdministrator(db, settings())
  developmentAuthentication(db, 'CANARY-development-token')
  const before = db.prepare('SELECT * FROM users ORDER BY id').all()
  db.close()
  await expect(recoverAdministrator(file, provider, username, passwordFile)).rejects.toMatchObject({ code: 'USERNAME_INVALID' })
  const reopened = openStore(file, provider)
  try {
    expect(reopened.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(before)
    expect(reopened.prepare('SELECT * FROM audit').all()).toEqual([])
  } finally { reopened.close() }
})

test('malformed UTF-8 recovery password leaves account and sessions unchanged without audit', async () => {
  const db = openStore(file, provider)
  await bootstrapAdministrator(db, settings())
  const userId = (db.prepare('SELECT id FROM users').get() as { id: string }).id
  const token = issueTestAccessToken(db, userId)
  const before = db.prepare('SELECT * FROM users').get()
  db.close()
  writeFileSync(passwordFile, Buffer.concat([Buffer.from('CANARY-password-'), Buffer.from([0xe9])]))
  await expect(recoverAdministrator(file, provider, 'synthetic-admin', passwordFile)).rejects.toMatchObject({ code: 'PASSWORD_FILE_INVALID' })
  const reopened = openStore(file, provider)
  try {
    expect(reopened.prepare('SELECT * FROM users').get()).toEqual(before)
    expect(verifyAccessToken(reopened, token)).toBe(userId)
    expect(reopened.prepare('SELECT * FROM audit').all()).toEqual([])
  } finally { reopened.close() }
})

test('audit failure rolls back recovery password, account state and session revocations', async () => {
  const db = openStore(file, provider)
  await bootstrapAdministrator(db, settings())
  const userId = (db.prepare('SELECT id FROM users').get() as { id: string }).id
  const token = issueTestAccessToken(db, userId)
  const before = db.prepare('SELECT * FROM users').get()
  db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  db.close()
  writeFileSync(passwordFile, 'CANARY-recovery-password')
  await expect(recoverAdministrator(file, provider, 'synthetic-admin', passwordFile)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
  const reopened = openStore(file, provider)
  try {
    expect(reopened.prepare('SELECT * FROM users').get()).toEqual(before)
    expect(verifyAccessToken(reopened, token)).toBe(userId)
    expect(reopened.prepare('SELECT * FROM audit').all()).toEqual([])
  } finally { reopened.close() }
})

test('recovery refuses a held store before reading passwords', async () => {
  const release = acquireMaintenanceLock(file)
  try {
    await expect(recoverAdministrator(file, provider, 'synthetic-admin', '/missing')).rejects.toMatchObject({ code: 'MAINTENANCE_BUSY' })
  } finally { release() }
})

test('recovery with an unrelated key refuses a fresh bootstrapped store without mutation', async () => {
  const db = openStore(file, provider)
  await bootstrapAdministrator(db, settings())
  const before = db.prepare('SELECT * FROM users').get()
  const marker = db.prepare('SELECT * FROM bootstrap_metadata').get()
  db.close()
  const wrong = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
  await expect(recoverAdministrator(file, wrong, 'synthetic-admin', passwordFile)).rejects.toMatchObject({ code: 'MASTER_KEY_INVALID' })
  const reopened = openStore(file, provider)
  try {
    expect(reopened.prepare('SELECT * FROM users').get()).toEqual(before)
    expect(reopened.prepare('SELECT * FROM bootstrap_metadata').get()).toEqual(marker)
    expect(reopened.prepare('SELECT * FROM audit').all()).toEqual([])
  } finally { reopened.close() }
})

test('a marker without enabled administrators never reads bootstrap settings or recreates an account', async () => {
  const db = openStore(file, provider)
  try {
    db.exec('INSERT INTO bootstrap_metadata VALUES (1, 1)')
    await bootstrapAdministrator(db, { ARTIUM_AXI_ADMIN_USERNAME: '', ARTIUM_AXI_ADMIN_PASSWORD_FILE: '/missing' })
    expect(db.prepare('SELECT * FROM users').all()).toEqual([])
  } finally { db.close() }
})

test('recovery enables and promotes an existing disabled local account without replacing the last administrator', async () => {
  const db = openStore(file, provider)
  await bootstrapAdministrator(db, settings())
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, disabled)
    VALUES ('synthetic-disabled', 'synthetic-disabled', 'Disabled', 'unusable', 1)`)
  db.close()
  await recoverAdministrator(file, provider, 'synthetic-disabled', passwordFile)
  const reopened = openStore(file, provider)
  try {
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM users WHERE administrator = 1 AND disabled = 0').get()).toEqual({ count: 2 })
    expect(await new LocalAuthProvider(reopened).signIn('synthetic-disabled', password)).toEqual({ userId: 'synthetic-disabled', mustChange: true })
  } finally { reopened.close() }
})

test.each(['missing-store', 'missing-user', 'missing-marker'])('recovery refuses %s without creating an administrator', async boundary => {
  if (boundary !== 'missing-store') {
    const db = openStore(file, provider)
    if (boundary === 'missing-user') await bootstrapAdministrator(db, settings())
    else db.exec("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-admin', 'synthetic-admin', 'Admin', 'unusable')")
    db.close()
  }
  await expect(recoverAdministrator(file, provider, boundary === 'missing-user' ? 'unknown' : 'synthetic-admin', passwordFile))
    .rejects.toMatchObject({ code: 'RECOVERY_FAILED' })
})

test('real entry point bootstraps before development data and repeat starts ignore absent settings', async () => {
  const tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'CANARY-development-token')
  const entry = await bundle(`
    import { Server } from 'node:net';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(options, ...args) { return listen.call(this, { ...options, port: 0, host: '127.0.0.1' }, ...args); };
    const emit = Server.prototype.emit;
    Server.prototype.emit = function(event, ...args) { if (event === 'listening') console.log(JSON.stringify(this.address())); return emit.call(this, event, ...args); };
    await import('./src/server/main.ts');
  `)
  const environment = { ...process.env, ARTIUM_AXI_DEV: '1', ARTIUM_AXI_DEV_TOKEN_FILE: tokenFile,
    ARTIUM_AXI_DATABASE_FILE: file, ARTIUM_AXI_MASTER_KEY_FILE: '',
    ARTIUM_AXI_MASTER_KEY: provider.getKey().bytes.toString('base64'), ARTIUM_AXI_AUDIT_STDOUT: '0' }
  async function start(settings: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, [entry], { env: { ...environment, ...settings } })
    const closed = once(child, 'close')
    try {
      const ready = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('server exited before listening') })])
      const address = JSON.parse(ready[0].toString())
      expect((await fetch(`http://127.0.0.1:${address.port}/health/ready`)).status).toBe(200)
    } finally { child.kill('SIGTERM'); await closed }
  }
  await start(settings())
  await start({ ARTIUM_AXI_ADMIN_USERNAME: '', ARTIUM_AXI_ADMIN_PASSWORD_FILE: '/missing' })
  const db = openStore(file, provider)
  try {
    expect(db.prepare('SELECT username, administrator FROM users ORDER BY username').all()).toEqual([
      { username: 'synthetic-admin', administrator: 1 }, { username: 'synthetic-development-user', administrator: 0 },
    ])
    expect(db.prepare('SELECT COUNT(*) AS count FROM bootstrap_metadata').get()).toEqual({ count: 1 })
  } finally { db.close() }
}, 15_000)
