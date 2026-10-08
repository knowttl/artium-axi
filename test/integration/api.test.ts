import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { Audit } from '../../src/server/audit/audit.js'
import { readDevelopmentToken } from '../../src/server/auth/development.js'
import { errorResponseSchema, runSuccessSchema, toolsResponseSchema, inputLimits } from '../../src/shared/api.js'
import { errors } from '../../src/shared/errors.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { fakeTool } from '../fake-tool/tool.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let url: string
const token = 'CANARY-static-development-token'
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const getCredential = vi.fn(async () => ({ clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }))
let environment: NodeJS.ProcessEnv
let options: Parameters<typeof createApp>[0]

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-api-'))
  const tokenFile = join(directory, 'development-token')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  environment = { ARTIUM_AXI_DEV: '1', ARTIUM_AXI_DEV_TOKEN_FILE: tokenFile }
  db = openStore(join(directory, 'data', 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.3.0' WHERE name = 'falcon-axi'")
  const runner = await Runner.create(join(directory, 'calls'))
  const adapter = createFalconAdapter({ getCredential })
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference) => {
    const prepared = await prepare(args, reference)
    return { ...prepared, executable: fakeTool.executable, args: [...fakeTool.args, ...args], limits: { timeoutMs: 5000 },
      environment: { ...prepared.environment, ARTIUM_TEST_CANARY: prepared.environment.FALCON_CLIENT_SECRET } }
  })
  getCredential.mockClear()
  options = { db, runner, audit: new Audit(db), environment, adapters: [adapter],
    resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference: { id: 'synthetic-credential', tool: 'falcon-axi' }, value: {} }])) }
  app = createApp(options)
  url = await app.listen({ host: '127.0.0.1', port: 0 })
})
afterEach(async () => {
  await app.close()
  if (db.open) db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function run(body: unknown, requestHeaders = headers) {
  return fetch(`${url}/v1/tools/falcon-axi/run`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) })
}

async function expectFailure(response: Response, code: keyof typeof errors) {
  expect(response.status).toBe(errors[code].status)
  const body = errorResponseSchema.parse(await response.json())
  expect(body).toEqual({ error: { code, source: 'artium-axi', message: errors[code].message,
    next: errors[code].next, requestId: expect.any(String) } })
  return body.error.requestId
}

test('real requests list tools without retrieving credentials and preserve the completed upstream envelope', async () => {
  const listing = await fetch(`${url}/v1/tools`, { headers })
  expect(listing.status).toBe(200)
  expect(toolsResponseSchema.parse(await listing.json())).toEqual({ tools: [{ name: 'falcon-axi', version: '0.3.0', status: 'unconfigured' }] })
  expect(getCredential).not.toHaveBeenCalled()
  const response = await run({ args: ['upstream', 'vectra-axi', 'error'] })
  expect(response.status).toBe(200)
  const result = runSuccessSchema.parse(await response.json())
  expect(result.exitCode).not.toBe(0)
  expect(result.source).toBe('falcon-axi')
  expect(result.outputBytes).toEqual({ stdout: Buffer.byteLength(result.stdout), stderr: Buffer.byteLength(result.stderr) })
  expect(result.truncated).toEqual({ stdout: false, stderr: false })
})

test('audit is durable before credential preparation and child admission and identifies the socket address', async () => {
  const runChild = options.runner.run.bind(options.runner)
  vi.spyOn(options.runner, 'run').mockImplementation(async (...args) => {
    expect(db.prepare('SELECT event FROM audit').all()).toEqual([{ event: 'run-start' }])
    return runChild(...args)
  })
  getCredential.mockImplementationOnce(async () => {
    expect(db.prepare('SELECT event, user_id, client_address FROM audit').all()).toEqual([
      { event: 'run-start', user_id: 'synthetic-development-user', client_address: '127.0.0.1' },
    ])
    return { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }
  })
  const response = await run({ args: ['print', 'synthetic-output'], stdin: 'synthetic-input',
    files: [{ name: 'input.txt', contentBase64: Buffer.from('synthetic-file').toString('base64') }] })
  expect(response.status).toBe(200)
  expect(runSuccessSchema.parse(await response.json()).stdout).toBe('synthetic-output')
  expect(db.prepare('SELECT event, request_id FROM audit ORDER BY id').all()).toEqual([
    { event: 'run-start', request_id: expect.any(String) }, { event: 'run-terminal', request_id: expect.any(String) },
  ])
  expect(db.prepare('SELECT COUNT(DISTINCT request_id) AS count FROM audit').get()).toEqual({ count: 1 })
  expect(db.prepare('SELECT administrator FROM users').get()).toEqual({ administrator: 0 })
  await expectFailure(await fetch(`${url}/v1/admin/users`, { headers }), 'NOT_FOUND')
})

test.each([
  [{ args: ['--region=synthetic'] }, 'FLAG_BLOCKED'],
  [{ args: ['print'], environment: {} }, 'INVALID_INPUT'],
  [{ args: ['print'], files: [{ name: '../input', contentBase64: 'YQ==' }] }, 'INVALID_INPUT'],
  [{ args: ['print'], files: [{ name: 'input', contentBase64: 'YQ=' }] }, 'INVALID_INPUT'],
  [{ args: ['print'], files: [{ name: 'input', contentBase64: 'YQ==' }, { name: 'input', contentBase64: 'YQ==' }] }, 'INVALID_INPUT'],
  [{ args: ['print'], stdin: 'x'.repeat(inputLimits.stdinBytes + 1) }, 'INVALID_INPUT'],
] as const)('invalid body is rejected before credentials: %j', async (body, code) => {
  const requestId = await expectFailure(await run(body), code)
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare('SELECT event, outcome FROM audit WHERE request_id = ?').all(requestId)).toEqual([{ event: 'denial', outcome: code }])
})

test('current role removal denies the next request and produces an empty tools list', async () => {
  db.exec('DELETE FROM role_tools')
  await expectFailure(await run({ args: ['exit', '0'] }), 'TOOL_NOT_GRANTED')
  expect(await (await fetch(`${url}/v1/tools`, { headers })).json()).toEqual({ tools: [] })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['role_tools', 'user_roles'])('restart preserves revoked development policy in %s', async table => {
  db.exec(`DELETE FROM ${table}`)
  await expectFailure(await run({ args: ['exit', '0'] }), 'TOOL_NOT_GRANTED')
  await app.close()
  db.close()
  db = openStore(join(directory, 'data', 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  options = { ...options, db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')) }
  app = createApp(options)
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  await expectFailure(await run({ args: ['exit', '0'] }), 'TOOL_NOT_GRANTED')
  expect(await (await fetch(`${url}/v1/tools`, { headers })).json()).toEqual({ tools: [] })
  expect(getCredential).not.toHaveBeenCalled()
})

test('HTTP shutdown cancels an active child before draining requests and closing storage', async () => {
  await app.close()
  options.runner = await Runner.create(join(directory, 'calls'))
  app = createApp(options)
  const readyFile = join(directory, 'ready.json')
  const runChild = options.runner.run.bind(options.runner)
  vi.spyOn(options.runner, 'run').mockImplementation((userId, executable, args, environment, secrets, limits, input) =>
    runChild(userId, executable, args, { ...environment, ARTIUM_TEST_READY_FILE: readyFile }, secrets, limits, input))
  let watcher: ReturnType<typeof watch>
  const ready = new Promise<number>((resolve, reject) => {
    watcher = watch(directory, (_event, name) => {
      if (name !== 'ready.json') return
      watcher.close()
      try { resolve(JSON.parse(readFileSync(readyFile, 'utf8')).parent) } catch (error) { reject(error) }
    })
  })
  let terminal: unknown
  app.addHook('onClose', async () => {
    terminal = db.prepare("SELECT event, outcome FROM audit ORDER BY id").all()
    db.close()
  })
  try {
    url = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = run({ args: ['sleep', '60000'] })
    const pid = await ready
    const closing = app.close()
    await expectFailure(await response, 'CANCELLED')
    await closing
    expect(terminal).toEqual([{ event: 'run-start', outcome: 'started' }, { event: 'run-terminal', outcome: 'CANCELLED' }])
    expect(db.open).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally { watcher!.close() }
}, 10_000)

test('authentication failures use the exact envelope on both endpoints', async () => {
  await expectFailure(await fetch(`${url}/v1/tools`), 'TOKEN_INVALID')
  await expectFailure(await run({ args: ['exit', '0'] }, { ...headers, authorization: 'Bearer CANARY-wrong' }), 'TOKEN_INVALID')
  expect(getCredential).not.toHaveBeenCalled()
})

test('supported tools without an adapter still authenticate and audit their denial', async () => {
  const endpoint = `${url}/v1/tools/vectra-axi/run`
  await expectFailure(await fetch(endpoint, { method: 'POST', headers, body: '{"args":[]}' }), 'TOOL_DISABLED')
  await expectFailure(await fetch(endpoint, { method: 'POST', headers: { ...headers, authorization: 'Bearer CANARY-wrong' }, body: '{"args":[]}' }), 'TOKEN_INVALID')
  expect(db.prepare('SELECT tool, outcome FROM audit ORDER BY id').all()).toEqual([
    { tool: 'vectra-axi', outcome: 'TOOL_DISABLED' }, { tool: 'vectra-axi', outcome: 'TOKEN_INVALID' },
  ])
})

test.each([{}, { ARTIUM_AXI_DEV: '1' }, { ARTIUM_AXI_DEV: '1', ARTIUM_AXI_DEV_TOKEN_FILE: '/synthetic-missing-token' }])('startup rejects unavailable development token files', env => {
  expect(() => readDevelopmentToken(env)).toThrow(expect.objectContaining({ code: 'DEV_AUTH_INVALID' }))
})

test('audit failure refuses child creation and terminal failure withholds completed output', async () => {
  db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await run({ args: ['print', 'synthetic-output'] }), 'AUDIT_UNAVAILABLE')
  expect(getCredential).not.toHaveBeenCalled()
  db.exec("DROP TRIGGER fail_start; CREATE TRIGGER fail_terminal BEFORE INSERT ON audit WHEN NEW.event = 'run-terminal' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  await expectFailure(await run({ args: ['print', 'synthetic-output'] }), 'AUDIT_UNAVAILABLE')
  expect(getCredential).toHaveBeenCalledOnce()
})

test('a known-secret child output returns only the safe failure envelope', async () => {
  await expectFailure(await run({ args: ['leak'] }), 'SECRET_IN_OUTPUT')
  expect(db.prepare("SELECT outcome, stdout_bytes FROM audit WHERE event = 'run-terminal'").get())
    .toEqual({ outcome: 'SECRET_IN_OUTPUT', stdout_bytes: 13 })
})

test('bundled CLI runs through the real API and withholds environment-mode canary output', async () => {
  const { build } = await import('esbuild')
  const bundle = join(directory, 'artium-axi.mjs')
  await build({ entryPoints: ['src/cli/main.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22.12' })
  const execute = promisify(execFile)
  const settings = { cwd: directory, timeout: 10_000,
    env: { PATH: process.env.PATH, ...environment, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }
  const result = await execute(process.execPath, [bundle, 'falcon-axi', 'print', 'synthetic output'], settings)
  expect(result).toEqual({ stdout: 'synthetic output', stderr: '' })
  await expect(execute(process.execPath, [bundle, 'falcon-axi', 'env'], settings))
    .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '' })
  const terminal = db.prepare("SELECT outcome, stdout_bytes FROM audit WHERE event = 'run-terminal' ORDER BY id").all()
  expect(terminal).toEqual([{ outcome: 'completed', stdout_bytes: 16 }, { outcome: 'SECRET_IN_OUTPUT', stdout_bytes: expect.any(Number) }])
})

test.each(['stdout', 'stderr'])('security: bundled CLI withholds every encoded canary in %s and records only safe metadata', async stream => {
  const { build } = await import('esbuild')
  const bundle = join(directory, 'artium-axi.mjs')
  await build({ entryPoints: ['src/cli/main.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22.12' })
  const execute = promisify(execFile)
  const canary = 'CANARY-☃ÿ?/+='
  for (const form of ['raw', 'base64', 'base64url', 'url']) {
    getCredential.mockResolvedValueOnce({ clientId: 'CANARY-client', clientSecret: canary, region: 'us-2' })
    await expect(execute(process.execPath, [bundle, 'falcon-axi', 'leak', form, stream], { cwd: directory, timeout: 10_000,
      env: { PATH: process.env.PATH, ...environment, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }))
      .rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '' })
  }
  const records = db.prepare("SELECT tool, outcome, arguments FROM audit WHERE event = 'run-terminal'").all()
  expect(records).toEqual(Array(4).fill({ tool: 'falcon-axi', outcome: 'SECRET_IN_OUTPUT', arguments: null }))
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(canary)
})

test('malformed JSON, content type, unknown tool and body byte limit use safe errors', async () => {
  await expectFailure(await fetch(`${url}/v1/tools/falcon-axi/run`, { method: 'POST', headers, body: '{' }), 'INVALID_INPUT')
  await expectFailure(await run({ args: [] }, { ...headers, 'content-type': 'text/plain' }), 'INVALID_INPUT')
  await expectFailure(await fetch(`${url}/v1/tools/unknown/run`, { method: 'POST', headers, body: '{"args":[]}' }), 'INVALID_INPUT')
  await expectFailure(await run({ args: [], stdin: 'x'.repeat(inputLimits.requestBytes) }), 'INVALID_INPUT')
  expect(getCredential).not.toHaveBeenCalled()
})

test('health is public and checks local storage without retrieving credentials', async () => {
  for (const endpoint of ['live', 'ready']) {
    const response = await fetch(`${url}/health/${endpoint}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  }
  db.close()
  const response = await fetch(`${url}/health/ready`)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'unavailable' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'])('security rejects spoofed %s from untrusted sockets', async header => {
  await expectFailure(await run({ args: ['exit', '0'] }, { ...headers, [header]: '192.0.2.17' }), 'PROXY_HEADERS_UNTRUSTED')
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 })
})

test('a real trusted proxy replaces supplied forwarding headers and audits its verified client address', async () => {
  await app.close()
  options.runner = await Runner.create(join(directory, 'proxy-calls'))
  app = createApp({ ...options, environment: { ...environment, ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' } })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const result = await fetch(`${url}${request.url}`, { method: request.method,
      headers: { ...headers, 'x-forwarded-for': '192.0.2.42' }, body: Buffer.concat(chunks) })
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(await result.text())
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const address = proxy.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/tools/falcon-axi/run`, {
      method: 'POST', headers: { ...headers, 'x-forwarded-for': '192.0.2.99' }, body: JSON.stringify({ args: ['exit', '0'] }) })
    expect(response.status).toBe(200)
    expect(db.prepare("SELECT client_address FROM audit WHERE event = 'run-start'").get()).toEqual({ client_address: '192.0.2.42' })
  } finally { await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) }
})

test.each([undefined, '0', 'true', '01'])('startup refuses a configured dev token unless the gate equals 1: %s', value => {
  expect(() => readDevelopmentToken({ ...environment, ARTIUM_AXI_DEV: value })).toThrow(expect.objectContaining({ code: 'DEV_AUTH_INVALID' }))
  expect(() => createApp({ ...options, environment: { ...environment, ARTIUM_AXI_DEV: value } })).toThrow(expect.objectContaining({ code: 'DEV_AUTH_INVALID' }))
})

test('the real server process exits at startup with the dev setting absent', async () => {
  const { build } = await import('esbuild')
  const entry = join(directory, 'server.mjs')
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  await build({ entryPoints: ['src/server/main.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(entry)})`], {
    cwd: process.cwd(), env: { ...process.env, ...environment, ARTIUM_AXI_DEV: '0' }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'DEV_AUTH_INVALID', requestId: 'startup' } })
})

test('the real server remains available after startup encounters a damaged native journal', async () => {
  const { build } = await import('esbuild')
  const entry = join(directory, 'server.mjs')
  const logDirectory = join(directory, 'data', 'tool-logs', 'vectra-axi')
  const journal = join(logDirectory, 'writes.log')
  const damaged = '{"kind":"intent","synthetic":"CANARY-partial'
  mkdirSync(logDirectory, { recursive: true })
  writeFileSync(journal, damaged, { mode: 0o600 })
  writeFileSync(`${journal}.lock`, '')
  writeFileSync(`${journal}.retention`, 'interrupted compaction')
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  cpSync('src/server/store/migrations', join(directory, 'migrations'), { recursive: true })
  await build({ stdin: { contents: `
    import { Server } from 'node:net';
    import { serverDefaults } from './src/server/config.ts';
    Object.assign(serverDefaults, { host: '127.0.0.1', port: 0, temporaryDirectory: ${JSON.stringify(join(directory, 'startup-calls'))} });
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => process.stdout.write(JSON.stringify(this.address()) + '\\n'));
      return listen.apply(this, args);
    };
    await import('./src/server/main.ts');
  `, resolveDir: process.cwd() }, outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const child = spawn(process.execPath, [entry], { cwd: directory,
    env: { ...process.env, ...environment, ARTIUM_AXI_DATABASE_FILE: join(directory, 'data', 'artium.db'),
      ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const closed = once(child, 'close')
  try {
    const [output] = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error(stderr) })])
    const address = JSON.parse(output.toString()) as { port: number }
    const origin = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${origin}/health/ready`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    const listing = await fetch(`${origin}/v1/tools`, { headers })
    expect(listing.status).toBe(200)
    expect(toolsResponseSchema.parse(await listing.json()).tools).toContainEqual({ name: 'falcon-axi', version: '0.3.0', status: 'unconfigured' })
    expect(readFileSync(journal, 'utf8')).toBe(damaged)
  } finally {
    child.kill('SIGTERM')
    await closed
  }
  expect(stderr.trim().split('\n').map(line => JSON.parse(line))).toEqual(expect.arrayContaining([
    { error: { code: 'AUDIT_UNAVAILABLE', source: 'artium-axi', message: errors.AUDIT_UNAVAILABLE.message,
      next: errors.AUDIT_UNAVAILABLE.next, requestId: 'retention' } },
  ]))
  expect(stderr).not.toContain('CANARY-partial')
}, 10_000)
