import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { createSshAdapter } from '../../src/server/adapters/ssh.js'
import { decryptCredential, type EncryptedCredential } from '../../src/server/store/crypto.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
let hosts: SshHosts
const actor = 'synthetic-development-user'
const host = { id: 'synthetic-host', expectedRevision: 0, confirm: true,
  address: '127.0.0.1', port: 22, approvedHostKeys: ['ssh-ed25519 YWJj'], allowedAddresses: ['127.0.0.1'],
  independentVerification: 'Synthetic offline key verification', enabled: true, readOnly: true,
  commandSeconds: 600, outputBytes: 65536, idleMinutes: 60 }
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') })

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ssh-admin-'))
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  const store = createCredentialStore(db, provider)
  hosts = new SshHosts(db, provider)
  const runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner,
    resolver: new SharedIdentityResolver(store), credentialStore: store, sshHosts: hosts, adapters: [], environment: {} })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  expect(login.statusCode).toBe(200)
  headers = { authorization: `Bearer ${login.json().accessToken}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  headers['x-artium-reauth-ticket'] = reauth.json().ticket
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

test('administrators can discover the dedicated SSH configuration', async () => {
  const response = await app.inject({ url: '/v1/admin/ssh/hosts', headers })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ hosts: [], bindings: [], grants: [] })
})

const post = (path: string, payload: Record<string, unknown>, proof = headers) => app.inject({ method: 'POST', url: `/v1/admin/ssh/${path}`, headers: proof, payload })
async function save(path: string, payload: Record<string, unknown>) {
  const response = await post(path, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { id: string, revision: number }
}
async function provision() {
  await save('hosts', host)
  await save('credential', { id: 'ordinary', expectedRevision: 0, confirm: true, privateKey: 'CANARY-private-ordinary', passphrase: 'CANARY-passphrase' })
  await save('credential', { id: 'elevated', expectedRevision: 0, confirm: true, privateKey: 'CANARY-private-elevated' })
  await save('binding', { host: host.id, expectedRevision: 1, confirm: true, sudo: false, username: 'ordinary', credential: 'ordinary' })
  await save('grant', { host: host.id, user: actor, expectedRevision: 2, confirm: true, shell: true, sudo: false })
}

test('provisioning uses encrypted ordinary credentials and exposes only administrator metadata', async () => {
  await provision()
  expect(hosts.list(actor)).toEqual([{ id: host.id, address: host.address, port: 22, username: 'ordinary' }])
  expect(hosts.profile(actor, host.id)).toMatchObject({ privateKey: 'CANARY-private-ordinary', passphrase: 'CANARY-passphrase' })
  const encrypted = db.prepare('SELECT * FROM ssh_credentials WHERE id=?').get('ordinary') as EncryptedCredential
  expect(encrypted.ciphertext.includes(Buffer.from('CANARY-private-ordinary'))).toBe(false)
  const decrypted = decryptCredential(encrypted, provider.getKey())
  try { expect(JSON.parse(decrypted.toString())).toEqual({ privateKey: 'CANARY-private-ordinary', passphrase: 'CANARY-passphrase' }) }
  finally { decrypted.fill(0) }
  const credentials = await app.inject({ url: '/v1/admin/ssh/credentials', headers })
  expect(credentials.json().credentials).toEqual([
    { id: 'elevated', revision: 1, updatedAt: expect.any(Number), updatedBy: actor },
    { id: 'ordinary', revision: 1, updatedAt: expect.any(Number), updatedBy: actor },
  ])
  expect(credentials.body).not.toMatch(/CANARY|privateKey|passphrase|ciphertext/)
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toMatch(/CANARY|privateKey|passphrase/)
  expect(db.prepare("SELECT action, target_id FROM audit WHERE action='ssh-credential-save' ORDER BY id").all()).toEqual([
    { action: 'ssh-credential-save', target_id: 'ordinary' }, { action: 'ssh-credential-save', target_id: 'elevated' },
  ])
})

test.each([
  ['ordinary', 'elevated'], ['elevated-account', 'ordinary'],
])('sudo binding refuses reused account %s or credential %s', async (username, credential) => {
  await provision()
  const response = await post('binding', { host: host.id, expectedRevision: 3, confirm: true, sudo: true, username, credential })
  expect(response.json().error.code).toBe('INVALID_INPUT')
  expect(hosts.profile(actor, host.id).privateKey).toBe('CANARY-private-ordinary')
})

test('separate sudo bindings never substitute for a missing ordinary credential', async () => {
  await provision()
  await save('binding', { host: host.id, expectedRevision: 3, confirm: true, sudo: true, username: 'elevated-account', credential: 'elevated' })
  await save('credential-delete', { id: 'ordinary', expectedRevision: 1, confirm: true })
  expect(hosts.list(actor)).toEqual([])
  expect(() => hosts.profile(actor, host.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  const response = await app.inject({ url: '/v1/admin/ssh/hosts', headers })
  expect(response.json().hosts[0].revision).toBe(5)
  expect(response.json().bindings).toEqual([{ host: host.id, username: 'elevated-account', credential: 'elevated', revision: 1, sudo: 1 }])
})

test('concurrent edits cannot overwrite host policy, bindings or grants with a stale revision', async () => {
  await provision()
  const edit = { ...host, expectedRevision: 3, port: 2222 }
  const responses = await Promise.all([post('hosts', edit), post('hosts', { ...edit, port: 2223 })])
  expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409])
  const binding = await post('binding', { host: host.id, expectedRevision: 3, confirm: true, sudo: true, username: 'elevated-account', credential: 'elevated' })
  expect(binding.json().error.code).toBe('REVISION_CONFLICT')
  const grant = await post('grant', { host: host.id, user: actor, expectedRevision: 3, confirm: true, shell: false, sudo: false })
  expect(grant.json().error.code).toBe('REVISION_CONFLICT')
  expect(hosts.list(actor)[0]?.port).toBe([2222, 2223][responses.findIndex(response => response.statusCode === 200)])
})

test('credential replacement rotates encrypted values and rejects stale replacement or deletion', async () => {
  await provision()
  await save('credential', { id: 'ordinary', expectedRevision: 1, confirm: true, privateKey: 'CANARY-rotated-key', passphrase: '' })
  expect(hosts.profile(actor, host.id).privateKey).toBe('CANARY-rotated-key')
  expect(hosts.profile(actor, host.id).passphrase).toBeUndefined()
  const stale = await post('credential', { id: 'ordinary', expectedRevision: 1, confirm: true, privateKey: 'CANARY-stale-key' })
  expect(stale.json().error.code).toBe('REVISION_CONFLICT')
  expect((await post('credential-delete', { id: 'ordinary', expectedRevision: 1, confirm: true })).json().error.code).toBe('REVISION_CONFLICT')
  expect(hosts.profile(actor, host.id).privateKey).toBe('CANARY-rotated-key')
})

test('revoking a host grant or disabling the host removes discovery and profile access immediately', async () => {
  await provision()
  await save('grant', { host: host.id, user: actor, expectedRevision: 3, confirm: true, shell: false, sudo: false })
  expect(hosts.list(actor)).toEqual([])
  expect(() => hosts.profile(actor, host.id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  await save('grant', { host: host.id, user: actor, expectedRevision: 4, confirm: true, shell: true, sudo: false })
  await save('hosts', { ...host, expectedRevision: 5, enabled: false })
  expect(hosts.list(actor)).toEqual([])
})

test.each(['hosts', 'binding', 'grant', 'credential', 'host-delete', 'credential-delete'])('%s requires administrator identity and recent authentication', async path => {
  const unconfirmed = { authorization: headers.authorization! }
  expect((await post(path, {}, unconfirmed)).json().error.code).toBe('REAUTH_REQUIRED')
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change, administrator)
    SELECT 'other-admin', 'other-admin', 'Other administrator', password_hash, 0, 1 FROM users WHERE id='synthetic-development-user';
    UPDATE users SET administrator = 0 WHERE id='synthetic-development-user'`)
  expect((await post(path, {})).json().error.code).toBe('ADMIN_REQUIRED')
  expect((await app.inject({ url: '/v1/admin/ssh/credentials', headers })).json().error.code).toBe('ADMIN_REQUIRED')
})

test.each([
  { ...host, confirm: false }, { ...host, allowedAddresses: ['synthetic.example'] },
  { ...host, approvedHostKeys: ['ssh-ed25519 YWJj', 'ssh-ed25519 YWJj'] }, { ...host, commandSeconds: 601 },
])('host registration validates trust, confirmation and bounds', async input => {
  expect((await post('hosts', input)).json().error.code).toBe('INVALID_INPUT')
  expect(hosts.list(actor)).toEqual([])
})

test('host deletion removes grants and bindings without deleting reusable encrypted credentials', async () => {
  await provision()
  await save('host-delete', { id: host.id, expectedRevision: 3, confirm: true })
  expect((await app.inject({ url: '/v1/admin/ssh/hosts', headers })).json()).toEqual({ hosts: [], bindings: [], grants: [] })
  expect((await app.inject({ url: '/v1/admin/ssh/credentials', headers })).json().credentials.map((row: { id: string }) => row.id)).toEqual(['elevated', 'ordinary'])
})

test('recreated host and credential handles never accept drafts from before deletion', async () => {
  await provision()
  await save('host-delete', { id: host.id, expectedRevision: 3, confirm: true })
  expect(await save('hosts', host)).toEqual({ id: host.id, revision: 4 })
  expect((await post('hosts', { ...host, expectedRevision: 3, address: '192.0.2.1' })).json().error.code).toBe('REVISION_CONFLICT')
  await save('credential-delete', { id: 'ordinary', expectedRevision: 1, confirm: true })
  expect(await save('credential', { id: 'ordinary', expectedRevision: 0, confirm: true, privateKey: 'CANARY-recreated-key' })).toEqual({ id: 'ordinary', revision: 2 })
  expect((await post('credential-delete', { id: 'ordinary', expectedRevision: 1, confirm: true })).json().error.code).toBe('REVISION_CONFLICT')
})

test.each([
  ['host policy', () => save('hosts', { ...host, expectedRevision: 3, enabled: false })],
  ['account binding', () => save('binding', { host: host.id, expectedRevision: 3, confirm: true, sudo: false, username: 'replacement', credential: 'elevated' })],
  ['caller grant', () => save('grant', { host: host.id, user: actor, expectedRevision: 3, confirm: true, shell: false, sudo: false })],
  ['credential revision', () => save('credential', { id: 'ordinary', expectedRevision: 1, confirm: true, privateKey: 'CANARY-replacement' })],
] as const)('a prepared SSH profile cannot dispatch after its %s changes', async (_name, change) => {
  await provision()
  const adapter = createSshAdapter(hosts, join(directory, 'writes.log'), join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js'))
  const prepared = await adapter.prepareForCaller!(['doctor', host.id], actor)
  expect(() => prepared.beforeSpawn!()).not.toThrow()
  await change()
  expect(() => prepared.beforeSpawn!()).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
})
