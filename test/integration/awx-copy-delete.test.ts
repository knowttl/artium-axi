import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { withFakeService } from '../fake-service/fixture.js'
import { allowRawApi, issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

type Resource = {
  kind: string
  setup?: { args: string[], input?: RunInput }[]
  create: string[]
  input?: RunInput
  copy?: string[]
  copyPath?: string
  remove: string[]
  removePath: string
  list: string[]
}

const resources: Resource[] = [
  { kind: 'organization', create: ['organization', 'create', 'Synthetic organization'], remove: ['organization', 'delete'],
    removePath: 'organizations', list: ['organization', 'list'] },
  { kind: 'inventory', create: ['inventory', 'create', 'Synthetic inventory', '--organization', '7'], remove: ['inventory', 'delete'],
    removePath: 'inventories', list: ['inventory', 'list'] },
  { kind: 'host', create: ['inventory', 'host-create', 'synthetic-host', '--inventory', '7'], remove: ['inventory', 'host-delete'],
    removePath: 'hosts', list: ['host', 'list'] },
  { kind: 'group', create: ['inventory', 'group-create', 'synthetic-group', '--inventory', '7'], remove: ['inventory', 'group-delete'],
    removePath: 'groups', list: ['group', 'list'] },
  { kind: 'inventory source', create: ['inventory', 'source-create', 'synthetic-source', '--inventory', '7', '--source', 'scm'],
    remove: ['inventory', 'source-delete'], removePath: 'inventory_sources', list: ['inventory-source', 'list'] },
  { kind: 'template', create: ['template', 'create', 'Synthetic template', '--inventory', '7', '--project', '8', '--playbook', 'site.yml'],
    copy: ['template', 'copy'], copyPath: 'job_templates', remove: ['template', 'delete'], removePath: 'job_templates', list: ['template', 'list'] },
  { kind: 'workflow', create: ['workflow', 'create', 'Synthetic workflow', '--organization', '7'],
    copy: ['workflow', 'copy'], copyPath: 'workflow_job_templates', remove: ['workflow', 'delete'], removePath: 'workflow_job_templates', list: ['workflow', 'list'] },
  { kind: 'workflow node', setup: [{ args: ['workflow', 'create', 'Synthetic workflow', '--organization', '7'] }],
    create: ['workflow', 'node-create', '42', '--template', '8'], remove: ['workflow', 'node-delete'],
    removePath: 'workflow_job_template_nodes', list: ['workflow', 'template-nodes', '42'] },
  { kind: 'schedule', create: ['schedule', 'create', 'Synthetic schedule', '--template', '7'], remove: ['schedule', 'delete'],
    removePath: 'schedules', list: ['schedule', 'list'] },
  { kind: 'project', create: ['project', 'create', 'Synthetic project', '--organization', '7', '--scm-type', 'git', '--scm-url', 'https://scm.example/synthetic.git'],
    copy: ['project', 'copy'], copyPath: 'projects', remove: ['project', 'delete'], removePath: 'projects', list: ['project', 'list'] },
  { kind: 'execution environment', create: ['execution-environment', 'create', 'Synthetic environment', '--image', 'registry.example/synthetic:1'],
    copy: ['execution-environment', 'copy'], copyPath: 'execution_environments', remove: ['execution-environment', 'delete'],
    removePath: 'execution_environments', list: ['execution-environment', 'list'] },
  { kind: 'notification template', create: ['notification-template', 'create', 'Synthetic notification', '--organization', '7',
    '--notification-type', 'webhook', '--configuration-file', 'configuration.json'],
  input: { files: [upload('configuration.json', '{"token":"CANARY-notification-token"}')] },
  copy: ['notification-template', 'copy'], copyPath: 'notification_templates', remove: ['notification-template', 'delete'],
  removePath: 'notification_templates', list: ['notification-template', 'list'] },
  { kind: 'user', create: ['user', 'create', 'synthetic-person', '--password-file', '-'], input: { stdin: 'CANARY-user-password\n' },
    remove: ['user', 'delete'], removePath: 'users', list: ['user', 'list'] },
  { kind: 'team', create: ['team', 'create', 'Synthetic team', '--organization', '7'], remove: ['team', 'delete'],
    removePath: 'teams', list: ['team', 'list'] },
  { kind: 'credential', create: ['credential', 'create', 'Synthetic credential', '--credential-type', '7', '--inputs-file', 'credential.json'],
    input: { files: [upload('credential.json', '{"password":"CANARY-credential-password"}')] },
    copy: ['credential', 'copy'], copyPath: 'credentials', remove: ['credential', 'delete'], removePath: 'credentials', list: ['credential', 'list'] },
]

async function withAwx(check: (context: {
  run: (args: string[], input?: RunInput) => Promise<{ json: () => any, body: string }>
  setWrites: (enabled: boolean) => void
  setDeletes: (enabled: boolean) => void
  send: (path: string, method?: string) => Promise<string>
  evidence: () => Promise<{ mutations: number, requests: { method: string, path: string, canaryReceived: boolean }[] }>
  audit: () => unknown[]
  lines: string[]
  directory: string
}) => Promise<void>) {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    allowRawApi(db, 'awx-axi')
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    let allowDeletes = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`, token: 'CANARY-awx-token', allowWrites, allowDeletes }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db), db) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    try {
      await check({
        run: (args, input = {}) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } }),
        setWrites: enabled => { allowWrites = enabled },
        setDeletes: enabled => { allowDeletes = enabled },
        send,
        evidence: async () => JSON.parse(await send('/__evidence')),
        audit: () => db.prepare("SELECT action, outcome FROM audit WHERE tool = 'awx-axi' AND event = 'run-terminal' ORDER BY id").all(),
        lines, directory,
      })
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
    } finally { await app.close(); db.close() }
  })
}

test('AWX destructive commands refuse the missing separate grant while ordinary configuration writes work (237d)', async () => {
  await withAwx(async ({ run, setDeletes, evidence }) => {
    setDeletes(false)
    const before = await evidence()
    const commands = [
      ['inventory', 'delete', '42'], ['inventory', 'host-delete', '42'],
      ['inventory', 'host-bulk-delete'], ['inventory', 'host-bulk-create'],
      ['inventory', 'group-delete', '42'], ['inventory', 'source-delete', '42'],
      ['credential', 'delete', '42'], ['user', 'delete', '42'], ['team', 'delete', '42'],
      ['organization', 'delete', '42'], ['template', 'delete', '42'], ['workflow', 'delete', '42'],
      ['workflow', 'node-delete', '42'], ['schedule', 'delete', '42'], ['project', 'delete', '42'],
      ['execution-environment', 'delete', '42'], ['notification-template', 'delete', '42'],
      ['api', 'delete', 'hosts/42/'],
    ]
    for (const command of commands) {
      for (const flag of ['--dry-run', '--confirm']) {
        const refused = await run([...command, flag])
        expect(refused.json(), refused.body).toMatchObject({ error: { code: 'FLAG_BLOCKED',
          message: 'Destructive deletes and bulk host operations are disabled for this tool.',
          next: expect.stringContaining('Allow destructive deletes') } })
      }
    }
    expect((await evidence()).requests).toEqual(before.requests)
    const created = await run(['organization', 'create', 'Synthetic ordinary write', '--confirm'])
    expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
    expect((await evidence()).mutations).toBe(before.mutations + 1)
  })
}, 60_000)

test.each(resources)('AWX $kind create, copy and delete journey changes state only while writes are enabled (S13)', async resource => {
  await withAwx(async ({ run, setWrites, send, evidence, audit }) => {
    const ids = { first: 42, copy: 43 }
    const count = async (expected: number) => {
      setWrites(false)
      const listed = await run(resource.list)
      expect(listed.json(), listed.body).toMatchObject({ exitCode: 0 })
      expect(decode(listed.json().stdout)).toMatchObject({ count: `${expected} total` })
      setWrites(true)
    }
    const confirmed = async (args: string[], input?: RunInput) => {
      const response = await run([...args, '--confirm'], input)
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return response
    }
    for (const setup of resource.setup ?? []) await confirmed(setup.args, setup.input)
    await confirmed(resource.create, resource.input)
    await count(1)
    if (resource.copy) {
      const copied = await confirmed([...resource.copy, String(ids.first), '--name', 'Synthetic copy'])
      expect(JSON.stringify(decode(copied.json().stdout))).toContain(`${ids.copy}`)
      await count(2)
      await confirmed([...resource.remove, String(ids.copy)])
      await count(1)
    }
    setWrites(true)
    await send('/__awx/configuration-permission?enabled=false', 'POST')
    const denied = await run([...resource.remove, String(ids.first), '--confirm'])
    expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
    await count(1)
    await send('/__awx/configuration-permission?enabled=true', 'POST')
    const before = (await evidence()).requests.length
    setWrites(false)
    for (const flag of ['--confirm', '--dry-run']) {
      const refused = await run([...resource.remove, String(ids.first), flag])
      expect(refused.json(), refused.body).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    }
    expect((await evidence()).requests).toHaveLength(before)
    setWrites(true)
    const unconfirmed = await run([...resource.remove, String(ids.first)])
    expect(unconfirmed.json(), unconfirmed.body).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    const preview = await run([...resource.remove, String(ids.first), '--dry-run'])
    expect(preview.json(), preview.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining(`DELETE ${resource.removePath}/${ids.first}/`) })
    await count(1)
    await confirmed([...resource.remove, String(ids.first)])
    await count(0)
    const log = await evidence()
    const deletes = log.requests.filter(request => request.method === 'DELETE')
    expect(deletes).toEqual([...(resource.copy ? [ids.copy] : []), ids.first, ids.first]
      .map(id => expect.objectContaining({ path: `/api/v2/${resource.removePath}/${id}/`, canaryReceived: true })))
    expect(log.requests.filter(request => request.path.endsWith('/copy/'))).toHaveLength(resource.copy ? 1 : 0)
    // A controller-denied delete exits non-zero, so Artium audits it as an unknown action rather than a write.
    const executed = (audit() as { action: string, outcome: string }[]).filter(row => row.action !== 'read' && row.outcome === 'completed')
    expect(executed).toHaveLength(log.requests.filter(request => request.method !== 'GET').length)
  })
}, 60_000)

test.each(resources.filter(resource => resource.copy))('AWX $kind copy previews and refuses disabled writes without a controller request (S13)', async resource => {
  await withAwx(async ({ run, setWrites, evidence }) => {
    const args = [...resource.copy!, '42', '--name', 'Synthetic copy']
    const before = await evidence()
    setWrites(false)
    for (const flag of ['--confirm', '--dry-run']) {
      const refused = await run([...args, flag])
      expect(refused.json(), refused.body).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    }
    setWrites(true)
    const unconfirmed = await run(args)
    expect(unconfirmed.json(), unconfirmed.body).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    const preview = await run([...args, '--dry-run'])
    expect(preview.json(), preview.body).toMatchObject({ exitCode: 0,
      stdout: expect.stringContaining(`POST ${resource.copyPath}/42/copy/`) })
    const after = await evidence()
    expect(after.mutations).toBe(before.mutations)
    expect(after.requests.filter(request => request.method !== 'GET')).toEqual([])
  })
}, 60_000)

test.each([
  { kind: 'project delete', setup: ['project', 'create', 'Synthetic project', '--organization', '7', '--scm-type', 'git', '--scm-url', 'https://scm.example/synthetic.git'],
    args: ['project', 'delete', '42'], next: 'artium-axi awx-axi project show 42', list: ['project', 'list'], count: '0 total' },
  { kind: 'execution environment copy', setup: ['execution-environment', 'create', 'Synthetic environment', '--image', 'registry.example/synthetic:1'],
    args: ['execution-environment', 'copy', '42', '--name', 'Synthetic copy'], next: 'artium-axi awx-axi execution-environment list --limit 100',
    list: ['execution-environment', 'list'], count: '2 total' },
])('AWX $kind reports an unknown outcome and is recoverable by reads with writes disabled (S13)', async ({ setup, args, next, list, count }) => {
  await withAwx(async ({ run, setWrites, send, evidence, audit }) => {
    const created = await run([...setup, '--confirm'])
    expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
    await send('/__awx/write-outcome?drop=true', 'POST')
    const interrupted = await run([...args, '--confirm'])
    expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME', next: expect.stringContaining(next) } })
    expect((await evidence()).mutations).toBe(2)
    await send('/__awx/write-outcome?drop=false', 'POST')
    setWrites(false)
    const recovered = await run(list)
    expect(recovered.json(), recovered.body).toMatchObject({ exitCode: 0 })
    expect(decode(recovered.json().stdout)).toMatchObject({ count })
    expect(audit().filter(row => (row as { outcome: string }).outcome === 'UNKNOWN_OUTCOME')).toHaveLength(1)
  })
}, 60_000)

const acceptance = [
  { kind: 'association', args: ['inventory', 'group-add-host', '42', '--host', '7'], method: 'POST', path: '/api/v2/groups/42/hosts/' },
  { kind: 'security association', args: ['team', 'user-add', '42', '--user', '7'], method: 'POST', path: '/api/v2/teams/42/users/' },
  { kind: 'bulk', args: ['inventory', 'host-bulk-create', '--inventory', '7', '--hosts-file', 'hosts.json'], method: 'POST', path: '/api/v2/bulk/host_create/',
    input: { files: [upload('hosts.json', '[{"name":"synthetic-host","variables":"token: CANARY-host-variable"}]')] } },
  { kind: 'destructive', args: ['inventory', 'delete', '42'], method: 'DELETE', path: '/api/v2/inventories/42/' },
] as { kind: string, args: string[], method: string, path: string, input?: RunInput }[]

test.each(acceptance)('AWX $kind write is refused without a controller request while the tenant switch is off (S14)', async ({ args, input }) => {
  await withAwx(async ({ run, setWrites, evidence }) => {
    setWrites(false)
    for (const flag of ['--dry-run', '--confirm']) {
      const refused = await run([...args, flag], input)
      expect(refused.json(), refused.body).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    }
    expect((await evidence()).requests).toEqual([])
  })
}, 60_000)

test.each(acceptance)('AWX $kind write previews, then reports the controller denial without changing state (S14)', async ({ args, input, method, path }) => {
  await withAwx(async ({ run, send, evidence }) => {
    const preview = await run([...args, '--dry-run'], input)
    expect(preview.json(), preview.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('dry_run') })
    expect((await evidence()).mutations).toBe(0)
    await send('/__awx/configuration-permission?enabled=false', 'POST')
    const denied = await run([...args, '--confirm'], input)
    expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
    expect((await evidence()).requests.filter(request => request.method === method && request.path === path)).toHaveLength(1)
    await send('/__awx/configuration-permission?enabled=true', 'POST')
    const confirmed = await run([...args, '--confirm'], input)
    expect(confirmed.json(), confirmed.body).toMatchObject({ exitCode: 0 })
    expect((await evidence()).requests.filter(request => request.method === method && request.path === path)).toHaveLength(2)
  })
}, 60_000)

test.each(acceptance)('AWX $kind write keeps private input out of responses, audit and runner files (S14)', async ({ args, input }) => {
  await withAwx(async ({ run, lines, directory, evidence }) => {
    const response = await run([...args, '--confirm'], input)
    expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
    expect(response.body).not.toContain('CANARY-')
    expect(lines.join('\n')).not.toContain('CANARY-')
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
    expect((await evidence()).requests.every(request => request.canaryReceived)).toBe(true)
  })
}, 60_000)
