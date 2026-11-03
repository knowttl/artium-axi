import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
let hosts: SshHosts
const input = { host: 'synthetic-host', command: 'id', confirm: true }
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 6).toString('base64') })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ssh-execution-'))
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled=1 WHERE name='ssh-axi'")
  const store = createCredentialStore(db, provider)
  hosts = new SshHosts(db, provider)
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner: await Runner.create(join(directory, 'calls')),
    credentialStore: store, sshHosts: hosts, sshExecution: { provider, writeLog: join(directory, 'writes.log'),
      executable: join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js') },
    resolver: new SharedIdentityResolver(store), adapters: [], environment: {} })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  headers = { authorization: `Bearer ${login.json().accessToken}` }
})
afterEach(async () => { vi.useRealTimers(); await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

test('SSH execution preparation enforces the administrator default-off gate before credentials', async () => {
  const response = await post('prepare', input)
  expect(response.json().error.code).toBe('FLAG_BLOCKED')
})

const post = (route: string, payload: Record<string, unknown>, identity = headers) => app.inject({ method: 'POST', url: `/v1/ssh/${route}`, headers: identity, payload })
function provision() {
  db.exec(`UPDATE tools SET native_settings='{"allowWrites":true}' WHERE name='ssh-axi';
    INSERT INTO ssh_hosts (id,address,port,approved_host_keys,allowed_addresses,enabled,read_only)
      VALUES ('synthetic-host','127.0.0.1',22,'["ssh-ed25519 YWJj"]','["127.0.0.1"]',1,0)`)
  hosts.replaceCredential('ordinary-key', { privateKey: 'CANARY-private-key', passphrase: 'CANARY-private-passphrase' }, 0, 'synthetic-development-user')
  db.exec(`INSERT INTO ssh_bindings (host_id,username,credential_id,sudo) VALUES ('synthetic-host','ordinary','ordinary-key',0);
    INSERT INTO ssh_grants (user_id,host_id,shell,sudo) VALUES ('synthetic-development-user','synthetic-host',1,0)`)
}

test('preparation signs input without creating a dispatch claim', async () => {
  provision()
  const prepared = await post('prepare', input)
  expect(prepared.statusCode, prepared.body).toBe(200)
  const recovery = await post('show', { requestKey: prepared.json().requestKey })
  expect(recovery.json().error.code).toBe('NOT_FOUND')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
  expect(db.prepare("SELECT * FROM audit WHERE event='run-start'").all()).toEqual([])
})

test.each([
  { label: 'confirmation', value: { ...input, confirm: false } },
  { label: 'credential override', value: { ...input, privateKey: 'CANARY-injected' } },
  { label: 'endpoint override', value: { ...input, address: '192.0.2.1' } },
  { label: 'maximum timeout', value: { ...input, timeout: 601 } },
])('preparation refuses invalid $label at the API boundary', async ({ value }) => {
  const response = await post('prepare', value)
  expect(response.json().error.code).toBe('INVALID_INPUT')
})

test('read-only host policy remains authoritative after tool writes are enabled', async () => {
  provision()
  db.exec('UPDATE ssh_hosts SET read_only=1')
  expect((await post('prepare', input)).json().error.code).toBe('FLAG_BLOCKED')
})

test('sudo preparation never falls back to the ordinary binding or grant', async () => {
  provision()
  expect((await post('prepare', { ...input, sudo: true })).json().error.code).toBe('NOT_FOUND')
})

test('protected command material is refused before journal or audit custody', async () => {
  provision()
  const response = await post('prepare', { ...input, command: 'printf CANARY-private-passphrase' })
  expect(response.json().error.code).toBe('INVALID_INPUT')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-private-passphrase')
})

test('forged request keys cannot claim execution', async () => {
  provision()
  const response = await post('submit', { requestKey: 'forged.signature', input })
  expect(response.json().error.code).toBe('INVALID_INPUT')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
})

test('prepared commands cannot be changed at submission', async () => {
  provision()
  const prepared = await post('prepare', input)
  const response = await post('submit', { requestKey: prepared.json().requestKey, input: { ...input, command: 'whoami' } })
  expect(response.json().error.code).toBe('REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
})

test('prepared bindings become stale after credential replacement', async () => {
  provision()
  const prepared = await post('prepare', input)
  hosts.replaceCredential('ordinary-key', { privateKey: 'CANARY-replacement-key' }, 1, 'synthetic-development-user')
  const response = await post('submit', { requestKey: prepared.json().requestKey, input })
  expect(response.json().error.code).toBe('REVISION_CONFLICT')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
})

test('a new session family cannot use another family preparation', async () => {
  provision()
  const prepared = await post('prepare', input)
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  const response = await post('submit', { requestKey: prepared.json().requestKey, input }, { authorization: `Bearer ${login.json().accessToken}` })
  expect(response.json().error.code).toBe('NOT_FOUND')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
})

test('unused preparation expires without creating a dispatch claim', async () => {
  provision()
  const prepared = await post('prepare', input)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 600001)
  const response = await post('submit', { requestKey: prepared.json().requestKey, input })
  expect(response.json().error.code).toBe('INVALID_INPUT')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
})
