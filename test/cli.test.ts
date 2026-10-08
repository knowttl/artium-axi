import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestCertificates } from './fake-service/certificates.mjs'

const execute = promisify(execFile)
const directory = mkdtempSync(join(tmpdir(), 'artium-cli-'))
const tokenFile = join(directory, 'token')
const bundle = join(directory, 'artium-axi.mjs')
let url: string
let response: { status: number, body: unknown, location?: string, stall?: boolean }
let requests: { path: string, token?: string, body: unknown }[]
const server = createServer()

beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'])
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
  writeFileSync(tokenFile, 'CANARY-cli-token', { mode: 0o600 })
  createTestCertificates(directory, ['localhost'])
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) })
  server.on('request', async (request, reply) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, token: request.headers.authorization, body: body ? JSON.parse(body) : undefined })
    if (request.url!.startsWith('/stall-headers/')) return
    reply.writeHead(response.status, { 'content-type': 'application/json', ...(response.location ? { location: response.location } : {}) })
    if (response.stall || request.url!.startsWith('/stall-body/')) {
      reply.flushHeaders()
      return
    }
    reply.end(JSON.stringify(response.body))
  })
  server.listen(0)
  await once(server, 'listening')
  url = `https://localhost:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function cli(args: string[], environment: NodeJS.ProcessEnv = {}, timeout = 10_000) {
  try {
    return { ...await execute(process.execPath, [bundle, ...args], { cwd: directory, timeout,
      env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, ARTIUM_AXI_DEV_TOKEN_FILE: tokenFile,
        ARTIUM_AXI_CA_FILE: join(directory, 'ca.crt'), ...environment } }), code: 0 }
  } catch (error) { return error as { stdout: string, stderr: string, code: number } }
}

test('standalone bundle lists tools and reports an empty list', async () => {
  requests = []
  response = { status: 200, body: { tools: [{ name: 'falcon-axi', status: 'ok', version: '0.3.0' }] } }
  expect(await cli(['tools'])).toMatchObject({ code: 0, stdout: 'tools[1]{name,status,version}:\n  falcon-axi,ok,"0.3.0"\n', stderr: '' })
  expect(requests).toEqual([{ path: '/v1/tools', token: 'Bearer CANARY-cli-token', body: undefined }])
  response = { status: 200, body: { tools: [] } }
  expect((await cli(['tools'])).stdout).toBe('tools: 0 available\n')
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

test.each([301, 302, 303, 307, 308])('authenticated redirect %i is refused without a second request', async status => {
  requests = []
  response = { status, body: {}, location: `${url}/destination`, stall: true }
  expect(await cli(['tools'])).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE'), stderr: '' })
  expect(requests).toHaveLength(1)
})

test('stalled headers and bodies fail without retrying either command', async () => {
  requests = []
  response = { status: 200, body: {} }
  const results = await Promise.all([
    cli(['tools'], { ARTIUM_AXI_URL: `${url}/stall-headers` }, 95_000),
    cli(['falcon-axi'], { ARTIUM_AXI_URL: `${url}/stall-headers` }, 95_000),
    cli(['tools'], { ARTIUM_AXI_URL: `${url}/stall-body` }, 95_000),
    cli(['falcon-axi'], { ARTIUM_AXI_URL: `${url}/stall-body` }, 95_000),
  ])
  const failure = { code: 1, stdout: expect.stringContaining('SERVER_UNAVAILABLE'), stderr: '' }
  expect(results).toMatchObject([failure, failure, failure, failure])
  expect(requests.map(request => request.path).sort()).toEqual([
    '/stall-body/v1/tools', '/stall-body/v1/tools/falcon-axi/run',
    '/stall-headers/v1/tools', '/stall-headers/v1/tools/falcon-axi/run',
  ])
}, 100_000)

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
  expect(await cli(['tools'], { ARTIUM_AXI_CA_FILE: undefined })).toMatchObject({ code: 1, stdout: expect.stringContaining('SERVER_UNAVAILABLE') })
  expect(requests).toEqual([])
})

test('owner-only development token file is required on Linux', async () => {
  requests = []
  chmodSync(tokenFile, 0o644)
  try { expect(await cli(['tools'])).toMatchObject({ code: 2, stdout: expect.stringContaining('CLIENT_CONFIG_INVALID') }) }
  finally { chmodSync(tokenFile, 0o600) }
  expect(requests).toEqual([])
})

test('Artium errors withhold streams and use the failure status', async () => {
  requests = []
  response = { status: 500, body: { error: { code: 'SECRET_IN_OUTPUT', source: 'artium-axi', message: 'Known secret detected.', next: 'Check upstream.', requestId: 'synthetic-request' } } }
  expect(await cli(['falcon-axi', 'env'])).toMatchObject({ code: 1, stdout: expect.stringContaining('SECRET_IN_OUTPUT'), stderr: '' })
})

test.each([{ tools: [], extra: true }, { stdout: 'untrusted' }])('malformed response does not print unvalidated data', async body => {
  requests = []
  response = { status: 200, body }
  expect(await cli(['tools'])).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE'), stderr: '' })
})

test.each([{ args: [] }, { args: ['tools', '--unknown'] }, { args: ['missing'] }, { args: ['falcon-axi', 'x'.repeat(4097)] }])('usage failure exits 2 before sending a request', async ({ args }) => {
  requests = []
  expect(await cli(args)).toMatchObject({ code: 2, stdout: expect.stringContaining('INVALID_INPUT'), stderr: '' })
  expect(requests).toEqual([])
})
