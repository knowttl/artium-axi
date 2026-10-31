import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loginResponseSchema } from '../../src/shared/api.js'
import { withFakeService } from '../fake-service/fixture.js'
import { seedToolUser } from '../fixtures/tokens.js'

const configurationCases = [
  { args: ['inventory', 'create', 'Synthetic inventory', '--organization', '7'], path: 'inventories/', body: { name: 'Synthetic inventory', organization: 7 } },
  { args: ['inventory', 'edit', '42', '--name', 'Updated inventory'], path: 'inventories/42/', body: { name: 'Updated inventory' } },
  { args: ['inventory', 'host-create', 'synthetic-host', '--inventory', '7'], path: 'hosts/', body: { name: 'synthetic-host', inventory: 7 } },
  { args: ['inventory', 'host-edit', '42', '--name', 'updated-host'], path: 'hosts/42/', body: { name: 'updated-host' } },
  { args: ['inventory', 'group-create', 'Synthetic group', '--inventory', '7'], path: 'inventories/7/groups/', body: { name: 'Synthetic group' } },
  { args: ['inventory', 'group-edit', '42', '--name', 'Updated group'], path: 'groups/42/', body: { name: 'Updated group' } },
  { args: ['inventory', 'source-create', 'Synthetic source', '--inventory', '7', '--source', 'scm'], path: 'inventory_sources/', body: { name: 'Synthetic source', inventory: 7, source: 'scm' } },
  { args: ['inventory', 'source-edit', '42', '--name', 'Updated source'], path: 'inventory_sources/42/', body: { name: 'Updated source' } },
  { args: ['template', 'create', 'Synthetic template', '--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml'], path: 'job_templates/', body: { name: 'Synthetic template', inventory: 7, project: 8, playbook: 'synthetic.yml' } },
  { args: ['template', 'edit', '42', '--name', 'Updated template'], path: 'job_templates/42/', body: { name: 'Updated template' } },
  { args: ['project', 'create', 'Synthetic project', '--organization', '7'], path: 'projects/', body: { name: 'Synthetic project', organization: 7 } },
  { args: ['project', 'edit', '42', '--name', 'Updated project'], path: 'projects/42/', body: { name: 'Updated project' } },
  { args: ['schedule', 'create', 'Synthetic schedule', '--template', '7', '--rrule', 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY'], path: 'schedules/', body: { name: 'Synthetic schedule', unified_job_template: 7, rrule: 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY' } },
  { args: ['schedule', 'edit', '42', '--name', 'Updated schedule'], path: 'schedules/42/', body: { name: 'Updated schedule' } },
  { args: ['workflow', 'create', 'Synthetic workflow', '--organization', '7'], path: 'workflow_job_templates/', body: { name: 'Synthetic workflow', organization: 7 } },
  { args: ['workflow', 'edit', '42', '--name', 'Updated workflow'], path: 'workflow_job_templates/42/', body: { name: 'Updated workflow' } },
  { args: ['workflow', 'node-create', '7', '--template', '8'], path: 'workflow_job_templates/7/workflow_nodes/', body: { unified_job_template: 8 } },
  { args: ['workflow', 'node-edit', '42', '--template', '8'], path: 'workflow_job_template_nodes/42/', body: { unified_job_template: 8 } },
  { args: ['workflow', 'node-link', '42', '--to', '7', '--on', 'success'], path: 'workflow_job_template_nodes/42/success_nodes/', body: { id: 7 } },
  { args: ['workflow', 'node-add-approval', '42', '--name', 'Synthetic approval'], path: 'workflow_job_template_nodes/42/create_approval_template/', body: { name: 'Synthetic approval' } },
  { args: ['workflow', 'node-label-add', '42', '--label', '7'], path: 'workflow_job_template_nodes/42/labels/', body: { id: 7 } },
  { args: ['workflow', 'node-instance-group-add', '42', '--instance-group', '7'], path: 'workflow_job_template_nodes/42/instance_groups/', body: { id: 7 } },
  { args: ['workflow', 'label-add', '42', '--label', '7'], path: 'workflow_job_templates/42/labels/', body: { id: 7 } },
  { args: ['template', 'label-add', '42', '--label', '7'], path: 'job_templates/42/labels/', body: { id: 7 } },
  { args: ['template', 'instance-group-add', '42', '--instance-group', '7'], path: 'job_templates/42/instance_groups/', body: { id: 7 } },
  { args: ['schedule', 'label-add', '42', '--label', '7'], path: 'schedules/42/labels/', body: { id: 7 } },
  { args: ['schedule', 'instance-group-add', '42', '--instance-group', '7'], path: 'schedules/42/instance_groups/', body: { id: 7 } },
  { args: ['inventory', 'group-add-host', '42', '--host', '7'], path: 'groups/42/hosts/', body: { id: 7 } },
  { args: ['inventory', 'group-add-child', '42', '--child', '7'], path: 'groups/42/children/', body: { id: 7 } },
  { args: ['template', 'copy', '42', '--name', 'Synthetic copy'], path: 'job_templates/42/copy/', body: { name: 'Synthetic copy' } },
  { args: ['workflow', 'copy', '42', '--name', 'Synthetic copy'], path: 'workflow_job_templates/42/copy/', body: { name: 'Synthetic copy' } },
  { args: ['template', 'notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'job_templates/42/notification_templates_success/', body: { id: 7 } },
  { args: ['workflow', 'notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'workflow_job_templates/42/notification_templates_success/', body: { id: 7 } },
  { args: ['project', 'notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'projects/42/notification_templates_success/', body: { id: 7 } },
  { args: ['inventory', 'source-notification-add', '42', '--event', 'success', '--notification-template', '7'], path: 'inventory_sources/42/notification_templates_success/', body: { id: 7 } },
]

test.each(configurationCases)('AWX configuration authority gates $args through the public run API', async ({ args, path, body }) => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'))
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    try {
      await seedToolUser(db)
      db.exec('UPDATE users SET administrator = 1')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
        username: 'synthetic-user', password: 'CANARY-local-password' } })
      const session = loginResponseSchema.parse(login.json())
      if (session.status !== 'authenticated') throw new Error('Expected local login')
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      headers['x-artium-reauth-ticket'] = reauth.json().ticket
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/credential', headers,
        payload: { value: { origin: `https://localhost:${port}`, token: 'CANARY-awx-token' }, expectedRevision: 0, expectedToolRevision: 1 } })
      expect(saved.statusCode, saved.body).toBe(200)
      const inspected = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload: { endpointIndex: 0 } })
      const trusted = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/trust', headers,
        payload: { inspectionId: inspected.json().inspectionId, mode: 'pin' } })
      expect(trusted.statusCode, trusted.body).toBe(200)
      const settings = async (nativeSettings: Record<string, boolean>) => {
        const revision = (db.prepare("SELECT revision FROM tools WHERE name = 'awx-axi'").get() as { revision: number }).revision
        const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
          payload: { enabled: true, nativeSettings, expectedRevision: revision } })
        expect(response.statusCode, response.body).toBe(200)
      }
      const run = (input: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args: input } })
      await settings({ allowWrites: true })
      await send('/__ado/reset', 'POST')
      expect((await run([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
      await settings({ allowConfigurationWrites: true })
      await send('/__ado/reset', 'POST')
      expect((await run(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
      const preview = await run([...args, '--dry-run'])
      expect(preview.json(), preview.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('dry_run') })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=false', 'POST')
      const denied = await run([...args, '--confirm'])
      expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__ado/reset', 'POST')
      const written = await run([...args, '--confirm'])
      expect(written.json(), written.body).toMatchObject({ exitCode: 0 })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(1)
      expect(evidence.requests).toContainEqual({ method: args[1].endsWith('edit') ? 'PATCH' : 'POST',
        path: `/api/v2/${path}`, auth: 'Bearer', canaryReceived: true, body })
      const audit = db.prepare("SELECT event, action, arguments FROM audit WHERE tool = 'awx-axi'").all()
      expect(audit).toContainEqual(expect.objectContaining({ event: 'run-terminal', action: 'write' }))
      expect(JSON.stringify(audit)).not.toContain('CANARY-awx-token')
      expect(written.body).not.toContain('CANARY-awx-token')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX credentials save, test with scoped trust, read and gate operational writes through the published CLI', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    // Ambient category gates must never enter the isolated child environment.
    vi.stubEnv('AWX_AXI_ALLOW_CONFIG_WRITES', '1')
    vi.stubEnv('AWX_AXI_ALLOW_DELETES', '1')
    vi.stubEnv('AWX_AXI_ALLOW_SECURITY_WRITES', '1')
    vi.stubEnv('AWX_AXI_WRITE_LOG', join(directory, 'ambient-writes.log'))
    const runner = await Runner.create(join(directory, 'calls'))
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    try {
      await seedToolUser(db)
      db.exec('UPDATE users SET administrator = 1')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
        username: 'synthetic-user', password: 'CANARY-local-password' } })
      const session = loginResponseSchema.parse(login.json())
      if (session.status !== 'authenticated') throw new Error('Expected local login')
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      headers['x-artium-reauth-ticket'] = reauth.json().ticket
      const origin = `https://localhost:${port}`
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/credential', headers,
        payload: { value: { origin, token: 'CANARY-awx-token' }, expectedRevision: 0, expectedToolRevision: 1 } })
      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.json()).toMatchObject({ metadata: { origin } })
      expect(saved.body).not.toContain('CANARY-')
      const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
      const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]
      const browserLogin = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
        cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
      const page = await app.inject({ url: '/admin/tools/awx-axi', headers: {
        cookie: browserLogin.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
      expect(page.statusCode, page.body).toBe(200)
      expect(page.body).toContain('data-profile-field="origin"')
      expect(page.body).toContain('data-profile-field="signIn"')
      expect(page.body).toContain('data-profile-field="username"')
      expect(page.body).toContain('data-profile-field="password"')
      expect(page.body).toContain('data-credential-field="password" data-secret data-ephemeral')
      expect(page.body).toContain('stores only that token')
      expect(page.body).toContain('data-profile-field="token"')
      expect(page.body).toContain('Separate allowConfigurationWrites')
      expect(page.body).toContain('name="allowConfigurationWrites" data-type="boolean"')
      expect(page.body).not.toContain('data-profile-field="verifySsl"')
      expect(page.body).not.toContain('CANARY-awx-token')
      const checked = () => app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/test', headers, payload: {} })
      const untrusted = await checked()
      expect(untrusted.json()).toMatchObject({ error: { code: 'UPSTREAM_TLS_FAILED', diagnostic: { stage: 'TLS', host: 'localhost' } } })
      const inspected = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload: { endpointIndex: 0 } })
      expect(inspected.statusCode, inspected.body).toBe(200)
      const trusted = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/trust', headers,
        payload: { inspectionId: inspected.json().inspectionId, mode: 'pin' } })
      expect(trusted.statusCode, trusted.body).toBe(200)
      const health = await checked()
      expect(health.statusCode, health.body).toBe(200)
      expect(health.json()).toMatchObject({ status: 'ok', readOnly: true })
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
        payload: { enabled: true, expectedRevision: 2 } })).statusCode).toBe(200)
      const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      const read = await run(['job', 'list', '--limit', '1'])
      expect(read.json()).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic AWX job') })
      expect((await run(['job', 'cancel', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
        payload: { nativeSettings: { allowWrites: true }, expectedRevision: 3 } })).statusCode).toBe(200)
      const written = await run(['job', 'cancel', '42', '--type', 'job', '--confirm'])
      expect(written.json(), written.body).toMatchObject({ exitCode: 0 })
      expect((await run(['template', 'create', 'Synthetic', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await run(['template', 'delete', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await run(['role', 'grant', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(1)
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/jobs/42/cancel/', canaryReceived: true }))
      const audit = db.prepare("SELECT action, arguments FROM audit WHERE tool = 'awx-axi'").all()
      expect(audit).toContainEqual(expect.objectContaining({ action: 'write' }))
      expect(existsSync(join(directory, 'ambient-writes.log'))).toBe(false)
      expect(JSON.stringify(audit)).not.toContain('CANARY-awx-token')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access', headers,
        payload: { enabled: true, allowConfigurationWrites: true, expectedRevision: 4 } })).statusCode).toBe(200)
      const beforeBlocked = JSON.parse(await send('/__evidence'))
      for (const blocked of [
        ['template', 'delete', '42'], ['workflow', 'node-unlink', '42', '--to', '7', '--on', 'success'],
        ['inventory', 'group-remove-host', '42', '--host', '7'], ['inventory', 'host-bulk-create', '--hosts-file', 'synthetic.json'],
        ['credential', 'create', 'Synthetic credential'], ['template', 'credential-add', '42', '--credential', '7'],
        ['organization', 'create', 'Synthetic organization'], ['user', 'create', 'synthetic-user'],
        ['team', 'create', 'Synthetic team'], ['role', 'grant', '42', '--user', '7'], ['user', 'token-create', '42'],
        ['project', 'create', 'Synthetic', '--credential', '7'], ['project', 'create', 'Synthetic', '--scm-url', 'https://scm.example/synthetic'],
        ['inventory', 'create', 'Synthetic', '--variables', '{"canary":"CANARY-input"}'],
        ['template', 'create', 'Synthetic', '--extra-vars', '{"canary":"CANARY-input"}'],
      ]) {
        const refused = await run([...blocked, '--confirm'])
        expect(refused.json(), refused.body).toMatchObject({ error: { code: expect.stringMatching(/FLAG_BLOCKED|INVALID_INPUT|UNSUPPORTED_INPUT/) } })
      }
      expect(JSON.parse(await send('/__evidence'))).toEqual(beforeBlocked)
      expect(JSON.stringify(db.prepare("SELECT arguments FROM audit WHERE tool = 'awx-axi'").all())).not.toContain('CANARY-input')
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access', headers,
        payload: { enabled: false, expectedRevision: 5 } })).statusCode).toBe(200)
      const tools = await app.inject({ url: '/v1/tools', headers })
      expect(tools.json()).toMatchObject({ tools: [expect.objectContaining({ name: 'awx-axi', readOnly: false })] })
      const beforeOperational = JSON.parse(await send('/__evidence'))
      expect((await run(['job', 'cancel', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.parse(await send('/__evidence'))).toEqual(beforeOperational)
      const grants = db.prepare("SELECT arguments FROM audit WHERE tool = 'awx-axi' AND event = 'tool-write-access' ORDER BY id").all() as { arguments: string }[]
      expect(grants.map(row => JSON.parse(row.arguments))).toContainEqual(expect.objectContaining({ enabled: false, allowConfigurationWrites: true }))
      const disabledConfiguration = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access', headers,
        payload: { enabled: false, allowConfigurationWrites: false, expectedRevision: 6 } })
      expect(disabledConfiguration.json(), disabledConfiguration.body).toMatchObject({ readOnly: true, nativeSettings: { allowWrites: false, allowConfigurationWrites: false } })
      const beforeDisabled = JSON.parse(await send('/__evidence'))
      expect((await run(['template', 'create', 'Synthetic', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.parse(await send('/__evidence'))).toEqual(beforeDisabled)
      store.replaceCredential('awx-axi', { origin, token: 'CANARY-invalid-token' }, store.findCredential('awx-axi')!.revision!, 'synthetic-development-user', Date.now())
      const rejected = await checked()
      expect(rejected.json()).toMatchObject({ error: { code: 'UPSTREAM_AUTH_FAILED', diagnostic: { stage: 'authentication', toolCode: 'AUTH_REQUIRED' } } })
      expect(rejected.body).not.toContain('CANARY-invalid-token')
    } finally { vi.unstubAllEnvs(); await app.close(); db.close() }
  })
}, 60_000)

test.each(['PATCH', 'PUT'] as const)('AWX password sign-in via %s bootstraps scoped trust and stores only the minted token', async initialMethod => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const lines: string[] = []
    const runner = await Runner.create(join(directory, 'calls'))
    const app = createApp({ db, audit: new Audit(db, Date.now, line => { lines.push(line) }), runner, adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    const password = 'CANARY-awx-password'
    const username = 'synthetic-awx'
    const minted = 'CANARY-awx-minted-token'
    const encoded = Buffer.from(`${username}:${password}`).toString('base64')
    const onDisk = (secret: string) => ['artium.db', 'artium.db-wal', 'artium.db-shm'].some(name => {
      const path = join(directory, name)
      return existsSync(path) && readFileSync(path).includes(Buffer.from(secret))
    })
    try {
      await seedToolUser(db)
      db.exec('UPDATE users SET administrator = 1')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
        username: 'synthetic-user', password: 'CANARY-local-password' } })
      const session = loginResponseSchema.parse(login.json())
      if (session.status !== 'authenticated') throw new Error('Expected local login')
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      headers['x-artium-reauth-ticket'] = reauth.json().ticket
      const origin = `https://localhost:${port}`
      const revisions = () => ({
        credential: store.findCredential('awx-axi')?.revision ?? 0,
        tool: (db.prepare('SELECT revision FROM tools WHERE name = ?').get('awx-axi') as { revision: number }).revision,
      })
      const save = (method: 'PATCH' | 'PUT', value: Record<string, unknown>) => {
        const current = revisions()
        return app.inject({ method, url: '/v1/admin/tools/awx-axi/credential', headers, payload: {
          value, expectedRevision: current.credential, expectedToolRevision: current.tool } })
      }
      const saveOrigin = (address: string) => {
        const current = revisions()
        return app.inject({ method: 'PUT', url: '/v1/admin/tools/awx-axi/origin', headers, payload: {
          origin: address, expectedRevision: current.credential, expectedToolRevision: current.tool } })
      }
      const absent = (body: string) => {
        expect(body).not.toContain(password)
        expect(body).not.toContain(encoded)
        expect(body).not.toContain(username)
      }
      const unsaved = await save(initialMethod, { origin, signIn: 'password', username, password })
      expect(unsaved.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('Save the controller address') } })
      expect(store.findCredential('awx-axi')).toBeUndefined()
      for (const address of [`http://localhost:${port}`, `${origin}/api/v2`, `https://${username}:${password}@localhost:${port}`]) {
        const invalidOrigin = await saveOrigin(address)
        expect(invalidOrigin.statusCode, invalidOrigin.body).toBe(400)
        absent(invalidOrigin.body)
      }
      const address = await saveOrigin(origin)
      expect(address.statusCode, address.body).toBe(200)
      expect(address.json()).toMatchObject({ configured: false, metadata: { origin } })
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin })
      const staleAddress = await app.inject({ method: 'PUT', url: '/v1/admin/tools/awx-axi/origin', headers, payload: {
        origin, expectedRevision: 0, expectedToolRevision: revisions().tool } })
      expect(staleAddress.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
      const secretInAddress = await app.inject({ method: 'PUT', url: '/v1/admin/tools/awx-axi/origin', headers, payload: {
        origin, password, expectedRevision: revisions().credential, expectedToolRevision: revisions().tool } })
      expect(secretInAddress.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
      absent(secretInAddress.body)
      const pendingSettings = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
        payload: { enabled: true, nativeSettings: {}, expectedRevision: revisions().tool } })
      expect(pendingSettings.statusCode, pendingSettings.body).toBe(200)
      expect(pendingSettings.json()).toMatchObject({ health: { status: 'unconfigured' } })
      const pendingTools = await app.inject({ url: '/v1/tools', headers })
      expect(pendingTools.json()).toMatchObject({ tools: [{ name: 'awx-axi', status: 'unconfigured' }] })
      const pendingTest = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/test', headers, payload: {} })
      expect(pendingTest.json()).toMatchObject({ error: { code: 'CREDENTIAL_NOT_CONFIGURED' } })
      const pendingRun = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args: ['job', 'list', '--limit', '1'] } })
      expect(pendingRun.json()).toMatchObject({ error: { code: 'CREDENTIAL_NOT_CONFIGURED' } })
      const both = await save('PATCH', { origin, signIn: 'password', username, password, token: 'CANARY-awx-token' })
      expect(both.statusCode, both.body).toBe(400)
      expect(both.body).toContain('Choose either a personal access token or a username and password.')
      absent(both.body)
      const partial = await save('PATCH', { origin, signIn: 'password', username })
      expect(partial.statusCode, partial.body).toBe(400)
      expect(partial.body).toContain('Username and password are both required to mint a token.')
      absent(partial.body)
      await send('/__ado/reset', 'POST')
      const insecure = await save('PATCH', { origin: `http://localhost:${port}`, signIn: 'password', username, password })
      expect(insecure.statusCode, insecure.body).toBe(400)
      expect(insecure.body).toContain('HTTPS')
      absent(insecure.body)
      const embedded = await save('PATCH', { origin: `https://${username}:${password}@localhost:${port}`, signIn: 'password', username, password })
      expect(embedded.statusCode, embedded.body).toBe(400)
      expect(embedded.body).toContain('HTTPS')
      absent(embedded.body)
      expect(JSON.parse(await send('/__evidence')).requests.filter((request: { path: string }) => request.path === '/api/v2/tokens/')).toEqual([])
      const untrusted = await save('PATCH', { origin, signIn: 'password', username, password })
      expect(untrusted.statusCode, untrusted.body).toBe(503)
      expect(untrusted.json()).toMatchObject({ error: { code: 'UPSTREAM_TLS_FAILED' } })
      absent(untrusted.body)
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin })
      for (const payload of [{ endpointIndex: 0, origin: 'https://other.example' }, { endpointIndex: 0, host: 'other.example' }, { endpointIndex: 1 }]) {
        const refused = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload })
        expect(refused.statusCode, refused.body).toBe(400)
      }
      const inspected = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload: { endpointIndex: 0 } })
      expect(inspected.statusCode, inspected.body).toBe(200)
      expect(inspected.json()).toMatchObject({ endpoint: `${origin}/`, hostname: 'localhost' })
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      const trusted = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/trust', headers,
        payload: { inspectionId: inspected.json().inspectionId, mode: 'pin' } })
      expect(trusted.statusCode, trusted.body).toBe(200)
      await send('/__ado/reset', 'POST')
      const unsavedDestination = await save(initialMethod, { origin: `https://127.0.0.1:${port}`, signIn: 'password', username, password })
      expect(unsavedDestination.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: expect.stringContaining('Save the controller address') } })
      const beforeInvalid = revisions()
      for (const method of ['PATCH', 'PUT'] as const) {
        for (const invalid of [{ unsupported: true }, { signIn: 'unsupported' }]) {
          const rejected = await save(method, { origin, signIn: 'password', username, password, ...invalid })
          expect(rejected.statusCode, rejected.body).toBe(400)
          expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
          absent(rejected.body)
        }
      }
      expect(revisions()).toEqual(beforeInvalid)
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin })
      expect(JSON.parse(await send('/__evidence')).requests.filter((request: { path: string }) => request.path === '/api/v2/tokens/')).toEqual([])
      const saved = await save(initialMethod, { origin, signIn: 'password', username, password })
      expect(saved.statusCode, saved.body).toBe(200)
      absent(saved.body)
      expect(saved.body).not.toContain(minted)
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin, token: minted })
      expect(onDisk(password)).toBe(false)
      expect(onDisk(encoded)).toBe(false)
      expect(onDisk(username)).toBe(false)
      const replaced = await save('PUT', { origin, signIn: 'password', username, password })
      expect(replaced.statusCode, replaced.body).toBe(200)
      absent(replaced.body)
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin, token: minted })
      const sameAddress = await saveOrigin(origin)
      expect(sameAddress.json()).toMatchObject({ configured: true, metadata: { origin } })
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin, token: minted })
      const keptTrust = await app.inject({ url: '/v1/admin/tools/awx-axi/certificates', headers })
      expect(keptTrust.json().certificates).toHaveLength(1)
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
        payload: { enabled: true, expectedRevision: revisions().tool } })).statusCode).toBe(200)
      const read = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args: ['job', 'list', '--limit', '1'] } })
      expect(read.json(), read.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic AWX job') })
      absent(read.body)
      const evidence = JSON.parse(await send('/__evidence'))
      const tokenPosts = evidence.requests.filter((request: { path: string }) => request.path === '/api/v2/tokens/')
      expect(tokenPosts).toEqual([
        { method: 'POST', path: '/api/v2/tokens/', auth: 'Basic', accept: 'application/json', contentType: 'application/json',
          body: { description: 'awx-axi', scope: 'write' } },
        { method: 'POST', path: '/api/v2/tokens/', auth: 'Basic', accept: 'application/json', contentType: 'application/json',
          body: { description: 'awx-axi', scope: 'write' } },
      ])
      const later = evidence.requests.filter((request: { path: string }) => request.path !== '/api/v2/tokens/')
      expect(later.length).toBeGreaterThan(0)
      expect(later.every((request: { auth: string, canaryReceived: boolean }) => request.auth === 'Bearer' && request.canaryReceived)).toBe(true)
      await send('/__awx/basic-auth?enabled=false', 'POST')
      const stored = minted
      const denied = await save(initialMethod, { origin, signIn: 'password', username, password })
      expect(denied.statusCode, denied.body).toBe(503)
      // Regression #236: AWX's Bearer challenge does not establish whether Basic authentication is enabled.
      expect(denied.json()).toMatchObject({ error: {
        code: 'UPSTREAM_AUTH_FAILED',
        message: 'Controller authentication failed. The credentials may be incorrect or the authentication configuration may not support password sign-in.',
        next: 'Check the credentials and controller authentication configuration, or paste an existing personal access token.',
      } })
      expect(denied.body).not.toContain('disabled')
      absent(denied.body)
      expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin, token: stored })
      const staleInspection = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload: { endpointIndex: 0 } })
      expect(staleInspection.statusCode, staleInspection.body).toBe(200)
      await withFakeService(async destination => {
        const changedOrigin = `https://localhost:${destination.port}`
        const changed = await saveOrigin(changedOrigin)
        expect(changed.json()).toMatchObject({ configured: false, metadata: { origin: changedOrigin } })
        expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin: changedOrigin })
        const pins = await app.inject({ url: '/v1/admin/tools/awx-axi/certificates', headers })
        expect(pins.json()).toEqual({ certificates: [] })
        const staleTrust = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/trust', headers,
          payload: { inspectionId: staleInspection.json().inspectionId } })
        expect(staleTrust.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
        const untrustedDestination = await save(initialMethod, { origin: changedOrigin, signIn: 'password', username, password })
        expect(untrustedDestination.json()).toMatchObject({ error: { code: 'UPSTREAM_TLS_FAILED' } })
        const inspection = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/inspect', headers, payload: { endpointIndex: 0 } })
        expect(inspection.json()).toMatchObject({ endpoint: `${changedOrigin}/` })
        expect(JSON.parse(await destination.send('/__evidence')).requests).toEqual([])
        const approval = await app.inject({ method: 'POST', url: '/v1/admin/tools/awx-axi/certificates/trust', headers,
          payload: { inspectionId: inspection.json().inspectionId, mode: 'pin' } })
        expect(approval.statusCode, approval.body).toBe(200)
        const signedIn = await save(initialMethod, { origin: changedOrigin, signIn: 'password', username, password })
        expect(signedIn.statusCode, signedIn.body).toBe(200)
        expect(store.readCredential(store.findCredential('awx-axi')!)).toEqual({ origin: changedOrigin, token: minted })
      })
      const recorded = JSON.stringify(db.prepare('SELECT * FROM audit').all()) + lines.join('\n')
      expect(recorded).not.toContain(password)
      expect(recorded).not.toContain(encoded)
      expect(onDisk(password)).toBe(false)
      expect(onDisk(encoded)).toBe(false)
    } finally { await app.close(); db.close() }
  })
}, 60_000)
