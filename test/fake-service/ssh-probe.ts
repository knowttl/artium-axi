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
let ordinary = parse(ordinaryKey, passphrase)
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
const hostKey = `${approved.type} ${approved.getPublicSSH().toString('base64')}`
const store = createCredentialStore(db, provider)
const hosts = new SshHosts(db, provider)
const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, credentialStore: store,
  sshHosts: hosts, resolver: new SharedIdentityResolver(store), environment: {},
  adapters: [createSshAdapter(hosts, join(directory, 'writes.log'))] })
try {
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  assert.equal(login.statusCode, 200, login.body)
  const headers = { authorization: `Bearer ${login.json().accessToken}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  assert.equal(reauth.statusCode, 200, reauth.body)
  const revisions = new Map<string, number>()
  const admin = async (path: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: `/v1/admin/ssh/${path}`,
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { confirm: true, ...payload } })
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json() as { id: string, revision: number }
    revisions.set(result.id, result.revision)
  }
  const saveKey = (id: string, privateKey: string) => admin('credential', { id, privateKey, passphrase, expectedRevision: revisions.get(id) ?? 0 })
  await saveKey('ordinary-key', ordinaryKey)
  await saveKey('sudo-key', sudoKey)
  for (const id of ['granted', 'hidden']) {
    await admin('hosts', { id, address: '127.0.0.1', port, approvedHostKeys: [hostKey], allowedAddresses: ['127.0.0.1'],
      independentVerification: 'Synthetic isolated SSH peer key', enabled: true, readOnly: true,
      commandSeconds: 600, outputBytes: 65536, idleMinutes: 60, expectedRevision: 0 })
    await admin('binding', { host: id, username: 'ordinary', credential: 'ordinary-key', sudo: false, expectedRevision: revisions.get(id) })
  }
  await admin('binding', { host: 'granted', username: 'sudo-account', credential: 'sudo-key', sudo: true, expectedRevision: revisions.get('granted') })
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: true, sudo: true, expectedRevision: revisions.get('granted') })
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
  const replacement = makeKey(true)
  ordinary = parse(replacement, passphrase)
  await saveKey('ordinary-key', replacement)
  const rotated = await invoke(['doctor', 'granted', '--json'])
  assert.equal(rotated.json().exitCode, 0, rotated.body)
  assert.equal(JSON.parse(rotated.json().stdout).authenticated, true)
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
  await saveKey('ordinary-key', sudoKey)
  const failedOrdinary = await invoke(['doctor', 'granted', '--json'])
  assert.notEqual(failedOrdinary.json().exitCode, 0, failedOrdinary.body)
  assert.ok(counts.usernames.every(username => username === 'ordinary'))
  assert.equal(counts.channels, 0)
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: false, sudo: false, expectedRevision: revisions.get('granted') })
  assert.equal((await invoke(['doctor', 'granted'])).statusCode, 404)
  assert.deepEqual(JSON.parse((await invoke(['host', 'list', '--json'])).json().stdout).hosts, [])
  db.exec("DELETE FROM role_tools WHERE tool = 'ssh-axi'")
  const denied = await invoke(['host', 'list'])
  assert.equal(denied.statusCode, 403, denied.body)
  assert.equal(denied.json().error.code, 'TOOL_NOT_GRANTED')
  assert.deepEqual(readdirSync(join(directory, 'calls')), [])
  const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
  assert.doesNotMatch(audit, /CANARY|PRIVATE KEY|BEGIN RSA/)
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE tool = 'ssh-axi' AND action = 'read'").get())
  console.log(JSON.stringify({ ssh: 'passed', transports: counts.transports, authenticatedAccounts: [...new Set(counts.usernames)], remoteChannels: counts.channels,
    discovery: 'caller-filtered', trust: 'strict', addressSet: 'fixed', sudoFallback: 'refused', credentialCleanup: 'passed',
    administration: 'public-api', keyRotation: 'authenticated', grantRevocation: 'immediate' }))
} finally {
  await app.close()
  for (const connection of connections) connection.end()
  await new Promise<void>(resolve => peer.close(() => resolve()))
  db.close(); rmSync(directory, { recursive: true, force: true })
}
