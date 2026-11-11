import assert from 'node:assert/strict'
import { decode } from '@toon-format/toon'
import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queryObjects } from 'node:v8'
import type { ParsedKey, Connection } from 'ssh2'
import { createSshAdapter } from '../../src/server/adapters/ssh.js'
import { Runner } from '../../src/server/runner/runner.js'
import { SecretScanner } from '../../src/server/runner/scan.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { runnerLimits, toolPaths } from '../../src/server/config.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { SessionStore, sessionPath } from '../../src/cli/session.js'
import { sshExecutionStatus } from '../../src/shared/ssh-execution.js'
import { backupStore, restoreStore } from '../../src/server/store/backup.js'
import { rotateKey } from '../../src/server/store/rotate-key.js'
import { decryptCredential, type EncryptedCredential } from '../../src/server/store/crypto.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'

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
const events = new EventEmitter()
const terminals = new Set<string>()
const commands: string[] = []
let writesEnabled = false
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
  connection.on('session', (accept, reject) => {
    counts.channels++
    if (!writesEnabled) { reject(); return }
    accept().on('exec', (acceptCommand, _reject, info) => {
      const stream = acceptCommand()
      counts.commands++; commands.push(info.command)
      events.emit('command', info.command)
      if (info.command === 'synthetic-hold') return
      if (info.command === 'synthetic-output') stream.write('x'.repeat(12000))
      else if (info.command === 'synthetic-flood') stream.write(Buffer.alloc(17 * 1024 * 1024, 120))
      else if (info.command === 'synthetic-secret-output') stream.write(passphrase)
      else if (info.command.includes('synthetic-sudo-denied')) {
        stream.stderr.write('sudo: a password is required\n'); stream.exit(1); stream.end(); return
      }
      else stream.write('synthetic-result\n')
      stream.exit(0); stream.end()
    })
  })
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
const app = createApp({ db, audit: new Audit(db, Date.now, line => {
  const record = JSON.parse(line) as { event: string, request_id: string }
  if (record.event === 'run-terminal') { terminals.add(record.request_id); events.emit(record.request_id) }
}), runner, credentialStore: store, sshExecution: { provider, writeLog: join(directory, 'writes.log') },
  sshHosts: hosts, resolver: new SharedIdentityResolver(store, db), environment: {},
  adapters: [createSshAdapter(hosts, join(directory, 'writes.log'))] })
let dropSubmitReply = false
app.addHook('onSend', async (request, reply, payload) => {
  if (dropSubmitReply && request.url === '/v1/ssh/submit') { dropSubmitReply = false; reply.raw.destroy() }
  return payload
})
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
  assert.deepEqual(JSON.parse(help.json().stdout).commands, ['host list', 'host show', 'doctor', 'exec',
    'connection open', 'connection list', 'connection show', 'connection set', 'connection close', 'execution list', 'execution show', 'execution cancel'])
  assert.doesNotMatch(help.json().stdout, /--config|--profile/)
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
  const failedConnection = await app.inject({ method: 'POST', url: '/v1/ssh/connection/open', headers, payload: { host: 'granted' } })
  assert.equal(failedConnection.json().error.code, 'UPSTREAM_AUTH_FAILED', failedConnection.body)
  assert.ok(counts.usernames.every(username => username === 'ordinary'))
  assert.equal(counts.channels, 0)
  const occupyRunner = () => Array.from({ length: runnerLimits.globalCalls }, (_, index) => {
    const controller = new AbortController()
    let admitted!: () => void
    const ready = new Promise<void>(resolve => { admitted = resolve })
    const pending = runner.run(`synthetic-blocker-${index}`, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, [],
      { signal: controller.signal }, {}, [], admitted)
    return { controller, ready, pending }
  })
  const blockers = occupyRunner()
  try {
    await Promise.all(blockers.map(blocker => blocker.ready))
    const queued = invoke(['doctor', 'granted', '--json'])
    await new Promise<void>(resolve => setImmediate(resolve))
    const beforeRevocation = counts.transports
    await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: false, sudo: false, expectedRevision: revisions.get('granted') })
    for (const blocker of blockers) blocker.controller.abort()
    await Promise.allSettled(blockers.map(blocker => blocker.pending))
    const revoked = await queued
    assert.equal(revoked.json().error?.code, 'CREDENTIAL_INVALID', revoked.body)
    assert.equal(counts.transports, beforeRevocation)
  } finally {
    for (const blocker of blockers) blocker.controller.abort()
    await Promise.allSettled(blockers.map(blocker => blocker.pending))
  }
  assert.equal((await invoke(['doctor', 'granted'])).statusCode, 404)
  assert.deepEqual(JSON.parse((await invoke(['host', 'list', '--json'])).json().stdout).hosts, [])
  await saveKey('ordinary-key', replacement)
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: true, sudo: true, expectedRevision: revisions.get('granted') })
  await admin('hosts', { id: 'granted', address: '127.0.0.1', port, approvedHostKeys: [hostKey], allowedAddresses: ['127.0.0.1'],
    independentVerification: 'Synthetic isolated SSH peer key', enabled: true, readOnly: false,
    commandSeconds: 600, outputBytes: 65536, idleMinutes: 60, expectedRevision: revisions.get('granted') })
  const execution = (route: string, payload: Record<string, unknown>, identity = headers) => app.inject({ method: 'POST', url: `/v1/ssh/${route}`, headers: identity, payload })
  const setWrites = async (enabled: boolean) => {
    const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
    const detail = await app.inject({ url: '/v1/admin/tools/ssh-axi', headers: proof })
    assert.equal(detail.statusCode, 200, detail.body)
    const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ssh-axi/write-access',
      headers: proof, payload: { enabled, expectedRevision: detail.json().revision } })
    assert.equal(response.statusCode, 200, response.body)
  }
  const input = { host: 'granted', command: 'id', confirm: true }
  assert.equal((await execution('prepare', input)).json().error.code, 'FLAG_BLOCKED')
  await setWrites(true)
  writesEnabled = true
  const prepare = async (command: string, extra: Record<string, unknown> = {}) => {
    const selected = { ...input, command, ...extra }
    const prepared = await execution('prepare', selected)
    assert.equal(prepared.statusCode, 200, prepared.body)
    return { requestKey: prepared.json().requestKey as string, input: selected }
  }
  const submit = async (prepared: Awaited<ReturnType<typeof prepare>>) => {
    const response = await execution('submit', prepared)
    assert.equal(response.statusCode, 200, response.body)
    return sshExecutionStatus.parse(response.json())
  }
  const finish = async (row: ReturnType<typeof sshExecutionStatus.parse>) => {
    if (row.outcome === 'running' && !terminals.has(String(row.requestId))) await once(events, String(row.requestId), { signal: AbortSignal.timeout(20000) })
    const response = await execution('show', { id: row.id })
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as ReturnType<typeof sshExecutionStatus.parse> & { stdout: { text: string, truncated: boolean, withheld: boolean } }
  }
  const prepared = await prepare('id')
  const beforeCommand = counts.commands
  const duplicate = await Promise.all([submit(prepared), submit(prepared)])
  assert.equal(duplicate[0].id, duplicate[1].id)
  const completed = await finish(duplicate[0])
  assert.equal(completed.outcome, 'completed', JSON.stringify(completed))
  assert.equal(completed.stdout.text, 'synthetic-result\n')
  assert.equal(counts.commands, beforeCommand + 1)
  assert.equal((await submit(prepared)).id, completed.id)
  assert.equal(counts.commands, beforeCommand + 1)
  const otherLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  const other = { authorization: `Bearer ${otherLogin.json().accessToken}` }
  assert.equal((await execution('show', { id: completed.id }, other)).json().error.code, 'NOT_FOUND')
  const openConnection = async (extra: Record<string, unknown> = {}, identity = headers) => {
    const response = await execution('connection/open', { host: 'granted', ...extra }, identity)
    assert.equal(response.statusCode, 200, response.body)
    return response.json() as { id: string, state: string, expiresAt: string }
  }
  const closeConnection = async (id: string, identity = headers, confirm = false) => {
    const response = await execution('connection/close', { id, confirm }, identity)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().state, 'closed')
  }
  // R4: retain closed metadata, but release the real worker and its secret scanner at close.
  const retainedResources = () => ({ workers: queryObjects(ChildProcess, { format: 'count' }) as number,
    scanners: queryObjects(SecretScanner, { format: 'count' }) as number })
  await new Promise<void>(resolve => setImmediate(resolve))
  const retainedBefore = retainedResources()
  const reusable = await openConnection()
  assert.deepEqual(retainedResources(),
    { workers: retainedBefore.workers + 1, scanners: retainedBefore.scanners + 1 })
  const reusedTransport = counts.transports
  const firstReuse = await finish(await submit(await prepare('id', { connection: reusable.id })))
  const secondReuse = await finish(await submit(await prepare('printf synthetic', { connection: reusable.id })))
  assert.equal(firstReuse.connectionId, reusable.id)
  assert.equal(secondReuse.outcome, 'completed')
  assert.equal(counts.transports, reusedTransport)
  assert.equal((await execution('connection/show', { id: reusable.id }, other)).json().error.code, 'NOT_FOUND')
  assert.deepEqual((await execution('connection/list', {}, other)).json().connections, [])
  const remoteStarted = once(events, 'command', { signal: AbortSignal.timeout(20000) })
  const held = await submit(await prepare('synthetic-hold', { connection: reusable.id }))
  await remoteStarted
  const activeView = await execution('connection/show', { id: reusable.id })
  assert.equal(Date.parse(activeView.json().expiresAt) - Date.parse(activeView.json().openedAt), 8 * 3600000)
  const claimedBeforeBusy = db.prepare('SELECT count(*) AS count FROM ssh_executions').get()
  const busy = await execution('prepare', { ...input, connection: reusable.id })
  assert.equal(busy.json().error.code, 'CONNECTION_BUSY')
  assert.deepEqual(db.prepare('SELECT count(*) AS count FROM ssh_executions').get(), claimedBeforeBusy)
  const unconfirmedClose = await execution('connection/close', { id: reusable.id, confirm: false })
  assert.equal(unconfirmedClose.json().error.code, 'INVALID_INPUT')
  const cancelled = await execution('cancel', { id: held.id, confirm: true })
  assert.equal(cancelled.json().outcome, 'cancelled', cancelled.body)
  assert.equal(cancelled.json().termination, 'unknown')
  await closeConnection(reusable.id)
  await closeConnection(reusable.id)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(retainedResources(), retainedBefore,
    'R4: closed connection metadata must not retain workers, listeners or secret-scanner buffers')
  assert.equal((await execution('prepare', { ...input, connection: reusable.id })).json().error.code, 'CONNECTION_CLOSED')
  assert.equal(counts.transports, reusedTransport)
  const tokenAdapter = createSshAdapter(hosts, join(directory, 'writes.log'))
  const mint = () => createDelegation(db, 'synthetic-development-user', { label: 'Synthetic', scope: { tools: [{ tool: 'ssh-axi' }] },
    readOnly: false, reusable: true, expiresAt: Date.now() + 600000 }, [tokenAdapter])
  const firstToken = mint()
  const secondToken = mint()
  const firstDelegate = { authorization: `Bearer ${exchangeDelegation(db, firstToken.token).accessToken}` }
  const secondDelegate = { authorization: `Bearer ${exchangeDelegation(db, secondToken.token).accessToken}` }
  const firstConnection = await openConnection({}, firstDelegate)
  const secondConnection = await openConnection({}, secondDelegate)
  const delegateLimit = await execution('connection/open', { host: 'granted' }, firstDelegate)
  assert.equal(delegateLimit.json().error.code, 'TOO_MANY_CALLS')
  assert.match(delegateLimit.json().error.message, /two per creator/)
  const ownerConnections = [await openConnection(), await openConnection()]
  const startHeld = async (identity: typeof headers, connection: string) => {
    const selected = { ...input, command: 'synthetic-hold', connection }
    const preparation = await execution('prepare', selected, identity)
    assert.equal(preparation.statusCode, 200, preparation.body)
    const started = once(events, 'command', { signal: AbortSignal.timeout(20000) })
    const submitted = await execution('submit', { requestKey: preparation.json().requestKey, input: selected }, identity)
    assert.equal(submitted.statusCode, 200, submitted.body)
    await started
    return submitted.json() as { id: string }
  }
  const delegatedHeld = await startHeld(firstDelegate, firstConnection.id)
  const ownerHeld = await startHeld(headers, ownerConnections[0].id)
  const revoked = await app.inject({ method: 'POST', url: `/v1/account/tokens/${firstToken.id}/revoke`, headers })
  assert.equal(revoked.statusCode, 204, revoked.body)
  assert.notEqual((db.prepare('SELECT outcome FROM ssh_executions WHERE id = ?').get(delegatedHeld.id) as { outcome: string }).outcome, 'running')
  assert.equal((await execution('connection/show', { id: secondConnection.id }, secondDelegate)).json().state, 'idle')
  assert.equal((await execution('show', { id: ownerHeld.id })).json().outcome, 'running')
  assert.equal((await execution('connection/show', { id: firstConnection.id }, firstDelegate)).json().error.code, 'TOKEN_INVALID')
  await execution('cancel', { id: ownerHeld.id, confirm: true })
  await closeConnection(secondConnection.id, secondDelegate)
  await Promise.all(ownerConnections.map(connection => closeConnection(connection.id, headers, true)))
  db.exec('UPDATE delegation_settings SET minting_enabled=0')
  const activeClose = await openConnection()
  const activeStarted = once(events, 'command', { signal: AbortSignal.timeout(20000) })
  const closedExecution = await submit(await prepare('synthetic-hold', { connection: activeClose.id }))
  await activeStarted
  await closeConnection(activeClose.id, headers, true)
  assert.notEqual((await execution('show', { id: closedExecution.id })).json().outcome, 'running')
  const sudoConnection = await openConnection({ sudo: true })
  assert.equal(counts.usernames.at(-1), 'sudo-account')
  const mismatchedMode = await execution('prepare', { ...input, connection: sudoConnection.id })
  assert.equal(mismatchedMode.json().error.code, 'NOT_FOUND')
  const sudoReuse = await finish(await submit(await prepare('id', { connection: sudoConnection.id, sudo: true })))
  assert.equal(sudoReuse.outcome, 'completed')
  assert.equal(commands.at(-1), "sudo -n -- /bin/sh -c 'id'")
  await closeConnection(sudoConnection.id)
  const realPerformanceNow = performance.now.bind(performance)
  let clockOffset = 0
  Object.defineProperty(performance, 'now', { configurable: true, value: () => realPerformanceNow() + clockOffset })
  try {
    const expiring = await openConnection()
    assert.equal((await execution('connection/show', { id: expiring.id })).json().expiresAt, expiring.expiresAt)
    clockOffset += 61000
    const shortened = await execution('connection/set', { id: expiring.id, idle: 1 })
    assert.equal(shortened.json().state, 'closed', shortened.body)
    const aged = await openConnection()
    for (let index = 0; index < 53; index++) {
      clockOffset += 9 * 60000
      assert.equal((await finish(await submit(await prepare('id', { connection: aged.id })))).outcome, 'completed')
    }
    clockOffset += 4 * 60000
    assert.equal((await execution('connection/show', { id: aged.id })).json().state, 'closed')
    assert.equal((await execution('connection/list', {})).json().count, 0)
    const activeAge = await openConnection()
    const ageStarted = once(events, 'command', { signal: AbortSignal.timeout(20000) })
    const agedExecution = await submit(await prepare('synthetic-hold', { connection: activeAge.id }))
    await ageStarted
    clockOffset += 8 * 3600000
    assert.equal((await execution('connection/show', { id: activeAge.id })).json().state, 'closed')
    assert.notEqual((await execution('show', { id: agedExecution.id })).json().outcome, 'running')
  } finally { Object.defineProperty(performance, 'now', { configurable: true, value: realPerformanceNow }) }
  const userCapacity = await Promise.all(Array.from({ length: 4 }, () => openConnection()))
  const userLimit = await execution('connection/open', { host: 'granted' }, other)
  assert.equal(userLimit.json().error.code, 'TOO_MANY_CALLS')
  await Promise.all(userCapacity.map(connection => closeConnection(connection.id)))
  const globalCapacity: { id: string, identity: typeof headers }[] = []
  try {
    for (let index = 0; index < 4; index++) {
      const user = `synthetic-connection-cap-${index}`
      db.prepare(`INSERT INTO users (id,username,display_name,password_hash,must_change)
        SELECT ?,?, ?,password_hash,0 FROM users WHERE id='synthetic-development-user'`).run(user, user, user)
      db.prepare("INSERT INTO user_roles (user_id,role_id) VALUES (?,'synthetic-role')").run(user)
      db.prepare("INSERT INTO ssh_grants (user_id,host_id,shell,sudo) VALUES (?,'granted',1,0)").run(user)
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user, password: 'CANARY-local-password' } })
      assert.equal(response.statusCode, 200, response.body)
      const identity = { authorization: `Bearer ${response.json().accessToken}` }
      const opened = await Promise.all(Array.from({ length: 4 }, () => openConnection({}, identity)))
      globalCapacity.push(...opened.map(connection => ({ id: connection.id, identity })))
    }
    const globalLimit = await execution('connection/open', { host: 'granted' })
    assert.equal(globalLimit.json().error.code, 'TOO_MANY_CALLS')
  } finally { await Promise.all(globalCapacity.map(connection => closeConnection(connection.id, connection.identity))) }
  const rotatingConnection = await openConnection()
  await saveKey('ordinary-key', replacement)
  assert.equal((await execution('connection/show', { id: rotatingConnection.id })).json().state, 'closed')
  const revokingConnection = await openConnection()
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: false, sudo: false, expectedRevision: revisions.get('granted') })
  assert.equal(connections.size, 0)
  assert.deepEqual(readdirSync(join(directory, 'connections')), [])
  assert.equal((await execution('connection/show', { id: revokingConnection.id })).json().error.code, 'NOT_FOUND')
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: true, sudo: true, expectedRevision: revisions.get('granted') })
  const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
  const auditPage = await app.inject({ url: '/v1/admin/ssh/audit', headers: proof })
  assert.equal(auditPage.statusCode, 200, auditPage.body)
  assert.equal(auditPage.json().executions.length, 50)
  assert.ok(auditPage.json().nextCursor)
  const older = await app.inject({ url: `/v1/admin/ssh/audit?before=${auditPage.json().nextCursor}`, headers: proof })
  assert.ok(older.json().executions.some((row: { id: string }) => row.id === completed.id))
  const exported = await app.inject({ url: '/v1/admin/ssh/audit/export', headers: proof })
  assert.equal(exported.statusCode, 200, exported.body)
  assert.doesNotMatch(exported.body, /synthetic-result|CANARY|PRIVATE KEY/)
  assert.ok(exported.json().executions.every((row: { stdout?: { text?: string } }) => row.stdout?.text === undefined))
  const bounded = await finish(await submit(await prepare('synthetic-output')))
  assert.equal(bounded.stdout.text, 'x'.repeat(8192))
  assert.equal(bounded.stdout.truncated, true)
  const flooded = await finish(await submit(await prepare('synthetic-flood')))
  assert.equal(flooded.outcome, 'unknown', JSON.stringify(flooded))
  assert.equal(flooded.stdout.text.length, 8192)
  const protectedOutput = await finish(await submit(await prepare('synthetic-secret-output')))
  assert.equal(protectedOutput.stdout.withheld, true)
  assert.doesNotMatch(JSON.stringify(protectedOutput), /CANARY/)
  const quoted = `printf '%s\\n' 'quoted value' | cat`
  const sudoResult = await finish(await submit(await prepare(quoted, { sudo: true })))
  assert.equal(sudoResult.outcome, 'completed')
  assert.equal(counts.usernames.at(-1), 'sudo-account')
  assert.equal(commands.at(-1), `sudo -n -- /bin/sh -c '${quoted.replaceAll("'", "'\\''")}'`)
  const sudoDenied = await finish(await submit(await prepare('synthetic-sudo-denied', { sudo: true })))
  assert.equal(sudoDenied.code, 'SUDO_DENIED')
  const deadline = await finish(await submit(await prepare('synthetic-hold', { timeout: 1 })))
  assert.equal(deadline.outcome, 'timed_out', JSON.stringify(deadline))
  const started = once(events, 'command', { signal: AbortSignal.timeout(20000) })
  const active = await submit(await prepare('synthetic-hold'))
  await started
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: false, sudo: false, expectedRevision: revisions.get('granted') })
  assert.equal((await execution('show', { id: active.id })).json().error.code, 'NOT_FOUND')
  await admin('grant', { host: 'granted', user: 'synthetic-development-user', shell: true, sudo: true, expectedRevision: revisions.get('granted') })
  const interrupted = await execution('show', { id: active.id })
  assert.notEqual(interrupted.json().outcome, 'running', interrupted.body)
  assert.equal(connections.size, 0)
  await setWrites(false)
  assert.equal((await execution('show', { id: completed.id })).json().outcome, 'completed')
  assert.equal((await execution('prepare', input)).json().error.code, 'FLAG_BLOCKED')
  const readOnlyConnection = await openConnection()
  await setWrites(true)
  assert.equal((await execution('connection/show', { id: readOnlyConnection.id })).json().state, 'closed')
  const queuedBlockers = occupyRunner()
  try {
    await Promise.all(queuedBlockers.map(blocker => blocker.ready))
    const prepared = await prepare('id')
    const beforeQueued = counts.transports
    const queued = await submit(prepared)
    await setWrites(false)
    assert.equal(counts.transports, beforeQueued)
    assert.equal((await execution('show', { id: queued.id })).json().outcome, 'unknown')
  } finally {
    for (const blocker of queuedBlockers) blocker.controller.abort()
    await Promise.allSettled(queuedBlockers.map(blocker => blocker.pending))
  }
  await setWrites(true)
  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  const environment = { ...process.env, ARTIUM_AXI_URL: serverUrl, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: join(directory, 'client') }
  new SessionStore(serverUrl, sessionPath(process.platform, environment)).write(otherLogin.json())
  const cli = (args: string[], onSpawn?: (child: ChildProcess) => void) => new Promise<{ code: number | null, value: Record<string, unknown> }>((resolve, reject) => {
    const child = spawn(process.execPath, ['/work/dist/cli/artium-axi.mjs', 'ssh-axi', ...args, '--json'], { env: environment, stdio: 'pipe' })
    let output = ''; let error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => {
      try { resolve({ code, value: (output.startsWith('{') ? JSON.parse(output) : decode(output)) as Record<string, unknown> }) }
      catch { reject(new Error(`${code}: ${output} ${error}`)) }
    })
    onSpawn?.(child)
    child.stdin.end()
  })
  const cliResult = await cli(['exec', 'granted', '--command', 'id', '--confirm'])
  assert.equal(cliResult.code, 0, JSON.stringify(cliResult))
  assert.equal(cliResult.value.outcome, 'completed')
  const receiptDirectory = join(directory, 'client', 'artium-axi', 'ssh-executions')
  const receipt = readFileSync(join(receiptDirectory, 'latest.json'), 'utf8')
  assert.doesNotMatch(receipt, /"command"|CANARY|accessToken|refreshToken/)
  assert.equal(lstatSync(join(receiptDirectory, 'latest.json')).mode & 0o077, 0)
  const beforeRecovery = counts.commands
  assert.equal((await cli(['execution', 'show'])).value.id, cliResult.value.id)
  assert.equal(counts.commands, beforeRecovery)
  dropSubmitReply = true
  const lost = await cli(['exec', 'granted', '--command', 'id', '--confirm'])
  assert.notEqual(lost.code, 0)
  const recovered = await cli(['execution', 'show'])
  assert.equal(recovered.code, 0, JSON.stringify(recovered))
  const recoveredRow = recovered.value
  if (recoveredRow.outcome === 'running' && !terminals.has(String(recoveredRow.requestId))) await once(events, String(recoveredRow.requestId), { signal: AbortSignal.timeout(20000) })
  assert.equal((await cli(['execution', 'show'])).value.id, recoveredRow.id)
  assert.equal(counts.commands, beforeRecovery + 1)
  const cliConnection = await cli(['connection', 'open', 'granted', '--idle-timeout', '1m'])
  assert.equal(cliConnection.code, 0, JSON.stringify(cliConnection))
  const cliId = String(cliConnection.value.id)
  const beforeCliReuse = counts.transports
  const cliExecution = await cli(['exec', 'granted', '--connection', cliId, '--command', 'id', '--confirm'])
  assert.equal(cliExecution.value.outcome, 'completed')
  assert.equal(cliExecution.value.connectionId, cliId)
  assert.equal(counts.transports, beforeCliReuse)
  assert.ok(JSON.stringify((await cli(['connection', 'list'])).value).includes(cliId))
  const cliSet = await cli(['connection', 'set', cliId, '--idle-timeout', '2m'])
  assert.equal(cliSet.value.idleTimeout, '2m')
  assert.equal((await cli(['execution', 'show', String(cliExecution.value.id), '--full'])).value.samples, 'available')
  const cliExecutions = await cli(['execution', 'list'])
  assert.ok(JSON.stringify(cliExecutions.value).includes(String(cliExecution.value.id)))
  assert.ok(!JSON.stringify(cliExecutions.value).includes(completed.id))
  assert.equal((await cli(['connection', 'close', cliId])).value.state, 'closed')
  assert.equal((await cli(['connection', 'close', cliId])).value.state, 'closed')
  const interruptAtCommand = once(events, 'command', { signal: AbortSignal.timeout(20000) })
  const interruptedCli = await cli(['exec', 'granted', '--command', 'synthetic-hold', '--confirm'], child => {
    void interruptAtCommand.then(() => child.kill('SIGINT'))
  })
  assert.equal(interruptedCli.code, 130, JSON.stringify(interruptedCli))
  assert.equal(interruptedCli.value.outcome, 'cancelled')
  assert.equal((await cli(['execution', 'cancel', String(interruptedCli.value.id), '--confirm'])).value.outcome, 'cancelled')
  db.exec("DELETE FROM role_tools WHERE tool = 'ssh-axi'")
  const denied = await invoke(['host', 'list'])
  assert.equal(denied.statusCode, 403, denied.body)
  assert.equal(denied.json().error.code, 'TOOL_NOT_GRANTED')
  assert.equal((await execution('show', { id: completed.id })).json().error.code, 'TOOL_NOT_GRANTED')
  assert.deepEqual(readdirSync(join(directory, 'calls')), [])
  const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
  assert.doesNotMatch(audit, /CANARY|PRIVATE KEY|BEGIN RSA/)
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE tool = 'ssh-axi' AND action = 'read'").get())
  db.exec("INSERT INTO role_tools (role_id,tool) VALUES ('synthetic-role','ssh-axi')")
  await app.close()
  const launch = async () => {
    const child = spawn(process.execPath, ['/work/dist/test/fake-service/ssh-execution-server.js', directory], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 4).toString('base64') },
    })
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(20000) }) as [{ url: string }]
    return { child, url: message.url }
  }
  const stop = async (server: Awaited<ReturnType<typeof launch>>, signal: NodeJS.Signals) => {
    const exited = once(server.child, 'exit', { signal: AbortSignal.timeout(20000) })
    server.child.kill(signal)
    await exited
  }
  const external = async (server: Awaited<ReturnType<typeof launch>>, route: string, payload: Record<string, unknown>) => {
    const response = await fetch(`${server.url}/v1/ssh/${route}`, { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const value = await response.json() as Record<string, unknown>
    assert.equal(response.status, 200, JSON.stringify(value))
    return value
  }
  let server = await launch()
  try {
    const persistent = await external(server, 'connection/open', { host: 'granted' })
    const restartInput = { ...input, command: 'synthetic-hold', timeout: 2, connection: persistent.id }
    const prepared = await external(server, 'prepare', restartInput)
    const started = once(events, 'command', { signal: AbortSignal.timeout(20000) })
    const claimed = await external(server, 'submit', { requestKey: prepared.requestKey, input: restartInput })
    await started
    const beforeRestart = counts.commands
    await stop(server, 'SIGKILL')
    server = await launch()
    const abandoned = await fetch(`${server.url}/v1/ssh/connection/show`, { method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: persistent.id }) })
    assert.equal(abandoned.status, 404)
    assert.deepEqual(readdirSync(join(directory, 'connections')), [])
    const recovered = await external(server, 'show', { requestKey: prepared.requestKey })
    assert.equal(recovered.id, claimed.id)
    assert.equal(recovered.outcome, 'unknown')
    const duplicate = await external(server, 'submit', { requestKey: prepared.requestKey, input: restartInput })
    assert.equal(duplicate.id, claimed.id)
    assert.equal(duplicate.outcome, 'unknown')
    assert.equal(counts.commands, beforeRestart)
  } finally { await stop(server, 'SIGTERM') }
  const backup = join(directory, 'backup.db')
  const restoredFile = join(directory, 'restored', 'artium.db')
  await backupStore(join(directory, 'data', 'artium.db'), backup, provider)
  restoreStore(backup, restoredFile, provider)
  const replacementProvider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  rotateKey(restoredFile, provider, replacementProvider)
  const restored = openStore(restoredFile, replacementProvider)
  try {
    assert.equal((restored.prepare('SELECT count(*) AS count FROM session_families').get() as { count: number }).count, 0)
    const result = restored.prepare('SELECT * FROM ssh_execution_results WHERE id=?').get(completed.id) as EncryptedCredential
    const plain = decryptCredential(result, replacementProvider.getKey())
    try { assert.equal(JSON.parse(plain.toString()).stdout.text, 'synthetic-result\n') } finally { plain.fill(0) }
    assert.equal((restored.prepare('SELECT command FROM ssh_executions WHERE id=?').get(completed.id) as { command: string }).command, 'id')
  } finally { restored.close() }
  console.log(JSON.stringify({ ssh: 'passed', transports: counts.transports, authenticatedAccounts: [...new Set(counts.usernames)], remoteChannels: counts.channels,
    discovery: 'caller-filtered', trust: 'strict', addressSet: 'fixed', sudoFallback: 'refused', credentialCleanup: 'passed',
    administration: 'public-api', keyRotation: 'authenticated', grantRevocation: 'immediate', execution: 'published-runtime',
    dispatch: 'one per durable key', sudo: 'distinct binding and exact quoting', recovery: 'private CLI receipt, lost response and hard restart',
    reusable: 'owned, one active command, bounded lifetime and capacity, no reconnection', cancellation: 'API, active close and CLI interrupt',
    retainedAudit: 'paged metadata-only exports', deadline: 'bounded', output: 'encrypted and capped' }))
} finally {
  await app.close()
  for (const connection of connections) connection.end()
  await new Promise<void>(resolve => peer.close(() => resolve()))
  db.close(); rmSync(directory, { recursive: true, force: true })
}
