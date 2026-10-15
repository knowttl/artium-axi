import { execFile, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { SessionStore } from '../src/cli/session.js'
import { ArtiumError, errorResponse } from '../src/shared/errors.js'
import type { ErrorCode } from '../src/shared/errors.js'

let directory: string
let server: ReturnType<typeof createServer>
let url: string
let polls: number[]
let failure: ErrorCode
let lifetimeMs: number
let store: SessionStore
const session = { status: 'authenticated', accessToken: 'CANARY-access', refreshToken: 'CANARY-refresh',
  accessExpiresAt: Date.now() + 300_000, familyExpiresAt: Date.now() + 28_800_000 }

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-cli-device-'))
  polls = []
  failure = 'DEVICE_POLL_LIMITED'
  lifetimeMs = 60_000
  server = createServer(async (request, reply) => {
    for await (const _chunk of request) { /* Drain the request body. */ }
    reply.setHeader('content-type', 'application/json')
    if (request.url === '/v1/auth/device') {
      reply.end(JSON.stringify({ deviceCode: 'CANARY-device', userCode: 'ABCD-EFGH', verificationUri: url + '/device',
        expiresAt: Date.now() + lifetimeMs, intervalMs: 1000 }))
      return
    }
    polls.push(performance.now())
    if (polls.length === 1) reply.end(JSON.stringify({ status: 'pending' }))
    else if (polls.length === 2) {
      reply.statusCode = 429
      reply.end(JSON.stringify(errorResponse(new ArtiumError(failure), 'synthetic-request')))
    } else reply.end(JSON.stringify(session))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  store = new SessionStore(url, join(directory, 'artium-axi', 'session.json'))
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function login() {
  return promisify(execFile)(process.execPath, ['dist/cli/artium-axi.mjs', 'login', '--sso'], {
    env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' },
  })
}

test('bundled SSO login waits and resumes pending approval after a polling limit', async () => {
  const result = await login()
  expect(result.stdout).toContain('status: authenticated')
  expect(store.read()).toMatchObject(session)
  expect(polls).toHaveLength(3)
  expect(polls[2]! - polls[1]!).toBeGreaterThan(900)
  expect(result.stdout + result.stderr).not.toContain(session.accessToken)
  expect(result.stdout + result.stderr).not.toContain(session.refreshToken)
})

test.each(['DEVICE_DENIED', 'DEVICE_CODE_EXPIRED', 'SERVER_UNAVAILABLE'] as const)(
  'bundled SSO login stops on %s without saving a session', async code => {
    failure = code
    await expect(login()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(code) })
    expect(store.read()).toBeUndefined()
    expect(polls).toHaveLength(2)
  })

test('bundled SSO login stops at device expiry after a polling limit', async () => {
  lifetimeMs = 1500
  await expect(login()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('DEVICE_CODE_EXPIRED') })
  expect(store.read()).toBeUndefined()
  expect(polls).toHaveLength(2)
})
