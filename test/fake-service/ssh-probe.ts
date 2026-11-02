import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParsedKey, Connection } from 'ssh2'
import { createSshAdapter } from '../../src/server/adapters/ssh.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { encryptCredential } from '../../src/server/store/crypto.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { toolPaths } from '../../src/server/config.js'
import { seedToolUser } from '../fixtures/tokens.js'

// All authenticated native probes run inside one owned --network none container.
assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
const ssh = createRequire(realpathSync(toolPaths['ssh-axi']))('ssh2') as typeof import('ssh2')
const passphrase = 'CANARY-synthetic-ssh-passphrase'
const makeKey = (encrypted = false) => generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs1', ...(encrypted ? { cipher: 'aes-256-cbc', passphrase } : {}) },
  publicKeyEncoding: { format: 'pem', type: 'pkcs1' } }).privateKey
const parse = (key: string, password?: string): ParsedKey => {
  const parsed = ssh.utils.parseKey(key, password)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid synthetic key')
  return parsed
}
const serverKey = makeKey()
const ordinaryKey = makeKey(true)
const sudoKey = makeKey(true)
const approved = parse(serverKey)
const ordinary = parse(ordinaryKey, passphrase)
const sudo = parse(sudoKey, passphrase)
const directory = mkdtempSync(join(tmpdir(), 'artium-ssh-probe-'))
const counts = { transports: 0, commands: 0, channels: 0, usernames: [] as string[] }
const connections = new Set<Connection>()
const peer = new ssh.Server({ hostKeys: [serverKey] }, connection => {
  connections.add(connection); counts.transports++
  connection.on('error', () => {})
  connection.on('close', () => connections.delete(connection))
  connection.on('authentication', context => {
    counts.usernames.push(context.username)
    const selected = context.username === 'ordinary' ? ordinary : context.username === 'sudo-account' ? sudo : undefined
    if (context.method === 'publickey' && selected && context.key.data.equals(selected.getPublicSSH())
      && (!context.signature || selected.verify(context.blob!, context.signature, context.hashAlgo) === true)) context.accept()
    else context.reject(['publickey'])
  })
  connection.on('session', (_accept, reject) => { counts.channels++; reject() })
})
await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
const port = (peer.address() as { port: number }).port
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 4).toString('base64') })
const db = openStore(join(directory, 'data', 'artium.db'), provider)
const runner = await Runner.create(join(directory, 'calls'))
await seedToolUser(db)
db.exec("UPDATE tools SET enabled = 1 WHERE name = 'ssh-axi'; UPDATE users SET administrator = 1")
const saveKey = (id: string, key: string) => {
  const plaintext = Buffer.from(JSON.stringify({ privateKey: key, passphrase }))
  try {
    const encrypted = encryptCredential(id, 'ssh-axi', plaintext, provider.getKey())
    db.prepare(`INSERT INTO ssh_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, updated_at)
      VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, 1)
      ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext, authentication_tag=excluded.authentication_tag`).run(encrypted)
  } finally { plaintext.fill(0) }
}
saveKey('ordinary-key', ordinaryKey); saveKey('sudo-key', sudoKey)
const hostKey = `${approved.type} ${approved.getPublicSSH().toString('base64')}`
db.prepare(`INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses, enabled)
  VALUES ('granted', '127.0.0.1', ?, ?, '["127.0.0.1"]', 1), ('hidden', '127.0.0.1', ?, ?, '["127.0.0.1"]', 1)`).run(port, JSON.stringify([hostKey]), port, JSON.stringify([hostKey]))
db.exec(`INSERT INTO ssh_bindings (host_id, username, credential_id, sudo) VALUES
  ('granted', 'ordinary', 'ordinary-key', 0), ('granted', 'sudo-account', 'sudo-key', 1), ('hidden', 'ordinary', 'ordinary-key', 0);
  INSERT INTO ssh_grants (user_id, host_id, shell, sudo) VALUES ('synthetic-development-user', 'granted', 1, 1)`)
const store = createCredentialStore(db, provider)
const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, credentialStore: store,
  resolver: new SharedIdentityResolver(store), environment: {},
  adapters: [createSshAdapter(new SshHosts(db, provider), join(directory, 'writes.log'))] })
try {
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  assert.equal(login.statusCode, 200, login.body)
  const headers = { authorization: `Bearer ${login.json().accessToken}` }
  const invoke = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/ssh-axi/run', headers, payload: { args } })
  for (const args of [[], ['host', 'list'], ['host', 'show', 'granted']]) {
    const response = await invoke([...args, '--json'])
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().exitCode, 0, response.body)
    assert.match(response.json().stdout, /granted/)
    assert.doesNotMatch(response.body, /hidden|CANARY|PRIVATE KEY|approvedHostKeys|allowedAddresses/)
  }
  assert.equal(counts.transports, 0)
  const doctor = await invoke(['doctor', 'granted', '--json'])
  assert.equal(doctor.statusCode, 200, doctor.body)
  assert.equal(doctor.json().exitCode, 0, doctor.body)
  assert.deepEqual(JSON.parse(doctor.json().stdout), { host: 'granted', authenticated: true, address: '127.0.0.1', commandsExecuted: 0 })
  assert.ok(counts.usernames.length > 0)
  assert.ok(counts.usernames.every(username => username === 'ordinary'))
  assert.equal(counts.channels, 0)
  const before = counts.transports
  for (const host of ['hidden', 'unknown']) {
    const response = await invoke(['doctor', host])
    assert.equal(response.statusCode, 404, response.body)
    assert.equal(response.json().error.code, 'NOT_FOUND')
  }
  db.exec("UPDATE ssh_hosts SET enabled = 0 WHERE id = 'granted'")
  const disabled = await invoke(['host', 'list', '--json'])
  assert.equal(disabled.json().exitCode, 0, disabled.body)
  assert.deepEqual(JSON.parse(disabled.json().stdout).hosts, [])
  db.exec("UPDATE ssh_hosts SET enabled = 1 WHERE id = 'granted'")
  for (const args of [['exec', 'granted', '--command', 'id', '--confirm'],
    ['doctor', 'granted', '--sudo'], ['doctor', 'granted', '--approved-host-keys', hostKey], ['connection', 'open', 'granted']]) {
    const response = await invoke(args)
    assert.ok(response.statusCode >= 400, response.body)
  }
  assert.equal(counts.transports, before)
  const help = await invoke(['--help', '--json'])
  assert.equal(help.json().exitCode, 0, help.body)
  assert.deepEqual(JSON.parse(help.json().stdout).commands, ['host list', 'host show', 'doctor'])
  assert.doesNotMatch(help.json().stdout, /--config|--profile|--command/)
  const authenticationCount = counts.usernames.length
  db.prepare('UPDATE ssh_hosts SET approved_host_keys = ? WHERE id = ?').run(JSON.stringify([`${sudo.type} ${sudo.getPublicSSH().toString('base64')}`]), 'granted')
  const trust = await invoke(['doctor', 'granted', '--json'])
  assert.equal(JSON.parse(trust.json().stdout).error.code, 'TRUST_FAILED')
  assert.equal(counts.usernames.length, authenticationCount)
  db.prepare('UPDATE ssh_hosts SET approved_host_keys = ?, allowed_addresses = ? WHERE id = ?').run(JSON.stringify([hostKey]), '["192.0.2.1"]', 'granted')
  const address = await invoke(['doctor', 'granted', '--json'])
  assert.equal(JSON.parse(address.json().stdout).error.code, 'ADDRESS_DENIED')
  assert.equal(counts.usernames.length, authenticationCount)
  db.prepare('UPDATE ssh_hosts SET allowed_addresses = ? WHERE id = ?').run('["127.0.0.1"]', 'granted')
  saveKey('ordinary-key', sudoKey)
  const failedOrdinary = await invoke(['doctor', 'granted', '--json'])
  assert.notEqual(failedOrdinary.json().exitCode, 0, failedOrdinary.body)
  assert.ok(counts.usernames.every(username => username === 'ordinary'))
  assert.equal(counts.channels, 0)
  db.exec("DELETE FROM role_tools WHERE tool = 'ssh-axi'")
  const denied = await invoke(['host', 'list'])
  assert.equal(denied.statusCode, 403, denied.body)
  assert.equal(denied.json().error.code, 'TOOL_NOT_GRANTED')
  assert.deepEqual(readdirSync(join(directory, 'calls')), [])
  const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
  assert.doesNotMatch(audit, /CANARY|PRIVATE KEY|BEGIN RSA/)
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE tool = 'ssh-axi' AND action = 'read'").get())
  console.log(JSON.stringify({ ssh: 'passed', transports: counts.transports, authenticatedAccounts: [...new Set(counts.usernames)], remoteChannels: counts.channels,
    discovery: 'caller-filtered', trust: 'strict', addressSet: 'fixed', sudoFallback: 'refused', credentialCleanup: 'passed' }))
} finally {
  await app.close()
  for (const connection of connections) connection.end()
  await new Promise<void>(resolve => peer.close(() => resolve()))
  db.close(); rmSync(directory, { recursive: true, force: true })
}
