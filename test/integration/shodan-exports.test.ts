import { createHash } from 'node:crypto'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { Audit } from '../../src/server/audit/audit.js'
import { healthDefaults, toolPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'

const boundary = vi.hoisted(() => ({ bootstrap: '' }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) =>
    original.spawn(command, args[0]?.endsWith('/shodan-axi.js') && boundary.bootstrap ? ['--import', boundary.bootstrap, ...args] : args, options) }
})

const user = 'synthetic-development-user'
const policy = { grants: { [user]: ['CLI-005', 'CLI-020'] }, maxQueryCredits: 10, maxRequests: 20, maxRecords: 1000, maxBytes: 1024 * 1024, retentionSeconds: 60 }
const download = { command: 'download', query: 'port:443', limit: 100, maxBytes: 65536, queryCreditBudget: 2, maxRequests: 6 }
const prefix = '/v1/tools/shodan-axi/exports'
const row = { ip_str: '192.0.2.1', port: 443, transport: 'tcp', timestamp: '2026-01-01T00:00:00Z', data: 'synthetic' }

afterEach(() => { vi.useRealTimers() })

async function exportFixture(check: (fixture: Awaited<ReturnType<typeof prepare>> & { send: (path: string) => Promise<string>, held: Promise<void> }) => Promise<void>, exports: object | null = policy) {
  let heldRequest!: () => void
  const held = new Promise<void>(resolve => { heldRequest = resolve })
  await withFakeService(async ({ directory, port, send }) => {
    boundary.bootstrap = join(directory, 'shodan-fake-route.mjs')
    writeFileSync(boundary.bootstrap, `import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const request = https.request
https.request = (url, options, callback) => {
  if (url.origin !== 'https://api.shodan.io') throw new Error('Unexpected endpoint')
  return request(new URL(url.pathname + url.search, ${JSON.stringify(`https://localhost:${port}`)}), options, callback)
}
syncBuiltinESMExports()
`)
    const fixture = await prepare(directory, exports)
    try { await check({ ...fixture, send, held }) } finally { await fixture.close() }
  }, heldRequest)
}

async function prepare(directory: string, exports: object | null) {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  const store = createCredentialStore(db, provider)
  store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, 0, user, Date.now())
  const setPolicy = (value: object | null) => db.prepare("UPDATE tools SET enabled=1,native_settings=? WHERE name='shodan-axi'").run(JSON.stringify(value ? { exports: value } : {}))
  setPolicy(exports)
  const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
  const previous = { path: toolPaths['shodan-axi'], tick: healthDefaults.tickMs }
  Object.assign(toolPaths, { 'shodan-axi': join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js') })
  Object.assign(healthDefaults, { tickMs: 2_147_483_647 })
  const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
    resolver: new SharedIdentityResolver(store, db), adapters: [createShodanAdapter(new EmbeddedSecretSource(store))] })
  await app.ready()
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, user)}` }
  const exportRoot = join(directory, 'tool-logs/shodan-axi/exports')
  const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: prefix + path, headers, payload: payload as object })
  const finish = async (id: string) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const status = await app.inject({ method: 'GET', url: `${prefix}/${id}?waitMs=30000`, headers })
      if (status.json().state !== 'running') return status.json()
    }
    throw new Error('Export did not finish')
  }
  return { app, db, store, headers, exportRoot, post, finish, setPolicy, close: async () => {
    await app.close(); db.close()
    Object.assign(toolPaths, { 'shodan-axi': previous.path })
    Object.assign(healthDefaults, { tickMs: previous.tick })
    boundary.bootstrap = ''
  } }
}

test('a confirmed export is retained once and retrieved with a verifiable hash', async () => {
  await exportFixture(async ({ app, headers, exportRoot, post, finish, db }) => {
    const preview = await post('/preview', download)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ instance: 'default', command: 'download', operation: 'CLI-005', total: 2, retentionSeconds: 60 })
    expect(preview.body).not.toContain(exportRoot)
    const started = await post('/start', { ...download, confirm: preview.json().confirm })
    expect(started.statusCode, started.body).toBe(200)
    const finished = await finish(started.json().id)
    expect(finished).toMatchObject({ state: 'completed', result: { count: 1, total: 1, complete: true } })
    const retrieved = await app.inject({ method: 'POST', url: `${prefix}/${started.json().id}/retrieve`, headers })
    expect(retrieved.statusCode).toBe(200)
    expect(retrieved.headers['x-artium-export-complete']).toBe('true')
    expect(retrieved.rawPayload.length).toBe(finished.result.bytes)
    expect(createHash('sha256').update(retrieved.rawPayload).digest('hex')).toBe(finished.result.sha256)
    expect(retrieved.headers['x-artium-export-sha256']).toBe(finished.result.sha256)
    expect(gunzipSync(retrieved.rawPayload).toString()).toBe(`${JSON.stringify(row)}\n`)
    expect((await app.inject({ method: 'POST', url: `${prefix}/${started.json().id}/retrieve`, headers })).statusCode).toBe(404)
    expect(readdirSync(exportRoot)).toEqual([])
    expect(db.prepare("SELECT event, outcome, action, arguments FROM audit WHERE tool = 'shodan-axi' AND event IN ('run-start', 'run-terminal') ORDER BY id").all()).toEqual([
      { event: 'run-start', outcome: 'started', action: null, arguments: JSON.stringify(['export', 'CLI-005']) },
      { event: 'run-terminal', outcome: 'completed', action: 'read', arguments: null },
    ])
  })
})

test('an incomplete export is retrievable and marked partial', async () => {
  await exportFixture(async ({ app, headers, post, finish }) => {
    const input = { ...download, query: 'port:many', limit: 1, queryCreditBudget: 1, maxRequests: 3 }
    const preview = await post('/preview', input)
    const started = await post('/start', { ...input, confirm: preview.json().confirm })
    expect(await finish(started.json().id)).toMatchObject({ state: 'partial', result: { count: 1, total: 250, complete: false } })
    const retrieved = await app.inject({ method: 'POST', url: `${prefix}/${started.json().id}/retrieve`, headers })
    expect(retrieved.statusCode).toBe(200)
    expect(retrieved.headers['x-artium-export-complete']).toBe('false')
    expect(gunzipSync(retrieved.rawPayload).toString()).toBe(`${JSON.stringify(row)}\n`)
  })
})

test('alert downloads select the monitored networks', async () => {
  await exportFixture(async ({ post, finish }) => {
    const input = { command: 'alert download', limit: 100, maxBytes: 65536, queryCreditBudget: 2, maxRequests: 8 }
    const preview = await post('/preview', input)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ operation: 'CLI-020', command: 'alert download' })
    const started = await post('/start', { ...input, confirm: preview.json().confirm })
    expect(await finish(started.json().id)).toMatchObject({ state: 'completed', result: { count: 1, complete: true } })
  })
})

test.each([
  { name: 'a missing grant', exports: { ...policy, grants: {} }, input: download, status: 403, code: 'TOOL_NOT_GRANTED' },
  { name: 'a grant for the other download command', exports: { ...policy, grants: { [user]: ['CLI-020'] } }, input: download, status: 403, code: 'TOOL_NOT_GRANTED' },
  { name: 'unconfigured exports', exports: null, input: download, status: 403, code: 'TOOL_NOT_GRANTED' },
  { name: 'a record limit above the ceiling', exports: { ...policy, maxRecords: 50 }, input: download, status: 400, code: 'INVALID_INPUT' },
  { name: 'a byte limit above the ceiling', exports: { ...policy, maxBytes: 1024 }, input: download, status: 400, code: 'INVALID_INPUT' },
  { name: 'a credit budget above the ceiling', exports: { ...policy, maxQueryCredits: 1 }, input: download, status: 400, code: 'INVALID_INPUT' },
  { name: 'a request bound above the ceiling', exports: { ...policy, maxRequests: 5 }, input: download, status: 400, code: 'INVALID_INPUT' },
  { name: 'a credit budget below the limit minimum', exports: policy, input: { ...download, limit: 500, queryCreditBudget: 2 }, status: 400, code: 'INVALID_INPUT' },
  { name: 'a request bound below the minimum', exports: policy, input: { ...download, maxRequests: 2 }, status: 400, code: 'INVALID_INPUT' },
  { name: 'a destination override', exports: policy, input: { ...download, filename: '/tmp/export' }, status: 400, code: 'INVALID_INPUT' },
  { name: 'a download without a query', exports: policy, input: { ...download, query: undefined }, status: 400, code: 'INVALID_INPUT' },
])('preview refuses $name before any native call', async ({ exports, input, status, code }) => {
  await exportFixture(async ({ post, exportRoot }) => {
    const refused = await post('/preview', input)
    expect(refused.statusCode, refused.body).toBe(status)
    expect(refused.json()).toMatchObject({ error: { code } })
    expect(readdirSync(exportRoot)).toEqual([])
  }, exports)
})

test('a read-only instance cannot preview an export', async () => {
  await exportFixture(async ({ db, post }) => {
    db.prepare("UPDATE credentials SET read_only = 1 WHERE tool = 'shodan-axi'").run()
    expect((await post('/preview', download)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
  })
})

test('a confirmation starts one export and only for identical input', async () => {
  await exportFixture(async ({ post, finish }) => {
    const changed = await post('/preview', download)
    expect((await post('/start', { ...download, limit: 99, confirm: changed.json().confirm })).statusCode).toBe(400)
    expect((await post('/start', { ...download, confirm: changed.json().confirm })).statusCode).toBe(404)
    const preview = await post('/preview', download)
    const started = await post('/start', { ...download, confirm: preview.json().confirm })
    expect(started.statusCode, started.body).toBe(200)
    expect((await post('/start', { ...download, confirm: preview.json().confirm })).statusCode).toBe(404)
    await finish(started.json().id)
  })
})

test('a settings change discards a pending confirmation and its private files', async () => {
  await exportFixture(async ({ setPolicy, post, exportRoot }) => {
    const preview = await post('/preview', download)
    expect(readdirSync(exportRoot)).toHaveLength(1)
    setPolicy({ ...policy, retentionSeconds: 30 })
    expect((await post('/start', { ...download, confirm: preview.json().confirm })).statusCode).toBe(409)
    expect(readdirSync(exportRoot)).toEqual([])
  })
})

test('concurrent previews cannot exceed the per-user capacity', async () => {
  await exportFixture(async ({ post, exportRoot }) => {
    const responses = await Promise.all(Array.from({ length: 9 }, () => post('/preview', download)))
    expect(responses.filter(response => response.statusCode === 200)).toHaveLength(8)
    expect(responses.filter(response => response.json().error?.code === 'TOO_MANY_CALLS')).toHaveLength(1)
    expect(readdirSync(exportRoot)).toHaveLength(8)
  })
})

test('shutdown removes an in-flight preview directory', async () => {
  await exportFixture(async ({ app, post, exportRoot, send, held }) => {
    await send('/__shodan/count-wait')
    const preview = post('/preview', download)
    await held
    await app.close()
    await preview
    expect(readdirSync(exportRoot)).toEqual([])
  })
})

test('a retained export is removed when its retention elapses', async () => {
  await exportFixture(async ({ app, headers, post, finish, exportRoot }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const preview = await post('/preview', download)
    const started = await post('/start', { ...download, confirm: preview.json().confirm })
    expect(await finish(started.json().id)).toMatchObject({ state: 'completed' })
    expect(readdirSync(exportRoot)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect((await app.inject({ method: 'GET', url: `${prefix}/${started.json().id}`, headers })).statusCode).toBe(404)
    await vi.waitFor(() => expect(readdirSync(exportRoot)).toEqual([]))
  })
})

test('a settings change discards a retained export', async () => {
  await exportFixture(async ({ app, headers, setPolicy, post, finish, exportRoot }) => {
    const preview = await post('/preview', download)
    const started = await post('/start', { ...download, confirm: preview.json().confirm })
    await finish(started.json().id)
    setPolicy({ ...policy, retentionSeconds: 30 })
    expect((await app.inject({ method: 'POST', url: `${prefix}/${started.json().id}/retrieve`, headers })).statusCode).toBe(409)
    await vi.waitFor(() => expect(readdirSync(exportRoot)).toEqual([]))
  })
})

test('a failed native export reports the failure and keeps no file', async () => {
  await exportFixture(async ({ post, finish, exportRoot }) => {
    const preview = await post('/preview', { ...download, maxBytes: 16 })
    const started = await post('/start', { ...download, maxBytes: 16, confirm: preview.json().confirm })
    expect(await finish(started.json().id)).toMatchObject({ state: 'failed', result: { error: 'TOOL_FAILED' } })
    expect(readdirSync(exportRoot)).toEqual([])
  })
})
