import { spawn, execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { copyFileSync, mkdtempSync, rmSync, watch } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { SessionStore } from '../src/cli/session.js'
import { Client } from '../src/cli/http.js'
import { ArtiumError, errorResponse } from '../src/shared/errors.js'

let directory: string
let url: string
let store: SessionStore
let requests: { path: string, authorization?: string, body: unknown }[]
let scenario: 'refresh' | 'still-expired' | 'disconnect' | 'invalid' | 'unavailable' | 'completed' | 'bad-refresh' | 'login-replaced' | 'rotated' | 'hang'
let homeScenario: { changeAt?: string, transition?: 'replace' | 'remove', expiresAt?: string } | undefined
let original: ReturnType<SessionStore['write']>
let server: ReturnType<typeof createServer>
const pair = { status: 'authenticated' as const, accessToken: 'CANARY-old', refreshToken: 'CANARY-refresh',
  accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000 }
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-cli-retry-'))
  copyFileSync('dist/cli/artium-axi.mjs', join(directory, 'artium-axi.mjs'))
  requests = []
  scenario = 'refresh'
  homeScenario = undefined
  server = createServer(async (request, reply) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url!, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined })
    if (homeScenario && request.url !== '/v1/auth/refresh') {
      if (request.url === homeScenario.changeAt) {
        await store.locked(async () => {
          if (homeScenario!.transition === 'remove') store.remove()
          else store.write({ ...pair, accessToken: 'CANARY-other-user' })
        })
      }
      const expired = request.url === homeScenario.expiresAt && request.headers.authorization === 'Bearer CANARY-old'
      reply.writeHead(expired ? 401 : 200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(expired ? errorResponse(new ArtiumError('TOKEN_EXPIRED'), 'synthetic-request') :
        request.url === '/v1/me' ? { username: 'synthetic-user', displayName: 'Synthetic User', administrator: false,
          roles: [], accessExpiresAt: pair.accessExpiresAt, sessionExpiresAt: pair.familyExpiresAt } : { tools: [] }))
      return
    }
    if (requests.length === 1 && (scenario === 'login-replaced' || scenario === 'rotated')) {
      await store.locked(async () => {
        store.write({ ...pair, accessToken: 'CANARY-new', refreshToken: 'CANARY-next' },
          scenario === 'rotated' ? original.loginGeneration : undefined)
      })
    }
    if (request.url === '/v1/auth/refresh') {
      if (scenario === 'hang') return
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(scenario === 'bad-refresh' ? {} : { ...pair, accessToken: 'CANARY-new', refreshToken: 'CANARY-next' }))
    } else if (scenario === 'disconnect') request.socket.destroy()
    else if (scenario === 'completed' || ((scenario === 'refresh' || scenario === 'rotated') && request.headers.authorization === 'Bearer CANARY-new')) {
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
  original = store.write(pair)
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})
async function run(args = ['falcon-axi', 'detection', 'list']) {
  const child = spawn(process.execPath, [join(directory, 'artium-axi.mjs'), ...args], {
    cwd: directory, env: { XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const [code] = await once(child, 'close')
  return { stdout, stderr, code }
}

test('a bundle copied during publication remains executable', async () => {
  const watcher = watch('dist/cli')
  try {
    const copied = new Promise<void>((resolve, reject) => {
      watcher.on('error', reject)
      watcher.on('change', (_event, filename) => {
        if (filename !== 'artium-axi.mjs') return
        try { copyFileSync('dist/cli/artium-axi.mjs', join(directory, 'artium-axi.mjs')); resolve() }
        catch (error) { reject(error) }
        watcher.close()
      })
    })
    await Promise.all([copied, promisify(execFile)(process.execPath, ['scripts/build-cli.mjs'])])
    expect(await run(['--help'])).toMatchObject({ code: 0, stderr: '', stdout: expect.stringContaining('usage: artium-axi') })
  } finally { watcher.close() }
})

test('only a pre-execution expiry permits one refresh and one retry of the same arguments', async () => {
  expect(await run()).toEqual({ code: 7, stdout: 'TOKEN_EXPIRED upstream text\n', stderr: '' })
  expect(requests).toEqual([
    { path: '/v1/tools/falcon-axi/run', authorization: 'Bearer CANARY-old', body: { args: ['detection', 'list'] } },
    { path: '/v1/auth/refresh', authorization: undefined, body: { refreshToken: 'CANARY-refresh' } },
    { path: '/v1/tools/falcon-axi/run', authorization: 'Bearer CANARY-new', body: { args: ['detection', 'list'] } },
  ])
  expect(store.read()).toMatchObject({ accessToken: 'CANARY-new', refreshToken: 'CANARY-next' })
  expect(store.read()!.loginGeneration).toBe(original.loginGeneration)
})

test('a second expiry ends the call without another refresh', async () => {
  scenario = 'still-expired'
  expect(await run()).toMatchObject({ code: 1, stdout: expect.stringContaining('TOKEN_EXPIRED') })
  expect(requests.map(request => request.path)).toEqual(['/v1/tools/falcon-axi/run', '/v1/auth/refresh', '/v1/tools/falcon-axi/run'])
})

test.each([true, false])('concurrent ambient deadlines release refresh locks before the host timeout, expired=%s (R1)', async expired => {
  scenario = 'hang'
  store.write({ ...pair, accessExpiresAt: expired ? Date.now() - 1 : pair.accessExpiresAt })
  const ambient = () => promisify(execFile)(process.execPath, [join(directory, 'artium-axi.mjs'), 'session-context'], {
    cwd: directory, timeout: 8_000,
    env: { XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' },
  }).catch(error => ({ stdout: error.stdout, stderr: error.stderr, killed: error.killed }))
  const refreshing = once(server, 'request')
  const first = ambient()
  await refreshing
  const results = await Promise.all([first, ambient()])
  for (const result of results) expect(result).toEqual({
    stdout: expect.stringContaining('artium: unavailable\nreason: SERVER_UNAVAILABLE\n'), stderr: '',
  })
  scenario = 'refresh'
  homeScenario = {}
  expect(await run(['tools'])).toMatchObject({ code: 0, stdout: expect.stringContaining('tools: 0 available') })
})

test('cancelling a refresh lock wait preserves the owner and permits later requests (R1)', async () => {
  store.write({ ...pair, accessExpiresAt: Date.now() - 1 })
  const client = new Client({ XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' })
  await store.locked(async () => {
    const pending = client.authenticated('/v1/tools', 'GET')
    client.cancel()
    await expect(pending).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' })
  })
  homeScenario = {}
  expect(await run(['tools'])).toMatchObject({ code: 0, stdout: expect.stringContaining('tools: 0 available') })
})

test.each(['disconnect', 'invalid', 'unavailable', 'completed'] as const)('an uncertain or completed %s run is never retried', async outcome => {
  scenario = outcome
  expect((await run()).code).toBe(outcome === 'completed' ? 7 : 1)
  expect(requests).toHaveLength(1)
  expect(store.read()).toEqual(original)
})

test('invalid refresh response preserves the session and never retries the run', async () => {
  scenario = 'bad-refresh'
  expect(await run()).toMatchObject({ code: 1, stdout: expect.stringContaining('INVALID_RESPONSE') })
  expect(requests).toHaveLength(2)
  expect(store.read()).toEqual(original)
})

test.each([
  { args: ['falcon-axi', 'detection', 'list'] },
  { args: ['tools'] },
  { args: ['whoami'] },
])('a concurrent login stops the expired $args call before refresh or retry', async ({ args }) => {
  scenario = 'login-replaced'
  expect(await run(args)).toMatchObject({ code: 1, stdout: expect.stringContaining('SESSION_CHANGED') })
  expect(requests).toHaveLength(1)
  expect(store.read()).toMatchObject({ accessToken: 'CANARY-new', refreshToken: 'CANARY-next' })
  expect(store.read()!.loginGeneration).not.toBe(original.loginGeneration)
})

test('a concurrent rotation of the same login reuses its token without another refresh', async () => {
  scenario = 'rotated'
  expect(await run()).toEqual({ code: 7, stdout: 'TOKEN_EXPIRED upstream text\n', stderr: '' })
  expect(requests.map(request => request.path)).toEqual(['/v1/tools/falcon-axi/run', '/v1/tools/falcon-axi/run'])
  expect(store.read()!.loginGeneration).toBe(original.loginGeneration)
})

test.each([
  { changeAt: '/v1/me', transition: 'replace' as const },
  { changeAt: '/v1/me', transition: 'remove' as const },
  { changeAt: '/v1/tools', transition: 'replace' as const },
  { changeAt: '/v1/tools', transition: 'remove' as const },
])('home withholds composite output when the session changes during $changeAt: $transition', async change => {
  homeScenario = change
  const result = await run([])
  expect(result).toMatchObject({ code: 1, stderr: '' })
  expect(result.stdout.startsWith(`bin: ${JSON.stringify(join(directory, 'artium-axi.mjs'))}\ndescription: Run managed upstream tools through one local sign-in.\nerror:\n  code: "SESSION_CHANGED"`)).toBe(true)
  expect(result.stdout).not.toMatch(/^(user|server|roles|sessionExpiresAt|accessExpiresAt|tools)[:\[]/m)
  expect(requests.map(request => request.path).sort()).toEqual(['/v1/me', '/v1/tools'])
})

test.each(['replace', 'remove'] as const)('ambient context withholds grants after session %s (R2)', async transition => {
  homeScenario = { changeAt: '/v1/tools', transition }
  expect(await run(['session-context'])).toEqual({ code: 0, stderr: '',
    stdout: 'artium: unavailable\nreason: SESSION_CHANGED\nnote: Current tool access could not be verified; no cached grants are shown.\nnext: artium-axi doctor\n' })
})

test('ambient context permits refresh within the original login (R2)', async () => {
  homeScenario = { expiresAt: '/v1/tools' }
  expect(await run(['session-context'])).toEqual({ code: 0, stderr: '',
    stdout: 'artium: available\ntools[0]{name,status,readOnly}:\n\nnext: artium-axi tools\nnote: Server roles and write gates still apply.\n' })
  expect(store.read()!.loginGeneration).toBe(original.loginGeneration)
})

test.each(['/v1/me', '/v1/tools'])('home allows refresh during %s within the original login', async expiresAt => {
  homeScenario = { expiresAt }
  const result = await run([])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(result.stdout).toContain('user: "synthetic-user"\n')
  expect(result.stdout).toContain('tools: 0 available\n')
  expect(requests.map(request => request.path).sort()).toEqual(['/v1/me', '/v1/tools', '/v1/auth/refresh', expiresAt].sort())
  expect(requests.filter(request => request.path === expiresAt).map(request => request.authorization))
    .toEqual(['Bearer CANARY-old', 'Bearer CANARY-new'])
  expect(store.read()!.loginGeneration).toBe(original.loginGeneration)
})

test.each([
  { restrictedBefore: false, restrictedAfter: false },
  { restrictedBefore: false, restrictedAfter: true },
  { restrictedBefore: true, restrictedAfter: false },
  { restrictedBefore: true, restrictedAfter: true },
])('password change preserves the login across prompts: $restrictedBefore to $restrictedAfter', async ({ restrictedBefore, restrictedAfter }) => {
  const restricted = { status: 'password-change-required' as const, passwordChangeToken: 'CANARY-restricted', passwordChangeExpiresAt: Date.now() + 600_000 }
  const before = store.write(restrictedBefore ? restricted : pair)
  const client = new Client({ XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' })
  let replacement: ReturnType<SessionStore['write']> | undefined
  await expect(client.changePassword(async session => {
    expect(session).toEqual(before)
    await store.locked(async () => { replacement = store.write(restrictedAfter ? restricted : pair) })
    return { newPassword: 'CANARY-new-password', ...(restrictedBefore ? {} : { currentPassword: 'CANARY-current-password' }) }
  })).rejects.toMatchObject({ code: 'SESSION_CHANGED' })
  expect(requests).toEqual([])
  expect(store.read()).toEqual(replacement)
})
