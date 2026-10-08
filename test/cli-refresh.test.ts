import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { SessionStore } from '../src/cli/session.js'
import { ArtiumError, errorResponse } from '../src/shared/errors.js'

let directory: string
let url: string
let store: SessionStore
let requests: { path: string, authorization?: string, body: unknown }[]
let scenario: 'refresh' | 'still-expired' | 'disconnect' | 'invalid' | 'unavailable' | 'completed' | 'bad-refresh'
let server: ReturnType<typeof createServer>
const pair = { status: 'authenticated' as const, accessToken: 'CANARY-old', refreshToken: 'CANARY-refresh',
  accessExpiresAt: Date.now(), familyExpiresAt: Date.now() + 43200_000 }
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-cli-retry-'))
  copyFileSync('dist/cli/artium-axi.mjs', join(directory, 'artium-axi.mjs'))
  requests = []
  scenario = 'refresh'
  server = createServer(async (request, reply) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined })
    if (request.url === '/v1/auth/refresh') {
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(scenario === 'bad-refresh' ? {} : { ...pair, accessToken: 'CANARY-new', refreshToken: 'CANARY-next' }))
    } else if (scenario === 'disconnect') request.socket.destroy()
    else if (scenario === 'completed' || (scenario === 'refresh' && request.headers.authorization === 'Bearer CANARY-new')) {
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify({ source: 'falcon-axi', stdout: 'TOKEN_EXPIRED upstream text\n', stderr: '', exitCode: 7,
        durationMs: 1, outputBytes: { stdout: 28, stderr: 0 }, truncated: { stdout: false, stderr: false } }))
    } else {
      const failure = new ArtiumError(scenario === 'invalid' ? 'TOKEN_INVALID' : scenario === 'unavailable' ? 'SERVER_UNAVAILABLE' : 'TOKEN_EXPIRED')
      reply.writeHead(scenario === 'unavailable' ? 503 : 401, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(errorResponse(failure, 'synthetic-request')))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  store = new SessionStore(url, join(directory, 'artium-axi', 'session.json'))
  store.write(pair)
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})
async function run() {
  const child = spawn(process.execPath, [join(directory, 'artium-axi.mjs'), 'falcon-axi', 'detection', 'list'], {
    cwd: directory, env: { XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(child, 'close')
  return { stdout, stderr, code }
}

test('only a pre-execution expiry permits one refresh and one retry of the same arguments', async () => {
  expect(await run()).toEqual({ code: 7, stdout: 'TOKEN_EXPIRED upstream text\n', stderr: '' })
  expect(requests).toEqual([
    { path: '/v1/tools/falcon-axi/run', authorization: 'Bearer CANARY-old', body: { args: ['detection', 'list'] } },
    { path: '/v1/auth/refresh', authorization: undefined, body: { refreshToken: 'CANARY-refresh' } },
    { path: '/v1/tools/falcon-axi/run', authorization: 'Bearer CANARY-new', body: { args: ['detection', 'list'] } },
  ])
  expect(store.read()).toMatchObject({ accessToken: 'CANARY-new', refreshToken: 'CANARY-next' })
})

test('a second expiry ends the call without another refresh', async () => {
  scenario = 'still-expired'
  expect(await run()).toMatchObject({ code: 1, stdout: expect.stringContaining('TOKEN_EXPIRED') })
  expect(requests.map(request => request.path)).toEqual(['/v1/tools/falcon-axi/run', '/v1/auth/refresh', '/v1/tools/falcon-axi/run'])
})

test.each(['disconnect', 'invalid', 'unavailable', 'completed'] as const)('an uncertain or completed %s run is never retried', async outcome => {
  scenario = outcome
  expect((await run()).code).toBe(outcome === 'completed' ? 7 : 1)
  expect(requests).toHaveLength(1)
  expect(store.read()).toEqual(pair)
})

test('invalid refresh response preserves the session and never retries the run', async () => {
  scenario = 'bad-refresh'
  expect(await run()).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE') })
  expect(requests).toHaveLength(2)
  expect(store.read()).toEqual(pair)
})
