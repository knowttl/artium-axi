import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { expect, test, vi } from 'vitest'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { toolPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { registerShodanSessions } from '../../src/server/shodan-sessions.js'
import { registerShodanWrites } from '../../src/server/shodan-writes.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'

const user = 'synthetic-development-user'
const writes = { grants: { [user]: ['OP-013', 'OP-027', 'OP-037', 'OP-038'] }, maxQueryCredits: 5, maxRequests: 10 }
const allWrites = { ...writes, grants: { [user]: ['OP-013', 'OP-015', 'OP-016', 'OP-019', 'OP-020', 'OP-021', 'OP-022', 'OP-023', 'OP-024', 'OP-027', 'OP-028', 'OP-030', 'OP-037', 'OP-038', 'OP-070'] } }
const alert = { command: 'alert create', arguments: ['Fresh alert', '198.51.100.0/24'], queryCreditBudget: 2, maxRequests: 4 }
const member = { command: 'org add', arguments: ['new.member@example.test'], queryCreditBudget: 2, maxRequests: 4, silent: true }
const notifier = { command: 'notifier create', arguments: [], queryCreditBudget: 2, maxRequests: 4,
  body: { provider: 'webhook', description: 'Synthetic', args: { url: 'https://hooks.example.test/CANARY-body-secret' } } }

async function withWriteApp(check: (context: Awaited<ReturnType<typeof prepare>>) => Promise<void>, policy: object = writes, bare = false) {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  const previous = toolPaths['shodan-axi']
  Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
  await withFakeService(async fixture => {
    const context = await prepare(fixture, policy, bare)
    try { await check(context) } finally { await context.app.close(); context.db.close() }
  }).finally(() => { Object.assign(toolPaths, { 'shodan-axi': previous }) })
}

async function prepare({ directory, port, send }: { directory: string, port: number, send: (path: string) => Promise<string> }, policy: object, bare: boolean) {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  const store = createCredentialStore(db, provider)
  store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, 0, user, Date.now())
  db.prepare("UPDATE tools SET enabled=1,native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ writes: policy }))
  const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
  const real = createShodanAdapter(new EmbeddedSecretSource(store))
  let preparations = 0
  const adapter = { ...real, async prepare(...args: Parameters<typeof real.prepare>) {
    preparations++
    const call = await real.prepare(...args)
    for (const file of call.files) if (typeof file.content === 'string') file.content = file.content.replace('https://api.shodan.io', `https://localhost:${port}`)
    return call
  } }
  const audit = new Audit(db), resolver = new SharedIdentityResolver(store, db)
  const app = bare ? Fastify() : createApp({ db, runner, audit, credentialStore: store, environment: {}, resolver, adapters: [adapter] })
  const plans = bare ? registerShodanWrites(app, db, resolver, adapter, runner, audit, registerShodanSessions(app, db, resolver, adapter, runner, audit)) : undefined
  const token = issueTestAccessToken(db, user)
  const post = (path: string, payload: object, bearer = token) => app.inject({ method: 'POST', url: `/v1/tools/shodan-axi/writes/${path}`,
    headers: { authorization: `Bearer ${bearer}` }, payload })
  const requests = async () => (JSON.parse(await send('/__evidence')) as { requests: { method: string, path: string }[] }).requests
  const stagedPlans = () => readdirSync(join(directory, 'tool-logs/shodan-axi/writes'))
  return { app, db, token, post, requests, stagedPlans, send, directory, preparations: () => preparations, plans }
}

test('preview binds observed state without writing and execute applies it once', async () => {
  await withWriteApp(async ({ db, post, requests, stagedPlans, send }) => {
    const preview = await post('preview', alert)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ instance: 'default', command: 'alert create', operation: 'OP-013', cost: 'unknown', queryCreditBudget: 2, maxRequests: 4,
      effects: [{ operation: 'OP-013', method: 'POST', target: 'Fresh alert', networks: ['198.51.100.0/24'] }] })
    expect(preview.body).not.toContain('CANARY-')
    expect((await requests()).filter(entry => entry.method !== 'GET')).toEqual([])
    expect(stagedPlans()).toHaveLength(1)
    const { confirm } = preview.json()
    const executed = await post('execute', { ...alert, confirm })
    expect(executed.statusCode, executed.body).toBe(200)
    expect(executed.json()).toMatchObject({ status: 'completed', steps: [{ operation: 'OP-013', status: 'verified' }] })
    expect((await requests()).filter(entry => entry.method === 'POST').map(entry => entry.path)).toEqual(['/shodan/alert'])
    expect(JSON.parse(await send('/__shodan/state')).alerts['created-alert-1']).toMatchObject({ name: 'Fresh alert', filters: { ip: ['198.51.100.0/24'] } })
    expect(stagedPlans()).toEqual([])
    expect((await post('execute', { ...alert, confirm })).statusCode).toBe(404)
    const rows = db.prepare("SELECT event, outcome, action, arguments AS args FROM audit WHERE tool = 'shodan-axi' AND event IN ('run-start', 'run-terminal') ORDER BY id").all()
    expect(rows).toEqual([{ event: 'run-start', outcome: 'started', action: null, args: JSON.stringify(['write', 'OP-013']) },
      { event: 'run-terminal', outcome: 'completed', action: 'write', args: null }])
    expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('Fresh alert')
    const stranger = issueTestAccessToken(db, user)
    const second = (await post('preview', member)).json().confirm
    expect((await post('execute', { ...member, confirm: second }, stranger)).statusCode).toBe(404)
  })
})

test.each([
  { name: 'ungranted operation', payload: { ...alert, command: 'alert remove', arguments: ['synthetic-alert'] }, code: 'TOOL_NOT_GRANTED', status: 403 },
  { name: 'request ceiling', payload: { ...alert, maxRequests: 11 }, code: 'INVALID_INPUT', status: 400 },
  { name: 'credit ceiling', payload: { ...alert, queryCreditBudget: 6 }, code: 'INVALID_INPUT', status: 400 },
  { name: 'flag-shaped argument', payload: { ...alert, arguments: ['--config', '198.51.100.0/24'] }, code: 'INVALID_INPUT', status: 400 },
  { name: 'unlisted command', payload: { ...alert, command: 'alert clear', arguments: [] }, code: 'INVALID_INPUT', status: 400 },
  { name: 'budget below the native minimum', payload: { ...alert, queryCreditBudget: 1, maxRequests: 1 }, code: 'INVALID_INPUT', status: 400 },
])('preview refuses $name before any upstream request', async ({ payload, code, status }) => {
  await withWriteApp(async ({ post, requests, stagedPlans }) => {
    const response = await post('preview', payload)
    expect([response.statusCode, response.json().error.code]).toEqual([status, code])
    expect(await requests()).toEqual([])
    expect(stagedPlans()).toEqual([])
  })
})

test('preview refuses a read-only credential before any upstream request', async () => {
  await withWriteApp(async ({ db, post, requests }) => {
    db.exec("UPDATE credentials SET read_only=1 WHERE tool='shodan-axi'")
    const response = await post('preview', alert)
    expect([response.statusCode, response.json().error.code]).toEqual([400, 'FLAG_BLOCKED'])
    expect(await requests()).toEqual([])
  })
})

test('preview gates run before credential preparation in order', async () => {
  await withWriteApp(async ({ db, post, preparations }) => {
    db.exec("UPDATE tools SET enabled=0 WHERE name='shodan-axi'; UPDATE credentials SET read_only=1 WHERE tool='shodan-axi'")
    const ungranted = { ...alert, command: 'alert remove', arguments: ['synthetic-alert'], maxRequests: 11 }
    expect((await post('preview', ungranted, 'invalid')).json().error.code).toBe('TOKEN_INVALID')
    expect((await post('preview', ungranted)).json().error.code).toBe('TOOL_DISABLED')
    db.exec("UPDATE tools SET enabled=1 WHERE name='shodan-axi'")
    expect((await post('preview', ungranted)).json().error.code).toBe('TOOL_NOT_GRANTED')
    expect((await post('preview', { ...alert, maxRequests: 11 })).json().error.code).toBe('FLAG_BLOCKED')
    db.exec("UPDATE credentials SET read_only=0 WHERE tool='shodan-axi'")
    expect((await post('preview', { ...alert, maxRequests: 11 })).json().error.code).toBe('INVALID_INPUT')
    expect(preparations()).toBe(0)
    for (let i = 0; i < 8; i++) expect((await post('preview', alert)).statusCode).toBe(200)
    expect(preparations()).toBe(8)
    expect((await post('preview', alert)).json().error.code).toBe('TOO_MANY_CALLS')
    expect(preparations()).toBe(8)
  })
})

test('execute refuses changed input without sending the write', async () => {
  await withWriteApp(async ({ post, requests }) => {
    const { confirm } = (await post('preview', alert)).json()
    const response = await post('execute', { ...alert, arguments: ['Other alert', '198.51.100.0/24'], confirm })
    expect([response.statusCode, response.json().error.code]).toEqual([400, 'INVALID_INPUT'])
    expect((await requests()).filter(entry => entry.method !== 'GET')).toEqual([])
  })
})

test.each([
  { previewInstance: 'default', executeInstance: undefined },
  { previewInstance: undefined, executeInstance: 'default' },
])('execute refuses a changed instance field', async ({ previewInstance, executeInstance }) => {
  await withWriteApp(async ({ post, requests }) => {
    const preview = await post('preview', { ...alert, instance: previewInstance })
    expect(preview.statusCode, preview.body).toBe(200)
    const response = await post('execute', { ...alert, instance: executeInstance, confirm: preview.json().confirm })
    expect([response.statusCode, response.json().error.code]).toEqual([400, 'INVALID_INPUT'])
    expect((await requests()).filter(entry => entry.method !== 'GET')).toEqual([])
  })
})

test('execute accepts the same explicitly selected instance', async () => {
  await withWriteApp(async ({ post }) => {
    const input = { ...alert, instance: 'default' }
    const preview = await post('preview', input)
    expect(preview.statusCode, preview.body).toBe(200)
    const response = await post('execute', { ...input, confirm: preview.json().confirm })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'completed' })
  })
})

test('concurrent previews cannot exceed the per-user plan quota', async () => {
  await withWriteApp(async ({ post }) => {
    for (let i = 0; i < 7; i++) expect((await post('preview', alert)).statusCode).toBe(200)
    const responses = await Promise.all([post('preview', alert), post('preview', alert)])
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 429])
  })
})

test('execute accepts notifier arguments in a different key order', async () => {
  await withWriteApp(async ({ post }) => {
    const body = { ...notifier.body, args: { url: 'https://hooks.example.test/synthetic', token: 'synthetic-token' } }
    const preview = await post('preview', { ...notifier, body })
    expect(preview.statusCode, preview.body).toBe(200)
    const response = await post('execute', { ...notifier, body: { ...body, args: { token: 'synthetic-token', url: body.args.url } },
      confirm: preview.json().confirm })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'completed' })
  })
})

test('execute refuses when observed state changed after preview', async () => {
  await withWriteApp(async ({ post, requests, send, stagedPlans }) => {
    const { confirm } = (await post('preview', member)).json()
    await send('/__shodan/member?email=other.member@example.test')
    const response = await post('execute', { ...member, confirm })
    expect([response.statusCode, response.json().error.code]).toEqual([409, 'REVISION_CONFLICT'])
    expect((await requests()).filter(entry => entry.method === 'PUT')).toEqual([])
    expect(stagedPlans()).toEqual([])
  })
})

test('execute reports an unknown outcome when the write response is lost', async () => {
  await withWriteApp(async ({ db, post, send }) => {
    const { confirm } = (await post('preview', alert)).json()
    await send('/__shodan/write-drop')
    const response = await post('execute', { ...alert, confirm })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'OUTCOME_UNKNOWN', completed: [], uncertain: { operation: 'OP-013', status: 'failed' }, unsent: [] })
    expect(JSON.parse(await send('/__shodan/state')).alerts['created-alert-1']).toMatchObject({ name: 'Fresh alert', filters: { ip: ['198.51.100.0/24'] } })
    expect(db.prepare("SELECT outcome, action FROM audit WHERE event = 'run-terminal'").all()).toEqual([{ outcome: 'interrupted', action: 'unknown' }])
  })
})

test('execute reports an unverified readback after a successful write', async () => {
  await withWriteApp(async ({ db, post, send }) => {
    const preview = await post('preview', alert)
    expect(preview.statusCode, preview.body).toBe(200)
    await send('/__shodan/readback-mismatch')
    const response = await post('execute', { ...alert, confirm: preview.json().confirm })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({ status: 'READBACK_UNVERIFIED', completed: [], unsent: [] })
    expect(JSON.parse(await send('/__shodan/state')).alerts['created-alert-1']).toMatchObject({ name: 'Fresh alert', filters: { ip: ['198.51.100.0/24'] } })
    expect(db.prepare("SELECT outcome, action FROM audit WHERE event = 'run-terminal'").all()).toEqual([{ outcome: 'interrupted', action: 'unknown' }])
  })
})

test('notifier secrets stay out of previews, results and retained files', async () => {
  await withWriteApp(async ({ post, stagedPlans, db, directory, send }) => {
    const logs = vi.spyOn(process.stderr, 'write')
    try {
      const preview = await post('preview', notifier)
      expect(preview.statusCode, preview.body).toBe(200)
      expect(preview.json()).toMatchObject({ operation: 'OP-027', arguments: ['url'], effects: [{ operation: 'OP-027', target: 'webhook' }] })
      const root = join(directory, 'tool-logs/shodan-axi/writes')
      const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      for (const file of files) expect(readFileSync(join(file.parentPath, file.name)).includes('CANARY-body-secret')).toBe(false)
      const executed = await post('execute', { ...notifier, confirm: preview.json().confirm })
      expect(executed.statusCode, executed.body).toBe(200)
      expect(executed.json()).toMatchObject({ status: 'completed', steps: [{ operation: 'OP-027', status: 'verified' }] })
      expect(JSON.parse(await send('/__shodan/state')).notifiers['created-notifier-1']).toMatchObject({ provider: 'webhook', description: 'Synthetic', args: notifier.body.args })
      expect(preview.body + executed.body + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(JSON.stringify(logs.mock.calls)).not.toContain('CANARY-body-secret')
      expect(stagedPlans()).toEqual([])
    } finally { logs.mockRestore() }
  })
})

test('retained notifier plans contain only the input hash', async () => {
  await withWriteApp(async ({ post, plans }) => {
    const preview = await post('preview', notifier)
    expect(preview.statusCode, preview.body).toBe(200)
    const retained = plans!.retainedPlans()
    expect(retained).toHaveLength(1)
    const canonical = '{"arguments":[],"body":{"args":{"url":"https://hooks.example.test/CANARY-body-secret"},"description":"Synthetic","provider":"webhook"},"command":"notifier create","maxRequests":4,"queryCreditBudget":2}'
    expect(retained[0].inputHash).toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(retained[0]).not.toHaveProperty('input')
    const serialized = JSON.stringify(retained)
    const fields = (value: unknown): unknown[] => value && typeof value === 'object'
      ? [value, ...Object.entries(value).flatMap(([key, child]) => [key, ...fields(child)])] : [value]
    expect(fields(retained)).not.toContainEqual(notifier)
    for (const value of [notifier.body.provider, notifier.body.description, ...Object.values(notifier.body.args), notifier.command]) {
      expect(serialized).not.toContain(value)
      expect(fields(retained)).not.toContain(value)
    }
  }, writes, true)
})

test.each([
  { command: 'alert update', args: ['synthetic-alert', '198.51.100.0/24'], operation: 'OP-016', method: 'POST', expected: { alerts: { 'synthetic-alert': { filters: { ip: ['198.51.100.0/24'] } } } } },
  { command: 'alert remove', args: ['synthetic-alert'], operation: 'OP-015', method: 'DELETE', absent: ['alerts', 'synthetic-alert'] },
  { command: 'alert enable', args: ['synthetic-alert', 'open_database'], operation: 'OP-019', method: 'PUT', expected: { alerts: { 'synthetic-alert': { triggers: { open_database: {} } } } } },
  { command: 'alert disable', args: ['synthetic-alert', 'new_service'], operation: 'OP-020', method: 'DELETE', absent: ['alerts', 'synthetic-alert', 'triggers', 'new_service'] },
  { command: 'alert ignore', args: ['synthetic-alert', 'new_service', '192.0.2.2:443'], operation: 'OP-021', method: 'PUT', expected: { ignored: { 'synthetic-alert': { new_service: { '192.0.2.2:443': [] } } } } },
  { command: 'alert ignore', args: ['synthetic-alert', 'new_service', '192.0.2.2:443'], operation: 'OP-070', method: 'PUT', vulns: 'CVE-2024-1234', expected: { ignored: { 'synthetic-alert': { new_service: { '192.0.2.2:443': ['CVE-2024-1234'] } } } } },
  { command: 'alert unignore', args: ['synthetic-alert', 'new_service', '192.0.2.1:443'], operation: 'OP-022', method: 'DELETE', expected: { ignored: { 'synthetic-alert': { new_service: {} } } }, absent: ['ignored', 'synthetic-alert', 'new_service', '192.0.2.1:443'] },
  { command: 'alert notifier add', args: ['synthetic-alert', 'other-notifier'], operation: 'OP-023', method: 'PUT', expected: { alerts: { 'synthetic-alert': { notifiers: ['synthetic-notifier', 'other-notifier'] } } } },
  { command: 'alert notifier remove', args: ['synthetic-alert', 'synthetic-notifier'], operation: 'OP-024', method: 'DELETE', expected: { alerts: { 'synthetic-alert': { notifiers: [] } } } },
  { command: 'notifier update', args: ['synthetic-notifier'], operation: 'OP-030', method: 'PUT', body: notifier.body, expected: { notifiers: { 'synthetic-notifier': { provider: 'webhook', description: 'Synthetic', args: notifier.body.args } } } },
  { command: 'notifier remove', args: ['synthetic-notifier'], operation: 'OP-028', method: 'DELETE', absent: ['notifiers', 'synthetic-notifier'] },
])('$command previews and verifies its mutation ($operation)', async ({ command, args, operation, method, expected, absent, ...options }) => {
  await withWriteApp(async ({ post, send }) => {
    const input = { command, arguments: args, queryCreditBudget: 2, maxRequests: 4, ...options }
    if (operation === 'OP-022') expect(JSON.parse(await send('/__shodan/state')).ignored['synthetic-alert'].new_service).toHaveProperty(['192.0.2.1:443'])
    const preview = await post('preview', input)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ operation, effects: [{ operation, method }] })
    const result = await post('execute', { ...input, confirm: preview.json().confirm })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ status: 'completed', steps: [{ operation, status: 'verified' }] })
    const state = JSON.parse(await send('/__shodan/state'))
    if (expected) expect(state).toMatchObject(expected)
    if (absent) expect(state).not.toHaveProperty(absent)
  }, allWrites)
})

test('organization removal previews downgrade and verifies removal', async () => {
  await withWriteApp(async ({ post, send }) => {
    const input = { ...member, command: 'org remove', arguments: ['reader@example.test'], silent: undefined }
    const preview = await post('preview', input)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ operation: 'OP-038', effects: [{ operation: 'OP-038', method: 'DELETE', downgrade: true }] })
    const result = await post('execute', { ...input, confirm: preview.json().confirm })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ status: 'completed', steps: [{ operation: 'OP-038', status: 'verified' }] })
    expect(JSON.parse(await send('/__shodan/state')).members).not.toHaveProperty(['reader@example.test'])
  })
})

test('organization invitation adds the member', async () => {
  await withWriteApp(async ({ post, send }) => {
    const preview = await post('preview', member)
    expect(preview.statusCode, preview.body).toBe(200)
    const result = await post('execute', { ...member, confirm: preview.json().confirm })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json()).toMatchObject({ status: 'completed', steps: [{ operation: 'OP-037', status: 'verified' }] })
    expect(JSON.parse(await send('/__shodan/state')).members['new.member@example.test']).toEqual({ email: 'new.member@example.test' })
  })
})

test('silent organization invitation previews its notification flag', async () => {
  await withWriteApp(async ({ post }) => {
    const preview = await post('preview', member)
    expect(preview.json()).toMatchObject({ operation: 'OP-037', effects: [{ operation: 'OP-037', method: 'PUT', notify: false }] })
    const loud = await post('preview', { ...member, silent: undefined })
    expect(loud.json()).toMatchObject({ effects: [{ notify: true }] })
  })
})

test('plans dropped by a binding change delete their private files', async () => {
  await withWriteApp(async ({ db, post, stagedPlans }) => {
    const { confirm } = (await post('preview', alert)).json()
    expect(stagedPlans()).toHaveLength(1)
    db.prepare("UPDATE tools SET native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ writes: { ...writes, maxRequests: 9 } }))
    expect((await post('execute', { ...alert, confirm })).json().error.code).toBe('REVISION_CONFLICT')
    expect(stagedPlans()).toEqual([])
  })
})
