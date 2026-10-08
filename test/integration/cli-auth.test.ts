import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { hashToken } from '../../src/server/auth/tokens.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { SessionStore } from '../../src/cli/session.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let url: string
let store: SessionStore
let bundle: string
const startingPassword = 'CANARY-local-password'
const newPassword = 'CANARY-new-password'
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-cli-auth-'))
  bundle = join(directory, 'artium-axi.mjs')
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
  db = openStore(join(directory, 'data', 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') }))
  await seedToolUser(db)
  const runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, runner, audit: new Audit(db), environment: {}, adapters: [],
    resolver: new SharedIdentityResolver(new FakeCredentialStore([])) })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  store = new SessionStore(url, join(directory, 'artium-axi', 'session.json'))
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

async function cli(args: string[], input?: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [bundle, ...args], { cwd: directory,
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', ...environment },
    stdio: ['pipe', 'pipe', 'pipe'] })
  // The actual process argv carries only the command and non-secret options.
  expect(child.spawnargs).not.toContain(startingPassword)
  expect(child.spawnargs).not.toContain(newPassword)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(input)
  const [code] = await once(child, 'close')
  expect(stdout + stderr).not.toContain(startingPassword)
  expect(stdout + stderr).not.toContain(newPassword)
  if (existsSync(store.file)) {
    const stored = JSON.parse(readFileSync(store.file, 'utf8'))
    for (const token of [stored.accessToken, stored.refreshToken, stored.passwordChangeToken].filter(Boolean)) expect(stdout + stderr).not.toContain(token)
  }
  return { stdout, stderr, code }
}
const login = (password = startingPassword) => cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)

test('bundled first login stores only a restricted token and blocks tools until password change and login', async () => {
  db.exec('UPDATE users SET must_change = 1')
  expect(await login()).toMatchObject({ code: 1, stdout: expect.stringContaining('PASSWORD_CHANGE_REQUIRED'), stderr: '' })
  const restricted = store.read()!
  expect(restricted.status).toBe('password-change-required')
  expect(restricted).not.toHaveProperty('accessToken')
  expect(statSync(store.file).mode & 0o777).toBe(0o600)
  expect(await cli(['tools'])).toMatchObject({ code: 1, stdout: expect.stringContaining('PASSWORD_CHANGE_REQUIRED') })
  expect(await cli(['passwd', '--password-stdin'], `${newPassword}\n`)).toMatchObject({ code: 0, stdout: expect.stringContaining('password-changed'), stderr: '' })
  expect(existsSync(store.file)).toBe(false)
  expect(await login(newPassword)).toMatchObject({ code: 0, stdout: expect.stringContaining('authenticated'), stderr: '' })
  expect(await cli(['tools'])).toMatchObject({ code: 0, stdout: 'tools: 0 available\n' })
  const identity = await cli(['whoami'])
  expect(identity).toMatchObject({ code: 0, stdout: expect.stringContaining('synthetic-user'), stderr: '' })
  expect(identity.stdout).toContain('Synthetic Role')
  expect(identity.stdout).toContain(url)
  const tokens = store.read()!
  expect(identity.stdout).not.toContain((tokens as { accessToken: string }).accessToken)
  db.exec('DELETE FROM user_roles')
  expect((await cli(['whoami'])).stdout).toContain('roles[0]:')
})

test.each([false, true])('ordinary password change verifies the current password and handles expired access=%s', async expired => {
  await login()
  if (expired) db.prepare("UPDATE tokens SET expires_at = ? WHERE type = 'access'").run(Date.now() - 1)
  expect(await cli(['passwd', '--password-stdin'], newPassword, { ARTIUM_AXI_CURRENT_PASSWORD: 'CANARY-wrong-password' }))
    .toMatchObject({ code: 1, stdout: expect.stringContaining('SIGN_IN_FAILED') })
  expect(existsSync(store.file)).toBe(true)
  expect(await cli(['passwd', '--password-stdin'], newPassword, { ARTIUM_AXI_CURRENT_PASSWORD: startingPassword })).toMatchObject({ code: 0 })
  expect(existsSync(store.file)).toBe(false)
  expect(await login(newPassword)).toMatchObject({ code: 0 })
})

test('stdin takes precedence over the password environment and environment sign-in never prompts', async () => {
  expect(await cli(['login', '--username', 'synthetic-user', '--password-stdin'], startingPassword, { ARTIUM_AXI_PASSWORD: 'CANARY-wrong' }))
    .toMatchObject({ code: 0, stderr: '' })
  expect(await cli(['login', '--username', 'synthetic-user'], undefined, { ARTIUM_AXI_PASSWORD: startingPassword }))
    .toMatchObject({ code: 0, stderr: '' })
})

test.each(['-synthetic-user', '--username', '--password-stdin'])('login accepts the username value %s', async username => {
  db.prepare('UPDATE users SET username = ?').run(username)
  expect(await cli(['login', '--username', username, '--password-stdin'], startingPassword)).toMatchObject({ code: 0, stderr: '' })
  expect(await cli(['whoami'])).toMatchObject({ code: 0, stdout: expect.stringContaining(JSON.stringify(username)) })
})

test('password stdin preserves surrounding spaces and Unicode while removing one line ending', async () => {
  const password = '  CANARY-password-雪  '
  db.exec('UPDATE users SET must_change = 1')
  await login()
  expect(await cli(['passwd', '--password-stdin'], `${password}\r\n`)).toMatchObject({ code: 0 })
  expect(await login(password)).toMatchObject({ code: 0 })
})

test('logout removes local tokens when the configured CA file is unreadable', async () => {
  await login()
  expect(await cli(['logout'], undefined, { ARTIUM_AXI_CA_FILE: join(directory, 'missing-ca') }))
    .toMatchObject({ code: 0, stdout: expect.stringContaining('remoteRevocation: unverified') })
  expect(existsSync(store.file)).toBe(false)
})

test.each([
  ['login', '--username', 'synthetic-user', '--password', 'CANARY-refused'],
  ['login', '--username', 'synthetic-user', 'CANARY-refused'],
  ['passwd', '--password=CANARY-refused'],
  ['login', '--username', 'synthetic-user', '--unknown'],
  ['login', '--username', 'synthetic-user', '--username', 'synthetic-user'],
  ['login', '--username', 'synthetic-user', '--password-stdin', '--password-stdin'],
].map(args => ({ args })))('password and unknown arguments are refused without token output: $args', async ({ args }) => {
  const result = await cli(args)
  expect(result).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '' })
  expect(result.stdout).not.toContain('CANARY-refused')
  expect(existsSync(store.file)).toBe(false)
})

test('missing non-terminal password fails immediately without a prompt', async () => {
  expect(await cli(['login', '--username', 'synthetic-user'])).toMatchObject({ code: 2, stderr: '' })
})

test('concurrent bundled processes rotate an expired access token only once', async () => {
  await login()
  const original = store.read()!
  if (original.status !== 'authenticated') throw new Error('Expected authenticated session')
  db.prepare('UPDATE tokens SET expires_at = ? WHERE hash = ?').run(Date.now() - 1, hashToken(original.accessToken))
  const results = await Promise.all(Array.from({ length: 6 }, () => cli(['tools'])))
  expect(results).toEqual(Array.from({ length: 6 }, () => ({ code: 0, stdout: 'tools: 0 available\n', stderr: '' })))
  expect(db.prepare("SELECT COUNT(*) AS count FROM tokens WHERE type = 'refresh' AND consumed_at IS NOT NULL").get()).toEqual({ count: 1 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM session_families WHERE revoked_at IS NOT NULL').get()).toEqual({ count: 0 })
  const rotated = store.read()!
  expect(rotated).toMatchObject({ familyExpiresAt: original.familyExpiresAt })
  expect(rotated).not.toMatchObject({ accessToken: original.accessToken })
})

test('logout revokes the family even after access expiry and deletes the local session', async () => {
  await login()
  db.prepare("UPDATE tokens SET expires_at = ? WHERE type = 'access'").run(Date.now() - 1)
  expect(await cli(['logout'])).toMatchObject({ code: 0, stdout: expect.stringContaining('remoteRevocation: verified') })
  expect(existsSync(store.file)).toBe(false)
  expect(db.prepare('SELECT COUNT(*) AS count FROM session_families WHERE revoked_at IS NOT NULL').get()).toEqual({ count: 1 })
})

test('offline logout deletes local tokens and reports unverified remote revocation', async () => {
  await login()
  await app.close()
  expect(await cli(['logout'])).toMatchObject({ code: 0, stdout: expect.stringContaining('remoteRevocation: unverified') })
  expect(existsSync(store.file)).toBe(false)
})

test('changed server URL never receives stored tokens and logout still removes them', async () => {
  await login()
  const environment = { ARTIUM_AXI_URL: `${url}/another` }
  expect(await cli(['whoami'], undefined, environment)).toMatchObject({ code: 1, stdout: expect.stringContaining('SESSION_SERVER_MISMATCH') })
  expect(await cli(['logout'], undefined, environment)).toMatchObject({ code: 0, stdout: expect.stringContaining('unverified') })
  expect(existsSync(store.file)).toBe(false)
})
