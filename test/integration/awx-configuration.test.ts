import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
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
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

const configurationCases: { args: string[], path: string, body: unknown, input?: RunInput, unconfirmed?: Record<string, unknown>, preview?: unknown, privateValue?: string }[] = [
  { args: ['organization', 'edit', '42', '--name', 'Synthetic organization', '--description', 'Synthetic automation', '--max-hosts', '0', '--default-environment', '7'],
    path: 'organizations/42/', body: { name: 'Synthetic organization', description: 'Synthetic automation', max_hosts: 0, default_environment: 7 } },
  { args: ['organization', 'user-remove', '42', '--user', '7'], path: 'organizations/42/users/', body: { id: 7, disassociate: true } },
  { args: ['user', 'create', 'synthetic-person', '--password-file', '-'], path: 'users/', body: { username: 'synthetic-person', password: 'CANARY-user-password' },
    input: { stdin: 'CANARY-user-password\n' } },
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', '{"ansible_password":12345678}'],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: '{"ansible_password":12345678}' }, privateValue: '12345678',
    preview: { dry_run: { payload: '[structured input redacted, 29 bytes]' }, input: { variables: '[structured input redacted, 29 bytes]' } } },
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', 'variables.yml'],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: 'common: &pw CANARY-alias\nansible_password: *pw\n' }, privateValue: 'CANARY-alias',
    input: { files: [upload('variables.yml', 'common: &pw CANARY-alias\nansible_password: *pw\n')] },
    preview: { dry_run: { payload: '[structured input redacted, 47 bytes]' }, input: { variables: '[structured input redacted, 47 bytes]' } } },
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', '{"mode":"[redacted]"}'],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: '{"mode":"[redacted]"}' },
    preview: { dry_run: { action: 'create', type: 'host', would_send: 'POST hosts/', payload: '[structured input redacted, 21 bytes]' },
      help: ['Re-run with --confirm to create'] } },
  { args: ['credential', 'create', 'Synthetic credential', '--credential-type', '7', '--inputs-file', 'credential.json'], path: 'credentials/',
    body: { name: 'Synthetic credential', credential_type: 7, inputs: { ssh_key_data: 'CANARY-private-key\nsecond-line' } },
    input: { files: [upload('credential.json', '{"ssh_key_data":"CANARY-private-key\\nsecond-line"}')] } },
  { args: ['credential', 'copy', '42', '--name', 'Synthetic copied credential'], path: 'credentials/42/copy/',
    body: { name: 'Synthetic copied credential' } },
  { args: ['job', 'launch', '43', '--credential-passwords-file', 'passwords.json'], path: 'job_templates/43/launch/',
    unconfirmed: { exitCode: 0 },
    body: { credential_passwords: { ssh_password: 'CANARY-launch-password' } },
    input: { files: [upload('passwords.json', '{"ssh_password":"CANARY-launch-password"}')] } },
  { args: ['notification-template', 'create', 'Synthetic notification', '--organization', '7', '--notification-type', 'webhook',
      '--description', 'Synthetic webhook', '--configuration-file', 'configuration.json', '--messages-file', 'messages.json'],
    path: 'notification_templates/',
    body: { name: 'Synthetic notification', organization: 7, notification_type: 'webhook', description: 'Synthetic webhook',
      notification_configuration: { token: 'CANARY-notification-token' }, messages: { success: { body: 'CANARY-notification-message' } } },
    input: { files: [upload('configuration.json', '{"token":"CANARY-notification-token"}'),
      upload('messages.json', '{"success":{"body":"CANARY-notification-message"}}')] },
    preview: { input: { notification_configuration: '[structured input redacted, 37 bytes]', messages: '[structured input redacted, 50 bytes]' } } },
  { args: ['workflow', 'node-create', '42', '--template', '8', '--inventory', '7', '--extra-vars', 'node.json',
      '--limit', 'synthetic-host', '--scm-branch', 'synthetic', '--job-type', 'check', '--job-tags', 'connectivity', '--skip-tags', 'updates', '--verbosity', '2'],
    path: 'workflow_job_templates/42/workflow_nodes/',
    body: { unified_job_template: 8, inventory: 7, extra_data: { mode: 'synthetic', password: 'CANARY-node-variable' },
      limit: 'synthetic-host', scm_branch: 'synthetic', job_type: 'check', job_tags: 'connectivity', skip_tags: 'updates', verbosity: 2 },
    input: { files: [upload('node.json', '{"mode":"synthetic","password":"CANARY-node-variable"}')] },
    preview: { input: { extra_data: '[structured input redacted, 54 bytes]' } } },
  { args: ['project', 'create', 'Synthetic SCM project', '--organization', '7', '--scm-type', 'git', '--scm-url', 'scm.txt',
      '--scm-branch', 'synthetic-branch', '--credential', '9'],
    path: 'projects/',
    body: { name: 'Synthetic SCM project', organization: 7, scm_type: 'git', scm_url: 'https://scm.example/repo?ref=main',
      scm_branch: 'synthetic-branch', credential: 9 },
    input: { files: [upload('scm.txt', 'https://scm.example/repo?ref=main')] },
    preview: { dry_run: { payload: { organization: 7, scm_type: 'git', scm_branch: 'synthetic-branch', credential: 9,
      scm_url: '[SCM URL redacted]' } } } },
]

test('AWX enabling writes in one tenant does not grant another tenant write access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-awx-tenants-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const tenants = await Promise.all(['first', 'second'].map(async name => {
    const db = openStore(join(directory, name, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec('UPDATE users SET administrator = 1')
    const store = createCredentialStore(db, provider)
    const reference = store.replaceCredential('awx-axi', { origin: 'https://controller.example', token: 'CANARY-awx-token' },
      0, 'synthetic-development-user', Date.now())
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}),
      runner: await Runner.create(join(directory, name, 'calls')), adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    return { db, app, adapter, reference, store }
  }))
  try {
    const [first, second] = tenants
    const login = await first.app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
      username: 'synthetic-user', password: 'CANARY-local-password' } })
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const reauth = await first.app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const grant = await first.app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { enabled: true, expectedRevision: 1 } })
    expect(grant.json(), grant.body).toMatchObject({ writeAccess: { enabled: true } })
    first.reference = first.store.findCredential('awx-axi')!
    for (const args of [['job', 'cancel', '42', '--confirm'], ['inventory', 'edit', '42', '--name', 'Synthetic', '--confirm'],
      ['organization', 'admin-add', '42', '--user', '7', '--confirm'], ['team', 'user-add', '42', '--user', '7', '--confirm'],
      ['user', 'edit', '42', '--is-superuser', '--confirm'], ['role', 'grant', '42', '--team', '7', '--confirm'],
      ['user', 'token-revoke', '7', '--confirm']]) {
      expect((await first.adapter.prepare(args, first.reference)).effect).toBe('write')
      await expect(second.adapter.prepare(args, second.reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
    }
    expect((await second.adapter.prepare(['job', 'list'], second.reference)).effect).toBe('read')
    expect((await first.adapter.prepare(['job', 'list'], first.reference)).effect).toBe('read')
  } finally {
    for (const { app, db } of tenants) { await app.close(); db.close() }
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(configurationCases)('AWX configuration authority gates $args through the public run API', async ({ args, path, body, input = {}, unconfirmed = { error: { code: 'FLAG_BLOCKED' } }, preview: expectedPreview, privateValue = 'CANARY-' }) => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        const args = [...call.args]
        args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return { ...call, args }
      }
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 1) }
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
      const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      await settings({})
      await send('/__ado/reset', 'POST')
      expect((await run([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await run([...args, '--dry-run'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
      await settings({ allowWrites: true })
      await send('/__ado/reset', 'POST')
      expect((await run(args)).json()).toMatchObject(unconfirmed)
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      const preview = await run([...args, '--dry-run'])
      expect(preview.json(), preview.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('dry_run') })
      if (expectedPreview) expect(decode(preview.json().stdout)).toMatchObject(expectedPreview)
      expect(preview.body).not.toContain(privateValue)
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=false', 'POST')
      const denied = await run([...args, '--confirm'])
      expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
      expect(denied.body).not.toContain(privateValue)
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
      expect(JSON.stringify(audit)).not.toContain('CANARY-')
      expect(written.body).not.toContain(privateValue)
      expect(written.body).not.toContain('CANARY-awx-token')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)
