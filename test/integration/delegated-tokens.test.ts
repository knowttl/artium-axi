import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { copyClientInput } from '../fixtures/client-inputs.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { createRunnerTestAdapter } from '../fake-tool/tool.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { createKubernetesAdapter } from '../../src/server/adapters/kubernetes.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { createGhAdapter } from '../../src/server/adapters/gh.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { createSshAdapter } from '../../src/server/adapters/ssh.js'
import { createUnifiAdapter } from '../../src/server/adapters/unifi.js'
import { SshHosts } from '../../src/server/store/ssh-hosts.js'
import { checkDelegation, classifyDelegatedCommand, createDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation, verifyPrincipal } from '../../src/server/auth/tokens.js'
import { ArtiumError } from '../../src/shared/errors.js'
import { decode } from '@toon-format/toon'
import { SessionStore } from '../../src/cli/session.js'
import type { ToolName } from '../../src/server/store/credential-store.js'
import proxmoxInventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let url: string
let bundle: string
let auditLines: string[]
let credentials: ReturnType<typeof createCredentialStore>
const password = 'CANARY-local-password'

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-delegated-cli-'))
  bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  db = openStore(join(directory, 'db', 'artium.db'), provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'; UPDATE delegation_settings SET minting_enabled = 1")
  credentials = createCredentialStore(db, provider)
  credentials.replaceCredential('falcon-axi', { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }, 0, 'synthetic-development-user', Date.now())
  auditLines = []
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db, Date.now, line => auditLines.push(line)),
    adapters: [createRunnerTestAdapter(new EmbeddedSecretSource(credentials), true)], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })

async function cli(args: string[], input = '', config = 'owner', privateOutput = false, environment: NodeJS.ProcessEnv = {}, managedSession?: { accessToken: string }) {
  const child = spawn(process.execPath, [bundle, ...args], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: join(directory, config),
    ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', ...environment }, stdio: ['pipe', 'pipe', 'pipe', privateOutput || managedSession ? 'pipe' : 'ignore', managedSession ? 'pipe' : 'ignore'] })
  let stdout = ''; let stderr = ''; let secret = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  if (privateOutput) (child.stdio[3] as Readable).on('data', chunk => { secret += chunk })
  if (managedSession) {
    (child.stdio[3] as Writable).end(JSON.stringify({ serverUrl: url, ...managedSession }))
    ;(child.stdio[4] as Readable).resume()
  }
  child.stdin!.end(input)
  const [code] = await once(child, 'close')
  return { code, stdout, stderr, secret: secret.trim(), argv: child.spawnargs }
}

async function mint(extra: string[] = []) {
  const result = await cli(['token', 'create', '--label', 'Synthetic', '--tool', 'falcon-axi', '--expires',
    new Date(Date.now() + 600_000).toISOString(), '--password-stdin', '--token-fd', '3', ...extra], `${password}\n`, 'owner', true)
  expect(result.code, result.stdout.match(/code: "[A-Z_]+"/)?.[0]).toBe(0)
  expect(result.secret.startsWith('artd_')).toBe(true)
  expect((result.stdout + result.stderr + result.argv.join(' ')).includes(result.secret)).toBe(false)
  return result.secret
}

test('minting writable SSH access warns about all granted hosts and sudo', async () => {
  await app.close()
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'ssh-axi'")
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  const hosts = new SshHosts(db, provider)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-ssh')), audit: new Audit(db),
    adapters: [createSshAdapter(hosts, join(directory, 'writes.log'))], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  const result = await cli(['token', 'create', '--label', 'Synthetic', '--tool', 'ssh-axi', '--expires',
    new Date(Date.now() + 600_000).toISOString(), '--write', '--password-stdin', '--token-fd', '3'], `${password}\n`, 'owner', true)
  expect(result.code, result.stdout).toBe(0)
  expect(result.stdout).toContain('SSH write access reaches every host and sudo grant available to the creator.')
})

test('token --command refuses wildcard selections without storing a token (R12)', async () => {
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  const minted = await cli(['token', 'create', '--label', 'Synthetic', '--command', 'falcon-axi:detection *', '--expires',
    new Date(Date.now() + 600_000).toISOString(), '--password-stdin', '--token-fd', '3'], `${password}\n`, 'owner', true)
  expect(minted.code, minted.stdout).toBe(2)
  expect(minted.stdout).toContain('Wildcards are not supported yet.')
  expect(minted.secret).toBe('')
  expect(db.prepare('SELECT count(*) AS count FROM delegations').get()).toEqual({ count: 0 })
})

test.each([
  { command: 'exec', grants: ['exec', 'execution show', 'execution cancel'] },
  { command: 'connection open', grants: ['connection open'] },
  { command: 'connection list', grants: ['connection list'] },
  { command: 'connection show', grants: ['connection show'] },
  { command: 'connection set', grants: ['connection set'] },
  { command: 'connection close', grants: ['connection close'] },
  { command: 'execution list', grants: ['execution list'] },
  { command: 'execution show', grants: ['execution show'] },
  { command: 'execution cancel', grants: ['execution cancel'] },
])('granted managed SSH $command help preserves native output (R2)', async ({ command, grants }) => {
  await app.close()
  db.exec(`UPDATE tools SET enabled = 1, native_settings = '{"allowWrites":true}' WHERE name = 'ssh-axi'`)
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  const adapter = createSshAdapter(new SshHosts(db, provider), join(directory, 'writes.log'),
    join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js'))
  const runner = await Runner.create(join(directory, 'calls-ssh-help'))
  app = createApp({ db, runner, audit: new Audit(db), adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'ssh-axi', commands: grants }] }, readOnly: false, reusable: false,
    expiresAt: Date.now() + 600_000 }, [adapter])
  expect((await cli(['login', '--token-stdin'], `${minted.token}\n`, 'agent')).code).toBe(0)
  const args = [...command.split(' '), '--help']
  const native = await runner.run('synthetic-development-user', process.execPath, [adapter.executable, ...args], {}, [],
    { timeoutMs: adapter.timeoutMs, trustedIpc: { revision: 1, hosts: [] } })
  expect(native.exitCode, native.stdout + native.stderr).toBe(0)
  const result = await cli(['ssh-axi', ...args], '', 'agent')
  expect(result.code, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toBe(native.stdout)
  expect(result.stderr).toBe(native.stderr)
})

test('non-granted managed SSH command help is refused (R2)', async () => {
  await app.close()
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'ssh-axi'")
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  const adapter = createSshAdapter(new SshHosts(db, provider), join(directory, 'writes.log'),
    join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js'))
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-ssh-help')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'ssh-axi', commands: ['execution list'] }] }, readOnly: true, reusable: false,
    expiresAt: Date.now() + 600_000 }, [adapter])
  expect((await cli(['login', '--token-stdin'], `${minted.token}\n`, 'agent')).code).toBe(0)
  const result = await cli(['ssh-axi', 'connection', 'list', '--help'], '', 'agent')
  expect(result.code).toBe(1)
  expect(result.stdout).toContain('DELEGATED_SCOPE_DENIED')
})

test.each([
  { pattern: '*' },
  { pattern: 'defender alerts *' },
  { pattern: 'monitor *' },
  { pattern: 'security *' },
  { pattern: 'security alert list *' },
])('minting refuses $pattern and cannot store its scope (R25)', async ({ pattern }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 1, native_settings = ? WHERE name = ?').run('{"allowWrites":true}', 'az-axi')
  const adapter = createAzAdapter(new EmbeddedSecretSource(credentials), join(directory, 'writes.log'))
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-wildcards')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const owner = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  const recent = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers: owner, payload: { password } })
  const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
    headers: { ...owner, 'x-artium-reauth-ticket': recent.json().ticket }, payload: { label: 'Synthetic',
      scope: { tools: [{ tool: 'az-axi', commands: [pattern] }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 600_000 } })
  expect(minted.statusCode, minted.body).toBe(400)
  expect(minted.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'Wildcards are not supported yet.' } })
  expect(db.prepare('SELECT count(*) AS count FROM delegations').get()).toEqual({ count: 0 })
})

test.each<{ tool: ToolName, command: string, args: string[], parse?: (text: string) => unknown, code?: number,
  expected?: { commands?: string[], error?: { code: string } } }>([
  { tool: 'kubernetes-axi', command: 'get', args: ['kubernetes-axi', '--help'] },
  { tool: 'kubernetes-axi', command: 'get', args: ['kubernetes-axi', 'workspace', '--help'], code: 2, expected: { error: { code: 'INVALID_INPUT' } } },
  { tool: 'ssh-axi', command: 'host list', args: ['ssh-axi', '--help'] },
  { tool: 'ssh-axi', command: 'host list', args: ['ssh-axi', 'connection', '--help'], code: 2, expected: { error: { code: 'FLAG_BLOCKED' } } },
  { tool: 'gh-axi', command: 'issue list', args: ['--help', 'gh-axi'] },
  { tool: 'unifi-axi', command: 'info', args: ['unifi-axi', 'commands'] },
  { tool: 'unifi-axi', command: 'info', args: ['unifi-axi', '--json', 'commands'], parse: JSON.parse },
  { tool: 'unifi-axi', command: 'info', args: ['unifi-axi', '--help'] },
  { tool: 'gh-axi', command: 'issue list', args: ['tools', 'show', 'gh-axi', '--help'] },
])('delegated CLI discovery $args stays scoped (R14, R20)', async ({ tool, command, args, parse = decode, code = 0, expected = { commands: [command] } }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  const source = new EmbeddedSecretSource(credentials)
  const writeLog = join(directory, 'writes.log')
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  const adapter = tool === 'kubernetes-axi'
    ? await createKubernetesAdapter(source, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))
    : tool === 'ssh-axi' ? createSshAdapter(new SshHosts(db, provider), writeLog)
    : tool === 'unifi-axi' ? createUnifiAdapter(source, writeLog) : createGhAdapter(source)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-discovery')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool, commands: [command] }] }, readOnly: true, reusable: false, expiresAt: Date.now() + 600_000 }, [adapter])
  expect((await cli(['login', '--token-stdin'], `${minted.token}\n`, 'agent')).code).toBe(0)
  const result = await cli([...args], '', 'agent')
  expect(result.code, result.stdout).toBe(code)
  const output = parse(result.stdout) as { commands: string[], example?: string, upstreamHelp?: string }
  expect(output).toMatchObject(expected)
  expect(output.example).toBeUndefined()
  expect(output.upstreamHelp).toBeUndefined()
  const session = new SessionStore(url, join(directory, 'agent', 'artium-axi', 'session.json')).read()
  if (session?.status !== 'authenticated') throw new Error('Expected delegated session')
  const managed = await cli(['--managed-session', ...args], '', 'agent', false, {}, { accessToken: session.accessToken })
  expect(managed.code, managed.stdout).toBe(code)
  expect(parse(managed.stdout)).toMatchObject(expected)
})

test('token creation refreshes an idle owner before password reauthentication (R6)', async () => {
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  const sessions = new SessionStore(url, join(directory, 'owner', 'artium-axi', 'session.json'))
  const session = sessions.read()
  if (session?.status !== 'authenticated') throw new Error('Expected ordinary session')
  const { loginGeneration, delegated, ...tokens } = session
  sessions.write({ ...tokens, accessExpiresAt: Date.now() - 1 }, loginGeneration, delegated)
  db.prepare("UPDATE tokens SET expires_at = ? WHERE type = 'access'").run(Date.now() - 1)
  const token = await mint()
  expect((await cli(['login', '--token-stdin'], `${token}\n`, 'agent')).code).toBe(0)
  expect(db.prepare("SELECT count(*) AS count FROM tokens WHERE type = 'refresh' AND consumed_at IS NOT NULL").get())
    .toEqual({ count: 1 })
  expect(db.prepare('SELECT count(*) AS count FROM delegations').get()).toEqual({ count: 1 })
})

const batchRoute = ['create', '/nodes/{node}/execute']
const custodyChildren = JSON.stringify([{ method: 'GET', path: 'version' }, { method: 'POST', path: 'qemu/100/vncproxy' }])
const custodyInput = JSON.stringify({ api: { node: 'synthetic-node', commands: custodyChildren }, secrets: {} })
const updateChildren = JSON.stringify([{ method: 'PUT', path: 'qemu/100/config', args: { description: 'Synthetic' } }])
const updateInput = JSON.stringify({ api: { node: 'synthetic-node', commands: updateChildren }, secrets: {} })
const nestedInput = JSON.stringify({ api: { node: 'synthetic-node', commands: JSON.stringify([
  { method: 'POST', path: 'execute', args: { commands: updateChildren } },
]) }, secrets: {} })
const batchConfirmation = `00000000-0000-4000-8000-000000000001.${'a'.repeat(64)}`

test.each([
  { label: 'custody preview with protected input', commands: ['create /nodes/{node}/execute', 'get /nodes/{node}/version'], readOnly: false,
    request: { args: [...batchRoute, '--protected-input', '--preview'], stdin: custodyInput }, code: 'DELEGATED_SCOPE_DENIED' },
  { label: 'custody confirmation with flags', commands: ['create /nodes/{node}/execute', 'get /nodes/{node}/version'], readOnly: false,
    request: { args: [...batchRoute, '--api-node', 'synthetic-node', '--api-commands', custodyChildren, '--confirm', batchConfirmation] }, code: 'DELEGATED_SCOPE_DENIED' },
  { label: 'nested update outside batch grant', commands: ['create /nodes/{node}/execute'], readOnly: false,
    request: { args: [...batchRoute, '--protected-input', '--preview'], stdin: nestedInput }, code: 'DELEGATED_SCOPE_DENIED' },
  { label: 'nested update covered by a sibling grant', commands: ['create /nodes/{node}/execute', 'set /nodes/{node}/qemu/{vmid}/config'], readOnly: false,
    request: { args: [...batchRoute, '--protected-input', '--preview'], stdin: nestedInput }, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { label: 'update confirmation outside batch grant', commands: ['create /nodes/{node}/execute'], readOnly: false,
    request: { args: [...batchRoute, '--protected-input', '--confirm', batchConfirmation], stdin: updateInput }, code: 'DELEGATED_SCOPE_DENIED' },
  { label: 'custody child picked exactly', commands: ['create /nodes/{node}/execute', 'get /nodes/{node}/version', 'create /nodes/{node}/qemu/{vmid}/vncproxy'], readOnly: false,
    request: { args: [...batchRoute, '--protected-input', '--preview'], stdin: custodyInput }, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { label: 'update covered by a sibling grant', commands: ['create /nodes/{node}/execute', 'set /nodes/{node}/qemu/{vmid}/config'], readOnly: false,
    request: { args: [...batchRoute, '--protected-input', '--preview'], stdin: updateInput }, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { label: 'read-only batch', commands: ['create /nodes/{node}/execute', 'set /nodes/{node}/qemu/{vmid}/config'], readOnly: true,
    request: { args: [...batchRoute, '--protected-input', '--preview'], stdin: updateInput }, code: 'DELEGATED_SCOPE_DENIED' },
])('Proxmox $label enforces child scope before credential resolution (custody probe, R22)', async ({ commands, readOnly, request, code }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 1, native_settings = ? WHERE name = ?').run(JSON.stringify({
    hostWrites: { allowWrites: true, operations: proxmoxInventory.writeOperations },
    writes: { allowWrites: true, operations: proxmoxInventory.writeOperations },
  }), 'proxmox-axi')
  const adapter = createProxmoxAdapter(new EmbeddedSecretSource(credentials), join(directory, 'writes.log'))
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-batch')), audit: new Audit(db),
    adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'proxmox-axi', commands }] }, readOnly, reusable: false, expiresAt: Date.now() + 600_000 }, [adapter])
  const exchanged = exchangeDelegation(db, minted.token)
  const response = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/run',
    headers: { authorization: `Bearer ${exchanged.accessToken}` }, payload: request })
  expect(response.json()).toMatchObject({ error: { code } })
})

test.each<{ tool: 'proxmox-axi' | 'unifi-axi', args: string[], allowed: string, blocked: string, parse?: (text: string) => unknown }>([
  { tool: 'unifi-axi', args: ['commands'], allowed: 'info', blocked: 'device adopt' },
  { tool: 'proxmox-axi', args: ['help'], allowed: 'get /version', blocked: 'create /nodes/{node}/execute' },
  { tool: 'proxmox-axi', args: ['inventory'], allowed: 'get /version', blocked: 'create /nodes/{node}/execute' },
  { tool: 'proxmox-axi', args: ['--format', 'json', '--help'], allowed: 'get /version', blocked: 'create /nodes/{node}/execute', parse: JSON.parse },
  { tool: 'proxmox-axi', args: ['--format=json', '--help'], allowed: 'get /version', blocked: 'create /nodes/{node}/execute', parse: JSON.parse },
])('$tool API discovery $args is filtered before credentials (R21)', async ({ tool, args, allowed, blocked, parse = decode }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  const source = new EmbeddedSecretSource(credentials)
  const adapter = tool === 'proxmox-axi' ? createProxmoxAdapter(source) : createUnifiAdapter(source)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-listings')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic', scope: { tools: [{ tool }] },
    readOnly: true, reusable: false, expiresAt: Date.now() + 600_000 }, [adapter])
  const exchanged = exchangeDelegation(db, minted.token)
  const response = await app.inject({ method: 'POST', url: `/v1/tools/${tool}/run`,
    headers: { authorization: `Bearer ${exchanged.accessToken}` }, payload: { args } })
  expect(response.statusCode, response.body).toBe(200)
  const output = parse(response.json().stdout) as { commands: string[] }
  expect(output.commands).toContain(allowed)
  expect(output.commands).not.toContain(blocked)
})

test.each([
  { command: 'create', code: 0, text: '--title' },
  { command: 'edit', code: 1, text: 'DELEGATED_SCOPE_DENIED' },
])('delegated leaf issue $command help retains authorization and argument help (R20)', async ({ command, code, text }) => {
  await app.close()
  credentials.replaceCredential('gh-axi', { origin: 'https://git.synthetic.test', auth: 'token', token: 'CANARY-gh-help-token' },
    0, 'synthetic-development-user', Date.now())
  db.prepare('UPDATE tools SET enabled = 1, native_settings = ? WHERE name = ?')
    .run(JSON.stringify({ writes: { allowWrites: true, operations: ['issue create'] } }), 'gh-axi')
  const native = createGhAdapter(new EmbeddedSecretSource(credentials))
  const adapter = { ...native, async prepare(...args: Parameters<typeof native.prepare>) {
    return { ...await native.prepare(...args), executable: join(process.cwd(), 'tools/node_modules/.bin/gh-axi') }
  } }
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-leaf-help')), audit: new Audit(db),
    adapters: [adapter], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'gh-axi', commands: ['issue create'] }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 600_000 }, [adapter])
  expect((await cli(['login', '--token-stdin'], `${minted.token}\n`, 'agent')).code).toBe(0)
  const result = await cli(['gh-axi', 'issue', command, '--help'], '', 'agent')
  expect(result.code, result.stdout).toBe(code)
  expect(result.stdout).toContain(text)
  const session = new SessionStore(url, join(directory, 'agent', 'artium-axi', 'session.json')).read()
  if (session?.status !== 'authenticated') throw new Error('Expected delegated session')
  const managed = await cli(['--managed-session', 'gh-axi', 'issue', command, '--help'], '', 'agent', false, {}, { accessToken: session.accessToken })
  expect(managed.code, managed.stdout).toBe(code)
  expect(managed.stdout).toContain(text)
})

test.each([
  { selection: 'workspace create', args: ['workspace', 'create'], code: 0, text: 'artium-axi kubernetes-axi workspace <command>' },
  { selection: 'workspace show', args: ['workspace', 'show'], code: 0, text: 'artium-axi kubernetes-axi workspace <command>' },
  { selection: 'workspace download', args: ['workspace', 'download'], code: 0, text: 'artium-axi kubernetes-axi workspace <command>' },
  { selection: 'workspace delete', args: ['workspace', 'delete'], code: 0, text: 'artium-axi kubernetes-axi workspace <command>' },
  { selection: 'session list', args: ['session', 'list'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'session start exec', args: ['session', 'start', 'exec'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'session show', args: ['session', 'show'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'session output', args: ['session', 'output'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'session confirm', args: ['session', 'confirm'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'session cancel', args: ['session', 'cancel'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'session artifact', args: ['session', 'artifact'], code: 0, text: 'artium-axi kubernetes-axi session <command>' },
  { selection: 'tunnel', args: ['tunnel'], code: 0, text: 'artium-axi kubernetes-axi tunnel <session-id>' },
  { selection: 'credential', args: ['credential'], code: 0, text: 'artium-axi kubernetes-axi credential' },
  { selection: 'workspace create', args: ['session', 'start', 'exec'], code: 1, text: 'DELEGATED_SCOPE_DENIED' },
])('delegated hosted help respects the exact pick: $selection, $args', async ({ selection, args, code, text }) => {
  await app.close()
  db.prepare("UPDATE tools SET enabled=1, native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ allowWrites: true, sessions: { grants: { 'synthetic-development-user': ['exec'] } } }))
  const adapter = await createKubernetesAdapter(new EmbeddedSecretSource(credentials),
    join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-hosted-help')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const grant = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'kubernetes-axi', commands: [selection] }] }, readOnly: false, reusable: false,
    expiresAt: Date.now() + 600_000 }, [adapter])
  const session = exchangeDelegation(db, grant.token)
  new SessionStore(url, join(directory, 'agent', 'artium-axi', 'session.json')).write(session, undefined, true)
  const stored = await cli(['kubernetes-axi', ...args, '--help'], '', 'agent')
  expect(stored.code, stored.stdout).toBe(code)
  expect(stored.stdout).toContain(text)
  const managed = await cli(['--managed-session', 'kubernetes-axi', ...args, '--help'], '', 'agent', false, {}, { accessToken: session.accessToken })
  expect(managed.code, managed.stdout).toBe(code)
  expect(managed.stdout).toContain(text)
})

test.each([
  { selection: 'workspace show', args: ['workspace', 'show'], commands: ['workspace show <id>'], help: [] },
  { selection: 'session start exec', args: ['session', 'start', 'exec'],
    commands: ['session start <kind> [--workspace <id>] [--stdin-file <file>] -- <native arguments>'],
    help: ['Kinds: exec. Every kind needs its explicit caller grant; mutations additionally need Allow writes.'] },
])('delegated hosted help only advertises permitted commands and kinds: $selection', async ({ selection, args, commands, help }) => {
  await app.close()
  db.prepare("UPDATE tools SET enabled=1, native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ allowWrites: true, sessions: { grants: { 'synthetic-development-user': ['exec'] } } }))
  const adapter = await createKubernetesAdapter(new EmbeddedSecretSource(credentials),
    join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-hosted-help')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const grant = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'kubernetes-axi', commands: [selection] }] }, readOnly: false, reusable: false,
    expiresAt: Date.now() + 600_000 }, [adapter])
  const session = exchangeDelegation(db, grant.token)
  new SessionStore(url, join(directory, 'agent', 'artium-axi', 'session.json')).write(session, undefined, true)
  for (const format of [[], ['--json']]) {
    const stored = await cli(['kubernetes-axi', ...args, '--help', ...format], '', 'agent')
    const managed = await cli(['--managed-session', 'kubernetes-axi', ...args, '--help', ...format], '', 'agent', false, {}, { accessToken: session.accessToken })
    for (const result of [stored, managed]) {
      expect(result.code, result.stdout).toBe(0)
      const output = (format.length ? JSON.parse(result.stdout) : decode(result.stdout)) as { commands: string[], help: string[] }
      expect(output.commands).toEqual(commands)
      expect(output.help).toEqual(help)
    }
  }
})

test('read-only token limits real CLI calls and revocation stops the session', async () => {
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  const token = await mint()
  expect(JSON.stringify(db.prepare('SELECT * FROM delegations').all()).includes(token)).toBe(false)
  expect((await cli(['login', '--token-stdin'], `${token}\n`, 'owner')).code).toBe(2)
  const login = await cli(['login', '--token-stdin'], `${token}\n`, 'agent')
  expect(login.code).toBe(0)
  expect((login.stdout + login.stderr + login.argv.join(' ')).includes(token)).toBe(false)
  expect((await cli(['login', '--token-stdin'], `${token}\n`, 'other')).code).toBe(1)
  const tools = await cli(['tools'], '', 'agent')
  expect((tools.stdout + tools.stderr).includes(token)).toBe(false)
  expect(tools.stdout).toContain('falcon-axi')
  expect(tools.stdout).not.toContain('awx-axi')
  const help = await cli(['--help'], '', 'agent')
  expect(help.code, help.stdout).toBe(0)
  expect((decode(help.stdout) as { tools: { name: string }[] }).tools.map(tool => tool.name)).toEqual(['falcon-axi'])
  const read = await cli(['falcon-axi', 'detection', 'list'], '', 'agent')
  expect(read.stdout.includes(token)).toBe(false)
  expect(read.stdout).toContain('synthetic result')
  db.exec("DELETE FROM credentials WHERE tool = 'falcon-axi'")
  const calls = (db.prepare('SELECT COUNT(*) AS count FROM audit WHERE event = ?').get('run-start') as { count: number }).count
  for (const args of [['host', 'usb'], ['host', 'usb', '--help']]) {
    const refused = await cli(['falcon-axi', ...args], '', 'agent')
    expect(refused.stdout).toContain('DELEGATED_SCOPE_DENIED')
  }
  expect((db.prepare('SELECT COUNT(*) AS count FROM audit WHERE event = ?').get('run-start') as { count: number }).count).toBe(calls)
  const row = db.prepare('SELECT id FROM delegations').get() as { id: string }
  expect((await cli(['token', 'revoke', row.id])).code).toBe(0)
  expect((await cli(['falcon-axi', 'detection', 'list'], '', 'agent')).stdout).toContain('TOKEN_INVALID')
  expect(db.prepare("SELECT DISTINCT user_id, delegation_id FROM audit WHERE event IN ('run-start', 'run-terminal')").all())
    .toEqual([{ user_id: 'synthetic-development-user', delegation_id: row.id }])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(token)).toBe(false)
  expect(auditLines.join('').includes(token)).toBe(false)
  const admin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password } })
  const headers = { authorization: `Bearer ${admin.json().accessToken}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password } })
  const filtered = await app.inject({ method: 'GET', url: `/v1/admin/audit?delegationId=${row.id}`,
    headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket } })
  expect(filtered.statusCode).toBe(200)
  expect(filtered.json().records.every((record: { delegation_id: string, user_id: string }) =>
    record.delegation_id === row.id && record.user_id === 'synthetic-development-user')).toBe(true)
  expect(filtered.json().records.some((record: { event: string }) => record.event === 'run-start')).toBe(true)
})

test('disabling minting preserves existing tokens and revoke-all ends them', async () => {
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  const token = await mint(['--reusable'])
  db.exec('UPDATE delegation_settings SET minting_enabled = 0')
  const refused = await cli(['token', 'create', '--label', 'Synthetic', '--tool', 'falcon-axi', '--expires',
    new Date(Date.now() + 600_000).toISOString(), '--password-stdin', '--token-fd', '3'], `${password}\n`, 'owner', true)
  expect(refused.code).toBe(1)
  expect((await cli(['login', '--token-stdin'], `${token}\n`, 'agent')).code).toBe(0)
  const secondLogin = await cli(['login'], '', 'agent', false, { ARTIUM_AXI_TOKEN: token })
  expect(secondLogin.code).toBe(0)
  expect((secondLogin.stdout + secondLogin.stderr + secondLogin.argv.join(' ')).includes(token)).toBe(false)
  expect((await cli(['falcon-axi', 'detection', 'list'], '', 'agent')).code).toBe(0)
  const signIn = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password } })
  const headers = { authorization: `Bearer ${signIn.json().accessToken}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password } })
  const revoke = await app.inject({ method: 'POST', url: '/v1/admin/tokens/revoke-all', headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket } })
  expect(revoke.statusCode).toBe(204)
  expect((await cli(['falcon-axi', 'detection', 'list'], '', 'agent')).stdout).toContain('TOKEN_INVALID')
  expect((await cli(['login', '--token-stdin'], `${token}\n`, 'other')).code).toBe(1)
})

test('cookie-session token mutations require CSRF protection', async () => {
  const browser = createBrowserSession(db, 'synthetic-development-user', 'synthetic-csrf')
  for (const path of ['/v1/account/tokens', '/v1/account/tokens/00000000-0000-4000-8000-000000000001/revoke']) {
    const response = await app.inject({ method: 'POST', url: path,
      headers: { cookie: `artium-session=${browser.id}`, origin: 'http://synthetic.test', host: 'synthetic.test' }, payload: {} })
    expect(response.statusCode).toBe(403)
    expect(response.json().error.code).toBe('CSRF_INVALID')
  }
})

test('token expiry cannot exceed the administrator cap', async () => {
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  db.exec('UPDATE delegation_settings SET max_lifetime_ms = 60000')
  const result = await cli(['token', 'create', '--label', 'Synthetic', '--tool', 'falcon-axi', '--expires',
    new Date(Date.now() + 600_000).toISOString(), '--password-stdin', '--token-fd', '3'], `${password}\n`, 'owner', true)
  expect(result.code).toBe(2)
  expect(result.secret).toBe('')
  expect(db.prepare('SELECT count(*) AS count FROM delegations').get()).toEqual({ count: 0 })
})

test('revocation aborts an in-flight delegated read', async () => {
  await app.close()
  const readyFile = join(directory, 'ready.json')
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-running')), audit: new Audit(db),
    adapters: [createRunnerTestAdapter(new EmbeddedSecretSource(credentials), { readyFile })], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  const token = await mint()
  expect((await cli(['login', '--token-stdin'], `${token}\n`, 'agent')).code).toBe(0)
  const ready = new Promise<void>((resolve, reject) => {
    const watcher = watch(directory, (_event, name) => { if (name === 'ready.json') { watcher.close(); resolve() } })
    watcher.once('error', reject)
  })
  const read = cli(['falcon-axi', 'detection', 'list'], '', 'agent')
  await ready
  const row = db.prepare('SELECT id FROM delegations').get() as { id: string }
  expect((await cli(['token', 'revoke', row.id])).code).toBe(0)
  const result = await read
  expect(result.code).toBe(1)
  expect(result.stdout).toContain('CANCELLED')
})

test.each(['get /version', 'create /access/users/{userid}/token/{tokenid}'])('minting preserves the exact Proxmox route %s (R1)', async command => {
  await app.close()
  db.exec(`UPDATE tools SET enabled = 1, native_settings = '{"hostWrites":{"allowWrites":true,"operations":[]}}' WHERE name = 'proxmox-axi'`)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-proxmox')), audit: new Audit(db),
    adapters: [createProxmoxAdapter(new EmbeddedSecretSource(credentials))], environment: {},
    resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password } })
  const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
    headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { label: 'Synthetic',
      scope: { tools: [{ tool: 'proxmox-axi', commands: [command] }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 600_000 } })
  expect(minted.statusCode, minted.body).toBe(200)
  const exchanged = exchangeDelegation(db, minted.json().token)
  const tools = await app.inject({ url: '/v1/tools', headers: { authorization: `Bearer ${exchanged.accessToken}` } })
  expect(tools.json().tools[0].commands).toContain(command)
})

test.each([
  { tool: 'az-axi', args: [], pattern: 'group list', allowed: 'group list' },
  { tool: 'az-axi', args: ['--help'], pattern: 'group list', allowed: 'group list' },
  { tool: 'az-axi', args: ['-h'], pattern: 'group list', allowed: 'group list' },
  { tool: 'gh-axi', args: [], pattern: 'repo list', allowed: 'repo list' },
  { tool: 'gh-axi', args: ['--help'], pattern: 'repo list', allowed: 'repo list' },
  { tool: 'gh-axi', args: ['-h'], pattern: 'repo list', allowed: 'repo list' },
] as const)('$tool root discovery $args remains filtered before credential access (R8)', async ({ tool, args, pattern, allowed }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  const source = new EmbeddedSecretSource(credentials)
  const adapter = tool === 'az-axi' ? createAzAdapter(source, join(directory, 'writes.log')) : createGhAdapter(source)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-help')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool, commands: [pattern] }] }, readOnly: true, reusable: false, expiresAt: Date.now() + 600_000 }, [adapter])
  const exchanged = exchangeDelegation(db, minted.token)
  const response = await app.inject({ method: 'POST', url: `/v1/tools/${tool}/run`,
    headers: { authorization: `Bearer ${exchanged.accessToken}` }, payload: { args: [...args] } })
  expect(response.statusCode, response.body).toBe(200)
  const output = decode(response.json().stdout) as { commands: string[] }
  expect(output.commands).toContain(allowed)
  expect(output.commands).not.toContain('auth status')
})

test.each([
  { tool: 'kubernetes-axi', selection: 'prepare -- apply', canonical: 'apply', execution: ['prepare', '--', 'apply', '--help'], discovered: 'prepare -- apply' },
  { tool: 'kubernetes-axi', selection: 'server-dry-run -- apply', canonical: 'apply', execution: ['server-dry-run', '--', 'apply', '--help'], discovered: 'server-dry-run -- apply' },
  { tool: 'kubernetes-axi', selection: 'prepare -- create token', canonical: 'create token', execution: ['prepare', '--', 'create', 'token', '--help'], discovered: 'prepare -- create token' },
  { tool: 'kubernetes-axi', selection: 'server-dry-run -- create token', canonical: 'create token', execution: ['server-dry-run', '--', 'create', 'token', '--help'], discovered: 'server-dry-run -- create token' },
  { tool: 'kubernetes-axi', selection: 'native -- get', canonical: 'native -- get', execution: ['native', '--', 'get', '--help'], discovered: 'native -- get' },
  { tool: 'kubernetes-axi', selection: 'prepare -- create deployment', canonical: 'create deployment', execution: ['prepare', '--', 'create', 'deployment', '--help'], discovered: 'prepare -- create deployment' },
  { tool: 'ado-axi', selection: 'wi list', canonical: 'work-item list', execution: ['wi', 'list', '--help'], discovered: 'work-item list' },
  { tool: 'ado-axi', selection: 'prs list', canonical: 'pr list', execution: ['prs', 'list', '--help'], discovered: 'pr list' },
  { tool: 'gh-axi', selection: 'issue list', canonical: 'issue list', execution: ['issue', 'list', '-R', 'synthetic/repository', '--help'], discovered: 'issue list' },
  { tool: 'az-axi', selection: 'role assignment list', canonical: 'rbac list', execution: ['role', 'assignment', 'list', '--help'], discovered: 'rbac list' },
  { tool: 'proxmox-axi', selection: 'post /access/users/{userid}/token/{tokenid}', canonical: 'create /access/users/{userid}/token/{tokenid}', execution: ['post', '/access/users/{userid}/token/{tokenid}', '--help'], discovered: 'create /access/users/{userid}/token/{tokenid}' },
] as const)('$tool normalizes $selection from mint through execution and discovery (R15)', async ({ tool, selection, canonical, execution, discovered }) => {
  await app.close()
  db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'kubernetes-axi';
    UPDATE tools SET native_settings = '{"hostWrites":{"allowWrites":true,"operations":[]}}' WHERE name = 'proxmox-axi'`)
  const source = new EmbeddedSecretSource(credentials)
  const adapters = [createAdoAdapter(source), createGhAdapter(source), createAzAdapter(source, join(directory, 'writes.log')),
    createProxmoxAdapter(source), await createKubernetesAdapter(source,
      join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))]
  const adapter = adapters.find(item => item.name === tool)!
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-canonical')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password } })
  const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
    headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { label: 'Synthetic',
      scope: { tools: [{ tool, commands: [selection] }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 600_000 } })
  expect(minted.statusCode, minted.body).toBe(200)
  const stored = db.prepare('SELECT scope_json FROM delegations WHERE id = ?').get(minted.json().id) as { scope_json: string }
  expect(JSON.parse(stored.scope_json)).toEqual({ tools: [{ tool, commands: [canonical] }] })
  const classification = classifyDelegatedCommand(adapter, execution)
  expect(() => checkDelegation(stored.scope_json, false, adapter, classification.command, classification.effect)).not.toThrow()
  const exchanged = exchangeDelegation(db, minted.json().token)
  const delegated = { authorization: `Bearer ${exchanged.accessToken}` }
  const run = await app.inject({ method: 'POST', url: `/v1/tools/${tool}/run`, headers: delegated, payload: { args: [...execution] } })
  expect(run.json()).toMatchObject({ error: { code: 'CREDENTIAL_NOT_CONFIGURED' } })
  const tools = await app.inject({ url: '/v1/tools', headers: delegated })
  expect(tools.json().tools[0].commands).toContain(discovered)
})

test('Kubernetes token preparation requires an exact writable pick before resolving credentials', async () => {
  await app.close()
  db.exec(`UPDATE tools SET enabled = 1, native_settings = '{"allowWrites":true}' WHERE name = 'kubernetes-axi'`)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-kubernetes')), audit: new Audit(db),
    adapters: [await createKubernetesAdapter(new EmbeddedSecretSource(credentials),
      join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))],
    environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
  for (const [config, extra, expected] of [
    ['wide', ['--tool', 'kubernetes-axi', '--write'], 'DELEGATED_SCOPE_DENIED'],
    ['readonly', ['--exact', 'kubernetes-axi:create token'], 'DELEGATED_SCOPE_DENIED'],
    ['exact', ['--exact', 'kubernetes-axi:create token', '--write'], 'CREDENTIAL_NOT_CONFIGURED'],
  ] as const) {
    const minted = await cli(['token', 'create', '--label', 'Synthetic', '--expires', new Date(Date.now() + 600_000).toISOString(),
      '--password-stdin', '--token-fd', '3', ...extra], `${password}\n`, 'owner', true)
    expect(minted.code).toBe(0)
    expect((await cli(['login', '--token-stdin'], `${minted.secret}\n`, config)).code).toBe(0)
    const result = await cli(['kubernetes-axi', 'prepare', '--', 'create', 'token', 'synthetic-service-account'], '', config)
    expect((result.stdout + result.stderr).includes(minted.secret)).toBe(false)
    expect(result.stdout).toContain(expected)
  }
})

test.each([
  { grant: 'apply', operation: 'apply', readOnly: false, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { grant: 'create configmap', operation: 'create configmap', readOnly: false, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { grant: 'set env', operation: 'set env', readOnly: false, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { grant: 'apply', operation: 'create configmap', readOnly: false, code: 'DELEGATED_SCOPE_DENIED' },
  { grant: 'create configmap', operation: 'create token', readOnly: false, code: 'DELEGATED_SCOPE_DENIED' },
  { grant: 'create token', operation: 'create token', readOnly: false, code: 'CREDENTIAL_NOT_CONFIGURED' },
  { grant: 'apply', operation: 'apply', readOnly: true, code: 'DELEGATED_SCOPE_DENIED' },
  { grant: 'preview', operation: 'apply', readOnly: false, code: 'DELEGATED_SCOPE_DENIED' },
])('$grant authorizes saved $operation continuations before secret access, readOnly=$readOnly (R23)', async ({ grant, operation, readOnly, code }) => {
  await app.close()
  const root = join(directory, 'requests')
  const reference = credentials.replaceCredential('kubernetes-axi', { origin: 'https://cluster.synthetic.test', auth: 'token',
    namespace: 'synthetic', certificateAuthority: 'CANARY-CA', token: 'CANARY-kubernetes-token' }, 0, 'synthetic-development-user', Date.now())
  db.prepare('UPDATE tools SET enabled = 1, native_settings = ? WHERE name = ?').run('{"allowWrites":true}', 'kubernetes-axi')
  const adapter = await createKubernetesAdapter({ getCredential: async () => { throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED') },
    getSettings: () => ({ allowWrites: true }) }, join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), root)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls-continuations')), audit: new Audit(db),
    adapters: [adapter], environment: {}, resolver: new SharedIdentityResolver(credentials), credentialStore: credentials })
  const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
    scope: { tools: [{ tool: 'kubernetes-axi', commands: [grant] }] }, readOnly, reusable: false, expiresAt: Date.now() + 600_000 }, [adapter])
  const exchanged = exchangeDelegation(db, minted.token)
  const scope = createHash('sha256').update(JSON.stringify({ userId: 'synthetic-development-user',
    family: verifyPrincipal(db, exchanged.accessToken).familyId, reference })).digest('hex')
  const key = '00000000-0000-4000-8000-000000000001'
  const requestDirectory = join(root, scope, 'requests', key)
  await mkdir(requestDirectory, { recursive: true, mode: 0o700 })
  const signingKey = Buffer.alloc(32, 5).toString('hex')
  const plan = { version: 1, key, binding: 'b'.repeat(64), namespace: 'synthetic', command: operation,
    awaitDeletion: false, snapshots: [], changes: [], display: { command: operation, namespace: 'synthetic', selected: [], changes: [] } }
  const digest = createHmac('sha256', signingKey).update(JSON.stringify(plan)).digest('hex')
  await writeFile(join(requestDirectory, 'key'), signingKey, { mode: 0o600 })
  await writeFile(join(requestDirectory, 'request.json'), JSON.stringify({ plan, digest, state: 'prepared', results: [] }), { mode: 0o600 })
  const native = await import(pathToFileURL(join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/dist/mutations.js')).href)
  await native.preview({ config: join(root, scope, 'synthetic.json'), workflow: { kind: 'preview', key } })
  const headers = { authorization: `Bearer ${exchanged.accessToken}` }
  const preview = await app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/run', headers, payload: { args: ['preview', key] } })
  expect(preview.json()).toMatchObject({ error: { code } })
  const confirm = await app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/run', headers, payload: { args: ['confirm', key, '--digest', digest] } })
  expect(confirm.json()).toMatchObject({ error: { code } })
})

test.each(['expiry', 'role removal', 'creator disabled', 'password change'] as const)(
  '%s immediately removes a delegated session', async change => {
    expect((await cli(['login', '--username', 'synthetic-user', '--password-stdin'], `${password}\n`)).code).toBe(0)
    const token = await mint(['--reusable'])
    expect((await cli(['login', '--token-stdin'], `${token}\n`, 'agent')).code).toBe(0)
    if (change === 'expiry') db.exec('UPDATE delegations SET expires_at = created_at')
    if (change === 'role removal') db.exec("DELETE FROM user_roles WHERE user_id = 'synthetic-development-user'")
    if (change === 'creator disabled') {
      db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
        SELECT 'synthetic-admin', 'synthetic-admin', 'Synthetic Admin', password_hash, 1, 0 FROM users WHERE id = 'synthetic-development-user'`)
      const admin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-admin', password } })
      const headers = { authorization: `Bearer ${admin.json().accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password } })
      const disabled = await app.inject({ method: 'PATCH', url: '/v1/admin/users/synthetic-development-user',
        headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { enabled: false, expectedRevision: 1 } })
      expect(disabled.statusCode).toBe(200)
    }
    if (change === 'password change') {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password } })
      const changed = await app.inject({ method: 'POST', url: '/v1/auth/password',
        headers: { authorization: `Bearer ${response.json().accessToken}` },
        payload: { currentPassword: password, newPassword: 'CANARY-new-password-123!' } })
      expect(changed.statusCode).toBe(204)
    }
    const denied = await cli(['falcon-axi', 'detection', 'list'], '', 'agent')
    expect(denied.code).toBe(1)
    expect(denied.stdout).toContain(change === 'expiry' ? 'TOKEN_EXPIRED' : change === 'role removal' ? 'TOOL_NOT_GRANTED'
      : 'TOKEN_INVALID')
    if (change === 'password change' || change === 'creator disabled') {
      if (change === 'creator disabled') db.exec("UPDATE users SET disabled = 0 WHERE id = 'synthetic-development-user'")
      expect((await cli(['login', '--token-stdin'], `${token}\n`, 'other')).code).toBe(1)
    }
  },
)
