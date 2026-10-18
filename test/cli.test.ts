import { execFile, execFileSync, fork, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import type { Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestCertificates } from './fake-service/certificates.mjs'
import { SessionStore } from '../src/cli/session.js'
import { DEFAULT_REQUEST_DEADLINE_MS } from '../src/cli/http.js'
import { cliVersion } from '../src/shared/version.js'
import { ArtiumError, errorResponse, errors } from '../src/shared/errors.js'

const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), 'artium-cli-'))
const bundle = join(directory, 'artium-axi.mjs')
const clockBundle = join(directory, 'artium-axi-clock.mjs')
const stalls = new EventEmitter()
let url: string
let response: { status: number, body: unknown, location?: string, stall?: boolean, serverVersion?: string }
let requests: { path: string, token?: string, body: unknown, version?: string }[]
let doctorResponses: Record<string, typeof response> | undefined
let responseSequence: typeof response[] | undefined
const server = createServer()

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'])
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
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
      ...(current.serverVersion ? { 'x-artium-cli-version': current.serverVersion } : {}) })
    if (current.stall || request.url!.startsWith('/stall-body/')) {
      reply.flushHeaders()
      if (request.url!.startsWith('/stall-body/')) stalled()
      return
    }
    reply.end(JSON.stringify(current.body))
  })
  server.listen(0)
  await once(server, 'listening')
  url = `https://localhost:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function cli(args: string[], environment: NodeJS.ProcessEnv = {}, controlled = false, input?: string) {
  const configuration = mkdtempSync(join(directory, 'config-'))
  new SessionStore((environment.ARTIUM_AXI_URL || url).replace(/\/$/, ''), join(configuration, 'artium-axi', 'session.json')).write({
    status: 'authenticated', accessToken: 'CANARY-cli-token', refreshToken: 'CANARY-cli-refresh',
    accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000,
  })
  const env = { PATH: process.env.PATH, ARTIUM_AXI_URL: url, XDG_CONFIG_HOME: configuration,
    ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'), ...environment }
  if (controlled) return controlledCli(args, env)
  try {
    const pending = execute(process.execPath, [bundle, ...args], { cwd: directory, timeout: 10_000, env })
    if (input !== undefined) pending.child.stdin!.end(input)
    return { ...await pending, code: 0 }
  } catch (error) { return error as { stdout: string, stderr: string, code: number } }
}

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

const managedTokens = { accessToken: 'CANARY-managed-access', refreshToken: 'CANARY-managed-refresh' }
const rotatedTokens = { status: 'authenticated', accessToken: 'CANARY-rotated-access', refreshToken: 'CANARY-rotated-refresh',
  accessExpiresAt: 100000, familyExpiresAt: 200000 }

async function managedCli(args: string[], options: { json?: string, input?: string, missing?: 3 | 4, existing?: boolean, environment?: NodeJS.ProcessEnv } = {}) {
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

test.each(['passwd', 'logout', 'setup'])('managed mode refuses %s before network access', async command => {
  requests = []
  expect(await managedCli([command])).toMatchObject({ code: 2, stdout: expect.stringContaining('unavailable in managed session mode'), stderr: '', rotations: '' })
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
    stderr: warning ? `warning: CLI ${cliVersion} differs from server ${serverVersion}; download the matching client from ${url}/cli/artium-axi.mjs and verify its .sha256, or run npm install -g @knowttl/artium-axi@${serverVersion}.\n` : '' })
})

test('standalone bundle lists tools and reports an empty list', async () => {
  requests = []
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' }] } }
  expect(await cli(['tools'])).toMatchObject({ code: 0, stdout: 'tools[1]{name,status,version,readOnly}:\n  falcon-axi,ok,"0.3.0",true\nnext[2]:\n  - artium-axi tools show falcon-axi\n  - artium-axi falcon-axi detection list\n', stderr: '' })
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

test.each([[], ['home'], ['sub', 'list'], ['--subscription', 'synthetic', 'sub', 'list']].map(args => [args]))(
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
  ['api', 'POST', '/providers/Microsoft.ResourceGraph/resources'],
].map(args => [args]))('Azure query and body commands retain piped stdin: %j', async args => {
  requests = []
  response = { status: 200, body: { source: 'az-axi', stdout: 'synthetic result', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 16, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  expect(await cli(['az-axi', ...args], {}, false, 'synthetic input'))
    .toMatchObject({ code: 0, stdout: 'synthetic result' })
  expect(requests[0].body).toEqual({ args, stdin: 'synthetic input' })
})

test.each(['stdin', 'file', 'file-equals'] as const)('Azure query forwards bounded %s input through the API', async kind => {
  requests = []
  response = { status: 200, body: { source: 'az-axi', stdout: 'synthetic result', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 16, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  const query = 'Resources\n| count'
  const path = join(directory, 'query.kql')
  writeFileSync(path, query)
  const args = kind === 'stdin' ? [] : kind === 'file' ? ['--file', path] : [`--file=${path}`]
  expect(await cli(['az-axi', 'rg', 'query', ...args], {}, false, kind === 'stdin' ? query : ''))
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
      roles: [], accessExpiresAt: Date.now() + 3600_000 } },
    '/v1/tools': { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' },
      { name: 'vectra-axi', status: 'error', version: '0.1.3' }] } },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringMatching(
      /^pass: server address\npass: certificate\npass: token\npass: CLI version\npass: falcon-axi \(ok\)\nfail: vectra-axi \(error\)\nerror:\n  code: "CREDENTIAL_UNAVAILABLE"\n/) })
    expect(requests.map(request => request.path)).toEqual(['/health/live', '/v1/me', '/v1/me', '/v1/tools'])
    expect(requests.map(request => request.version)).toEqual(Array(4).fill(cliVersion))
    doctorResponses['/v1/tools'].body = { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' }] }
    expect(await cli(['doctor'])).toMatchObject({ code: 0, stdout: expect.stringContaining('pass: falcon-axi (ok)') })
  } finally { doctorResponses = undefined }
})

test.each(['stall-headers', 'stall-body'])('doctor bounds %s and stops after address failure', async stall => {
  requests = []
  response = { status: 200, body: {} }
  const result = await cli(['doctor'], { ARTIUM_AXI_URL: `${url}/${stall}` }, true)
  expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringMatching(
    /^fail: server address \(SERVER_UNAVAILABLE\)\npass: certificate\nerror:\n  code: "SERVER_UNAVAILABLE"\n/) })
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
      /^pass: server address\npass: certificate\nfail: token\npass: CLI version\nerror:\n  code: "TOKEN_INVALID"\n/) })
    expect(requests.map(request => request.path)).toEqual(['/health/live', '/v1/me', '/v1/me'])
    expect(requests.map(request => request.token)).toEqual([undefined, undefined, 'Bearer CANARY-cli-token'])
  } finally { doctorResponses = undefined }
})

test('managed doctor refreshes privately and completes its diagnostic probes', async () => {
  requests = []
  const me = { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
    roles: [], accessExpiresAt: Date.now() + 3600_000 }
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
      stdout: 'pass: server address\npass: certificate\npass: token\npass: CLI version\n',
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
  { path: '/v1/tools', code: 'CREDENTIAL_UNAVAILABLE', diagnostic: 'tools' },
] as const)('doctor emits the catalogue error for $diagnostic failures', async ({ path, code, diagnostic }) => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000 } },
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
  { status: 'unconfigured', code: 'CREDENTIAL_UNAVAILABLE' },
  { status: 'unknown', code: 'SERVER_UNAVAILABLE' },
  { status: 'error', code: 'CREDENTIAL_UNAVAILABLE' },
  { status: 'disabled', code: 'TOOL_DISABLED' },
] as const)('doctor maps cached $status health to $code', async ({ status, code }) => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000 } },
    '/v1/tools': { status: 200, body: { tools: [{ name: 'falcon-axi', version: '0.3.0', status }] } },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining(`fail: falcon-axi (${status})\n`) })
    expect(result.stdout).toContain(`error:\n  code: "${code}"\n  source: "artium-axi"\n`)
    expect(result.stdout).toContain(`  message: ${JSON.stringify(errors[code].message)}\n`)
    expect(result.stdout).toContain(`  next: ${JSON.stringify(errors[code].next)}\n`)
    expect(result.stdout).toMatch(/  requestId: "[^"\n]+"\n$/)
  } finally { doctorResponses = undefined }
})

test.each(['/v1/me', '/v1/tools'])('doctor rejects a malformed %s response through the catalogue', async path => {
  doctorResponses = {
    '/health/live': { status: 200, body: { status: 'ok' } },
    '/v1/me': { status: 200, body: { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
      roles: [], accessExpiresAt: Date.now() + 3600_000 } },
    '/v1/tools': { status: 200, body: { tools: [] } },
    [path]: { status: 200, body: {} },
  }
  try {
    const result = await cli(['doctor'])
    expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining('error:\n  code: "INVALID_RESPONSE"\n  source: "artium-axi"\n') })
    expect(result.stdout).toContain(`  message: ${JSON.stringify(errors.INVALID_RESPONSE.message)}\n`)
    expect(result.stdout).toContain(`  next: ${JSON.stringify(errors.INVALID_RESPONSE.next)}\n`)
    expect(result.stdout).toMatch(/  requestId: "[^"\n]+"\n$/)
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

test.each([{ args: ['tools', '--unknown'] }, { args: ['missing'] }, { args: ['falcon-axi', 'x'.repeat(4097)] },
  { args: ['tools', 'show'] }, { args: ['tools', 'show', 'missing'] }, { args: ['login', '--unknown', '--help'] },
  { args: ['whoami', '--unknown', '--help'] }, { args: ['tools', 'show', '--unknown', '--help'] },
  { args: ['tools', 'show', 'missing', '--help'] }, { args: ['tools', '--help', 'show', '--unknown'] },
  { args: ['tools', 'show', '--help', '--unknown'] }])('usage failure exits 2 before sending a request', async ({ args }) => {
  requests = []
  expect(await cli(args)).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '' })
  expect(requests).toEqual([])
})

test.each(['INVALID_INPUT', 'TIMEOUT', 'SECRET_IN_OUTPUT'] as const)('catalogue error %s preserves source, next step, request ID and exit code', async code => {
  const definition = errors[code]
  response = { status: definition.status, body: errorResponse(new ArtiumError(code), 'synthetic-catalogue') }
  const result = await cli(['falcon-axi', 'detection', 'list'])
  expect(result).toMatchObject({ code: code === 'INVALID_INPUT' ? 2 : 1, stderr: '' })
  expect(result.stdout).toBe(`error:\n  code: ${JSON.stringify(code)}\n  source: "artium-axi"\n  message: ${JSON.stringify(definition.message)}\n  next: ${JSON.stringify(definition.next)}\n  requestId: "synthetic-catalogue"\n`)
})

test.each([[], ['tools'], ['tools', 'show'], ['tools', 'show', 'falcon-axi'], ['whoami'], ['login'], ['passwd'], ['logout'], ['doctor']].map(command => ({ command })))(
  'command help uses the common layout without configuration or network: $command', async ({ command }) => {
    requests = []
    const result = await cli([...command, '--help'], { ARTIUM_AXI_URL: undefined })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout).toMatch(/^usage: artium-axi[^\n]*\npurpose: [^\n]+\nflags\[\d+\]:\n(?:  [^\n]+\n)+example: artium-axi[^\n]*\n$/)
    expect(result.stdout).toContain('"--help (default false)"')
    expect(requests).toEqual([])
  })

test.each([[], ['tools'], ['tools', 'show'], ['tools', 'show', 'falcon-axi'], ['whoami'], ['login'], ['passwd'], ['logout'], ['doctor'],
  ['falcon-axi'], ['vectra-axi'], ['ldap-axi']].map(command => ({ command })))(
  'prefix help uses the local layout without configuration or network: $command', async ({ command }) => {
    requests = []
    const result = await cli(['--help', ...command], { ARTIUM_AXI_URL: undefined })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(result.stdout).toMatch(/^usage: artium-axi[^\n]*\npurpose: [^\n]+\nflags\[\d+\]:\n(?:  [^\n]+\n)+example: artium-axi[^\n]*\n$/)
    expect(requests).toEqual([])
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
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' }] } }
  const result = await cli(['tools', 'show', 'falcon-axi'])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('version: "0.3.0"\nstatus: ok\nreadOnly: true\ncommands[')
  expect(result.stdout).toContain('example: artium-axi falcon-axi detection list\nupstreamHelp:')
  expect(result.stdout).toContain('default 20, ceiling 10000')
  expect(requests.map(request => request.path)).toEqual(['/v1/tools'])
})

test('tool detail refuses an inaccessible tool with an administrator next step', async () => {
  response = { status: 200, body: { tools: [] } }
  expect(await cli(['tools', 'show', 'falcon-axi'])).toMatchObject({ code: 1,
    stdout: expect.stringContaining('TOOL_NOT_GRANTED'), stderr: '' })
})

test.each([
  { tool: 'az-axi', example: 'sub list', version: '0.1.8' },
  { tool: 'mg-axi', example: 'entra user list', version: '0.1.7' },
  { tool: 'ldap-axi', example: 'user list --limit 1', version: '0.1.4' },
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

test.each(['falcon-axi', 'vectra-axi', 'ldap-axi'] as const)('%s upstream help remains an authenticated passthrough', async tool => {
  requests = []
  response = { status: 200, body: { source: tool, stdout: 'upstream help\n', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 14, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  expect(await cli([tool, '--help'])).toMatchObject({ code: 0, stdout: 'upstream help\n', stderr: '' })
  expect(requests[0]).toMatchObject({ path: `/v1/tools/${tool}/run`, body: { args: ['--help'] } })
})
