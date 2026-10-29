import { execFile, execFileSync, fork, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import type { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { build } from 'esbuild'
import { decode } from '@toon-format/toon'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestCertificates } from './fake-service/certificates.mjs'
import { SessionStore } from '../src/cli/session.js'
import { Client, DEFAULT_REQUEST_DEADLINE_MS } from '../src/cli/http.js'
import { cliVersion } from '../src/shared/version.js'
import { ArtiumError, errorResponse, errors } from '../src/shared/errors.js'

const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), 'artium-cli-'))
const bundle = join(directory, 'artium-axi.mjs')
const clockBundle = join(directory, 'artium-axi-clock.mjs')
const expiryBundle = join(directory, 'artium-axi-expiry.mjs')
const windowsBundle = join(directory, 'artium-axi-windows.mjs')
const localFailureBundle = join(directory, 'artium-axi-local-failure.mjs')
const stalls = new EventEmitter()
let url: string
let response: { status: number, body: unknown, location?: string, stall?: boolean, serverVersion?: string, requestId?: string, raw?: string }
let requests: { path: string, token?: string, body: unknown, version?: string }[] = []
let doctorResponses: Record<string, typeof response> | undefined
let responseSequence: typeof response[] | undefined
let beforeReply: ((path: string, reply: ServerResponse) => Promise<void>) | undefined
const server = createServer()

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'])
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
  await build({ entryPoints: ['src/cli/main.ts'], outfile: expiryBundle, bundle: true,
    platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' },
    banner: { js: "Date.now = () => Date.parse('2026-01-01T08:50:00Z')" } })
  await build({ entryPoints: ['src/cli/main.ts'], outfile: windowsBundle, bundle: true,
    platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' },
    banner: { js: "Object.defineProperty(process, 'platform', { value: 'win32' })" } })
  await build({ entryPoints: ['src/cli/main.ts'], outfile: localFailureBundle, bundle: true,
    platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' },
    // Fail at the OS boundary after a successful home request, with sensitive exception fields.
    banner: { js: `import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
      const originalResolve = path.resolve;
      process.argv[1] = { syntheticFailure: true };
      path.resolve = (...values) => {
        if (!values[0]?.syntheticFailure) return originalResolve(...values);
        const error = new TypeError('CANARY-local-secret {"body":"CANARY-request-body"}');
        error.name = 'CANARY-unsafe-class';
        error.stack = 'CANARY-private-stack';
        throw error;
      };
      syncBuiltinESMExports();` } })
  await build({ entryPoints: ['src/cli/main.ts'], outfile: clockBundle, bundle: true,
    platform: 'node', format: 'esm', target: 'node24.11', loader: { '.md': 'text' }, inject: ['test/cli-clock.ts'] })
  createTestCertificates(directory, ['localhost'])
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) })
  server.on('request', async (request, reply) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, token: request.headers.authorization, body: body ? JSON.parse(body) : undefined,
      version: request.headers['x-artium-cli-version'] as string | undefined })
    const current = responseSequence?.shift() ?? doctorResponses?.[request.url!] ?? response
    await beforeReply?.(request.url!, reply)
    const stalled = () => {
      const socket = request.socket
      const closed = new Promise<void>((resolve, reject) => {
        socket.once('close', () => resolve())
        socket.once('error', error => {
          // Aborting a stalled HTTPS request can reset its peer before close.
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
        })
      })
      stalls.emit(request.url!, { socket, closed })
    }
    if (request.url!.startsWith('/stall-headers/')) { stalled(); return }
    reply.writeHead(current.status, { 'content-type': 'application/json', ...(current.location ? { location: current.location } : {}),
      ...(current.serverVersion ? { 'x-artium-cli-version': current.serverVersion } : {}),
      ...(current.requestId ? { 'x-artium-request-id': current.requestId } : {}) })
    if (current.stall || request.url!.startsWith('/stall-body/')) {
      reply.flushHeaders()
      if (request.url!.startsWith('/stall-body/')) stalled()
      return
    }
    reply.end(current.raw ?? JSON.stringify(current.body))
  })
  server.listen(0)
  await once(server, 'listening')
  url = `https://localhost:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function cli(args: string[], environment: NodeJS.ProcessEnv = {}, controlled = false, input?: string, executable = bundle) {
  const configuration = environment.XDG_CONFIG_HOME ?? mkdtempSync(join(directory, 'config-'))
  new SessionStore((environment.ARTIUM_AXI_URL || url).replace(/\/$/, ''), join(configuration, 'artium-axi', 'session.json')).write({
    status: 'authenticated', accessToken: 'CANARY-cli-token', refreshToken: 'CANARY-cli-refresh',
    accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000,
  })
  const env = { PATH: process.env.PATH, ARTIUM_AXI_URL: url, XDG_CONFIG_HOME: configuration,
    ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'), ...environment }
  if (controlled) return controlledCli(args, env)
  try {
    const pending = execute(process.execPath, [executable, ...args], { cwd: directory, timeout: 20_000, env })
    if (input !== undefined) pending.child.stdin!.end(input)
    return { ...await pending, code: 0 }
  } catch (error) { return error as { stdout: string, stderr: string, code: number } }
}

test.each([
  { offset: -1, paths: ['/v1/auth/refresh', '/v1/tools'], token: 'Bearer CANARY-new' },
  { offset: 15_000, paths: ['/v1/auth/refresh', '/v1/tools'], token: 'Bearer CANARY-new' },
  { offset: 3600_000, paths: ['/v1/tools'], token: 'Bearer CANARY-old' },
])('stored access expiry offset $offset refreshes only when needed', async ({ offset, paths, token }) => {
  requests = []
  const client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'),
    XDG_CONFIG_HOME: mkdtempSync(join(directory, 'expiry-')) })
  client.sessions.write({ status: 'authenticated', accessToken: 'CANARY-old', refreshToken: 'CANARY-refresh',
    accessExpiresAt: Date.now() + offset, familyExpiresAt: Date.now() + 43200_000 })
  doctorResponses = {
    '/v1/auth/refresh': { status: 200, body: { status: 'authenticated', accessToken: 'CANARY-new', refreshToken: 'CANARY-new-refresh',
      accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    expect(await client.authenticated('/v1/tools', 'GET')).toEqual({ tools: [] })
    expect(requests.map(request => request.path)).toEqual(paths)
    expect(requests.at(-1)?.token).toBe(token)
  } finally { doctorResponses = undefined }
})

test('concurrent callers refresh an expired stored token once', async () => {
  requests = []
  const environment = { ARTIUM_AXI_URL: url, ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'),
    XDG_CONFIG_HOME: mkdtempSync(join(directory, 'race-')) }
  const first = new Client(environment)
  const second = new Client(environment)
  first.sessions.write({ status: 'authenticated', accessToken: 'CANARY-old', refreshToken: 'CANARY-refresh',
    accessExpiresAt: Date.now() - 1, familyExpiresAt: Date.now() + 43200_000 })
  doctorResponses = {
    '/v1/auth/refresh': { status: 200, body: { status: 'authenticated', accessToken: 'CANARY-new', refreshToken: 'CANARY-new-refresh',
      accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    expect(await Promise.all([first.authenticated('/v1/tools', 'GET'), second.authenticated('/v1/tools', 'GET')]))
      .toEqual([{ tools: [] }, { tools: [] }])
    expect(requests.map(request => request.path)).toEqual(['/v1/auth/refresh', '/v1/tools', '/v1/tools'])
    expect(requests.slice(1).map(request => request.token)).toEqual(['Bearer CANARY-new', 'Bearer CANARY-new'])
  } finally { doctorResponses = undefined }
})

test('fresh-looking stored access still refreshes and retries once on server expiry', async () => {
  requests = []
  responseSequence = [
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 200, body: { status: 'authenticated', accessToken: 'CANARY-new', refreshToken: 'CANARY-new-refresh',
      accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000 } },
    { status: 200, body: { tools: [] } },
  ]
  try {
    expect(await cli(['tools'])).toMatchObject({ code: 0, stderr: '' })
    expect(requests.map(request => request.path)).toEqual(['/v1/tools', '/v1/auth/refresh', '/v1/tools'])
    expect(requests.at(-1)?.token).toBe('Bearer CANARY-new')
  } finally { responseSequence = undefined }
})

test('home output is stable', async () => {
  doctorResponses = {
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.parse('2026-01-01T09:50:00Z'), sessionExpiresAt: Date.parse('2026-01-01T12:00:00Z') } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    const result = await cli([], {}, false, undefined, expiryBundle)
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout.replace(JSON.stringify(expiryBundle), '"<bin>"').replace(url, '<server>')).toMatchSnapshot()
  } finally { doctorResponses = undefined }
})

test('unexpected local failures identify the client and bounded cause without a server request ID', async () => {
  doctorResponses = {
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    const result = await cli([], {}, false, undefined, localFailureBundle)
    expect(result).toMatchObject({ code: 1, stderr: '' })
    expect(decode(result.stdout)).toEqual({ error: {
      code: 'INTERNAL_ERROR', source: 'artium-axi', message: 'The CLI failed locally (TypeError in main).',
      next: 'Report the error class and function to the CLI maintainer. Check the previous call outcome before retrying.',
    } })
    expect(result.stdout + result.stderr).not.toMatch(/CANARY|requestId|administrator|node:|\.mjs/)
  } finally { doctorResponses = undefined }
})

test.each([
  { tool: 'beyondtrust-axi', stdout: 'status: not configured\nhelp[3]: Run beyondtrust-axi config path to locate configuration,Run beyondtrust-axi auth status to validate local credentials,Run beyondtrust-axi profile list to inspect configured profiles\n', count: 3 },
  { tool: 'hybrid-axi', stdout: 'setup: required\nhelp[2]: Run hybrid-axi setup,Run hybrid-axi --help\n', count: 1 },
  { tool: 'tenable-axi', stdout: 'status: not configured\nhelp[1]: Run tenable-axi config path; configure a profile with accessKey and secretKey SecretRefs\n', count: 0 },
])('$tool home displays its server output after suggestion rewriting', async ({ tool, stdout, count }) => {
  response = { status: 200, body: { source: tool, stdout, stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: Buffer.byteLength(stdout), stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  const result = await cli([tool])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  const document = decode(result.stdout) as { help: string[] }
  expect(document.help).toHaveLength(count)
  expect(result.stdout).not.toContain('INTERNAL_ERROR')
})

test.each(['unchanged', 'removed', 'replaced'])('home requests are concurrent with session %s', async change => {
  requests = []
  const configuration = mkdtempSync(join(directory, 'home-'))
  const store = new SessionStore(url, join(configuration, 'artium-axi', 'session.json'))
  let release!: () => void
  const bothReceived = new Promise<void>(resolve => { release = resolve })
  doctorResponses = {
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  beforeReply = async () => {
    if (requests.length === 2) {
      if (change === 'removed') store.remove()
      if (change === 'replaced') store.write({ status: 'authenticated', accessToken: 'CANARY-replacement', refreshToken: 'CANARY-replacement-refresh',
        accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000 })
      release()
    }
    await bothReceived
  }
  try {
    const result = await cli([], { XDG_CONFIG_HOME: configuration })
    expect(requests.map(request => request.path).sort()).toEqual(['/v1/me', '/v1/tools'])
    expect(result).toMatchObject(change === 'unchanged' ? { code: 0, stderr: '', stdout: expect.stringContaining('user: "synthetic-user"') }
      : { code: 1, stderr: '', stdout: expect.stringContaining('SESSION_CHANGED') })
    if (change !== 'unchanged') expect(result.stdout).not.toContain('user:')
  } finally {
    release()
    beforeReply = undefined
    doctorResponses = undefined
  }
}, 15_000)

test.each([{ args: ['--help'], code: 0 }, { args: ['--unknown'], code: 2 }])(
  'closed stdout preserves command status $code without diagnostics', async ({ args, code }) => {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const closed = once(child, 'close')
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.destroy()
    expect(await closed).toEqual([code, null])
    expect(stderr).toBe('')
  })

async function controlledCli(args: string[], env: NodeJS.ProcessEnv) {
  const diagnostic = args[0] === 'doctor'
  const deadline = diagnostic ? 5_000 : DEFAULT_REQUEST_DEADLINE_MS
  const path = new URL(env.ARTIUM_AXI_URL!).pathname + (diagnostic ? '/health/live' : args[0] === 'tools' ? '/v1/tools' : '/v1/tools/falcon-axi/run')
  const stalled = once(stalls, path)
  const child = fork(clockBundle, args, { cwd: directory, env, silent: true, execArgv: [], signal: AbortSignal.timeout(10_000) })
  const closed = once(child, 'close')
  const unexpectedExit = closed.then(() => { throw new Error('Controlled CLI exited before socket cleanup was verified') })
  const messages = new EventEmitter()
  child.on('message', (message: { event: string }) => messages.emit(message.event, message))
  const scheduled = once(messages, 'scheduled')
  const receivedHeaders = path.startsWith('/stall-body/') ? once(messages, 'response') : Promise.resolve()
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  try {
    const [[timer], [connection]] = await Promise.race([Promise.all([scheduled, stalled, receivedHeaders]), unexpectedExit])
    const { socket, closed: socketClosed } = connection as { socket: TLSSocket, closed: Promise<unknown> }
    expect(timer.delay).toBe(deadline)
    expect(DEFAULT_REQUEST_DEADLINE_MS).toBe(90_000)
    expect(socket.encrypted).toBe(true)
    let advanced = once(messages, 'advanced')
    child.send({ advance: deadline - 1 })
    expect((await Promise.race([advanced, unexpectedExit]))[0]).toEqual({ event: 'advanced', elapsed: deadline - 1, pending: 1 })
    expect(socket.destroyed).toBe(false)
    expect(stdout).toBe('')
    expect(child.exitCode).toBeNull()
    advanced = once(messages, 'advanced')
    child.send({ advance: 1 })
    expect((await Promise.race([advanced, unexpectedExit]))[0]).toEqual({ event: 'advanced', elapsed: deadline, pending: 0 })
    await Promise.race([socketClosed, unexpectedExit])
    expect(socket.destroyed).toBe(true)
    expect(child.exitCode).toBeNull()
    child.send({ release: true })
    const [code, signal] = await closed
    expect(signal).toBeNull()
    return { code, stdout, stderr }
  } finally {
    if (child.exitCode === null) child.kill()
    await closed
  }
}

test('standalone bundle prints the package version offline without configuration or sign-in', async () => {
  const result = await execute(process.execPath, [bundle, '--version'], { cwd: directory, timeout: 10_000,
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: join(directory, 'unsigned-config') } })
  expect(result).toEqual({ stdout: `${cliVersion}\n`, stderr: '' })
})

test('update replaces the running bundle using saved TLS settings and keeps one backup', async () => {
  const install = mkdtempSync(join(directory, 'update-'))
  const executable = join(install, 'artium-axi.mjs')
  copyFileSync(bundle, executable)
  writeFileSync(`${executable}.bak`, 'previous backup')
  const original = readFileSync(executable)
  const replacement = '#!/usr/bin/env node\nconsole.log("999.0.0")\n'
  new SessionStore(url, join(install, 'artium-axi/session.json')).writeClientConfig(join(directory, 'ca.crt'))
  doctorResponses = {
    '/cli/artium-axi.mjs': { status: 200, body: undefined, raw: replacement },
    '/cli/artium-axi.mjs.sha256': { status: 200, body: undefined,
      raw: `${createHash('sha256').update(replacement).digest('hex')}  artium-axi.mjs\n` },
  }
  requests = []
  try {
    const result = await execute(process.execPath, [executable, 'update'], { env: { XDG_CONFIG_HOME: install }, timeout: 10_000 })
    expect(result.stdout).toContain('status: updated')
    expect((await execute(process.execPath, [executable, '--version'])).stdout).toBe('999.0.0\n')
    expect(readFileSync(`${executable}.bak`)).toEqual(original)
    expect(statSync(executable).mode & 0o777).toBe(statSync(bundle).mode & 0o777)
    expect(requests.map(request => ({ path: request.path, token: request.token }))).toEqual([
      { path: '/cli/artium-axi.mjs', token: undefined }, { path: '/cli/artium-axi.mjs.sha256', token: undefined },
    ])
  } finally { doctorResponses = undefined }
})

test.each(['0'.repeat(64), 'not-a-digest'])('update rejects checksum %s without changing the client or backup', async digest => {
  const install = mkdtempSync(join(directory, 'bad-update-'))
  const executable = join(install, 'artium-axi.mjs')
  copyFileSync(bundle, executable)
  writeFileSync(`${executable}.bak`, 'previous backup')
  doctorResponses = {
    '/cli/artium-axi.mjs': { status: 200, body: undefined, raw: 'unverified bundle' },
    '/cli/artium-axi.mjs.sha256': { status: 200, body: undefined, raw: digest },
  }
  try {
    await expect(execute(process.execPath, [executable, 'update'], { timeout: 10_000,
      env: { XDG_CONFIG_HOME: install, ARTIUM_AXI_URL: url, ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt') },
    })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('SHA-256 verification') })
    expect(readFileSync(executable)).toEqual(readFileSync(bundle))
    expect(readFileSync(`${executable}.bak`, 'utf8')).toBe('previous backup')
    expect(readdirSync(install).sort()).toEqual(['artium-axi.mjs', 'artium-axi.mjs.bak'])
  } finally { doctorResponses = undefined }
})

test('update refuses npm installations before reading configuration or contacting the server', async () => {
  const install = mkdtempSync(join(directory, 'npm-update-'))
  mkdirSync(join(install, 'bin'))
  const executable = join(install, 'bin/artium-axi.mjs')
  copyFileSync(bundle, executable)
  writeFileSync(join(install, 'package.json'), JSON.stringify({ name: '@knowttl/artium-axi' }))
  requests = []
  await expect(execute(process.execPath, [executable, 'update'], { timeout: 10_000, env: { XDG_CONFIG_HOME: install } }))
    .rejects.toMatchObject({ code: 2, stdout: expect.stringContaining('npm install -g @knowttl/artium-axi@latest') })
  expect(requests).toEqual([])
  expect(readFileSync(executable)).toEqual(readFileSync(bundle))
})

test.each(['password', 'sso'])('%s login remembers connection settings for tools and the installed SessionStart hook', async method => {
  const configuration = mkdtempSync(join(directory, 'remembered-config-'))
  const env = { PATH: process.env.PATH, HOME: configuration, XDG_CONFIG_HOME: configuration }
  const options = { cwd: directory, timeout: 10_000, env }
  response = { status: 200, body: { status: 'authenticated', accessToken: 'CANARY-access', refreshToken: 'CANARY-refresh',
    accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000 } }
  if (method === 'sso') responseSequence = [
    { status: 200, body: { deviceCode: 'CANARY-device', userCode: 'ABCD-EFGH',
      verificationUri: url + '/device', expiresAt: Date.now() + 60_000, intervalMs: 1000 } }, response,
  ]
  const login = execute(process.execPath, [bundle, 'login', ...(method === 'sso' ? ['--sso'] : ['--username', 'synthetic-user', '--password-stdin'])],
    { ...options, env: { ...env, ARTIUM_AXI_URL: url, ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt') } })
  login.child.stdin!.end('CANARY-password\n')
  try { expect((await login).stdout).toContain('status: authenticated') }
  finally { responseSequence = undefined }
  response = { status: 200, body: { tools: [] } }
  expect((await execute(process.execPath, [bundle, 'tools'], options)).stdout).toContain('tools: 0 available')
  const file = join(configuration, 'artium-axi', 'config.json')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ serverUrl: url, caFile: join(directory, 'ca.crt') })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(join(configuration, 'artium-axi')).mode & 0o777).toBe(0o700)
  response = { status: 200, body: { skills: [] } }
  await execute(process.execPath, [bundle, 'setup', '--host', 'claude', '--hook'], options)
  const settings = JSON.parse(readFileSync(join(configuration, '.claude/settings.json'), 'utf8'))
  const hook = settings.hooks.SessionStart[0].hooks[0]
  response = { status: 200, body: { tools: [] } }
  expect((await execute(hook.command, hook.args, options)).stdout).toContain('tools: 0 available')
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': response,
  }
  try {
    expect((await execute(process.execPath, [bundle, 'doctor'], options)).stdout).toContain('pass: server address (config.json)')
  } finally { doctorResponses = undefined }
})

test.each(['url', 'ca'])('the environment overrides the saved %s independently', async setting => {
  const configuration = mkdtempSync(join(directory, 'override-config-'))
  const caFile = join(directory, 'ca.crt')
  new SessionStore(setting === 'url' ? 'https://artium.example.test' : url,
    join(configuration, 'artium-axi/session.json')).writeClientConfig(setting === 'ca' ? 'missing-ca.crt' : caFile)
  const client = new Client({ XDG_CONFIG_HOME: configuration,
    ...(setting === 'url' ? { ARTIUM_AXI_URL: `${url}/override` } : { ARTIUM_AXI_CA_FILE: caFile }) })
  requests = []
  response = { status: 200, body: { status: 'ok' } }
  expect(await client.request('/health/live', 'GET')).toEqual({ status: 'ok' })
  expect(client.serverUrlSource).toBe(setting === 'url' ? 'ARTIUM_AXI_URL' : 'config.json')
  expect(requests.map(request => request.path)).toEqual([setting === 'url' ? '/override/health/live' : '/health/live'])
})

test('failed login preserves saved connection settings', async () => {
  const configuration = mkdtempSync(join(directory, 'failed-login-config-'))
  new SessionStore('https://artium.example.test', join(configuration, 'artium-axi/session.json')).writeClientConfig()
  const file = join(configuration, 'artium-axi/config.json')
  const before = readFileSync(file, 'utf8')
  response = { status: 401, body: errorResponse(new ArtiumError('SIGN_IN_FAILED'), 'synthetic-request') }
  const login = execute(process.execPath, [bundle, 'login', '--username', 'synthetic-user', '--password-stdin'], {
    cwd: directory, timeout: 10_000, env: { XDG_CONFIG_HOME: configuration, ARTIUM_AXI_URL: url, ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt') },
  })
  login.child.stdin!.end('CANARY-password\n')
  await expect(login).rejects.toMatchObject({ stdout: expect.stringContaining('SIGN_IN_FAILED') })
  expect(readFileSync(file, 'utf8')).toBe(before)
})

test.each(['invalid json', '{}', '{"serverUrl":"invalid"}', '{"serverUrl":42}'])(
  'invalid saved connection settings fail with CLIENT_CONFIG_INVALID: %s', content => {
    const configuration = mkdtempSync(join(directory, 'invalid-config-'))
    mkdirSync(join(configuration, 'artium-axi'))
    writeFileSync(join(configuration, 'artium-axi/config.json'), content)
    expect(() => new Client({ XDG_CONFIG_HOME: configuration })).toThrow(expect.objectContaining({ code: 'CLIENT_CONFIG_INVALID' }))
  })

const managedTokens = { accessToken: 'CANARY-managed-access', refreshToken: 'CANARY-managed-refresh' }
const rotatedTokens = { status: 'authenticated', accessToken: 'CANARY-rotated-access', refreshToken: 'CANARY-rotated-refresh',
  accessExpiresAt: 100000, familyExpiresAt: 200000 }

test('parallel managed home requests share one refresh and rotation', async () => {
  requests = []
  let release!: () => void
  const bothReceived = new Promise<void>(resolve => { release = resolve })
  beforeReply = async () => {
    if (requests.length === 2) release()
    await bothReceived
  }
  responseSequence = [
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 200, body: rotatedTokens },
  ]
  doctorResponses = {
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    const result = await managedCli([])
    expect(requests.slice(0, 2).map(request => request.path).sort()).toEqual(['/v1/me', '/v1/tools'])
    expect(requests[2].path).toBe('/v1/auth/refresh')
    expect(requests.slice(3).map(request => request.path).sort()).toEqual(['/v1/me', '/v1/tools'])
    expect(result).toMatchObject({ code: 0, stderr: '', stdout: expect.stringContaining('user: "synthetic-user"'), rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
  } finally { release(); beforeReply = undefined; responseSequence = undefined; doctorResponses = undefined }
})

test.each(['/v1/me', '/v1/tools'])('managed home preserves rotation when %s fails during the sibling refresh', async failingPath => {
  requests = []
  const refreshingPath = failingPath === '/v1/me' ? '/v1/tools' : '/v1/me'
  let refreshStarted!: () => void
  const refreshing = new Promise<void>(resolve => { refreshStarted = resolve })
  let failureFinished!: () => void
  const failureClosed = new Promise<void>(resolve => { failureFinished = resolve })
  beforeReply = async (path, reply) => {
    if (path === failingPath) {
      reply.socket!.once('close', failureFinished)
      await refreshing
      reply.setHeader('connection', 'close')
    } else if (path === '/v1/auth/refresh') {
      refreshStarted()
      await failureClosed
      doctorResponses![refreshingPath] = { status: 200, body: refreshingPath === '/v1/tools' ? { tools: [] } : {
        username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
        roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000,
      } }
    }
  }
  doctorResponses = {
    [failingPath]: { status: 503, body: errorResponse(new ArtiumError('SERVER_UNAVAILABLE'), 'synthetic-failure') },
    [refreshingPath]: {
      status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired'),
    },
    '/v1/auth/refresh': { status: 200, body: rotatedTokens },
  }
  try {
    const result = await managedCli([])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining('SERVER_UNAVAILABLE'),
      rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
    expect(result.stdout).not.toContain('user:')
    expect(result.stdout).not.toContain('tools:')
    expect(requests.filter(request => request.path === '/v1/auth/refresh')).toHaveLength(1)
  } finally { refreshStarted(); beforeReply = undefined; doctorResponses = undefined }
})

async function managedCli(args: string[], options: { json?: string, input?: string, missing?: 3 | 4, existing?: boolean, environment?: NodeJS.ProcessEnv, closeStream?: 'stdout' | 'stderr' } = {}) {
  const configuration = mkdtempSync(join(directory, 'managed-config-'))
  const storedFile = join(configuration, 'artium-axi', 'session.json')
  if (options.existing) {
    mkdirSync(join(configuration, 'artium-axi'))
    writeFileSync(storedFile, 'synthetic unreadable session')
  }
  const child = spawn(process.execPath, [bundle, '--managed-session', ...args], {
    cwd: directory, env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, XDG_CONFIG_HOME: configuration,
      ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'), ...options.environment },
    stdio: ['pipe', 'pipe', 'pipe', options.missing === 3 ? 'ignore' : 'pipe', options.missing === 4 ? 'ignore' : 'pipe'],
    signal: AbortSignal.timeout(10_000),
  })
  const closed = once(child, 'close')
  let stdout = '', stderr = '', rotations = ''
  child.stdout!.on('data', chunk => { stdout += chunk })
  child.stderr!.on('data', chunk => { stderr += chunk })
  if (options.closeStream) child[options.closeStream]!.destroy()
  child.stdio[4]?.on('data', chunk => { rotations += chunk })
  const sessionInput = child.stdio[3] as Writable | null
  sessionInput?.on('error', () => {})
  sessionInput?.end(options.json ?? JSON.stringify({ serverUrl: url, ...managedTokens }))
  child.stdin!.end(options.input ?? '')
  const [code, signal] = await closed
  expect(signal).toBeNull()
  if (options.existing) {
    expect(readdirSync(configuration)).toEqual(['artium-axi'])
    expect(readdirSync(join(configuration, 'artium-axi'))).toEqual(['session.json'])
    expect(readFileSync(storedFile, 'utf8')).toBe('synthetic unreadable session')
  } else expect(readdirSync(configuration)).toEqual([])
  for (const token of [...Object.values(managedTokens), rotatedTokens.accessToken, rotatedTokens.refreshToken]) {
    expect(stdout + stderr).not.toContain(token)
  }
  return { code, stdout, stderr, rotations }
}

test.each([false, true])('managed calls ignore session files and preserve tool stdin (existing file: %s)', async existing => {
  requests = []
  response = { status: 200, body: { source: 'az-axi', stdout: 'synthetic result', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 16, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  expect(await managedCli(['az-axi', 'rg', 'query'], { input: 'synthetic query', existing }))
    .toEqual({ code: 0, stdout: 'synthetic result', stderr: '', rotations: '' })
  expect(requests).toEqual([{ path: '/v1/tools/az-axi/run', token: `Bearer ${managedTokens.accessToken}`,
    body: { args: ['rg', 'query'], stdin: 'synthetic query' }, version: cliVersion }])
})

test.each([3, 4] as const)('managed mode refuses missing private fd %s before network access', async missing => {
  requests = []
  expect(await managedCli(['tools'], { missing })).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test.each(['not JSON CANARY-managed-access', '{}', '{"accessToken":""}', 'x'.repeat(65537)])('managed mode refuses invalid session JSON (%#)', async json => {
  requests = []
  expect(await managedCli(['tools'], { json })).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test.each(['passwd', 'logout', 'setup', 'update'])('managed mode refuses %s before network access', async command => {
  requests = []
  expect(await managedCli([command])).toMatchObject({ code: 2, stdout: expect.stringContaining('unavailable in managed session mode'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test('managed update is refused before configuration or private descriptor validation', async () => {
  requests = []
  expect(await managedCli(['update'], { missing: 3, existing: true, environment: { ARTIUM_AXI_URL: 'invalid' } }))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('unavailable in managed session mode'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test('whoami shows the session deadline in UTC and time remaining', async () => {
  response = { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
    roles: [], accessExpiresAt: Date.parse('2026-01-01T09:50:00Z'), sessionExpiresAt: Date.parse('2026-01-01T12:00:00Z') } }
  const result = await cli(['whoami'], {}, false, undefined, expiryBundle)
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('sessionExpiresAt: 2026-01-01T12:00:00Z (in 3h 10m)\n')
  expect(result.stdout).toContain('note: Access tokens refresh automatically when a refresh token is available.\n')
  expect(result.stdout).toContain('accessExpiresAt: 2026-01-01T09:50:00Z (in 1h 0m)\n')
})

test.each([{ args: ['whoami'] }, { args: [] }])('managed access-only identity shows both deadlines for $args', async ({ args }) => {
  const accessExpiresAt = Date.now() + 300_000
  const sessionExpiresAt = Date.now() + 11 * 3600_000
  doctorResponses = {
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt, sessionExpiresAt } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    const result = await managedCli(args, { json: JSON.stringify({ serverUrl: url, accessToken: managedTokens.accessToken }) })
    expect(result).toMatchObject({ code: 0, stderr: '', rotations: '' })
    expect(result.stdout).toContain(`accessExpiresAt: ${new Date(accessExpiresAt).toISOString().replace('.000Z', 'Z')} (`)
    expect(result.stdout).toContain(`sessionExpiresAt: ${new Date(sessionExpiresAt).toISOString().replace('.000Z', 'Z')} (`)
    expect(result.stdout).toContain('note: Access tokens refresh automatically when a refresh token is available.\n')
  } finally { doctorResponses = undefined }
})

test.each([
  { expiresAt: '2026-01-01T09:49:59Z', remaining: '0h 59m' },
  { expiresAt: '2026-01-01T09:50:00Z', remaining: '1h 0m' },
])('doctor reports a valid session with $remaining remaining', async ({ expiresAt, remaining }) => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.parse(expiresAt), sessionExpiresAt: Date.parse(expiresAt) } },
    '/v1/tools': { status: 200, body: { tools: [] } },
  }
  try {
    expect(await cli(['doctor'], {}, false, undefined, expiryBundle)).toMatchObject({ code: 0, stderr: '',
      stdout: expect.stringContaining(`pass: token (session expires ${expiresAt} (in ${remaining}))\n`) })
  } finally { doctorResponses = undefined }
})

test.each([
  ['update', '--help'], ['--help', 'update'],
  ['--managed-session', 'update', '--help'], ['--managed-session', '--help', 'update'],
].map(args => ({ args })))('update help advertises only standalone flags: $args', async ({ args }) => {
  requests = []
  const result = await cli(args, { ARTIUM_AXI_URL: undefined })
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('usage: artium-axi update')
  expect(result.stdout).not.toContain('--managed-session')
  expect(requests).toEqual([])
})

test.each([false, true])('managed login returns the first session privately without touching files (existing: %s)', async existing => {
  requests = []
  response = { status: 200, serverVersion: '999.0.0', body: rotatedTokens }
  const result = await managedCli(['login', '--username', 'synthetic-user', '--password-stdin'],
    { input: 'CANARY-password\n', missing: 3, existing })
  expect(result).toMatchObject({ code: 0, stdout: 'status: authenticated\nnext: artium-axi tools\n',
    rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
  expect(result.stderr).toContain('differs from server 999.0.0')
  expect(result.stdout + result.stderr).not.toContain('CANARY-password')
  expect(requests).toEqual([{ path: '/v1/auth/login', token: undefined,
    body: { username: 'synthetic-user', password: 'CANARY-password' }, version: cliVersion }])
})

test.each([false, true])('managed SSO returns the first session privately without touching files (existing: %s)', async existing => {
  requests = []
  responseSequence = [
    { status: 200, serverVersion: '999.0.0', body: { deviceCode: 'CANARY-device', userCode: 'ABCD-EFGH',
      verificationUri: url + '/device', expiresAt: Date.now() + 60_000, intervalMs: 1000 } },
    { status: 200, body: rotatedTokens },
  ]
  try {
    const result = await managedCli(['login', '--sso'], { missing: 3, existing })
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining('status: authenticated'),
      rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
    expect(result.stdout).toContain('code: ABCD-EFGH')
    expect(result.stderr).toContain('differs from server 999.0.0')
    expect(result.stdout + result.stderr).not.toContain('CANARY-device')
    expect(requests.map(request => request.path)).toEqual(['/v1/auth/device', '/v1/auth/device/poll'])
  } finally { responseSequence = undefined }
})

test.each([
  { args: ['--password', 'CANARY-password'] },
  { args: ['--password=CANARY-password'] },
  { args: ['CANARY-password'] },
  { args: [], environment: { ARTIUM_AXI_PASSWORD: 'CANARY-password' } },
  { args: ['--password-stdin'], environment: { ARTIUM_AXI_PASSWORD: 'CANARY-password' } },
  { args: [] },
])('managed login refuses unsafe or absent password sources (%#)', async ({ args, environment }) => {
  requests = []
  const result = await managedCli(['login', '--username', 'synthetic-user', ...args],
    { missing: 3, input: 'CANARY-password', environment })
  expect(result).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '', rotations: '' })
  expect(result.stdout).not.toContain('CANARY-password')
  expect(requests).toEqual([])
})

test('managed login refuses a missing private output before sending credentials', async () => {
  requests = []
  expect(await managedCli(['login', '--username', 'synthetic-user', '--password-stdin'], { missing: 4, input: 'CANARY-password' }))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test('managed SSO refuses password environment input before network access', async () => {
  requests = []
  expect(await managedCli(['login', '--sso'], { missing: 3, environment: { ARTIUM_AXI_PASSWORD: 'CANARY-password' } }))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test('managed login returns restricted password-change tokens only on the private channel', async () => {
  const restricted = { status: 'password-change-required', passwordChangeToken: 'CANARY-password-change', passwordChangeExpiresAt: 200000 }
  response = { status: 200, body: restricted }
  const result = await managedCli(['login', '--username', 'synthetic-user', '--password-stdin'], { missing: 3, input: 'CANARY-password' })
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('PASSWORD_CHANGE_REQUIRED'), stderr: '',
    rotations: `${JSON.stringify({ serverUrl: url, ...restricted })}\n` })
  expect(result.stdout).not.toContain(restricted.passwordChangeToken)
})

test('managed login withholds a password echoed by a server error', async () => {
  response = { status: 401, body: errorResponse(new ArtiumError('SIGN_IN_FAILED', 'CANARY-password'), 'synthetic-error') }
  expect(await managedCli(['login', '--username', 'synthetic-user', '--password-stdin'], { missing: 3, input: 'CANARY-password' }))
    .toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '', rotations: '' })
})

test('managed login scans version warnings against the issued tokens', async () => {
  response = { status: 200, serverVersion: rotatedTokens.accessToken, body: rotatedTokens }
  expect(await managedCli(['login', '--username', 'synthetic-user', '--password-stdin'], { missing: 3, input: 'CANARY-password' }))
    .toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '',
      rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
})

test.each([false, true])('managed rotation is private even when the retried request fails (%s)', async fails => {
  requests = []
  responseSequence = [
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 200, body: rotatedTokens },
    fails ? { status: 503, body: errorResponse(new ArtiumError('SERVER_UNAVAILABLE'), 'synthetic-retry') }
      : { status: 200, body: { tools: [] } },
  ]
  try {
    const result = await managedCli(['tools'])
    expect(result.code).toBe(fails ? 1 : 0)
    expect(result.stdout).toContain(fails ? 'SERVER_UNAVAILABLE' : 'tools: 0 available')
    expect(result.stderr).toBe('')
    expect(result.rotations).toBe(`${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n`)
    expect(requests.map(request => ({ path: request.path, token: request.token, body: request.body }))).toEqual([
      { path: '/v1/tools', token: `Bearer ${managedTokens.accessToken}`, body: undefined },
      { path: '/v1/auth/refresh', token: undefined, body: { refreshToken: managedTokens.refreshToken } },
      { path: '/v1/tools', token: `Bearer ${rotatedTokens.accessToken}`, body: undefined },
    ])
  } finally { responseSequence = undefined }
})

test.each(['stdout', 'stderr'] as const)('managed mode withholds both streams when a token appears in %s', async stream => {
  response = { status: 200, body: { source: 'falcon-axi', stdout: 'safe output', stderr: 'safe diagnostic',
    [stream]: Buffer.from(managedTokens.accessToken).toString('base64'), exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 50, stderr: 50 }, truncated: { stdout: false, stderr: false } } }
  const result = await managedCli(['falcon-axi'])
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '', rotations: '' })
  expect(result.stdout).not.toContain('safe output')
  expect(result.stdout).not.toContain(Buffer.from(managedTokens.accessToken).toString('base64'))
})

test('managed access-only expiry returns to the caller without refreshing', async () => {
  requests = []
  response = { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') }
  expect(await managedCli(['tools'], { json: JSON.stringify({ serverUrl: url, accessToken: managedTokens.accessToken }) }))
    .toMatchObject({ code: 1, stdout: expect.stringContaining('TOKEN_EXPIRED'), stderr: '', rotations: '' })
  expect(requests).toHaveLength(1)
})

test('managed mode rejects a session bound to another server before network access', async () => {
  requests = []
  expect(await managedCli(['tools'], { json: JSON.stringify({ serverUrl: 'https://synthetic.invalid', ...managedTokens }) }))
    .toMatchObject({ code: 1, stdout: expect.stringContaining('SESSION_SERVER_MISMATCH'), stderr: '', rotations: '' })
  expect(requests).toEqual([])
})

test('managed mode scans server error text before printing it', async () => {
  response = { status: 401, body: errorResponse(new ArtiumError('TOKEN_INVALID', managedTokens.refreshToken), 'synthetic-error') }
  expect(await managedCli(['tools']))
    .toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '', rotations: '' })
})

test('managed refresh refusal returns no rotation and does not retry the call', async () => {
  requests = []
  responseSequence = [
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_INVALID'), 'synthetic-refused') },
  ]
  try {
    expect(await managedCli(['tools']))
      .toMatchObject({ code: 1, stdout: expect.stringContaining('TOKEN_INVALID'), stderr: '', rotations: '' })
    expect(requests.map(request => request.path)).toEqual(['/v1/tools', '/v1/auth/refresh'])
  } finally { responseSequence = undefined }
})

test('managed rotation remains private when the retry echoes a rotated token', async () => {
  responseSequence = [
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 200, body: rotatedTokens },
    { status: 200, body: { source: 'falcon-axi', stdout: rotatedTokens.accessToken, stderr: 'synthetic diagnostic', exitCode: 0,
      durationMs: 1, outputBytes: { stdout: 50, stderr: 50 }, truncated: { stdout: false, stderr: false } } },
  ]
  try {
    expect(await managedCli(['falcon-axi'])).toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '',
      rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
  } finally { responseSequence = undefined }
})

test.each([
  { serverVersion: '0.0.0-old', warning: true },
  { serverVersion: '999.0.0', warning: true },
  { serverVersion: cliVersion, warning: false },
  { serverVersion: undefined, warning: false },
])('login succeeds with server version $serverVersion and warns only on mismatch', async ({ serverVersion, warning }) => {
  requests = []
  response = { status: 200, serverVersion, body: { status: 'authenticated', accessToken: 'CANARY-access',
    refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 300_000, familyExpiresAt: Date.now() + 3600_000 } }
  const result = await cli(['login', '--username', 'synthetic-user', '--password-stdin'], {}, false, 'CANARY-password\n')
  expect(result).toMatchObject({ code: 0, stdout: 'status: authenticated\nnext: artium-axi tools\n',
    stderr: warning ? `warning: CLI ${cliVersion} differs from server ${serverVersion}; run artium-axi update, or run npm install -g @knowttl/artium-axi@${serverVersion}.\n` : '' })
})

test('standalone bundle lists tools and reports an empty list', async () => {
  requests = []
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.8.2' }] } }
  expect(await cli(['tools'])).toMatchObject({ code: 0, stdout: 'tools[1]{name,status,version,readOnly}:\n  falcon-axi,ok,"0.8.2",true\nnext[2]:\n  - artium-axi tools show falcon-axi\n  - artium-axi falcon-axi detection list\n', stderr: '' })
  expect(requests).toEqual([{ path: '/v1/tools', token: 'Bearer CANARY-cli-token', body: undefined, version: cliVersion }])
  response = { status: 200, body: { tools: [] } }
  expect((await cli(['tools'])).stdout).toBe('tools: 0 available\nreason: No enabled runtime tool is available through your assigned roles.\ncontact: Ask an administrator to check your role assignments and enabled tools.\nnext[1]:\n  - artium-axi whoami\n')
})

test('passthrough preserves argument tokens, streams and upstream nonzero status', async () => {
  requests = []
  response = { status: 200, body: { source: 'falcon-axi', stdout: 'data\n', stderr: 'diagnostic\n', exitCode: 7,
    durationMs: 1, outputBytes: { stdout: 5, stderr: 11 }, truncated: { stdout: false, stderr: false } } }
  const args = ['detection', 'list', '', 'two words', '"quoted"', "'single'", '$(touch synthetic)', ';', '\\', '雪', '--flag=a b']
  expect(await cli(['falcon-axi', ...args])).toMatchObject({ code: 7, stdout: 'data\n', stderr: 'diagnostic\n' })
  expect(requests[0].body).toEqual({ args })
})

test.each([0, 7])('tool exit %i prints the server request ID only on failure', async exitCode => {
  response = { status: 200, requestId: 'cc10556c-a785-4eac-93ef-c180a0a75fb3',
    body: { source: 'falcon-axi', stdout: 'data\n', stderr: 'diagnostic', exitCode,
      durationMs: 1, outputBytes: { stdout: 5, stderr: 10 }, truncated: { stdout: false, stderr: false } } }
  expect(await cli(['falcon-axi'])).toMatchObject({ code: exitCode, stdout: 'data\n',
    stderr: exitCode === 0 ? 'diagnostic' : 'diagnostic\nartium-axi: request_id cc10556c-a785-4eac-93ef-c180a0a75fb3\n' })
})

test.each(['stdout', 'stderr'] as const)('closed %s preserves upstream status and the other stream', async closeStream => {
  response = { status: 200, body: { source: 'falcon-axi', stdout: 'data\n', stderr: 'diagnostic\n', exitCode: 7,
    durationMs: 1, outputBytes: { stdout: 5, stderr: 11 }, truncated: { stdout: false, stderr: false } } }
  expect(await managedCli(['falcon-axi', 'host', 'list'], { closeStream })).toMatchObject({
    code: 7, stdout: closeStream === 'stdout' ? '' : 'data\n', stderr: closeStream === 'stderr' ? '' : 'diagnostic\n',
  })
})

test('truncation diagnostic precedes upstream stderr without changing stdout', async () => {
  requests = []
  response = { status: 200, body: { source: 'falcon-axi', stdout: 'data', stderr: 'upstream', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 10, stderr: 8 }, truncated: { stdout: true, stderr: false } } }
  expect(await cli(['falcon-axi'])).toMatchObject({ code: 0, stdout: 'data', stderr: 'artium-axi: output truncated (stdout).\nupstream' })
})

test('bundle rewrites only complete suggestion streams and preserves the upstream exit code', async () => {
  requests = []
  const stdout = 'help[1]:\n  Run `falcon-axi host list`\n'
  const stderr = '{ "help": ["Run `falcon-axi detection list`"], "data": "falcon-axi" }'
  response = { status: 200, body: { source: 'falcon-axi', stdout, stderr, exitCode: 7,
    durationMs: 1, outputBytes: { stdout: stdout.length, stderr: stderr.length }, truncated: { stdout: false, stderr: false } } }
  expect(await cli(['falcon-axi'])).toMatchObject({ code: 7,
    stdout: 'help[1]:\n  Run `artium-axi falcon-axi host list`\n',
    stderr: '{ "help": ["Run `artium-axi falcon-axi detection list`"], "data": "falcon-axi" }' })
  response.body = { ...response.body as object, truncated: { stdout: true, stderr: false } }
  expect(await cli(['falcon-axi'])).toMatchObject({ code: 7, stdout,
    stderr: 'artium-axi: output truncated (stdout).\n{ "help": ["Run `artium-axi falcon-axi detection list`"], "data": "falcon-axi" }' })
  response.body = { ...response.body as object, truncated: { stdout: false, stderr: true } }
  expect(await cli(['falcon-axi'])).toMatchObject({ code: 7,
    stdout: 'help[1]:\n  Run `artium-axi falcon-axi host list`\n',
    stderr: `artium-axi: output truncated (stderr).\n${stderr}` })
})

test.each([[], ['home'], ['sub', 'list'], ['--subscription', 'synthetic', 'sub', 'list'],
  ['logs', 'query', '--workspace', 'synthetic', 'Heartbeat | count'],
  ['rg', 'query', '--limit=1', 'Resources | count'],
  ['rg', 'query', 'Resources', '--'], ['logs', 'query', 'Resources', '--'],
  ['graph', 'query', 'Resources', '--'], ['monitor', 'log-analytics', 'query', 'Heartbeat', '--'],
  ['graph', 'query', '--graph-query', 'Resources'], ['graph', 'query', '-q=Resources'],
  ['monitor', 'log-analytics', 'query', '--analytics-query=Heartbeat'],
  ['api', 'POST', '/synthetic', '--body', '{}'], ['api', 'POST', '/synthetic', '--data={}'],
].map(args => [args]))(
  'Azure commands that consume no input complete with stdin left open: %j', async args => {
    requests = []
    response = { status: 200, body: { source: 'az-axi', stdout: 'synthetic result', stderr: '', exitCode: 0,
      durationMs: 1, outputBytes: { stdout: 16, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
    expect(await cli(['az-axi', ...args])).toMatchObject({ code: 0, stdout: 'synthetic result' })
    expect(requests[0].body).toEqual({ args })
  })

test.each([
  ['graph', 'query'], ['logs', 'query', '-w', 'synthetic'],
  ['monitor', 'log-analytics', 'query', '-w', 'synthetic'],
  ['--subscription', 'synthetic', 'rg', 'query'],
  ['api', 'POST', '/synthetic'],
].map(args => [args]))('Azure query and body commands retain piped stdin: %j', async args => {
  requests = []
  response = { status: 200, body: { source: 'az-axi', stdout: 'synthetic result', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 16, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  expect(await cli(['az-axi', ...args], {}, false, 'synthetic input'))
    .toMatchObject({ code: 0, stdout: 'synthetic result' })
  expect(requests[0].body).toEqual({ args, stdin: 'synthetic input' })
})

test.each([
  { tool: 'az-axi', args: ['graph', 'query'], alternative: '--file' },
  { tool: 'az-axi', args: ['api', 'POST', '/synthetic'], alternative: '--data' },
  { tool: 'tenable-axi', args: ['asset', 'list', '--filter-file', '-'], alternative: '--filter-file' },
  { tool: 'hybrid-axi', args: ['api', '--body-file', '-'], alternative: '--body-file' },
])('open tool stdin fails visibly before any request: $tool $args', async ({ tool, args, alternative }) => {
  requests = []
  const result = await cli([tool, ...args])
  expect(result).toMatchObject({ code: 2, stderr: '' })
  expect(result.stdout).toContain('INVALID_INPUT')
  expect(result.stdout).toContain(`no stdin EOF after 5 s; close stdin or pass ${alternative}`)
  expect(requests).toEqual([])
})

test.each(['stdin', 'file', 'file-equals'] as const)('Azure query forwards bounded %s input through the API', async kind => {
  requests = []
  response = { status: 200, body: { source: 'az-axi', stdout: 'synthetic result', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 16, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  const query = 'Resources\n| count'
  const path = join(directory, 'query.kql')
  writeFileSync(path, query)
  const args = kind === 'stdin' ? [] : kind === 'file' ? ['--file', path] : [`--file=${path}`]
  expect(await cli(['az-axi', 'rg', 'query', ...args], {}, false, kind === 'stdin' ? query : undefined))
    .toMatchObject({ code: 0, stdout: 'synthetic result' })
  expect(requests[0].body).toEqual(kind === 'stdin' ? { args: ['rg', 'query'], stdin: query }
    : { args: ['rg', 'query', ...(kind === 'file' ? ['--file', 'query.kql'] : ['--file=query.kql'])],
      files: [{ name: 'query.kql', contentBase64: Buffer.from(query).toString('base64') }] })
})

test.each(['stdin', 'file', 'missing-file'] as const)('Azure refuses %s input that cannot be uploaded before sending a request', async kind => {
  requests = []
  const path = join(directory, `${kind}.kql`)
  if (kind === 'file') writeFileSync(path, Buffer.alloc(1024 * 1024 + 1, 'x'))
  const args = kind === 'stdin' ? [] : ['--file', path]
  const result = await cli(['az-axi', 'rg', 'query', ...args], {}, false,
    kind === 'stdin' ? 'x'.repeat(512 * 1024 + 1) : undefined)
  expect(result).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT') })
  expect(requests).toEqual([])
})

test.each([
  { name: 'dangling TOON indentation', output: 'help: falcon-axi host list\n  dangling\n' },
  { name: 'escaped command delimiters', output: JSON.stringify({ help: 'Run "falcon-axi host list --filter \\"synthetic\\"' }) },
  { name: 'object TOON help items', output: 'help[1]:\n  - message: Run `falcon-axi host list`\n' },
  { name: 'mixed TOON help items', output: 'help[2]:\n  - Run `falcon-axi host list`\n  - message: Run `falcon-axi host show`\n' },
  { name: 'bare TOON marker after a command', output: 'help[2]:\n  - Run `falcon-axi host list`\n  -' },
  { name: 'bare TOON marker before a command', output: 'help[2]:\r\n  -\t\r\n  - Run `falcon-axi host list`\r\n' },
  { name: 'quoted other-command arguments', output: 'help: Run `falcon-axi host show` or `echo \'falcon-axi host list\'`\n' },
  { name: 'plain other-command arguments', output: JSON.stringify({ help: ['Run echo "falcon-axi host list"', 'falcon-axi host show'] }) },
].flatMap(value => ['stdout', 'stderr'].map(stream => ({ ...value, stream }))))(
  'bundle preserves $name in $stream while rewriting the other stream', async ({ output, stream }) => {
    requests = []
    const complete = 'help: falcon-axi host list\n'
    const stdout = stream === 'stdout' ? output : complete
    const stderr = stream === 'stderr' ? output : complete
    response = { status: 200, body: { source: 'falcon-axi', stdout, stderr, exitCode: 7,
      durationMs: 1, outputBytes: { stdout: stdout.length, stderr: stderr.length }, truncated: { stdout: false, stderr: false } } }
    expect(await cli(['falcon-axi'])).toMatchObject({ code: 7,
      stdout: stream === 'stdout' ? output : 'help: artium-axi falcon-axi host list\n',
      stderr: stream === 'stderr' ? output : 'help: artium-axi falcon-axi host list\n' })
  })

test.each([301, 302, 303, 307, 308])('authenticated redirect %i is refused without a second request', async status => {
  requests = []
  response = { status, body: {}, location: `${url}/destination`, stall: true }
  expect(await cli(['tools'])).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE'), stderr: '' })
  expect(requests).toHaveLength(1)
})

test('stalled headers and bodies fail without retrying either command', async () => {
  requests = []
  response = { status: 200, body: {} }
  const results = await Promise.allSettled([
    cli(['tools'], { ARTIUM_AXI_URL: `${url}/stall-headers` }, true),
    cli(['falcon-axi'], { ARTIUM_AXI_URL: `${url}/stall-headers` }, true),
    cli(['tools'], { ARTIUM_AXI_URL: `${url}/stall-body` }, true),
    cli(['falcon-axi'], { ARTIUM_AXI_URL: `${url}/stall-body` }, true),
  ])
  const failure = { code: 1, stdout: expect.stringContaining('SERVER_UNAVAILABLE'), stderr: '' }
  expect(results).toMatchObject(Array(4).fill({ status: 'fulfilled', value: failure }))
  expect(requests.map(request => request.path).sort()).toEqual([
    '/stall-body/v1/tools', '/stall-body/v1/tools/falcon-axi/run',
    '/stall-headers/v1/tools', '/stall-headers/v1/tools/falcon-axi/run',
  ])
}, 15_000)

test.each([
  ['https://user:password@localhost', {}], ['https://localhost?query=1', {}], ['https://localhost/#fragment', {}],
  ['https://localhost?', {}], ['https://localhost/#', {}],
  ['http://localhost', {}], ['http://192.0.2.1', { ARTIUM_AXI_TEST_HTTP: '1' }], ['ftp://localhost', {}],
])('invalid server URL fails before transmitting the token: %s', async (address, environment) => {
  requests = []
  expect(await cli(['tools'], { ...environment, ARTIUM_AXI_URL: address })).toMatchObject({ code: 2, stdout: expect.stringContaining('CLIENT_CONFIG_INVALID') })
  expect(requests).toEqual([])
})

test('TLS certificate trust cannot be bypassed and connection failure is not retried', async () => {
  requests = []
  expect(await cli(['tools'], { ARTIUM_AXI_CA_FILE: undefined })).toMatchObject({ code: 1, stdout: expect.stringContaining('CERTIFICATE_INVALID') })
  expect(requests).toEqual([])
})

test.each([
  { status: 200, body: { status: 'ok' } },
  { status: 503, body: { status: 'unavailable' } },
])('doctor reports trusted HTTPS, token, version and each cached tool when readiness returns $status', async readiness => {
  requests = []
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/health/ready': readiness,
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.8.2' },
      { name: 'vectra-axi', status: 'error', version: '0.1.3' }] } },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringMatching(
      /^pass: server address \(ARTIUM_AXI_URL\)\npass: certificate\npass: token \(session expires [^\n]+\npass: CLI version\npass: falcon-axi \(ok\)\nfail: vectra-axi \(error\)\nerror:\n  code: "TOOL_FAILED"\n/) })
    expect(requests.map(request => request.path)).toEqual(['/health/live', '/v1/me', '/v1/me', '/v1/tools'])
    expect(requests.map(request => request.version)).toEqual(Array(4).fill(cliVersion))
    doctorResponses['/v1/tools'].body = { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.8.2' }] }
    expect(await cli(['doctor'])).toMatchObject({ code: 0, stdout: expect.stringContaining('pass: falcon-axi (ok)') })
  } finally { doctorResponses = undefined }
})

test.each(['stall-headers', 'stall-body'])('doctor bounds %s and stops after address failure', async stall => {
  requests = []
  response = { status: 200, body: {} }
  const result = await cli(['doctor'], { ARTIUM_AXI_URL: `${url}/${stall}` }, true)
  expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringMatching(
    /^fail: server address \(ARTIUM_AXI_URL: SERVER_UNAVAILABLE\)\npass: certificate\nerror:\n  code: "SERVER_UNAVAILABLE"\n/) })
  expect(requests.map(request => request.path)).toEqual([`/${stall}/health/live`])
})

test('doctor continues authentication checks when the reachable server rejects the token', async () => {
  requests = []
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 401, body: errorResponse(new ArtiumError('TOKEN_INVALID'), 'synthetic-unauthorized') },
  }
  try {
    expect(await cli(['doctor'])).toMatchObject({ code: 1, stderr: '', stdout: expect.stringMatching(
      /^pass: server address \(ARTIUM_AXI_URL\)\npass: certificate\nfail: token\npass: CLI version\nerror:\n  code: "TOKEN_INVALID"\n/) })
    expect(requests.map(request => request.path)).toEqual(['/health/live', '/v1/me', '/v1/me'])
    expect(requests.map(request => request.token)).toEqual([undefined, undefined, 'Bearer CANARY-cli-token'])
  } finally { doctorResponses = undefined }
})

test('managed doctor refreshes privately and completes its diagnostic probes', async () => {
  requests = []
  const me = { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
    roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 }
  responseSequence = [
    { status: 200, body: { status: 'ok' } },
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_INVALID'), 'synthetic-version') },
    { status: 401, body: errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-expired') },
    { status: 200, body: rotatedTokens },
    { status: 200, body: me },
    { status: 200, body: { tools: [] } },
  ]
  try {
    expect(await managedCli(['doctor'], { existing: true })).toEqual({ code: 0, stderr: '',
      stdout: expect.stringMatching(/^pass: server address \(ARTIUM_AXI_URL\)\npass: certificate\npass: token \(session expires [^\n]+\npass: CLI version\n$/),
      rotations: `${JSON.stringify({ serverUrl: url, ...rotatedTokens })}\n` })
    expect(requests.map(request => ({ path: request.path, token: request.token }))).toEqual([
      { path: '/health/live', token: undefined },
      { path: '/v1/me', token: undefined },
      { path: '/v1/me', token: `Bearer ${managedTokens.accessToken}` },
      { path: '/v1/auth/refresh', token: undefined },
      { path: '/v1/me', token: `Bearer ${rotatedTokens.accessToken}` },
      { path: '/v1/tools', token: `Bearer ${rotatedTokens.accessToken}` },
    ])
  } finally { responseSequence = undefined }
})

test('doctor reports all prerequisite failures for an invalid server address', async () => {
  const result = await cli(['doctor'], { ARTIUM_AXI_URL: 'invalid' })
  expect(result).toMatchObject({ code: 2, stderr: '', stdout: expect.stringMatching(
    /^fail: server address \(CLIENT_CONFIG_INVALID\)\nfail: certificate \(CLIENT_CONFIG_INVALID\)\nfail: token \(CLIENT_CONFIG_INVALID\)\nfail: CLI version \(CLIENT_CONFIG_INVALID\)\nerror:\n  code: "CLIENT_CONFIG_INVALID"\n/) })
  expect(result.stdout).toContain('  source: "artium-axi"\n')
  expect(result.stdout).toContain(`  message: ${JSON.stringify(errors.CLIENT_CONFIG_INVALID.message)}\n`)
  expect(result.stdout).toContain(`  next: ${JSON.stringify(errors.CLIENT_CONFIG_INVALID.next)}\n`)
})

test('doctor stops at the certificate error before authenticated probes', async () => {
  requests = []
  const result = await cli(['doctor'], { ARTIUM_AXI_CA_FILE: undefined })
  expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining('fail: certificate (CERTIFICATE_INVALID)\n') })
  expect(result.stdout).toContain('error:\n  code: "CERTIFICATE_INVALID"\n  source: "artium-axi"\n')
  expect(result.stdout).toContain(`  message: ${JSON.stringify(errors.CERTIFICATE_INVALID.message)}\n`)
  expect(result.stdout).toContain(`  next: ${JSON.stringify(errors.CERTIFICATE_INVALID.next)}\n`)
  expect(requests).toEqual([])
})

test('doctor reports an unverified certificate when the HTTPS connection is refused', async () => {
  const unavailable = createServer()
  unavailable.listen(0, '127.0.0.1')
  await once(unavailable, 'listening')
  const port = (unavailable.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => unavailable.close(error => error ? reject(error) : resolve()))
  const result = await cli(['doctor'], { ARTIUM_AXI_URL: `https://127.0.0.1:${port}` })
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('fail: certificate (SERVER_UNAVAILABLE)\n') })
})

test('doctor reports an unverified certificate when the CA file cannot be read', async () => {
  requests = []
  const result = await cli(['doctor'], { ARTIUM_AXI_CA_FILE: join(directory, 'missing-ca.crt') })
  expect(result).toMatchObject({ code: 2, stdout: expect.stringContaining('fail: certificate (CLIENT_CONFIG_INVALID)\n') })
  expect(requests).toEqual([])
})

test('doctor does not report certificate success for a plain HTTP liveness error', async () => {
  const plain = createHttpServer((_request, reply) => {
    reply.writeHead(503, { 'content-type': 'application/json' })
    reply.end(JSON.stringify(errorResponse(new ArtiumError('SERVER_UNAVAILABLE'), 'synthetic-http')))
  })
  plain.listen(0, '127.0.0.1')
  await once(plain, 'listening')
  try {
    const result = await cli(['doctor'], { ARTIUM_AXI_URL: `http://127.0.0.1:${(plain.address() as { port: number }).port}`, ARTIUM_AXI_TEST_HTTP: '1' })
    expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('fail: certificate (SERVER_UNAVAILABLE)\n') })
  } finally {
    await new Promise<void>((resolve, reject) => plain.close(error => error ? reject(error) : resolve()))
  }
})

test.each([
  { path: '/health/live', code: 'SERVER_UNAVAILABLE', diagnostic: 'server address' },
  { path: '/v1/me', code: 'TOKEN_INVALID', diagnostic: 'token' },
  { path: '/v1/me', code: 'CLI_OUTDATED', diagnostic: 'CLI version' },
  { path: '/v1/tools', code: 'CREDENTIAL_INVALID', diagnostic: 'tools' },
] as const)('doctor emits the catalogue error for $diagnostic failures', async ({ path, code, diagnostic }) => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
    [path]: { status: errors[code].status, body: errorResponse(new ArtiumError(code), 'synthetic-doctor') },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining(`fail: ${diagnostic}`) })
    expect(result.stdout).toContain('pass: certificate\n')
    expect(result.stdout).toContain(`error:\n  code: "${code}"\n  source: "artium-axi"\n`)
    expect(result.stdout).toContain(`  message: ${JSON.stringify(errors[code].message)}\n`)
    expect(result.stdout).toContain(`  next: ${JSON.stringify(errors[code].next)}\n`)
    expect(result.stdout).toMatch(/  requestId: "synthetic-doctor"\n$/)
  } finally { doctorResponses = undefined }
})

test.each([
  { status: 'unconfigured', code: 'CREDENTIAL_NOT_CONFIGURED' },
  { status: 'unknown', code: 'SERVER_UNAVAILABLE' },
  { status: 'error', code: 'TOOL_FAILED' },
  { status: 'disabled', code: 'TOOL_DISABLED' },
] as const)('doctor maps cached $status health to $code', async ({ status, code }) => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [{ name: 'falcon-axi', version: '0.8.2', status }] } },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining(`fail: falcon-axi (${status})\n`) })
    expect(result.stdout).toContain(`error:\n  code: "${code}"\n  source: "artium-axi"\n`)
    expect(result.stdout).toContain(`  message: ${JSON.stringify(errors[code].message)}\n`)
    expect(result.stdout).toContain(`  next: ${JSON.stringify(errors[code].next)}\n`)
    expect(result.stdout).not.toContain('requestId:')
  } finally { doctorResponses = undefined }
})

test('doctor reports checking health as pending, not a failure', async () => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [{ name: 'falcon-axi', version: '0.8.2', status: 'checking' }] } },
  }
  try {
    expect(await cli(['doctor'])).toMatchObject({ code: 0, stderr: '',
      stdout: expect.stringContaining('pass: falcon-axi (checking)\n') })
  } finally { doctorResponses = undefined }
})

test.each(['/v1/me', '/v1/tools'])('doctor rejects a malformed %s response through the catalogue', async path => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000, sessionExpiresAt: Date.now() + 43200_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
    [path]: { status: 200, body: {} },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining('error:\n  code: "INVALID_RESPONSE"\n  source: "artium-axi"\n') })
    expect(result.stdout).toContain(`  message: ${JSON.stringify(errors.INVALID_RESPONSE.message)}\n`)
    expect(result.stdout).toContain(`  next: ${JSON.stringify(errors.INVALID_RESPONSE.next)}\n`)
    expect(result.stdout).not.toContain('requestId:')
  } finally { doctorResponses = undefined }
})

test('inherited TLS bypass cannot send the token to an untrusted server', async () => {
  requests = []
  response = { status: 200, body: { tools: [] } }
  const environment = { ARTIUM_AXI_CA_FILE: undefined, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
  const results = await Promise.all([cli(['tools'], environment), cli(['falcon-axi'], environment)])
  const failure = { code: 1, stdout: expect.stringContaining('CERTIFICATE_INVALID') }
  expect(results).toMatchObject([failure, failure])
  expect(requests).toEqual([])
})

test('Artium errors preserve the server request ID and withhold streams', async () => {
  requests = []
  response = { status: 500, body: { error: { code: 'SECRET_IN_OUTPUT', source: 'artium-axi', message: 'Known secret detected.', next: 'Check upstream.', requestId: 'synthetic-request' } } }
  const result = await cli(['falcon-axi', 'env'])
  expect(result).toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '' })
  expect(result.stdout).toContain('requestId: "synthetic-request"')
})

test.each([{ tools: [], extra: true }, { stdout: 'untrusted' }, { tools: [{ name: 'unknown-axi', status: 'ok', version: '0.1.4' }] }])('malformed response does not print unvalidated data', async body => {
  requests = []
  response = { status: 200, body }
  expect(await cli(['tools'])).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE'), stderr: '' })
})

test.each([{ args: ['tools', '--unknown'] }, { args: ['missing'] }, { args: ['falcon-axi', 'x'.repeat(64 * 1024 + 1)] },
  { args: ['tools', 'show'] }, { args: ['tools', 'show', 'missing'] }, { args: ['login', '--unknown', '--help'] },
  { args: ['whoami', '--unknown', '--help'] }, { args: ['tools', 'show', '--unknown', '--help'] },
  { args: ['tools', 'show', 'missing', '--help'] }, { args: ['tools', '--help', 'show', '--unknown'] },
  { args: ['tools', 'show', '--help', '--unknown'] }])('usage failure exits 2 before sending a request', async ({ args }) => {
  requests = []
  expect(await cli(args)).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '' })
  expect(requests).toEqual([])
})

test.each(['INVALID_INPUT', 'TIMEOUT', 'SECRET_IN_OUTPUT', 'INTERNAL_ERROR'] as const)('catalogue error %s preserves source, next step, request ID and exit code', async code => {
  const definition = errors[code]
  response = { status: definition.status, body: errorResponse(new ArtiumError(code), 'synthetic-catalogue') }
  const result = await cli(['falcon-axi', 'detection', 'list'])
  expect(result).toMatchObject({ code: code === 'INVALID_INPUT' ? 2 : 1, stderr: '' })
  expect(result.stdout).toBe(`error:\n  code: ${JSON.stringify(code)}\n  source: "artium-axi"\n  message: ${JSON.stringify(definition.message)}\n  next: ${JSON.stringify(definition.next)}\n  requestId: "synthetic-catalogue"\n`)
})

test.each([
  { prefix: [], suffix: ['--help'] },
  { prefix: ['--help'], suffix: [] },
  { prefix: ['--managed-session'], suffix: ['--help'] },
  { prefix: ['--managed-session', '--help'], suffix: [] },
].flatMap(mode => [[], ['--transfer', '00000000-0000-4000-8000-000000000001', '--execute', '--confirm', 'synthetic-confirm']]
  .map(execution => ({ ...mode, execution }))))('download help avoids authentication and destination access: %j', async ({ prefix, suffix, execution }) => {
  requests = []
  const result = await cli([...prefix, 'download', '--operation', 'report-download-bin', '--selector', 'synthetic-report',
    '--type', 'bin', '--destination', join(directory, 'missing-parent', 'new.bin'), '--sso', ...execution, ...suffix],
  { ARTIUM_AXI_URL: undefined })
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('usage: artium-axi download ')
  expect(requests).toEqual([])
})

test.each([[], ['tools'], ['tools', 'show'], ['tools', 'show', 'falcon-axi'], ['whoami'], ['login'], ['passwd'], ['logout'], ['doctor']].map(command => ({ command })))(
  'command help uses the common layout without configuration or network: $command', async ({ command }) => {
    requests = []
    const result = await cli([...command, '--help'], { ARTIUM_AXI_URL: undefined })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout).toMatch(/^purpose: [^\n]+\nusage: artium-axi[^\n]*\n/)
    expect(result.stdout).toContain('flags[')
    expect(result.stdout).toContain('example: artium-axi')
    expect(result.stdout).toContain('"--help (default false)"')
    expect(requests).toEqual([])
  })

test.each([[], ['tools'], ['tools', 'show'], ['tools', 'show', 'falcon-axi'], ['whoami'], ['login'], ['passwd'], ['logout'], ['doctor'],
  ['falcon-axi'], ['vectra-axi'], ['ldap-axi'], ['ado-axi'], ['awx-axi'], ['tenable-axi'], ['hybrid-axi'], ['checkpoint-axi'], ['az-axi'], ['mg-axi']].map(command => ({ command })))(
  'prefix help uses the local layout without configuration or network: $command', async ({ command }) => {
    requests = []
    const result = await cli(['--help', ...command], { ARTIUM_AXI_URL: undefined })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout).toMatch(/^purpose: [^\n]+\nusage: artium-axi[^\n]*\n/)
    expect(result.stdout).toContain('flags[')
    expect(result.stdout).toContain('example: artium-axi')
    expect(requests).toEqual([])
  })

test.each([
  ['--help', 'tools', 'show'],
  ['tools', '--help', 'show'],
  ['tools', 'show', '--help'],
  ['--help', 'tools', 'show', 'falcon-axi'],
  ['tools', '--help', 'show', 'falcon-axi'],
  ['tools', 'show', '--help', 'falcon-axi'],
  ['tools', 'show', 'falcon-axi', '--help'],
].flatMap(args => [{ args }, { args: ['--managed-session', ...args] }]))(
  'tools show help accepts every help position offline: $args', async ({ args }) => {
    requests = []
    const result = await cli(args, { ARTIUM_AXI_URL: undefined })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout).toContain('usage: artium-axi tools show <tool>')
    expect(requests).toEqual([])
  })

test.each([
  { args: ['missing'], token: 'missing', choices: 'Valid commands: gh-axi, setup, tools, whoami, login, passwd, logout, doctor, update, download, falcon-axi, vectra-axi, ldap-axi, ado-axi, awx-axi, tenable-axi, hybrid-axi, beyondtrust-axi, checkpoint-axi, az-axi, mg-axi' },
  { args: ['download', '--oops'], token: '--oops', choices: 'Valid flags for download: --help, --operation, --selector, --type, --destination' },
  { args: ['download', 'Limit'], token: 'Limit', choices: 'Valid flags for download: --help, --operation, --selector, --type, --destination' },
  { args: ['--oops'], token: '--oops', choices: 'Valid flags: --help, --version, --managed-session' },
  { args: ['tools', 'shwo'], token: 'shwo', choices: 'Valid subcommands: show <tool>' },
  { args: ['tools', 'show', 'missing'], token: 'missing', choices: 'Valid tools: falcon-axi, vectra-axi, az-axi, mg-axi, ldap-axi, ado-axi' },
  { args: ['tools', 'show', 'falcon-axi', '--oops'], token: '--oops', choices: 'Valid flags for tools show: --help' },
  { args: ['tools', '--help', 'show', '--oops'], token: '--oops', choices: 'Valid flags for tools show: --help' },
  { args: ['tools', '--help', 'show', 'missing'], token: 'missing', choices: 'Valid tools: falcon-axi, vectra-axi, az-axi, mg-axi, ldap-axi, ado-axi' },
  { args: ['tools', '--help', 'show', '--help'], token: '--help', choices: 'Valid flags for tools show: --help' },
  { args: ['whoami', '--oops'], token: '--oops', choices: 'Valid flags for whoami: --help' },
  { args: ['doctor', 'extra'], token: 'extra', choices: 'Valid flags for doctor: --help' },
  { args: ['logout', '--oops'], token: '--oops', choices: 'Valid flags for logout: --help' },
  { args: ['setup', '--host', 'missing'], token: 'missing', choices: 'Valid hosts: claude, codex, opencode, pi' },
  { args: ['setup', '--oops'], token: '--oops', choices: 'Valid flags for setup: --help, --host, --hook, --force' },
])('usage errors identify the token and command-level choices: $args', async ({ args, token, choices }) => {
  requests = []
  const result = await cli(args, { ARTIUM_AXI_URL: undefined })
  expect(result).toMatchObject({ code: 2, stderr: '' })
  expect(result.stdout).toContain(token)
  expect(result.stdout).toContain(choices)
  expect(requests).toEqual([])
})

test.each([
  ['login', '--username', 'synthetic-user'],
  ['passwd'],
  ['--managed-session', 'login', '--username', 'synthetic-user'],
  ['--managed-session', 'passwd'],
  ['--help', 'login', '--username', 'synthetic-user'],
  ['--help', 'passwd'],
  ['--managed-session', '--help', 'login', '--username', 'synthetic-user'],
  ['--managed-session', '--help', 'passwd'],
].flatMap(args => ['CANARY-password', '-CANARY-password', '--CANARY-password', '--password=CANARY-password']
  .map(password => ({ args: [...args, password] }))))('credential usage errors never echo rejected input: $args', async ({ args }) => {
  requests = []
  const result = await cli(args, { ARTIUM_AXI_URL: undefined })
  expect(result).toMatchObject({ code: 2, stderr: '' })
  expect(result.stdout).toContain('Password arguments are refused.')
  expect(result.stdout).toContain('Valid flags for')
  expect(result.stdout + result.stderr).not.toContain('CANARY-password')
  expect(requests).toEqual([])
})

test('ordinary help shows command purposes and keeps pipe details in managed and login help', async () => {
  const home = await cli(['--help'], { ARTIUM_AXI_URL: undefined })
  expect(home.stdout).toContain('commands[')
  expect(home.stdout).toContain('whoami,"Show your identity')
  expect(home.stdout).not.toContain('fd 3')
  const leaf = await cli(['whoami', '--help'], { ARTIUM_AXI_URL: undefined })
  expect(leaf.stdout).not.toContain('fd 3')
})

test.each([
  ['--managed-session', '--help'], ['login', '--help'], ['--managed-session', 'login', '--help'],
].map(args => ({ args })))('protocol help needs no private descriptors or configuration: $args', async ({ args }) => {
  const result = await cli(args, { ARTIUM_AXI_URL: undefined })
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('fd 3')
  expect(result.stdout).toContain('fd 4')
})

test('configuration errors reserve APPDATA advice for Windows', async () => {
  const ordinary = await cli(['whoami'], { ARTIUM_AXI_URL: 'invalid' })
  expect(ordinary).toMatchObject({ code: 2, stderr: '' })
  expect(ordinary.stdout).not.toContain('APPDATA')
  await expect(execute(process.execPath, [windowsBundle, 'whoami'], { cwd: directory, timeout: 10_000,
    env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url } })).rejects.toMatchObject({ code: 2, stderr: '',
    stdout: expect.stringContaining('Set APPDATA to your writable roaming configuration folder') })
})

test.each([
  ['--help', 'missing'], ['--unknown', 'falcon-axi'], ['--help', '--unknown', 'falcon-axi'],
  ['--help', 'falcon-axi', 'unexpected'],
].map(args => ({ args })))('invalid prefix help fails before configuration or network: $args', async ({ args }) => {
  requests = []
  expect(await cli(args, { ARTIUM_AXI_URL: undefined })).toMatchObject({ code: 2, stderr: '', stdout: expect.stringContaining('INVALID_INPUT') })
  expect(requests).toEqual([])
})

test('tool detail uses pinned help without running the tool', async () => {
  requests = []
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.8.2' }] } }
  const result = await cli(['tools', 'show', 'falcon-axi'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('version: "0.8.2"\nstatus: ok\nreadOnly: true\ncommands[')
  expect(result.stdout).toContain('example: artium-axi falcon-axi detection list\nupstreamHelp:')
  expect(result.stdout).toContain('default 20, ceiling 10000')
  const discovery = decode(result.stdout) as { commands: string[] }
  expect(discovery.commands).toEqual(expect.arrayContaining(['login', 'classification', 'cloud-asset', 'iom']))
  expect(discovery.commands).not.toContain('setup')
  expect(discovery.commands).not.toContain('config')
  expect(discovery.commands).not.toContain('profile')
  expect(requests.map(request => request.path)).toEqual(['/v1/tools'])
})

test('tool detail refuses an inaccessible tool with an administrator next step', async () => {
  response = { status: 200, body: { tools: [] } }
  expect(await cli(['tools', 'show', 'falcon-axi'])).toMatchObject({ code: 1,
    stdout: expect.stringContaining('TOOL_NOT_GRANTED'), stderr: '' })
})

test.each([
  { tool: 'az-axi', example: 'sub list', version: '0.1.14' },
  { tool: 'mg-axi', example: 'entra user list', version: '0.1.18' },
  { tool: 'vectra-axi', example: 'detection list', version: '0.1.12' },
  { tool: 'falcon-axi', example: 'detection list', version: '0.8.2' },
  { tool: 'ldap-axi', example: 'user list --limit 1', version: '0.3.1' },
  { tool: 'ado-axi', example: 'project list --limit 1', version: '0.4.7' },
  { tool: 'gh-axi', example: 'repo list --limit 1', version: '0.1.45' },
  { tool: 'awx-axi', example: 'job list --limit 1', version: '0.1.9' },
  { tool: 'tenable-axi', example: 'card list --limit 1', version: '0.1.4' },
  { tool: 'hybrid-axi', example: 'quota', version: '0.1.3' },
  { tool: 'checkpoint-axi', example: 'email search --limit 1', version: '0.1.1' },
])('$tool discovery exposes the pinned version and first read', async ({ tool, example, version }) => {
  response = { status: 200, body: { tools: [{ name: tool, status: 'ok', version }] } }
  const listing = await cli(['tools'])
  expect(listing).toMatchObject({ code: 0, stderr: '' })
  expect(listing.stdout).toContain(`artium-axi ${tool} ${example}`)
  const detail = await cli(['tools', 'show', tool])
  expect(detail).toMatchObject({ code: 0, stderr: '' })
  expect(detail.stdout).toContain(`version: "${version}"`)
  expect(detail.stdout).toContain(`example: artium-axi ${tool} ${example}`)
  expect(detail.stdout).toContain('upstreamHelp:')
})

test('tool detail refuses a mismatched pinned version', async () => {
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '9.9.9' }] } }
  expect(await cli(['tools', 'show', 'falcon-axi'])).toMatchObject({ code: 1,
    stdout: expect.stringContaining('INVALID_RESPONSE'), stderr: '' })
})

test.each(['falcon-axi', 'vectra-axi', 'ldap-axi', 'ado-axi', 'awx-axi', 'tenable-axi'] as const)('%s upstream help remains an authenticated passthrough', async tool => {
  requests = []
  response = { status: 200, body: { source: tool, stdout: 'upstream help\n', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 14, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  expect(await cli([tool, '--help'])).toMatchObject({ code: 0, stdout: 'upstream help\n', stderr: '' })
  expect(requests[0]).toMatchObject({ path: `/v1/tools/${tool}/run`, body: { args: ['--help'] } })
})
