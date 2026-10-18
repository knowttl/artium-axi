import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { Audit } from '../../src/server/audit/audit.js'
import { healthDefaults } from '../../src/server/config.js'
import { ToolHealth } from '../../src/server/health/health.js'
import { errors } from '../../src/shared/errors.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { toolsResponseSchema } from '../../src/shared/api.js'
import { cliVersion } from '../../src/shared/version.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

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
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-health-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 8).toString('base64') })
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
    let started!: () => void
    let release!: (value: typeof result) => void
    const admitted = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<typeof result>(resolve => { release = resolve })
    vi.spyOn(runner, 'run').mockImplementationOnce(() => { started(); return held })
    const pending = health.check('falcon-axi', 'synthetic-development-user', 'held-check', null)
    await admitted
    return async () => { release(result); await pending }
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
  let release!: (value: typeof result) => void
  const pending = new Promise<typeof result>(resolve => { release = resolve })
  const run = vi.spyOn(runner, 'run').mockReturnValue(pending)
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  expect(run).toHaveBeenCalledTimes(1)
  await expect(health.check('falcon-axi', 'synthetic-development-user', 'manual-test', null))
    .rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs * 3)
  expect(run).toHaveBeenCalledTimes(1)
  release(result)
  await health.stop()
  expect(db.prepare('SELECT status, credential_revision FROM tool_health').get()).toEqual({ status: 'ok', credential_revision: 1 })
  expect(db.prepare("SELECT action, checked_at, credential_revision FROM audit WHERE event = 'health-check'").get())
    .toEqual({ action: healthDefaults.actor, checked_at: expect.any(Number), credential_revision: 1 })
  expect(run.mock.calls[0][0]).toBe(`${healthDefaults.actor}:falcon-axi`)
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'read' })
})

test('each enabled configured tool is checked every fifteen minutes and stopping cancels the schedule', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const run = vi.spyOn(runner, 'run').mockResolvedValue(result)
  health.start()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs - 1)
  expect(run).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  expect(run).toHaveBeenCalledTimes(2)
  await health.stop()
  await vi.advanceTimersByTimeAsync(healthDefaults.intervalMs)
  expect(run).toHaveBeenCalledTimes(2)
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

test('listing reads a failed stored check without preparing or running a platform call', async () => {
  const run = vi.spyOn(runner, 'run').mockResolvedValue({ ...result, exitCode: 1 })
  await health.refresh('falcon-axi')
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'read' })
  run.mockClear()
  const prepare = vi.spyOn(adapter, 'prepare')
  const response = await app.inject({ url: '/v1/tools', headers: { authorization: `Bearer ${token}` } })
  expect(response.json()).toMatchObject({ tools: [{ name: 'falcon-axi', status: 'error' }] })
  expect(prepare).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
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

test.each(['0.0.0', '0.0.0-old'])('CLI %s is refused with the download command before authentication or tool preparation', async version => {
  const prepare = vi.spyOn(adapter, 'prepare')
  const response = await app.inject({ url: '/v1/tools', headers: { 'x-artium-cli-version': version, host: 'synthetic.invalid' } })
  expect(response.statusCode).toBe(426)
  expect(response.json()).toMatchObject({ error: { code: 'CLI_OUTDATED',
    next: 'Download the current CLI: curl --fail --output artium-axi.mjs https://synthetic.invalid/cli/artium-axi.mjs' } })
  expect(prepare).not.toHaveBeenCalled()
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
    { name: 'falcon-axi', version: '0.3.0', status: 'unknown', readOnly: true },
  ])
})

test.each(['/v1/auth/login', '/v1/auth/device', '/v1/auth/device/poll'])(
  '%s returns the server version without rejecting an older client', async url => {
    const response = await app.inject({ method: 'POST', url, payload: {}, headers: { 'x-artium-cli-version': '0.0.0' } })
    expect(response.headers['x-artium-cli-version']).toBe(cliVersion)
    expect(response.statusCode).not.toBe(426)
    expect(response.body).not.toContain('CLI_OUTDATED')
  })
