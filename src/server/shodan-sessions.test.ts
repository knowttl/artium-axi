import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { issueTestAccessToken, seedToolUser } from '../../test/fixtures/tokens.js'
import { createApp } from './app.js'
import { createShodanAdapter } from './adapters/shodan.js'
import { Audit } from './audit/audit.js'
import { toolPaths } from './config.js'
import { SharedIdentityResolver } from './policy/identity-resolver.js'
import { Runner } from './runner/runner.js'
import { createCredentialStore, openStore } from './store/db.js'
import { EnvironmentKeyProvider } from './store/key-provider.js'
import { EmbeddedSecretSource } from './store/secret-source.js'

const processBoundary = vi.hoisted(() => ({ crash: false, multiple: false }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) =>
    original.spawn(command, args[0]?.endsWith('/shodan-axi.js') && args[1] === 'scan'
      ? ['-e', `process.stdout.write(JSON.stringify(${args.includes('--execute') ? '{status:"submitted",scanId:"synthetic-scan"}' : '{status:"preview",token:"00000000-0000-4000-8000-000000000000",effects:[{operation:"OP-009"}]}'}))`]
      : args[0]?.endsWith('/shodan-stream-worker.js')
      ? processBoundary.crash ? ['-e', 'process.exit(1)']
        : [fileURLToPath(new URL('../../test/fake-service/shodan-stream-worker.mjs', import.meta.url))] : args,
    { ...options, env: { ...options.env, ...(processBoundary.multiple ? { ARTIUM_TEST_MULTIPLE_EVENTS: '1' } : {}) } }) }
})

async function sessionFixture(capacity = 1, leaseSeconds = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'shodan-session-'))
  const previous = toolPaths['shodan-axi']
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  const store = createCredentialStore(db, provider)
  store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' },
    0, 'synthetic-development-user', Date.now())
  const sessions = { grants: { 'synthetic-development-user': ['OP-046'] }, perUser: capacity, perCredential: 1, total: capacity,
    sessionEvents: 10, totalEvents: 10 * capacity, sessionBytes: 4096, totalBytes: 4096 * capacity, retentionSeconds: 60, leaseSeconds }
  db.prepare("UPDATE tools SET enabled=1,native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ sessions }))
  const runner = await Runner.create(join(directory, 'calls'))
  const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
    resolver: new SharedIdentityResolver(store, db), adapters: [createShodanAdapter(new EmbeddedSecretSource(store))] })
  Object.assign(toolPaths, { 'shodan-axi': join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js') })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  const prefix = '/v1/tools/shodan-axi/sessions'
  const input = { operation: 'OP-046', selector: {}, bounds: { limit: 10, maxBytes: 4096, timeout: leaseSeconds * 1000, idleTimeout: 1000 },
    limits: {}, acceptUnknownCost: true }
  return { app, db, store, directory, headers, prefix, input, close: async () => {
    await app.close()
    db.close()
    processBoundary.crash = false
    processBoundary.multiple = false
    Object.assign(toolPaths, { 'shodan-axi': previous })
    rmSync(directory, { recursive: true, force: true })
  } }
}

test('lease expiry status wait returns expired with the worker summary and retained events', async () => {
  const fixture = await sessionFixture()
  const { app, directory, headers, prefix, input } = fixture
  try {
    const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
    expect(preview.statusCode, preview.body).toBe(200)
    const started = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
      payload: { ...input, confirm: preview.json().confirm } })
    expect(started.statusCode, started.body).toBe(200)
    const id = started.json().id
    const ended = await app.inject({ method: 'GET', url: `${prefix}/${id}?waitMs=5000`, headers })
    expect(ended.json()).toMatchObject({ state: 'expired', cleaned: true, expiresAt: started.json().expiresAt,
      summary: { stopReason: 'stopped', count: 1, partialRecordCount: 0 } })
    const retained = await app.inject({ method: 'POST', url: `${prefix}/${id}/read`, headers, payload: { limit: 10 } })
    expect(retained.statusCode, retained.body).toBe(200)
    expect(retained.json()).toMatchObject({ hasMore: false, items: [{ sequence: 1, value: { profile: 'artium', isolated: true, value: 'synthetic' } }] })
    expect(existsSync(join(directory, 'tool-logs/shodan-axi/sessions', `session-${id}`))).toBe(false)
  } finally {
    await fixture.close()
  }
})

test.each(['sessions', 'scan-collections'])('refused %s requests are recorded as denials with the credential instance', async route => {
  const fixture = await sessionFixture()
  const { app, db, headers } = fixture
  try {
    const refused = await app.inject({ method: 'POST', url: `/v1/tools/shodan-axi/${route}/preview`, headers, payload: { unexpected: true } })
    expect(refused.statusCode).toBe(400)
    expect(db.prepare("SELECT event, tool, outcome, instance FROM audit WHERE event = 'denial'").all())
      .toEqual([{ event: 'denial', tool: 'shodan-axi', outcome: 'INVALID_INPUT', instance: 'default' }])
  } finally { await fixture.close() }
})

test('a refused confirmed session is attributed to its owned plan', async () => {
  const fixture = await sessionFixture()
  const { app, db, store, headers, prefix, input } = fixture
  try {
    const first = store.findCredential('shodan-axi')!
    store.createInstance('shodan-axi', { name: 'second', description: '' }, store.readCredential(first), 'synthetic-development-user', Date.now())
    const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...input, instance: 'default' } })
    expect(preview.statusCode, preview.body).toBe(200)
    db.prepare('UPDATE credentials SET enabled = 0 WHERE id = ?').run(first.id)
    const refused = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
      payload: { ...input, instance: 'second', confirm: preview.json().confirm } })
    expect(refused.statusCode).toBe(400)
    expect(db.prepare("SELECT credential_id, instance, outcome FROM audit WHERE event = 'denial'").all())
      .toEqual([{ credential_id: first.id, instance: 'default', outcome: 'INVALID_INPUT' }])
  } finally { await fixture.close() }
})

test.each(['sessions', 'scan-collections'])('refused %s previews retain the resolved instance', async route => {
  const fixture = await sessionFixture()
  const { app, db, store, headers, input } = fixture
  try {
    const first = store.findCredential('shodan-axi')!
    store.createInstance('shodan-axi', { name: 'second', description: '' }, store.readCredential(first), 'synthetic-development-user', Date.now())
    const settings = JSON.parse((db.prepare("SELECT native_settings FROM tools WHERE name='shodan-axi'").get() as { native_settings: string }).native_settings)
    settings.sessions.grants = {}
    db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'").run(JSON.stringify(settings))
    const payload = route === 'sessions' ? { ...input, instance: 'default' } : {
      instance: 'default', scope: { kind: 'targets', targets: '192.0.2.1', force: false }, waitSeconds: 0,
      limit: 1, maxBytes: 1024, idleTimeout: 1000, scanCreditBudget: 1, maxRequests: 1, acceptUnknownCost: false,
    }
    const refused = await app.inject({ method: 'POST', url: `/v1/tools/shodan-axi/${route}/preview`, headers, payload })
    expect(refused.statusCode).toBe(403)
    expect(db.prepare("SELECT credential_id, instance FROM audit WHERE event = 'denial'").all())
      .toEqual([{ credential_id: first.id, instance: 'default' }])
  } finally { await fixture.close() }
})

test('closed sessions page through all retained events', async () => {
  const fixture = await sessionFixture()
  const { app, headers, prefix, input } = fixture
  processBoundary.multiple = true
  try {
    const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
    const started = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...input, confirm: preview.json().confirm } })
    const id = started.json().id
    await app.inject({ method: 'GET', url: `${prefix}/${id}?waitMs=5000`, headers })
    const first = await app.inject({ method: 'POST', url: `${prefix}/${id}/read`, headers, payload: { limit: 1 } })
    expect(first.json()).toMatchObject({ cleaned: true, hasMore: true, items: [{ sequence: 1, value: { value: 'synthetic' } }] })
    const second = await app.inject({ method: 'POST', url: `${prefix}/${id}/read`, headers,
      payload: { limit: 1, continuation: first.json().continuation } })
    expect(second.json()).toMatchObject({ cleaned: true, hasMore: false, items: [{ sequence: 2, value: { value: 'second' } }] })
  } finally { await fixture.close() }
})

test('a confirmed extension updates the running lease within its reserved limit', async () => {
  const fixture = await sessionFixture()
  const { app, db, headers, prefix, input } = fixture
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const row = db.prepare("SELECT native_settings FROM tools WHERE name='shodan-axi'").get() as { native_settings: string }
    const settings = JSON.parse(row.native_settings)
    settings.sessions.leaseSeconds = 10
    db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'").run(JSON.stringify(settings))
    const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
    const started = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...input, confirm: preview.json().confirm } })
    const id = started.json().id
    await app.inject({ method: 'POST', url: `${prefix}/${id}/read`, headers, payload: { waitMs: 5000 } })
    const rejected = await app.inject({ method: 'POST', url: `${prefix}/${id}/extend/preview`, headers, payload: { seconds: 10 } })
    expect(rejected.statusCode).toBe(400)
    const extension = await app.inject({ method: 'POST', url: `${prefix}/${id}/extend/preview`, headers, payload: { seconds: 2 } })
    expect(extension.statusCode, extension.body).toBe(200)
    const extended = await app.inject({ method: 'POST', url: `${prefix}/${id}/extend`, headers, payload: { confirm: extension.json().confirm } })
    expect(extended.statusCode, extended.body).toBe(200)
    expect(extended.json()).toMatchObject({ state: 'running', expiresAt: started.json().expiresAt + 2000 })
    const replay = await app.inject({ method: 'POST', url: `${prefix}/${id}/extend`, headers, payload: { confirm: extension.json().confirm } })
    expect(replay.statusCode).toBe(400)
    await vi.advanceTimersByTimeAsync(1000)
    const continued = await app.inject({ method: 'GET', url: `${prefix}/${id}`, headers })
    expect(continued.json()).toMatchObject({ state: 'running', cleaned: false })
    await vi.advanceTimersByTimeAsync(2000)
    const ended = await app.inject({ method: 'GET', url: `${prefix}/${id}?waitMs=5000`, headers })
    expect(ended.json()).toMatchObject({ state: 'expired', cleaned: true, expiresAt: extended.json().expiresAt })
  } finally {
    await fixture.close()
    vi.useRealTimers()
  }
})

test.each([
  { crash: false, state: 'closed', method: 'DELETE' as const },
  { crash: true, state: 'failed', method: 'GET' as const },
])('terminal audit failure is reported without escaping after worker crash=$crash', async ({ crash, state, method }) => {
  const fixture = await sessionFixture()
  const { app, db, headers, prefix, input } = fixture
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    db.exec(`CREATE TRIGGER refuse_terminal_audit BEFORE INSERT ON audit
      WHEN NEW.event = 'run-terminal' BEGIN SELECT RAISE(FAIL, 'synthetic audit storage failure'); END`)
    const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
    expect(preview.statusCode, preview.body).toBe(200)
    processBoundary.crash = crash
    const started = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
      payload: { ...input, confirm: preview.json().confirm } })
    expect(started.statusCode, started.body).toBe(200)
    const id = started.json().id
    const read = await app.inject({ method: 'POST', url: `${prefix}/${id}/read`, headers, payload: { limit: 10, waitMs: 5000 } })
    expect(read.statusCode, read.body).toBe(200)
    const ended = await app.inject({ method, url: `${prefix}/${id}?waitMs=5000`, headers })
    expect(ended.statusCode, ended.body).toBe(200)
    expect(ended.json()).toMatchObject({ cleaned: true, state })
    const stopped = await app.inject({ method: 'DELETE', url: `${prefix}/${id}`, headers })
    expect(stopped.statusCode, stopped.body).toBe(200)
    expect(stderr.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
      expect.objectContaining({ level: 'error', event: 'shodan-session-terminal', requestId: id, code: 'AUDIT_UNAVAILABLE' }),
    ])
  } finally {
    await fixture.close()
    stderr.mockRestore()
  }
})

test('sessions bind the previewed instance and deleting one instance closes only its sessions', async () => {
  const fixture = await sessionFixture(2, 30)
  const { app, db, store, headers, prefix, input } = fixture
  try {
    const defaultInstance = store.findInstance('shodan-axi', 'default')!
    store.createInstance('shodan-axi', { name: 'lab', description: '' }, store.readCredential(defaultInstance), 'synthetic-development-user', Date.now())
    const ambiguous = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
    expect(ambiguous.statusCode).toBe(409)
    expect(ambiguous.json()).toMatchObject({ error: { code: 'INSTANCE_REQUIRED' } })
    const unknown = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...input, instance: 'missing' } })
    expect(unknown.json()).toMatchObject({ error: { code: 'INSTANCE_NOT_FOUND' } })
    const start = async (instance: string, startInstance = instance) => {
      const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...input, instance } })
      expect(preview.statusCode, preview.body).toBe(200)
      expect(preview.json()).toMatchObject({ instance })
      return app.inject({ method: 'POST', url: `${prefix}/start`, headers,
        payload: { ...input, instance: startInstance, confirm: preview.json().confirm } })
    }
    expect((await start('lab', 'default')).statusCode).toBe(400)
    const lab = await start('lab'), other = await start('default')
    expect(lab.statusCode, lab.body).toBe(200)
    expect(other.statusCode, other.body).toBe(200)
    expect(lab.json()).toMatchObject({ instance: 'lab' })
    const rows = db.prepare("SELECT request_id AS id, instance FROM audit WHERE event = 'run-start' ORDER BY instance").all()
    expect(rows).toEqual([{ id: other.json().id, instance: 'default' }, { id: lab.json().id, instance: 'lab' }])
    const labInstance = store.findInstance('shodan-axi', 'lab')!
    store.deleteInstance('shodan-axi', 'lab', labInstance.id, labInstance.revision)
    await app.inject({ method: 'GET', url: `${prefix}/${lab.json().id}`, headers })
    expect((await app.inject({ method: 'GET', url: `${prefix}/${lab.json().id}`, headers })).statusCode).toBe(404)
    const running = await app.inject({ method: 'GET', url: `${prefix}/${other.json().id}`, headers })
    expect(running.json()).toMatchObject({ instance: 'default', state: expect.stringMatching(/^(starting|running)$/), cleaned: false })
  } finally { await fixture.close() }
})

test('scan collection previews bind the selected instance and reject a start that names another', async () => {
  const fixture = await sessionFixture(2, 30)
  const { app, db, store, headers } = fixture
  try {
    const settings = JSON.parse((db.prepare("SELECT native_settings FROM tools WHERE name='shodan-axi'").get() as { native_settings: string }).native_settings)
    db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ ...settings,
      scans: { grants: { 'synthetic-development-user': ['OP-009'] }, maxScanCredits: 10, maxRequests: 10 } }))
    const defaultInstance = store.findInstance('shodan-axi', 'default')!
    store.createInstance('shodan-axi', { name: 'lab', description: '' }, store.readCredential(defaultInstance), 'synthetic-development-user', Date.now())
    const prefix = '/v1/tools/shodan-axi/scan-collections'
    const scan = { scope: { kind: 'targets', targets: '192.0.2.1', force: false }, waitSeconds: 0, limit: 1, maxBytes: 1024,
      idleTimeout: 1000, scanCreditBudget: 1, maxRequests: 1, acceptUnknownCost: false }
    const ambiguous = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: scan })
    expect(ambiguous.json()).toMatchObject({ error: { code: 'INSTANCE_REQUIRED' } })
    const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...scan, instance: 'lab' } })
    expect(preview.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    const lab = store.findInstance('shodan-axi', 'lab')!
    store.setInstanceFlags('shodan-axi', 'lab', { readOnly: false }, lab.id, lab.revision, 'synthetic-development-user', Date.now())
    const writable = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...scan, instance: 'lab' } })
    expect(writable.statusCode, writable.body).toBe(200)
    expect(writable.json()).toMatchObject({ instance: 'lab' })
    const mismatched = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
      payload: { ...scan, instance: 'default', confirm: writable.json().confirm } })
    expect(mismatched.statusCode).toBe(400)
    const stale = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...scan, instance: 'lab' } })
    const current = store.findInstance('shodan-axi', 'lab')!
    const locked = store.setInstanceFlags('shodan-axi', 'lab', { readOnly: true }, current.id, current.revision, 'synthetic-development-user', Date.now())
    const refused = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
      payload: { ...scan, instance: 'lab', confirm: stale.json().confirm } })
    expect(refused.statusCode).toBe(409)
    store.setInstanceFlags('shodan-axi', 'lab', { readOnly: false }, locked.id, locked.revision, 'synthetic-development-user', Date.now())
    const start = async (instance: string) => {
      const plan = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...scan, instance } })
      expect(plan.statusCode, plan.body).toBe(200)
      const result = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...scan, instance, confirm: plan.json().confirm } })
      expect(result.statusCode, result.body).toBe(200)
      return result.json().id as string
    }
    const labId = await start('lab'), defaultId = await start('default')
    const labResult = await app.inject({ method: 'GET', url: `${prefix}/${labId}?waitMs=5000`, headers })
    const defaultResult = await app.inject({ method: 'GET', url: `${prefix}/${defaultId}?waitMs=5000`, headers })
    expect(labResult.json()).toMatchObject({ state: 'completed', result: { scanId: 'synthetic-scan' } })
    expect(defaultResult.json()).toMatchObject({ state: 'completed', result: { scanId: 'synthetic-scan' } })
    const currentLab = store.findInstance('shodan-axi', 'lab')!
    store.deleteInstance('shodan-axi', 'lab', currentLab.id, currentLab.revision)
    await app.inject({ method: 'GET', url: `${prefix}/${labId}`, headers })
    expect((await app.inject({ method: 'GET', url: `${prefix}/${labId}`, headers })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `${prefix}/${defaultId}`, headers })).json())
      .toMatchObject({ state: 'completed', result: { scanId: 'synthetic-scan' } })
  } finally { await fixture.close() }
})

test('deleting an instance leaves another active scan collection running', async () => {
  const fixture = await sessionFixture(2, 5)
  const { app, db, store, headers } = fixture
  try {
    const settings = JSON.parse((db.prepare("SELECT native_settings FROM tools WHERE name='shodan-axi'").get() as { native_settings: string }).native_settings)
    db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ ...settings,
      scans: { grants: { 'synthetic-development-user': ['OP-009'] }, maxScanCredits: 10, maxRequests: 10 } }))
    const defaultInstance = store.findInstance('shodan-axi', 'default')!
    const lab = store.createInstance('shodan-axi', { name: 'lab', description: '' }, store.readCredential(defaultInstance), 'synthetic-development-user', Date.now())
    const writableLab = store.setInstanceFlags('shodan-axi', 'lab', { readOnly: false }, lab.id, lab.revision, 'synthetic-development-user', Date.now())
    const prefix = '/v1/tools/shodan-axi/scan-collections'
    const scan = { scope: { kind: 'targets', targets: '192.0.2.1', force: false }, waitSeconds: 5, limit: 10, maxBytes: 4096,
      idleTimeout: 1000, scanCreditBudget: 1, maxRequests: 1, acceptUnknownCost: true }
    const start = async (instance: string) => {
      const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: { ...scan, instance } })
      expect(preview.statusCode, preview.body).toBe(200)
      const started = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
        payload: { ...scan, instance, confirm: preview.json().confirm } })
      expect(started.statusCode, started.body).toBe(200)
      expect(started.json().state).toBe('running')
      return started.json().id as string
    }
    const labId = await start('lab'), defaultId = await start('default')
    for (const id of [labId, defaultId]) {
      const active = await app.inject({ method: 'GET', url: `${prefix}/${id}`, headers })
      expect(active.json()).toMatchObject({ id, state: 'running' })
    }
    store.deleteInstance('shodan-axi', 'lab', writableLab.id, writableLab.revision)
    await app.inject({ method: 'GET', url: `${prefix}/${labId}`, headers })
    expect((await app.inject({ method: 'GET', url: `${prefix}/${labId}`, headers })).statusCode).toBe(404)
    const survivor = await app.inject({ method: 'GET', url: `${prefix}/${defaultId}?waitMs=10000`, headers })
    expect(survivor.statusCode, survivor.body).toBe(200)
    expect(survivor.json()).toMatchObject({ id: defaultId, state: 'completed', result: { scanId: 'synthetic-scan', cleanup: 'completed' } })
  } finally { await fixture.close() }
}, 15000)
