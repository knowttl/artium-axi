import { execFile, execFileSync, fork } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:https'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
let response: { status: number, body: unknown, location?: string, stall?: boolean }
let requests: { path: string, token?: string, body: unknown, version?: string }[]
let doctorResponses: Record<string, typeof response> | undefined
const server = createServer()

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'])
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
  await build({ entryPoints: ['src/cli/main.ts'], outfile: clockBundle, bundle: true,
    platform: 'node', format: 'esm', target: 'node22.12', loader: { '.md': 'text' }, inject: ['test/cli-clock.ts'] })
  createTestCertificates(directory, ['localhost'])
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) })
  server.on('request', async (request, reply) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, token: request.headers.authorization, body: body ? JSON.parse(body) : undefined,
      version: request.headers['x-artium-cli-version'] as string | undefined })
    const current = doctorResponses?.[request.url!] ?? response
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
    reply.writeHead(current.status, { 'content-type': 'application/json', ...(current.location ? { location: current.location } : {}) })
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

async function cli(args: string[], environment: NodeJS.ProcessEnv = {}, controlled = false) {
  const configuration = mkdtempSync(join(directory, 'config-'))
  new SessionStore((environment.ARTIUM_AXI_URL || url).replace(/\/$/, ''), join(configuration, 'artium-axi', 'session.json')).write({
    status: 'authenticated', accessToken: 'CANARY-cli-token', refreshToken: 'CANARY-cli-refresh',
    accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000,
  })
  const env = { PATH: process.env.PATH, ARTIUM_AXI_URL: url, XDG_CONFIG_HOME: configuration,
    ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'), ...environment }
  if (controlled) return controlledCli(args, env)
  try {
    return { ...await execute(process.execPath, [bundle, ...args], { cwd: directory, timeout: 10_000, env }), code: 0 }
  } catch (error) { return error as { stdout: string, stderr: string, code: number } }
}

async function controlledCli(args: string[], env: NodeJS.ProcessEnv) {
  const path = new URL(env.ARTIUM_AXI_URL!).pathname + (args[0] === 'tools' ? '/v1/tools' : '/v1/tools/falcon-axi/run')
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
    expect(timer.delay).toBe(DEFAULT_REQUEST_DEADLINE_MS)
    expect(DEFAULT_REQUEST_DEADLINE_MS).toBe(90_000)
    expect(socket.encrypted).toBe(true)
    let advanced = once(messages, 'advanced')
    child.send({ advance: DEFAULT_REQUEST_DEADLINE_MS - 1 })
    expect((await Promise.race([advanced, unexpectedExit]))[0]).toEqual({ event: 'advanced', elapsed: 89_999, pending: 1 })
    expect(socket.destroyed).toBe(false)
    expect(stdout).toBe('')
    expect(child.exitCode).toBeNull()
    advanced = once(messages, 'advanced')
    child.send({ advance: 1 })
    expect((await Promise.race([advanced, unexpectedExit]))[0]).toEqual({ event: 'advanced', elapsed: 90_000, pending: 0 })
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

test('standalone bundle lists tools and reports an empty list', async () => {
  requests = []
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' }] } }
  expect(await cli(['tools'])).toMatchObject({ code: 0, stdout: 'tools[1]{name,status,version}:\n  falcon-axi,ok,"0.3.0"\nnext[2]:\n  artium-axi tools show falcon-axi\n  artium-axi falcon-axi detection list\n', stderr: '' })
  expect(requests).toEqual([{ path: '/v1/tools', token: 'Bearer CANARY-cli-token', body: undefined, version: cliVersion }])
  response = { status: 200, body: { tools: [] } }
  expect((await cli(['tools'])).stdout).toBe('tools: 0 available\nreason: No enabled runtime tool is available through your assigned roles.\ncontact: Ask an administrator to check your role assignments and enabled tools.\nnext[1]:\n  artium-axi whoami\n')
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

test('doctor reports all prerequisite failures for an invalid server address', async () => {
  const result = await cli(['doctor'], { ARTIUM_AXI_URL: 'invalid' })
  expect(result).toMatchObject({ code: 2, stderr: '', stdout: expect.stringMatching(
    /^fail: server address \(CLIENT_CONFIG_INVALID\)\nfail: certificate \(CLIENT_CONFIG_INVALID\)\nfail: token \(CLIENT_CONFIG_INVALID\)\nfail: CLI version \(CLIENT_CONFIG_INVALID\)\nerror:\n  code: "CLIENT_CONFIG_INVALID"\n/) })
  expect(result.stdout).toContain('  source: "artium-axi"\n')
  expect(result.stdout).toContain(`  message: ${JSON.stringify(errors.CLIENT_CONFIG_INVALID.message)}\n`)
  expect(result.stdout).toContain(`  next: ${JSON.stringify(errors.CLIENT_CONFIG_INVALID.next)}\n`)
})

test('doctor retains the certificate error after continuing its prerequisite checks', async () => {
  const result = await cli(['doctor'], { ARTIUM_AXI_CA_FILE: undefined })
  expect(result).toMatchObject({ code: 1, stderr: '', stdout: expect.stringContaining('fail: certificate (CERTIFICATE_INVALID)\n') })
  expect(result.stdout).toContain('error:\n  code: "CERTIFICATE_INVALID"\n  source: "artium-axi"\n')
  expect(result.stdout).toContain(`  message: ${JSON.stringify(errors.CERTIFICATE_INVALID.message)}\n`)
  expect(result.stdout).toContain(`  next: ${JSON.stringify(errors.CERTIFICATE_INVALID.next)}\n`)
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

test.each([{ tools: [], extra: true }, { stdout: 'untrusted' }, { tools: [{ name: 'az-axi', status: 'ok', version: '0.1.4' }] }])('malformed response does not print unvalidated data', async body => {
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

test.each(Object.entries(errors))('catalogue error %s preserves source, next step, request ID and exit code', async (code, definition) => {
  response = { status: definition.status, body: errorResponse(new ArtiumError(code as keyof typeof errors), 'synthetic-catalogue') }
  const result = await cli(['falcon-axi', 'detection', 'list'])
  expect(result).toMatchObject({ code: ['INVALID_INPUT', 'UNSUPPORTED_INPUT', 'FLAG_BLOCKED', 'CLIENT_CONFIG_INVALID'].includes(code) ? 2 : 1, stderr: '' })
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
  ['falcon-axi'], ['vectra-axi']].map(command => ({ command })))(
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
  expect(result.stdout).toContain('version: "0.3.0"\nstatus: ok\ncommands[')
  expect(result.stdout).toContain('example: artium-axi falcon-axi detection list\nupstreamHelp:')
  expect(result.stdout).toContain('default 20, ceiling 10000')
  expect(requests.map(request => request.path)).toEqual(['/v1/tools'])
})

test('tool detail refuses an inaccessible tool with an administrator next step', async () => {
  response = { status: 200, body: { tools: [] } }
  expect(await cli(['tools', 'show', 'falcon-axi'])).toMatchObject({ code: 1,
    stdout: expect.stringContaining('TOOL_NOT_GRANTED'), stderr: '' })
})

test('tool detail refuses a mismatched pinned version', async () => {
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '9.9.9' }] } }
  expect(await cli(['tools', 'show', 'falcon-axi'])).toMatchObject({ code: 1,
    stdout: expect.stringContaining('INVALID_RESPONSE'), stderr: '' })
})

test.each(['falcon-axi', 'vectra-axi'] as const)('%s upstream help remains an authenticated passthrough', async tool => {
  requests = []
  response = { status: 200, body: { source: tool, stdout: 'upstream help\n', stderr: '', exitCode: 0,
    durationMs: 1, outputBytes: { stdout: 14, stderr: 0 }, truncated: { stdout: false, stderr: false } } }
  expect(await cli([tool, '--help'])).toMatchObject({ code: 0, stdout: 'upstream help\n', stderr: '' })
  expect(requests[0]).toMatchObject({ path: `/v1/tools/${tool}/run`, body: { args: ['--help'] } })
})
