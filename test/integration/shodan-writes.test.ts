import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { toolPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'

const user = 'synthetic-development-user'
const writes = { grants: { [user]: ['OP-013', 'OP-027', 'OP-037'] }, maxQueryCredits: 5, maxRequests: 10 }
const alert = { command: 'alert create', arguments: ['Fresh alert', '198.51.100.0/24'], queryCreditBudget: 2, maxRequests: 4 }
const member = { command: 'org add', arguments: ['new.member@example.test'], queryCreditBudget: 2, maxRequests: 4, silent: true }
const notifier = { command: 'notifier create', arguments: [], queryCreditBudget: 2, maxRequests: 4,
  body: { provider: 'webhook', description: 'Synthetic', args: { url: 'https://hooks.example.test/CANARY-body-secret' } } }

async function withWriteApp(check: (context: Awaited<ReturnType<typeof prepare>>) => Promise<void>, policy: object = writes) {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  const previous = toolPaths['shodan-axi']
  Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
  await withFakeService(async fixture => {
    const context = await prepare(fixture, policy)
    try { await check(context) } finally { await context.app.close(); context.db.close() }
  }).finally(() => { Object.assign(toolPaths, { 'shodan-axi': previous }) })
}

async function prepare({ directory, port, send }: { directory: string, port: number, send: (path: string) => Promise<string> }, policy: object) {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  const store = createCredentialStore(db, provider)
  store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, 0, user, Date.now())
  db.prepare("UPDATE tools SET enabled=1,native_settings=? WHERE name='shodan-axi'").run(JSON.stringify({ writes: policy }))
  const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
  const real = createShodanAdapter(new EmbeddedSecretSource(store))
  const adapter = { ...real, async prepare(...args: Parameters<typeof real.prepare>) {
    const call = await real.prepare(...args)
    for (const file of call.files) if (typeof file.content === 'string') file.content = file.content.replace('https://api.shodan.io', `https://localhost:${port}`)
    return call
  } }
  const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
    resolver: new SharedIdentityResolver(store, db), adapters: [adapter] })
  const token = issueTestAccessToken(db, user)
  const post = (path: string, payload: object, bearer = token) => app.inject({ method: 'POST', url: `/v1/tools/shodan-axi/writes/${path}`,
    headers: { authorization: `Bearer ${bearer}` }, payload })
  const requests = async () => (JSON.parse(await send('/__evidence')) as { requests: { method: string, path: string }[] }).requests
  const stagedPlans = () => readdirSync(join(directory, 'tool-logs/shodan-axi/writes'))
  return { app, db, token, post, requests, stagedPlans, send, directory }
}

test('preview binds observed state without writing and execute applies it once', async () => {
  await withWriteApp(async ({ db, post, requests, stagedPlans }) => {
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

test('execute refuses changed input without sending the write', async () => {
  await withWriteApp(async ({ post, requests }) => {
    const { confirm } = (await post('preview', alert)).json()
    const response = await post('execute', { ...alert, arguments: ['Other alert', '198.51.100.0/24'], confirm })
    expect([response.statusCode, response.json().error.code]).toEqual([400, 'INVALID_INPUT'])
    expect((await requests()).filter(entry => entry.method !== 'GET')).toEqual([])
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
    expect(db.prepare("SELECT outcome, action FROM audit WHERE event = 'run-terminal'").all()).toEqual([{ outcome: 'interrupted', action: 'unknown' }])
  })
})

test('notifier secrets stay out of previews, results and retained files', async () => {
  await withWriteApp(async ({ post, stagedPlans, db }) => {
    const preview = await post('preview', notifier)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ operation: 'OP-027', arguments: ['url'], effects: [{ operation: 'OP-027', target: 'webhook' }] })
    const executed = await post('execute', { ...notifier, confirm: preview.json().confirm })
    expect(executed.statusCode, executed.body).toBe(200)
    expect(executed.json()).toMatchObject({ status: 'completed', steps: [{ operation: 'OP-027', status: 'verified' }] })
    expect(preview.body + executed.body + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
    expect(stagedPlans()).toEqual([])
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
