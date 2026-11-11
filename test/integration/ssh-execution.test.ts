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
import { encryptCredential } from '../../src/server/store/crypto.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { createSshAdapter } from '../../src/server/adapters/ssh.js'
import { createDelegation, delegatedDiscovery, revokeDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'

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
    resolver: new SharedIdentityResolver(store, db), adapters: [], environment: {} })
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

function delegated(commands?: string[], readOnly = false) {
  const adapter = createSshAdapter(hosts, join(directory, 'writes.log'))
  const token = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic', scope: { tools: [{ tool: 'ssh-axi',
    ...(commands ? { commands } : {}) }] }, readOnly, reusable: true, expiresAt: Date.now() + 600000 }, [adapter])
  return { id: token.id, headers: { authorization: `Bearer ${exchangeDelegation(db, token.token).accessToken}` } }
}

test('read-only SSH delegation refuses setup and execution before credentials are loaded', async () => {
  const token = delegated(undefined, true)
  for (const [route, payload] of [['prepare', input], ['submit', { requestKey: 'synthetic', input }],
    ['connection/open', { host: 'synthetic-host' }], ['connection/set', { id: 'synthetic', idle: 10 }]] as const) {
    expect((await post(route, payload, token.headers)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  }
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
  expect(db.prepare('SELECT * FROM ssh_connection_events').all()).toEqual([])
})

test('SSH exact command picks authorize only the selected routes', async () => {
  const token = delegated(['execution list'])
  expect((await post('list', {}, token.headers)).json().count).toBe(0)
  expect((await post('connection/list', {}, token.headers)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect((await post('prepare', input, token.headers)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect(db.prepare("SELECT delegation_id, action FROM audit WHERE action='ssh-execution-list'").get()).toEqual({ delegation_id: token.id, action: 'ssh-execution-list' })
})

test.each([
  { commands: ['exec'] },
  { commands: ['exec', 'execution show'] },
  { commands: ['exec', 'execution cancel'] },
])('SSH exec refuses incomplete workflow scope $commands before preparation or submission (R1)', async ({ commands }) => {
  provision()
  const token = delegated(['exec', 'execution show', 'execution cancel'])
  const scopeJson = JSON.stringify({ tools: [{ tool: 'ssh-axi', commands }] })
  db.prepare('UPDATE delegations SET scope_json=? WHERE id=?').run(scopeJson, token.id)
  expect((await post('prepare', input, token.headers)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect((await post('submit', { requestKey: 'synthetic', input }, token.headers)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
  expect(db.prepare("SELECT * FROM audit WHERE event='run-start'").all()).toEqual([])
  expect(delegatedDiscovery(db, 'synthetic-development-user', { scopeJson, readOnly: false },
    [createSshAdapter(hosts, join(directory, 'writes.log'))]).flatMap(tool => tool.commands)).not.toContain('exec')
})

test.each([
  { commands: ['exec'], missing: 'ssh-axi:execution show, ssh-axi:execution cancel' },
  { commands: ['exec', 'execution show'], missing: 'ssh-axi:execution cancel' },
  { commands: ['exec', 'execution cancel'], missing: 'ssh-axi:execution show' },
])('SSH mint refuses incomplete exec picks $commands and names missing picks (R3)', ({ commands, missing }) => {
  expect(() => delegated(commands)).toThrow(`SSH exec requires missing picks: ${missing}.`)
  expect(db.prepare('SELECT * FROM delegations').all()).toEqual([])
})

test('SSH exec with explicit workflow grants permits preparation and follow-up routes (R1)', async () => {
  provision()
  const token = delegated(['exec', 'execution show', 'execution cancel'])
  const prepared = await post('prepare', input, token.headers)
  expect(prepared.statusCode, prepared.body).toBe(200)
  expect((await post('show', { requestKey: prepared.json().requestKey }, token.headers)).json().error.code).toBe('NOT_FOUND')
  expect((await post('cancel', { id: 'missing', confirm: true }, token.headers)).json().error.code).toBe('NOT_FOUND')
})

test('revoked SSH delegation cannot access its routes while the owner remains signed in', async () => {
  const token = delegated()
  revokeDelegation(db, token.id, 'synthetic-development-user', false)
  expect((await post('connection/list', {}, token.headers)).json().error.code).toBe('TOKEN_INVALID')
  expect((await post('connection/list', {})).json().count).toBe(0)
})

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

test('empty connection discovery works while writes are disabled', async () => {
  const response = await post('connection/list', {})
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ connections: [], count: 0, message: 'No open connections found for this caller.' })
})

test.each([
  { host: 'synthetic-host', idle: 0 },
  { host: 'synthetic-host', idle: 61 },
  { host: 'synthetic-host', username: 'injected-account' },
  { host: 'synthetic-host', privateKey: 'CANARY-injected-key' },
])('connection admission refuses invalid input before opening a transport: %j', async value => {
  const response = await post('connection/open', value)
  expect(response.json().error.code).toBe('INVALID_INPUT')
})

test('connection admission requires a current host grant without generic credentials', async () => {
  expect((await post('connection/open', { host: 'synthetic-host' })).json().error.code).toBe('NOT_FOUND')
})

test('connection reads retain the normal tool role denial', async () => {
  db.exec("DELETE FROM role_tools WHERE tool='ssh-axi'")
  expect((await post('connection/list', {})).json().error.code).toBe('TOOL_NOT_GRANTED')
})

test('cancellation requires explicit confirmation before looking up an execution', async () => {
  expect((await post('cancel', { id: 'missing', confirm: false })).json().error.code).toBe('INVALID_INPUT')
})

const sample = '<script>synthetic-untrusted-output</script>'
function retain() {
  provision()
  const family = db.prepare('SELECT id FROM session_families WHERE user_id=?').get('synthetic-development-user') as { id: string }
  const metadata = JSON.stringify({ stdout: { receivedBytes: sample.length, retainedBytes: sample.length, text: '' }, remoteExit: 0 })
  db.prepare(`INSERT INTO ssh_executions VALUES ('exec_fixture','fixture-key','fixture-input',? ,? ,'synthetic-host',
    'ordinary','fixture-binding','printf synthetic',0,'fixture-request',?,?,'completed',?)`)
    .run('synthetic-development-user', family.id, Date.now(), Date.now(), metadata)
  const encrypted = encryptCredential('exec_fixture', 'ssh-axi', Buffer.from(JSON.stringify({ stdout: { text: sample, receivedBytes: sample.length, retainedBytes: sample.length } })), provider.getKey())
  db.prepare(`INSERT INTO ssh_execution_results (id,tool,schema_version,key_id,nonce,ciphertext,authentication_tag,updated_at)
    VALUES (@id,@tool,@schema_version,@key_id,@nonce,@ciphertext,@authentication_tag,@now)`).run({ ...encrypted, now: Date.now() })
}

test('execution list returns owned metadata without output samples', async () => {
  retain()
  const response = await post('list', {})
  expect(response.json().executions).toEqual([{ id: 'exec_fixture', host: 'synthetic-host', outcome: 'completed', startedAt: expect.any(String) }])
  expect(response.body).not.toContain(sample)
})

test('retained output expires independently of command metadata', async () => {
  retain()
  db.prepare('UPDATE ssh_execution_results SET updated_at=?').run(Date.now() - 14 * 86400000)
  const response = await post('show', { id: 'exec_fixture', full: true })
  expect(response.json()).toMatchObject({ command: 'printf synthetic', samples: 'unavailable-or-expired', stdout: { receivedBytes: sample.length } })
  expect(response.body).not.toContain('synthetic-untrusted-output')
})

test('expired execution metadata is removed rather than exposed through recovery', async () => {
  retain()
  db.prepare('UPDATE ssh_executions SET finished_at=?').run(Date.now() - 90 * 86400000)
  expect((await post('show', { id: 'exec_fixture' })).json().error.code).toBe('NOT_FOUND')
})

test('retained audit reads require the existing administrator capability', async () => {
  const response = await app.inject({ url: '/v1/admin/ssh/audit', headers })
  expect(response.json().error.code).toBe('ADMIN_REQUIRED')
})

test('administrator export contains metadata and records every read without exporting samples', async () => {
  retain()
  db.exec('UPDATE users SET administrator=1')
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
  const inspected = await app.inject({ url: '/v1/admin/ssh/audit', headers: proof })
  expect(inspected.json().executions[0].stdout.text).toBe(sample)
  const exported = await app.inject({ url: '/v1/admin/ssh/audit/export', headers: proof })
  expect(exported.json().executions[0]).toMatchObject({ id: 'exec_fixture', command: 'printf synthetic', samples: 'omitted' })
  expect(exported.json().executions[0].stdout).not.toHaveProperty('text')
  expect(exported.body).not.toContain('synthetic-untrusted-output')
  expect(db.prepare("SELECT action FROM audit WHERE action IN ('ssh-audit-read','ssh-audit-export') ORDER BY id").all())
    .toEqual([{ action: 'ssh-audit-read' }, { action: 'ssh-audit-export' }])
})
