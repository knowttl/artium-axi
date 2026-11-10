import { configurationTests } from './awx-configuration-cases.js'
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
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

test('AWX server onboarding provisions a machine credential and launches synthetic connectivity (S6)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites: true }) })
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
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[], input: RunInput = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['inventory', 'create', 'Synthetic servers', '--organization', '7', '--confirm'])
      await run(['inventory', 'host-create', 'synthetic-host', '--inventory', '42', '--variables', '{"ansible_host":"synthetic.invalid"}', '--confirm'])
      await run(['credential', 'create', 'Synthetic SSH', '--credential-type', 'Machine', '--inputs-file', 'machine.json', '--confirm'],
        { files: [upload('machine.json', '{"username":"synthetic-user","ssh_key_data":"CANARY-onboarding-key"}')] })
      await run(['template', 'create', 'Synthetic connectivity', '--inventory', '42', '--project', '8', '--playbook', 'connectivity.yml', '--confirm'])
      await run(['template', 'credential-add', '42', '--credential', 'Synthetic SSH', '--confirm'])
      expect(await run(['inventory', 'hosts', '42'])).toMatchObject({ hosts: [{ id: 42, name: 'synthetic-host' }] })
      expect(await run(['template', 'launch', '42', '--dry-run'])).toMatchObject({ dry_run: { template: 42 } })
      expect(await run(['template', 'launch', '42', '--confirm'])).toMatchObject({ job: { id: 42, status: 'pending' } })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/credentials/',
        body: { name: 'Synthetic SSH', credential_type: 7, inputs: { username: 'synthetic-user', ssh_key_data: 'CANARY-onboarding-key' } } }))
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/job_templates/42/credentials/', body: { id: 42 } }))
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/job_templates/42/launch/', body: {} }))
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX workflow graph changes are visible with writes disabled and recover interrupted node creation (S6)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
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
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    const run = async (args: string[]) => {
      const response = await request(args)
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['workflow', 'create', 'Synthetic graph', '--organization', '7', '--confirm'])
      await run(['workflow', 'node-create', '42', '--template', '8', '--inventory', '7', '--extra-vars', '{"password":"CANARY-graph"}', '--confirm'])
      await run(['workflow', 'node-edit', '42', '--extra-vars', 'mode: updated\npassword: CANARY-graph-edit\n', '--limit', 'synthetic-host', '--confirm'])
      await run(['workflow', 'node-create', '42', '--template', '8', '--confirm'])
      await run(['workflow', 'node-add-approval', '43', '--name', 'Synthetic approval', '--description', 'Review synthetic targets', '--timeout', '300', '--confirm'])
      await run(['credential', 'create', 'Synthetic node credential', '--credential-type', '7', '--confirm'])
      await run(['workflow', 'node-credential-add', '42', '--credential', '42', '--confirm'])
      for (const on of ['success', 'failure', 'always']) await run(['workflow', 'node-link', '42', '--to', '43', '--on', on, '--confirm'])
      allowWrites = false
      expect(await run(['workflow', 'template-nodes', '42'])).toMatchObject({ workflow_template_nodes: [
        { id: 42, unified_job_template: '8', inventory: '7', success_nodes: '43', failure_nodes: '43', always_nodes: '43' },
        { id: 43, approval: '70 (Synthetic approval)', approval_timeout: 300 },
      ] })
      expect(await run(['workflow', 'template-node', '42'])).toMatchObject({ workflow_template_node: {
        workflow_template: '42', extra_data: { mode: 'updated', password: '***' }, limit: 'synthetic-host',
        credentials: [{ id: 42, name: 'Synthetic node credential' }], credentials_total: 1,
        success_nodes: [{ id: 43 }], failure_nodes: [{ id: 43 }], always_nodes: [{ id: 43 }],
      } })
      allowWrites = true
      for (const on of ['success', 'failure', 'always']) await run(['workflow', 'node-unlink', '42', '--to', '43', '--on', on, '--confirm'])
      await run(['workflow', 'node-credential-remove', '42', '--credential', '42', '--confirm'])
      allowWrites = false
      expect(await run(['workflow', 'template-node', '42'])).toMatchObject({ workflow_template_node: {
        credentials: [], credentials_total: 0, success_nodes: [], failure_nodes: [], always_nodes: [],
      } })
      allowWrites = true
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await request(['workflow', 'node-create', '42', '--template', '8', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi workflow template-nodes 42') } })
      allowWrites = false
      expect(await run(['workflow', 'template-nodes', '42'])).toMatchObject({ workflow_template_nodes: [
        { id: 42 }, { id: 43 }, { id: 44, unified_job_template: '8' },
      ] })
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX schedule edits preserve controller timing and reconcile interrupted changes with writes disabled (S7)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
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
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    const run = async (args: string[]) => {
      const response = await request(args)
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    const timing = { timezone: 'UTC', dtstart: '2027-01-01T00:00:00Z', dtend: null, next_run: '2027-01-02T00:00:00Z',
      preview: 'zone UTC: DTSTART:20270101T000000Z RRULE:FREQ=DAILY' }
    try {
      await run(['schedule', 'create', 'Synthetic daily', '--template', '7', '--rrule', 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY',
        '--extra-vars', 'mode: initial\npassword: CANARY-schedule-create\n', '--enabled', '--confirm'])
      allowWrites = false
      expect(await run(['schedule', 'show', 'Synthetic daily'])).toMatchObject({ schedule: { ...timing, enabled: 'enabled' } })
      allowWrites = true
      expect(await run(['schedule', 'edit', '42', '--disabled', '--dry-run'])).toMatchObject({ dry_run: { payload: { enabled: false } } })
      expect(await run(['schedule', 'show', '42'])).toMatchObject({ schedule: { ...timing, enabled: 'enabled' } })
      await run(['schedule', 'edit', '42', '--disabled', '--extra-vars', '{"mode":"updated","password":"CANARY-schedule-edit"}', '--confirm'])
      allowWrites = false
      expect(await run(['schedule', 'show', '42'])).toMatchObject({ schedule: { ...timing, enabled: 'disabled' } })
      expect(await run(['schedule', 'list'])).toMatchObject({ schedules: [{ id: 42, name: 'Synthetic daily', enabled: 'disabled', next_run: timing.next_run }] })
      allowWrites = true
      const rejected = await request(['schedule', 'edit', '42', '--template', '8', '--extra-vars', '{"mode":"rejected"}', '--confirm'])
      expect(rejected.json(), rejected.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('LAUNCH_WOULD_IGNORE_INPUT') })
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await request(['schedule', 'edit', '42', '--name', 'Synthetic renamed', '--enabled', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi schedule list --limit 100') } })
      allowWrites = false
      expect(await run(['schedule', 'list'])).toMatchObject({ schedules: [{ id: 42, name: 'Synthetic renamed', enabled: 'enabled', next_run: timing.next_run }] })
      expect(await run(['schedule', 'show', 'Synthetic renamed'])).toMatchObject({ schedule: { ...timing, enabled: 'enabled' } })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests.filter((entry: { method: string }) => entry.method !== 'GET')).toEqual([
        expect.objectContaining({ path: '/api/v2/schedules/', body: { name: 'Synthetic daily', unified_job_template: 7,
          rrule: 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY', enabled: true, extra_data: { mode: 'initial', password: 'CANARY-schedule-create' } } }),
        expect.objectContaining({ path: '/api/v2/schedules/42/', body: { enabled: false, extra_data: { mode: 'updated', password: 'CANARY-schedule-edit' } } }),
        expect.objectContaining({ path: '/api/v2/schedules/42/', body: { name: 'Synthetic renamed', enabled: true } }),
      ])
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)
configurationTests(['workflow'])
