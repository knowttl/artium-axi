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

const processBoundary = vi.hoisted(() => ({ crash: false }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (command: string, args: string[], options: import('node:child_process').SpawnOptions) =>
    original.spawn(command, args[0]?.endsWith('/shodan-stream-worker.js')
      ? processBoundary.crash ? ['-e', 'process.exit(1)']
        : [fileURLToPath(new URL('../../test/fake-service/shodan-stream-worker.mjs', import.meta.url))] : args, options) }
})

async function sessionFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shodan-session-'))
  const previous = toolPaths['shodan-axi']
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  const store = createCredentialStore(db, provider)
  store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' },
    0, 'synthetic-development-user', Date.now())
  const sessions = { grants: { 'synthetic-development-user': ['OP-046'] }, perUser: 1, perCredential: 1, total: 1,
    sessionEvents: 10, totalEvents: 10, sessionBytes: 4096, totalBytes: 4096, retentionSeconds: 60, leaseSeconds: 1 }
  db.prepare("UPDATE tools SET enabled=1,native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ sessions }))
  const runner = await Runner.create(join(directory, 'calls'))
  const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
    resolver: new SharedIdentityResolver(store), adapters: [createShodanAdapter(new EmbeddedSecretSource(store))] })
  Object.assign(toolPaths, { 'shodan-axi': join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js') })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  const prefix = '/v1/tools/shodan-axi/sessions'
  const input = { operation: 'OP-046', selector: {}, bounds: { limit: 10, maxBytes: 4096, timeout: 1000, idleTimeout: 1000 },
    limits: {}, acceptUnknownCost: true }
  return { app, db, directory, headers, prefix, input, close: async () => {
    await app.close()
    db.close()
    processBoundary.crash = false
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
    expect(retained.json().items).toEqual([{ sequence: 1, value: { profile: 'artium', isolated: true, value: 'synthetic' } }])
    expect(existsSync(join(directory, 'tool-logs/shodan-axi/sessions', `session-${id}`))).toBe(false)
  } finally {
    await fixture.close()
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
