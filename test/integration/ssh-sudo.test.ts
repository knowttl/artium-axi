import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Connection } from 'ssh2'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

const executable = join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js')
const ssh = createRequire(realpathSync(executable))('ssh2') as typeof import('ssh2')
const key = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'pkcs1' } }).privateKey
const parsed = ssh.utils.parseKey(key)
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid synthetic key')
const hostKey = `${parsed.type} ${parsed.getPublicSSH().toString('base64')}`
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
let directory: string
let db: ReturnType<typeof openStore>
let app: ReturnType<typeof createApp>
let hosts: SshHosts
let peer: InstanceType<typeof ssh.Server>
let headers: Record<string, string>
let password: string
let ordinaryPassword: string
let mode: 'password' | 'nopasswd' | 'cached' | 'wrong' | 'echo'
let journal: string[]
let commands: string[]
let inputs: string[]
const connections = new Set<Connection>()
let events: EventEmitter
let terminals: Set<string>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-sudo-'))
  password = randomBytes(24).toString('hex')
  ordinaryPassword = randomBytes(24).toString('hex')
  mode = 'password'; journal = []; commands = []; inputs = []; events = new EventEmitter(); terminals = new Set()
  peer = new ssh.Server({ hostKeys: [key] }, connection => {
    connections.add(connection)
    connection.on('error', () => {})
    connection.on('close', () => connections.delete(connection))
    connection.on('authentication', context => {
      if (context.method === 'password' && context.password === (context.username === 'sudo-account' ? password : ordinaryPassword)) context.accept()
      else if (context.method === 'publickey' && context.username === 'sudo-account'
        && context.key.data.equals(parsed.getPublicSSH())
        && (!context.signature || parsed.verify(context.blob!, context.signature, context.hashAlgo) === true)) context.accept()
      else context.reject(['password', 'publickey'])
    })
    connection.on('session', accept => accept().on('exec', (acceptCommand, _reject, info) => {
      const stream = acceptCommand()
      commands.push(info.command)
      const match = /^sudo -S -k -p (\S+) -- \/bin\/sh -c (.+)$/.exec(info.command)
      let received = ''
      stream.on('data', (chunk: Buffer) => { received += chunk.toString(); inputs.push(chunk.toString()) })
      const run = () => {
        const child = spawn('/bin/sh', ['-c', `/bin/sh -c ${match?.[2] ?? "'printf key-result'"}`], { stdio: ['pipe', 'pipe', 'pipe'] })
        stream.pipe(child.stdin)
        child.stdin.on('error', () => {})
        child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false })
        child.on('close', code => { stream.exit(code ?? 1); stream.end() })
      }
      if (!match || mode === 'nopasswd' || mode === 'cached') { run(); return }
      stream.stderr.write(match[1].slice(0, 7))
      stream.stderr.write(match[1].slice(7))
      stream.on('end', () => {
        if (mode === 'wrong') {
          stream.stderr.write(`${password}\nsudo: authentication failed\n${match[1]}`)
          stream.exit(1); stream.end()
        } else if (received === `${password}\n`) {
          if (mode === 'echo') stream.write(password)
          run()
        }
        else { stream.exit(1); stream.end() }
      })
    }))
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec(`UPDATE tools SET enabled=1, native_settings='{"allowWrites":true}' WHERE name='ssh-axi'`)
  hosts = new SshHosts(db, provider)
  hosts.replaceCredential('ordinary', { password: ordinaryPassword }, 0, 'synthetic-development-user')
  hosts.replaceCredential('sudo', { password }, 0, 'synthetic-development-user')
  db.prepare(`INSERT INTO ssh_hosts (id,address,port,approved_host_keys,allowed_addresses,enabled,read_only)
    VALUES ('lab','127.0.0.1',?,?,'["127.0.0.1"]',1,0)`).run((peer.address() as { port: number }).port, JSON.stringify([hostKey]))
  db.exec(`INSERT INTO ssh_bindings (host_id,username,credential_id,sudo) VALUES ('lab','ordinary','ordinary',0),('lab','sudo-account','sudo',1);
    INSERT INTO ssh_grants (user_id,host_id,shell,sudo) VALUES ('synthetic-development-user','lab',1,1)`)
  const store = createCredentialStore(db, provider)
  app = createApp({ db, audit: new Audit(db, Date.now, line => {
    journal.push(line)
    const record = JSON.parse(line) as { event: string, request_id: string }
    if (record.event === 'run-terminal') { terminals.add(record.request_id); events.emit(record.request_id) }
  }), runner: await Runner.create(join(directory, 'calls')), credentialStore: store,
  sshHosts: hosts, sshExecution: { provider, writeLog: join(directory, 'writes.log'), executable },
  resolver: new SharedIdentityResolver(store, db), adapters: [], environment: {} })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
})

afterEach(async () => {
  await app.close()
  for (const connection of connections) connection.end()
  await new Promise<void>(resolve => peer.close(() => resolve()))
  db.close(); rmSync(directory, { recursive: true, force: true })
})

const post = (route: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/v1/ssh/${route}`, headers, payload })
async function execute(command: string, connection?: string, sudo = true) {
  const input = { host: 'lab', command, confirm: true, sudo, ...(connection ? { connection } : {}) }
  const prepared = await post('prepare', input)
  expect(prepared.statusCode, prepared.body).toBe(200)
  const submitted = await post('submit', { requestKey: prepared.json().requestKey, input })
  expect(submitted.statusCode, submitted.body).toBe(200)
  const row = submitted.json()
  if (row.outcome === 'running' && !terminals.has(row.requestId)) await once(events, row.requestId, { signal: AbortSignal.timeout(15000) })
  return (await post('show', { id: row.id })).json()
}
async function open(sudo = true) {
  const response = await post('connection/open', { host: 'lab', sudo })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

test.each([false, true])('password sudo authenticates separately and gives the command /dev/null stdin (reusable=%s)', async reusable => {
  const connection = reusable ? await open() : undefined
  const result = await execute('readlink /proc/self/fd/0', connection)
  expect(result).toMatchObject({ outcome: 'completed', stdout: { text: '/dev/null\n' }, stderr: { text: '' } })
  expect(inputs).toEqual([`${password}\n`])
  expect(result.command).toBe('readlink /proc/self/fd/0')
})

test.each(['nopasswd', 'cached'] as const)('%s sudo sends no password and closes privileged command stdin', async selected => {
  mode = selected
  const result = await execute('readlink /proc/self/fd/0', await open())
  expect(result).toMatchObject({ outcome: 'completed', stdout: { text: '/dev/null\n' }, stderr: { text: '' } })
  expect(inputs).toEqual([])
})

test.each([false, true])('wrong sudo password is SUDO_DENIED without secret or marker disclosure (reusable=%s)', async reusable => {
  mode = 'wrong'
  const result = await execute('printf unreachable', reusable ? await open() : undefined)
  expect(result).toMatchObject({ outcome: 'failed', code: 'SUDO_DENIED' })
  expect(inputs).toEqual([`${password}\n`])
  const retained = JSON.stringify([result, journal, db.prepare('SELECT * FROM audit').all(), db.prepare('SELECT * FROM ssh_executions').all()])
  expect(retained).not.toContain(password)
  expect(retained).not.toContain(ordinaryPassword)
  expect(retained).not.toContain(commands[0].split(' ')[4])
})

test('reusable sudo worker receives only the separate sudo password through its environment', async () => {
  await open()
  const [leaf] = readdirSync(join(directory, 'connections'))
  const home = join(directory, 'connections', leaf, 'home')
  const pid = readdirSync('/proc').find(pid => {
    try { return realpathSync(`/proc/${pid}/cwd`) === home } catch { return false }
  })!
  const environment = readFileSync(`/proc/${pid}/environ`, 'utf8')
  expect(environment.split('\0')).toContain(`ARTIUM_SECRET_0=${password}`)
  expect(environment).not.toContain(ordinaryPassword)
  expect(readFileSync(`/proc/${pid}/cmdline`, 'utf8')).not.toContain(password)
})

test.each([false, true])('key sudo keeps the exact sudo -n command (reusable=%s)', async reusable => {
  hosts.replaceCredential('sudo', { privateKey: key }, 1, 'synthetic-development-user')
  const result = await execute('id', reusable ? await open() : undefined)
  expect(result).toMatchObject({ outcome: 'completed', stdout: { text: 'key-result' } })
  expect(commands).toEqual(["sudo -n -- /bin/sh -c 'id'"])
  expect(inputs).toEqual([])
})

test('ordinary password execution never enables password sudo mode', async () => {
  const result = await execute('id', await open(false), false)
  expect(result.outcome).toBe('completed')
  expect(commands).toEqual(['id'])
  expect(inputs).toEqual([])
})

test('sudo password in command text is refused before audit or dispatch', async () => {
  const response = await post('prepare', { host: 'lab', command: `printf ${password}`, confirm: true, sudo: true })
  expect(response.json().error.code).toBe('INVALID_INPUT')
  expect(commands).toEqual([])
  expect(db.prepare('SELECT * FROM ssh_executions').all()).toEqual([])
  expect(JSON.stringify(journal)).not.toContain(password)
})

test.each([false, true])('echoed sudo password is withheld (reusable=%s)', async reusable => {
  mode = 'echo'
  const result = await execute('printf safe', reusable ? await open() : undefined)
  expect(result).toMatchObject({ outcome: 'failed', stdout: { text: '', withheld: true }, stderr: { text: '', withheld: true } })
  expect(JSON.stringify([result, journal, db.prepare('SELECT * FROM audit').all()])).not.toContain(password)
})

test('reused password sudo generates distinct prompts for each run and strips both markers', async () => {
  const connection = await open()
  const first = await execute('printf first', connection)
  const second = await execute('printf second', connection)
  expect(first).toMatchObject({ stdout: { text: 'first' }, stderr: { text: '' } })
  expect(second).toMatchObject({ stdout: { text: 'second' }, stderr: { text: '' } })
  expect(commands[0].split(' ')[4]).not.toBe(commands[1].split(' ')[4])
  const retained = JSON.stringify([first, second, journal, db.prepare('SELECT * FROM ssh_executions').all()])
  expect(retained).not.toContain(commands[0].split(' ')[4])
  expect(retained).not.toContain(commands[1].split(' ')[4])
})

test.each([false, true])('successful sudo preserves the privileged command failure (reusable=%s)', async reusable => {
  const result = await execute("printf 'sudo: a password is required\\n' >&2; exit 7", reusable ? await open() : undefined)
  expect(result).toMatchObject({ outcome: 'failed', remoteExit: 7, stderr: { text: 'sudo: a password is required\n' } })
  expect(result.code).toBeUndefined()
})

test('a protocol-matching one-character password withholds the one-shot result', async () => {
  password = 'o'
  hosts.replaceCredential('sudo', { password }, 1, 'synthetic-development-user')
  const result = await execute('printf safe')
  expect(result.outcome).toBe('unknown')
  expect(result.stdout).toBeUndefined()
  expect(result.stderr).toBeUndefined()
})

test('a protocol-matching one-character password refuses a reusable connection', async () => {
  password = 'o'
  hosts.replaceCredential('sudo', { password }, 1, 'synthetic-development-user')
  const response = await post('connection/open', { host: 'lab', sudo: true })
  expect(response.json().error.code).toBe('CONNECTION_CLOSED')
  expect(commands).toEqual([])
  expect(inputs).toEqual([])
})
