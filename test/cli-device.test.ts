import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { copyClientInput } from './fixtures/client-inputs.js'
import { ssoLogin } from '../src/cli/device.js'
import { Client } from '../src/cli/http.js'
import { SessionStore } from '../src/cli/session.js'
import { ArtiumError, errorResponse } from '../src/shared/errors.js'
import type { ErrorCode } from '../src/shared/errors.js'

vi.mock('node:timers/promises', async importOriginal => {
  const timers = await importOriginal<typeof import('node:timers/promises')>()
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) }
})

let directory: string
let server: ReturnType<typeof createServer>
let url: string
let polls: number[]
let failure: ErrorCode
let serverVersion: string | undefined
let store: SessionStore
let deviceLifetimeMs: number
const session = { status: 'authenticated', accessToken: 'CANARY-access', refreshToken: 'CANARY-refresh',
  accessExpiresAt: Date.now() + 300_000, familyExpiresAt: Date.now() + 28_800_000 }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-cli-device-'))
  copyClientInput('bundle', join(directory, 'artium-axi.mjs'))
  polls = []
  failure = 'DEVICE_POLL_LIMITED'
  serverVersion = undefined
  deviceLifetimeMs = 60_000
  server = createServer(async (request, reply) => {
    for await (const _chunk of request) { /* Drain the request body. */ }
    reply.setHeader('content-type', 'application/json')
    if (serverVersion) reply.setHeader('x-artium-cli-version', serverVersion)
    if (request.url === '/v1/auth/device') {
      reply.end(JSON.stringify({ deviceCode: 'CANARY-device', userCode: 'ABCD-EFGH', verificationUri: url + '/device',
        expiresAt: Date.now() + deviceLifetimeMs, intervalMs: 1000 }))
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
  vi.mocked(setTimeout).mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

async function login() {
  return promisify(execFile)(process.execPath, [join(directory, 'artium-axi.mjs'), 'login', '--sso'], {
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

test('bundled SSO login warns once on version mismatch and still saves the session', async () => {
  serverVersion = '999.0.0'
  const result = await login()
  expect(result.stdout).toContain('status: authenticated')
  expect(result.stderr.split('\n').filter(line => line.startsWith('warning:'))).toEqual([
    expect.stringContaining('differs from server 999.0.0'),
  ])
  expect(result.stderr).toContain('npm install -g @knowttl/artium-axi@999.0.0')
  expect(store.read()).toMatchObject(session)
})

test.each(['DEVICE_DENIED', 'DEVICE_CODE_EXPIRED', 'SERVER_UNAVAILABLE'] as const)(
  'bundled SSO login stops on %s without saving a session', async code => {
    failure = code
    await expect(login()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(code) })
    expect(store.read()).toBeUndefined()
    expect(polls).toHaveLength(2)
  })

test('SSO login stops at device expiry after a polling limit', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  deviceLifetimeMs = 1500
  const client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  // A real timer may wake before expiry and legitimately allow another poll.
  // Advance the clock exactly so this checks expiry rather than timer scheduling.
  vi.mocked(setTimeout).mockImplementation(async ms => {
    vi.setSystemTime(Date.now() + ms!)
  })
  await expect(ssoLogin(client)).rejects.toMatchObject({ code: 'DEVICE_CODE_EXPIRED' })
  expect(store.read()).toBeUndefined()
  expect(Date.now()).toBe(new Date('2026-01-01T00:00:01.500Z').getTime())
  expect(polls).toHaveLength(2)
})
