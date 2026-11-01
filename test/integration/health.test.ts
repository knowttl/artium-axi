import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connect as connectTls } from 'node:tls'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { healthDefaults } from '../../src/server/config.js'
import { ToolHealth } from '../../src/server/health/health.js'
import { diagnosticError } from '../../src/server/health/diagnostic.js'
import { cliOutdatedDownloadNext, cliOutdatedUpdateNext, errors } from '../../src/shared/errors.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner, RunnerError } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { toolsResponseSchema } from '../../src/shared/api.js'
import { cliVersion, firstVersionWithUpdate, hasCliUpdateCommand } from '../../src/shared/version.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'
import { failedTlsSocket } from '../fixtures/failed-tls-socket.js'

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: vi.fn(original.spawn) }
})

async function controlledHealthProcess() {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let started!: (finish: () => void) => void
  const ready = new Promise<() => void>(resolve => { started = resolve })
  vi.mocked(spawn).mockImplementationOnce((_executable, _args, options) => {
    const child = original.spawn(fakeTool.executable, [...fakeTool.args, 'controlled-health'], {
      ...options, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    void once(child, 'message').then(() => started(() => { child.send({ stdout: 'synthetic', stderr: '', exitCode: 0 }) }))
    return child
  })
  return ready
}

let directory: string
let db: Database.Database
let runner: Runner
let app: ReturnType<typeof createApp>
let health: ToolHealth
let store: ReturnType<typeof createCredentialStore>
let adapter: ReturnType<typeof createFalconAdapter>
let token: string
const result = { stdout: 'synthetic', stderr: '', exitCode: 0, durationMs: 1,
  outputBytes: { stdout: 9, stderr: 0 }, timedOut: false, truncated: { stdout: false, stderr: false } }
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-health-'))
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  await seedToolUser(db)
  token = issueTestAccessToken(db, 'synthetic-development-user')
  store = createCredentialStore(db, provider)
  store.replaceCredential('falcon-axi', { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' },
    0, 'synthetic-development-user', Date.now())
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  adapter = createFalconAdapter(new EmbeddedSecretSource(store))
  runner = await Runner.create(join(directory, 'calls'))
  health = new ToolHealth(db, new Audit(db), runner, [adapter], store)
  app = createApp({ db, audit: new Audit(db), runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
})
afterEach(async () => {
  await app.close()
  await health.stop()
  db.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

test.each([
  { name: 'unconfigured credential', code: 'CREDENTIAL_NOT_CONFIGURED', revision: null, arrange: async () => {
    db.exec('DELETE FROM credentials')
    return async () => {}
  } },
  { name: 'missing adapter with a credential', code: 'TOOL_DISABLED', revision: 1, arrange: async () => {
    health = new ToolHealth(db, new Audit(db), runner, [], store)
    return async () => {}
  } },
  { name: 'missing adapter without a credential', code: 'TOOL_DISABLED', revision: null, arrange: async () => {
    db.exec('DELETE FROM credentials')
    health = new ToolHealth(db, new Audit(db), runner, [], store)
    return async () => {}
  } },
  { name: 'pending check', code: 'TOO_MANY_CALLS', revision: 1, arrange: async () => {
    const ready = controlledHealthProcess()
    const pending = health.check('falcon-axi', 'synthetic-development-user', 'held-check', null)
    const finish = await ready
    return async () => { finish(); await pending }
  } },
] as const)('$name admission returns safe configuration diagnostics', async ({ code, revision, arrange }) => {
  const cleanup = await arrange()
  try {
    await expect(health.check('falcon-axi', 'synthetic-development-user', 'admission-test', null)).rejects.toMatchObject({
      code, diagnostic: { stage: 'configuration', message: errors[code].message,
        checkedAt: expect.any(Number), credentialRevision: revision },
    })
    const audit = db.prepare("SELECT checked_at, credential_revision, error_code FROM audit WHERE request_id = 'admission-test'").get()
    expect(audit).toEqual({ checked_at: expect.any(Number), credential_revision: revision, error_code: code })
    expect(JSON.stringify(audit)).not.toContain('CANARY-secret')
  } finally { await cleanup() }
})

test('scheduled checks never overlap a pending check and manual tests share that exclusion', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const ready = controlledHealthProcess()
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  const finish = await ready
  await expect(health.check('falcon-axi', 'synthetic-development-user', 'manual-test', null))
    .rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs * 3)
  expect(db.prepare("SELECT user_id, tool FROM audit WHERE event = 'run-start'").all())
    .toEqual([{ user_id: null, tool: 'falcon-axi' }])
  finish()
  await health.stop()
  expect(db.prepare('SELECT status, credential_revision FROM tool_health').get()).toEqual({ status: 'ok', credential_revision: 1 })
  expect(db.prepare("SELECT action, checked_at, credential_revision FROM audit WHERE event = 'health-check'").get())
    .toEqual({ action: healthDefaults.actor, checked_at: expect.any(Number), credential_revision: 1 })
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'read' })
})

test('a background credential check emits exactly one run with its audit request ID', async () => {
  const ready = controlledHealthProcess()
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const pending = health.refresh('falcon-axi')
  const finish = await ready
  finish()
  await pending
  const audit = db.prepare("SELECT request_id FROM audit WHERE event = 'run-terminal'").get() as { request_id: string }
  expect(stderr.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
    expect.objectContaining({ event: 'run', requestId: audit.request_id, tool: 'falcon-axi', exitCode: 0 }),
  ])
})

test.each([
  { actor: 'synthetic-development-user', event: 'credential-test' },
  { actor: healthDefaults.actor, event: 'health-check' },
])('a failed $event retains its private diagnostic across restart', async ({ actor, event }) => {
  const lines: string[] = []
  const audit = new Audit(db, Date.now, line => { lines.push(line) })
  health = new ToolHealth(db, audit, runner, [adapter], store)
  const stderr = 'code: AUTH_FAILED\nmessage: Synthetic retained health failure'
  vi.spyOn(runner, 'run').mockResolvedValueOnce({ ...result, stdout: '', stderr, exitCode: 1 })
  await expect(health.check('falcon-axi', actor, 'retained-check', null)).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_FAILED' })
  const diagnostic = { stage: 'authentication', message: stderr, toolCode: 'AUTH_FAILED',
    checkedAt: expect.any(Number), credentialRevision: 1 }
  expect(audit.runDiagnostic('retained-check')).toEqual(diagnostic)
  expect(lines).toHaveLength(3)
  expect(lines.join('')).not.toContain('Synthetic retained health failure')
  await app.close()
  await health.stop()
  db.close()
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  store = createCredentialStore(db, provider)
  adapter = createFalconAdapter(new EmbeddedSecretSource(store))
  runner = await Runner.create(join(directory, 'calls'))
  const restartedAudit = new Audit(db)
  health = new ToolHealth(db, restartedAudit, runner, [adapter], store)
  app = createApp({ db, audit: restartedAudit, runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  expect(health.diagnostic('falcon-axi', 1, Date.now())).toBeUndefined()
  expect(restartedAudit.runDiagnostic('retained-check')).toEqual(diagnostic)
  db.prepare('UPDATE users SET administrator = 1').run()
  const session = createBrowserSession(db, 'synthetic-development-user', 'CANARY-csrf')
  const headers = { cookie: `${browserCookie}=${session.id}` }
  const { id } = db.prepare("SELECT id FROM audit WHERE request_id = 'retained-check' AND event = 'run-terminal'").get() as { id: number }
  const page = await app.inject({ url: '/admin/audit?requestId=retained-check&record=' + id, headers })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('Synthetic retained health failure')
  const exported = await app.inject({ url: '/v1/admin/audit/export?format=jsonl&requestId=retained-check', headers })
  expect(exported.statusCode).toBe(200)
  expect(exported.body.trim().split('\n').map(line => JSON.parse(line).event)).toEqual([
    event, 'run-terminal', 'run-start',
  ])
  expect(exported.body).not.toContain('Synthetic retained health failure')
})

test.each([
  { name: 'startup check', retry: false },
  { name: 'transient-failure retry', retry: true },
])('a manual check cannot consume a pending $name', async ({ retry }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const failure = { ...result, stderr: 'connect ECONNREFUSED', exitCode: 1 }
  const run = vi.spyOn(runner, 'run').mockResolvedValue(result)
  health.start()
  if (retry) {
    run.mockResolvedValueOnce(failure)
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(healthDefaults.retryMs - healthDefaults.tickMs)
  }
  let started!: () => void
  let release!: (value: typeof result) => void
  const admitted = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<typeof result>(resolve => { release = resolve })
  run.mockImplementationOnce(() => { started(); return held })
  const manual = health.check('falcon-axi', 'synthetic-development-user', 'manual-overlap', null)
  const completed = expect(manual).rejects.toMatchObject({ code: 'UPSTREAM_NETWORK_FAILED' })
  await admitted
  const calls = retry ? 2 : 1
  await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
  expect(run).toHaveBeenCalledTimes(calls)
  release(failure)
  await completed
  await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
  expect(run).toHaveBeenCalledTimes(calls + 1)
  expect(run.mock.calls[calls][0]).toBe(`${healthDefaults.actor}:falcon-axi`)
  expect(db.prepare('SELECT status FROM tool_health').get()).toEqual({ status: 'ok' })
})

test('the first check runs on the first tick after start and stopping cancels the schedule', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const run = vi.spyOn(runner, 'run').mockResolvedValue(result)
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.tickMs - 1)
  expect(run).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  expect(run).toHaveBeenCalledTimes(2)
  await health.stop()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  expect(run).toHaveBeenCalledTimes(2)
})

test.each([
  { name: 'a network failure', stderr: 'connect ECONNREFUSED', delay: healthDefaults.retryMs },
  { name: 'a rejected credential', stderr: 'code: AUTH_FAILED', delay: healthDefaults.intervalMs },
  { name: 'a TLS failure', stderr: 'code: TLS_UNTRUSTED', delay: healthDefaults.intervalMs },
  { name: 'an unclassified failure', stderr: 'boom', delay: healthDefaults.intervalMs },
])('after $name the next background check waits $delay ms', async ({ stderr, delay }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const run = vi.spyOn(runner, 'run').mockResolvedValue({ ...result, stderr, exitCode: 1 })
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(delay - healthDefaults.tickMs)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
  expect(run).toHaveBeenCalledTimes(2)
})

test('repeated network failures back off to the interval and a success restores it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const started: number[] = []
  const run = vi.spyOn(runner, 'run').mockImplementation(async () => {
    started.push(Date.now())
    return { ...result, stderr: 'connect ETIMEDOUT', exitCode: 1 }
  })
  const origin = Date.now()
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs * 3)
  expect(started.map(at => at - origin)).toEqual([10_000, 70_000, 190_000, 430_000, 910_000, 1_810_000])
  run.mockImplementation(async () => {
    started.push(Date.now())
    return result
  })
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs * 2)
  expect(started.slice(6).map(at => at - origin)).toEqual([2_710_000, 3_610_000])
  expect(db.prepare('SELECT status FROM tool_health').get()).toEqual({ status: 'ok' })
})

test.each([
  { name: 'timeout', error: new RunnerError('TIMEOUT'), delay: healthDefaults.retryMs },
  { name: 'success', error: undefined, delay: healthDefaults.intervalMs },
  { name: 'authentication failure', error: new RunnerError('UPSTREAM_AUTH_FAILED'), delay: healthDefaults.intervalMs },
  { name: 'admission rejection', error: new RunnerError('TOO_MANY_CALLS'), delay: healthDefaults.intervalMs },
])('the next check waits from completion after $name', async ({ error, delay }) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  let started!: () => void
  let finish!: () => void
  const admitted = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<typeof result>((resolve, reject) => {
    finish = () => { if (error) reject(error); else resolve(result) }
  })
  const run = vi.spyOn(runner, 'run').mockImplementationOnce(() => { started(); return held }).mockResolvedValue(result)
  try {
    health.start()
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    await admitted
    await vi.advanceTimersByTimeAsync(60_000)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(delay - healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(2)
  } finally {
    finish()
    await health.stop()
  }
})

test('credential saves defer background checks when both slots are occupied', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test',
    auth: 'token', token: 'CANARY-VECTRA-TOKEN' }, 0, 'synthetic-development-user', Date.now())
  store.replaceCredential('ldap-axi', { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'cn=synthetic',
    bindPassword: 'CANARY-LDAP-PASSWORD' }, 0, 'synthetic-development-user', Date.now())
  db.exec("UPDATE tools SET enabled = 1 WHERE name IN ('vectra-axi', 'ldap-axi')")
  health = new ToolHealth(db, new Audit(db), runner, [adapter, createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log')),
    createLdapAdapter(new EmbeddedSecretSource(store))], store)
  const run = vi.spyOn(runner, 'run').mockResolvedValue(result)
  await health.refresh('ldap-axi')
  run.mockClear()
  const releases: (() => void)[] = []
  let secondStarted!: () => void
  let thirdStarted!: () => void
  const initialChecks = new Promise<void>(resolve => { secondStarted = resolve })
  const deferredCheck = new Promise<void>(resolve => { thirdStarted = resolve })
  run.mockImplementation(() => new Promise(resolve => {
    releases.push(() => resolve(result))
    if (releases.length === 2) secondStarted()
    if (releases.length === 3) thirdStarted()
  }))
  try {
    health.start()
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs * 5)
    await initialChecks
    expect(run.mock.calls.map(call => call[0])).toEqual([
      `${healthDefaults.actor}:falcon-axi`, `${healthDefaults.actor}:vectra-axi`,
    ])
    store.replaceCredential('ldap-axi', { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'cn=synthetic',
      bindPassword: 'CANARY-LDAP-REPLACEMENT' }, 1, 'synthetic-development-user', Date.now())
    expect(health.refresh('ldap-axi', true)).toBeUndefined()
    expect(health.checking('ldap-axi')).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    releases[0]()
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    await deferredCheck
    expect(run.mock.calls.map(call => call[0])).toEqual([
      `${healthDefaults.actor}:falcon-axi`, `${healthDefaults.actor}:vectra-axi`, `${healthDefaults.actor}:ldap-axi`,
    ])
  } finally {
    releases.forEach(release => release())
    await health.stop()
  }
})

test.each(['ok', 'error'] as const)('a configuration refresh supersedes an in-flight %s check with both background slots occupied', async status => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test',
    auth: 'token', token: 'CANARY-VECTRA-TOKEN' }, 0, 'synthetic-development-user', Date.now())
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'vectra-axi'")
  health = new ToolHealth(db, new Audit(db), runner, [adapter,
    createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))], store)
  let releaseOld!: (value: typeof result) => void
  let releaseOther!: (value: typeof result) => void
  const old = new Promise<typeof result>(resolve => { releaseOld = resolve })
  const other = new Promise<typeof result>(resolve => { releaseOther = resolve })
  let admitted!: () => void
  const bothAdmitted = new Promise<void>(resolve => { admitted = resolve })
  const run = vi.spyOn(runner, 'run').mockReturnValueOnce(old).mockImplementationOnce(() => {
    admitted()
    return other
  }).mockResolvedValue(result)
  const pending = health.refresh('falcon-axi')
  const otherPending = health.refresh('vectra-axi')
  try {
    await bothAdmitted
    expect(run).toHaveBeenCalledTimes(2)
    expect(health.refresh('falcon-axi', true)).toBeUndefined()
    releaseOld(status === 'ok' ? result : { ...result, stderr: 'code: TLS_UNTRUSTED', exitCode: 1 })
    await pending
    expect(db.prepare("SELECT status FROM tool_health WHERE tool = 'falcon-axi'").get()).toBeUndefined()
    expect(health.checking('falcon-axi')).toBe(true)
    health.start()
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(3)
    expect(db.prepare("SELECT status, credential_revision FROM tool_health WHERE tool = 'falcon-axi'").get())
      .toEqual({ status: 'ok', credential_revision: 1 })
    expect(health.checking('falcon-axi')).toBe(false)
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(3)
  } finally {
    releaseOld(result)
    releaseOther(result)
    await Promise.all([pending, otherPending])
    await health.stop()
  }
})

test('a superseded failure cannot restore backoff after a credential change', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const failure = { ...result, stderr: 'connect ECONNREFUSED', exitCode: 1 }
  let started!: () => void
  let release!: (value: typeof result) => void
  const admitted = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<typeof result>(resolve => { release = resolve })
  const run = vi.spyOn(runner, 'run').mockImplementationOnce(() => { started(); return held }).mockResolvedValue(failure)
  const pending = health.refresh('falcon-axi')
  try {
    await admitted
    store.replaceCredential('falcon-axi', { clientId: 'CANARY-client', clientSecret: 'CANARY-replacement', region: 'us-2' },
      1, 'synthetic-development-user', Date.now())
    health.refresh('falcon-axi', true)
    release(failure)
    await pending
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    health.start()
    await vi.advanceTimersByTimeAsync(healthDefaults.retryMs - healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(healthDefaults.tickMs)
    expect(run).toHaveBeenCalledTimes(3)
    expect(db.prepare('SELECT credential_revision, error_code FROM tool_health').get())
      .toEqual({ credential_revision: 2, error_code: 'UPSTREAM_NETWORK_FAILED' })
  } finally {
    release(failure)
    await pending
    await health.stop()
  }
})

test('a credential change resets the backoff', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const run = vi.spyOn(runner, 'run').mockResolvedValue({ ...result, stderr: 'connect ETIMEDOUT', exitCode: 1 })
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.tickMs + healthDefaults.retryMs * 3)
  expect(run).toHaveBeenCalledTimes(3)
  store.replaceCredential('falcon-axi', { clientId: 'CANARY-client', clientSecret: 'CANARY-replacement', region: 'us-2' },
    1, 'synthetic-development-user', Date.now())
  await health.refresh('falcon-axi', true)
  expect(run).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(healthDefaults.retryMs + healthDefaults.tickMs)
  expect(run).toHaveBeenCalledTimes(5)
})

test.each(['disabled', 'unconfigured'] as const)('scheduled checks skip %s tools', async state => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  if (state === 'disabled') db.exec('UPDATE tools SET enabled = 0')
  else db.exec('DELETE FROM credentials')
  const prepare = vi.spyOn(adapter, 'prepare')
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  expect(prepare).not.toHaveBeenCalled()
  expect(db.prepare('SELECT * FROM tool_health').all()).toEqual([])
})

test('listing preserves an invalid token response category without running a platform call', async () => {
  const run = vi.spyOn(runner, 'run').mockResolvedValue({ ...result, exitCode: 1,
    stdout: 'code: AUTH_RESPONSE_INVALID\nmessage: Token response does not match the documented schema' })
  await health.refresh('falcon-axi')
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'read' })
  run.mockClear()
  const prepare = vi.spyOn(adapter, 'prepare')
  const response = await app.inject({ url: '/v1/tools', headers: { authorization: `Bearer ${token}` } })
  expect(response.json()).toMatchObject({ tools: [{ name: 'falcon-axi', status: 'error', errorCode: 'UPSTREAM_RESPONSE_INVALID' }] })
  expect(response.body).not.toContain('Token response')
  expect(prepare).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

test.each([
  ['OAuth credential exchange could not complete', 'UPSTREAM_NETWORK_FAILED'],
  ['OAuth credential exchange failed', 'TOOL_FAILED'],
])('background health retains the token-exchange category for %s', async (message, code) => {
  const text = `code: AUTH_EXCHANGE_FAILED\nmessage: ${message}`
  vi.spyOn(runner, 'run').mockResolvedValue({ ...result, stdout: '', stderr: text, exitCode: 1 })
  await health.refresh('falcon-axi')
  const cached = db.prepare('SELECT status, error_code, checked_at FROM tool_health').get() as {
    status: string, error_code: string, checked_at: number,
  }
  expect(cached).toMatchObject({ status: 'error', error_code: code })
  expect(health.diagnostic('falcon-axi', 1, cached.checked_at)).toMatchObject({
    stage: 'token acquisition', toolCode: 'AUTH_EXCHANGE_FAILED', message: text, credentialRevision: 1,
  })
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(message)
})

describe.each(['synthetic-development-user', healthDefaults.actor])('destination diagnostics for %s', actor => {
  test.each(['ENETUNREACH', 'EHOSTUNREACH', 'response terminated before completion'])(
    'Vectra native transport failure %s retains network detail', async cause => {
      store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test',
        auth: 'token', token: 'CANARY-VECTRA-TOKEN' }, 0, 'synthetic-development-user', Date.now())
      db.exec("UPDATE tools SET enabled = 1 WHERE name = 'vectra-axi'")
      const vectra = createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
      const prepare = vectra.prepare.bind(vectra)
      const text = `code: TRANSPORT_FAILED\nmessage: Request to https://appliance.test could not complete\nhint: ${cause}`
      vi.spyOn(vectra, 'prepare').mockImplementation(async (args, reference) => ({ ...await prepare(args, reference),
        executable: fakeTool.executable, args: [...fakeTool.args, 'failure', text] }))
      health = new ToolHealth(db, new Audit(db), runner, [vectra], store)
      await expect(health.check('vectra-axi', actor, 'native-transport', null)).rejects.toMatchObject({
        code: 'UPSTREAM_NETWORK_FAILED', diagnostic: { stage: 'TCP', host: 'appliance.test', toolCode: 'TRANSPORT_FAILED',
          message: text, hint: cause, checkedAt: expect.any(Number), credentialRevision: 1 },
      })
      const cached = db.prepare("SELECT checked_at, error_code FROM tool_health WHERE tool = 'vectra-axi'").get() as {
        checked_at: number, error_code: string,
      }
      expect(cached.error_code).toBe('UPSTREAM_NETWORK_FAILED')
      expect(health.diagnostic('vectra-axi', 1, cached.checked_at)).toMatchObject({ stage: 'TCP', host: 'appliance.test', message: text })
      expect(JSON.stringify(health.diagnostic('vectra-axi', 1, cached.checked_at))).not.toContain('CANARY-VECTRA-TOKEN')
      const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
      expect(audit).not.toContain(cause)
      expect(audit).not.toContain('CANARY-VECTRA-TOKEN')
    })

  test.each([
    { tool: 'ldap-axi', credential: { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'cn=synthetic',
      bindPassword: 'CANARY-LDAP-PASSWORD' }, create: () => createLdapAdapter(new EmbeddedSecretSource(store)),
    toolCode: 'SERVER_UNREACHABLE', message: 'could not connect to the directory',
    code: 'UPSTREAM_NETWORK_FAILED', stage: 'TCP', host: 'directory.test' },
    { tool: 'ldap-axi', credential: { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'cn=synthetic',
      bindPassword: 'CANARY-LDAP-PASSWORD' }, create: () => createLdapAdapter(new EmbeddedSecretSource(store)),
    toolCode: 'TLS_UNTRUSTED', message: 'certificate verification failed',
    code: 'UPSTREAM_TLS_FAILED', stage: 'TLS', host: 'directory.test' },
    { tool: 'vectra-axi', credential: { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test', auth: 'token',
      token: 'CANARY-VECTRA-TOKEN' },
    create: () => createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log')),
    toolCode: 'TLS_TRUST_ERROR', message: 'certificate verification failed',
    code: 'UPSTREAM_TLS_FAILED', stage: 'TLS', host: 'appliance.test' },
  ] as const)('$tool $toolCode retains the configured host', async ({ tool, credential, create, toolCode, message, code, stage, host }) => {
    store.replaceCredential(tool, credential, 0, 'synthetic-development-user', Date.now())
    health = new ToolHealth(db, new Audit(db), runner, [create()], store)
    const text = `code: ${toolCode}\nmessage: ${message}`
    vi.spyOn(runner, 'run').mockResolvedValue({ ...result, stdout: '', stderr: text, exitCode: 1 })
    await expect(health.check(tool, actor, 'destination-test', null)).rejects.toMatchObject({
      code, diagnostic: { stage, host, toolCode, message: text, checkedAt: expect.any(Number), credentialRevision: 1 },
    })
    const cached = db.prepare('SELECT checked_at FROM tool_health WHERE tool = ?').get(tool) as { checked_at: number }
    expect(health.diagnostic(tool, 1, cached.checked_at)).toMatchObject({ host })
    const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
    expect(audit).not.toContain(host)
    expect(audit).not.toContain('CANARY-')
    expect(JSON.stringify(health.diagnostic(tool, 1, cached.checked_at))).not.toContain('CANARY-')
  })
})

test.each(['UPSTREAM_NETWORK_FAILED', 'UPSTREAM_TLS_FAILED'] as const)('preserves the specific preflight host for %s', async code => {
  store.replaceCredential('az-axi', { auth: 'secret', tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-AZURE-SECRET' },
  0, 'synthetic-development-user', Date.now())
  health = new ToolHealth(db, new Audit(db), runner,
    [createAzAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))], store)
  vi.mocked(connectTls).mockImplementationOnce(() => failedTlsSocket(code === 'UPSTREAM_TLS_FAILED' ? 'CERT_HAS_EXPIRED' : 'ECONNRESET'))
  await expect(health.check('az-axi', 'synthetic-development-user', 'specific-host', null)).rejects.toMatchObject({
    code, diagnostic: { host: 'login.microsoftonline.com', checkedAt: expect.any(Number), credentialRevision: 1 },
  })
})

test.each(['UPSTREAM_NETWORK_FAILED', 'UPSTREAM_TLS_FAILED'] as const)('completes hostless preparation diagnostics for %s', async code => {
  vi.spyOn(adapter, 'prepare').mockRejectedValueOnce(diagnosticError(code, { stage: 'TLS', message: 'Synthetic connection failure.' }))
  await expect(health.check('falcon-axi', 'synthetic-development-user', 'prepare-host', null)).rejects.toMatchObject({
    code, diagnostic: { host: 'api.us-2.crowdstrike.com', checkedAt: expect.any(Number), credentialRevision: 1 },
  })
})

test.each([
  ['SERVER_UNREACHABLE', 'could not connect to the directory', 'UPSTREAM_NETWORK_FAILED'],
  ['TLS_UNTRUSTED', 'certificate verification failed', 'UPSTREAM_TLS_FAILED'],
])('scans the configured host before returning or caching %s', async (toolCode, message, code) => {
  store.replaceCredential('ldap-axi', { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'cn=synthetic',
    bindPassword: 'directory.test' }, 0, 'synthetic-development-user', Date.now())
  health = new ToolHealth(db, new Audit(db), runner, [createLdapAdapter(new EmbeddedSecretSource(store))], store)
  vi.spyOn(runner, 'run').mockResolvedValue({ ...result, stdout: '',
    stderr: `code: ${toolCode}\nmessage: ${message}`, exitCode: 1 })
  await expect(health.check('ldap-axi', 'synthetic-development-user', 'ldap-scan', null)).rejects.toMatchObject({
    code, diagnostic: undefined,
  })
  const cached = db.prepare("SELECT checked_at FROM tool_health WHERE tool = 'ldap-axi'").get() as { checked_at: number }
  expect(health.diagnostic('ldap-axi', 1, cached.checked_at)).toBeUndefined()
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('directory.test')
  expect(db.prepare('SELECT * FROM run_diagnostics').all()).toEqual([])
})

test('replacement during a check queues one fresh check and never caches the old revision', async () => {
  let release!: (value: typeof result) => void
  let started!: () => void
  const admitted = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<typeof result>(resolve => { release = resolve })
  const run = vi.spyOn(runner, 'run').mockImplementationOnce(() => { started(); return held }).mockResolvedValue(result)
  const pending = health.check('falcon-axi', 'synthetic-development-user', 'manual', null)
  await admitted
  store.replaceCredential('falcon-axi', { clientId: 'CANARY-client', clientSecret: 'CANARY-replacement', region: 'us-2' },
    1, 'synthetic-development-user', Date.now())
  health.refresh('falcon-axi', true)
  health.refresh('falcon-axi', true)
  expect(run).toHaveBeenCalledTimes(1)
  release(result)
  await pending
  await health.stop()
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' AND request_id = 'manual'").get())
    .toEqual({ action: 'read' })
  expect(run).toHaveBeenCalledTimes(2)
  expect(db.prepare('SELECT status, credential_revision FROM tool_health').get()).toEqual({ status: 'ok', credential_revision: 2 })
})

test.each(['0.0.0', '0.0.0-old', '0.0.9', `${firstVersionWithUpdate}-old`])(
  'CLI %s without the update command is refused with the verified download before authentication or tool preparation', async version => {
    const prepare = vi.spyOn(adapter, 'prepare')
    const response = await app.inject({ url: '/v1/tools', headers: { 'x-artium-cli-version': version, host: 'synthetic.invalid' } })
    expect(response.statusCode).toBe(426)
    expect(response.json()).toMatchObject({ error: { code: 'CLI_OUTDATED', next: cliOutdatedDownloadNext } })
    expect(response.body).not.toContain(cliOutdatedUpdateNext)
    expect(response.body).not.toContain('synthetic.invalid')
    expect(prepare).not.toHaveBeenCalled()
  })

test.each([firstVersionWithUpdate, '0.0.13', '0.0.13-rc.1', '0.0.13+build.01', '0.0.13-rc.1+build.01'])(
  'outdated CLI %s with the update command is refused with the update hint', async version => {
    const response = await app.inject({ url: '/v1/tools', headers: { 'x-artium-cli-version': version, host: 'synthetic.invalid' } })
    expect(response.statusCode).toBe(426)
    expect(response.json()).toMatchObject({ error: { code: 'CLI_OUTDATED', next: cliOutdatedUpdateNext } })
    expect(response.body).not.toContain('synthetic.invalid')
  })

test.each(['not-a-version', '0.0', '0.0.13+..', '0.0.13-01', '0.0.13-rc..1', '0.0.13-rc.01', '0.0.13+build..1', '0.0.13-rc.1+..'])('malformed CLI version %s is refused with the verified download', async version => {
  const response = await app.inject({ url: '/v1/tools', headers: { 'x-artium-cli-version': version, host: 'synthetic.invalid' } })
  expect(response.statusCode).toBe(426)
  expect(response.json()).toMatchObject({ error: { code: 'CLI_OUTDATED', next: cliOutdatedDownloadNext } })
  expect(response.body).not.toContain('synthetic.invalid')
})

test('a missing or malformed CLI version keeps the safe download default', () => {
  expect(hasCliUpdateCommand(undefined)).toBe(false)
  expect(hasCliUpdateCommand('not-a-version')).toBe(false)
  expect(hasCliUpdateCommand(firstVersionWithUpdate)).toBe(true)
  expect(errors.CLI_OUTDATED.next).toBe(cliOutdatedDownloadNext)
})

test.each(['/health/live', '/health/ready', '/cli/unavailable.mjs', '/login'])('%s is exempt from an old CLI header', async url => {
  const response = await app.inject({ url, headers: { 'x-artium-cli-version': '0.0.0-old' } })
  expect(response.statusCode).toBe(url.startsWith('/cli/') ? 404 : 200)
  expect(response.body).not.toContain('CLI_OUTDATED')
})

test('the current CLI version is accepted', async () => {
  const response = await app.inject({ url: '/v1/tools', headers: { 'x-artium-cli-version': cliVersion, authorization: `Bearer ${token}` } })
  expect(response.statusCode).toBe(200)
  expect(toolsResponseSchema.parse(response.json()).tools).toEqual([
    { name: 'falcon-axi', version: '0.9.0', status: 'unknown', readOnly: true },
  ])
})

test.each(['/v1/auth/login', '/v1/auth/device', '/v1/auth/device/poll'])(
  '%s returns the server version without rejecting an older client', async url => {
    const response = await app.inject({ method: 'POST', url, payload: {}, headers: { 'x-artium-cli-version': '0.0.0' } })
    expect(response.headers['x-artium-cli-version']).toBe(cliVersion)
    expect(response.statusCode).not.toBe(426)
    expect(response.body).not.toContain('CLI_OUTDATED')
  })
