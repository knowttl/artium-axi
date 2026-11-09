import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
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
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import type { RunInput } from '../../src/shared/api.js'

const upload = (name: string, content: string) => ({ name, size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') })

test.each(['module-args', 'args'].flatMap(flag => ['inline', 'upload'].map(channel => ({ flag, channel }))))(
  'AWX --$flag $channel arguments stay private in previews and confirmed responses (R6)', async ({ flag, channel }) => {
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
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
      const lines: string[] = []
      const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
        resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
      const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
      const content = 'url=https://synthetic.invalid url_password=CANARY-module-password'
      const args = ['ad-hoc', 'launch', '7', '--module-name', 'uri', `--${flag}`, channel === 'inline' ? content : 'args.txt']
      const input = channel === 'upload' ? { files: [upload('args.txt', content)] } : {}
      try {
        const preview = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers,
          payload: { args: [...args, '--dry-run'], ...input } })
        expect(preview.json(), preview.body).toMatchObject({ exitCode: 0 })
        expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { module_args: '[structured input redacted, 65 bytes]' } })
        expect(preview.body).not.toContain('CANARY-')
        expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
        const written = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers,
          payload: { args: [...args, '--confirm'], ...input } })
        expect(written.json(), written.body).toMatchObject({ exitCode: 0 })
        expect(written.body).not.toContain('CANARY-')
        expect(JSON.parse(await send('/__evidence'))).toMatchObject({ mutations: 1, requests: [{
          method: 'POST', path: '/api/v2/ad_hoc_commands/', canaryReceived: true, body: { module_args: content },
        }] })
        const call = await adapter.prepare([...args, '--confirm'], reference, input)
        expect(call.args.join(' ')).not.toContain('CANARY-')
        expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
        expect(readdirSync(join(directory, 'calls'))).toEqual([])
      } finally { await app.close(); db.close() }
    })
  }, 60_000,
)

test('AWX protocol metadata survives structured values through completion and uncertain writes (R3)', async () => {
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
      if (call.executable === process.execPath) {
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    try {
      const launched = await run(['ad-hoc', 'launch', '7', '--extra-vars', '{"mode":"pending"}', '--confirm'])
      expect(launched.json(), launched.body).toMatchObject({ exitCode: 0 })
      expect(decode(launched.json().stdout)).toMatchObject({ ad_hoc_command: { status: 'pending' } })
      await send('/__ado/reset', 'POST')
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await run(['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', '{"mode":"A"}', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi host list --limit 100') } })
      expect(JSON.parse(await send('/__evidence'))).toMatchObject({ mutations: 1,
        requests: [{ method: 'POST', path: '/api/v2/hosts/', body: { name: 'synthetic', inventory: 7, variables: '{"mode":"A"}' } }] })
      const recovered = await run(['host', 'list', '--limit', '100'])
      expect(recovered.json(), recovered.body).toMatchObject({ exitCode: 0 })
      expect(decode(recovered.json().stdout)).toMatchObject({ hosts: [{ id: 42, name: 'synthetic' }] })
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test.each([
  { flag: 'variables', args: ['inventory', 'host-create', 'synthetic', '--inventory', '7'], trailing: ['--description', 'placeholder'],
    path: '/api/v2/hosts/', field: 'variables', exitCode: 0 },
  { flag: 'source-vars', args: ['inventory', 'source-create', 'synthetic', '--inventory', '7'], trailing: ['--source', 'scm'],
    path: '/api/v2/inventory_sources/', field: 'source_vars', exitCode: 2 },
  { flag: 'extra-vars', args: ['ad-hoc', 'launch', '7', '--module-name', 'command'], trailing: ['--verbosity', '0'],
    path: '/api/v2/ad_hoc_commands/', field: 'extra_vars', exitCode: 0 },
  { flag: 'module-args', args: ['ad-hoc', 'launch', '7', '--module-name', 'command'], trailing: ['--verbosity', '0'],
    path: '/api/v2/ad_hoc_commands/', field: 'module_args', exitCode: 0 },
  { flag: 'args', args: ['ad-hoc', 'launch', '7', '--module-name', 'command'], trailing: ['--verbosity', '0'],
    path: '/api/v2/ad_hoc_commands/', field: 'module_args', exitCode: 0 },
].flatMap(route => ['inline', 'separate', 'upload'].map(channel => ({ ...route, channel }))))(
  'AWX structured --$flag $channel input cannot redirect the managed token (R2)',
  async ({ flag, args, trailing, path, field, exitCode, channel }) => {
    await withFakeService(async controller => {
      await withFakeService(async receiver => {
        const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
        const db = openStore(join(controller.directory, 'artium.db'), provider)
        await seedToolUser(db)
        db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
        const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
        const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${controller.port}`,
          token: 'CANARY-awx-token', allowWrites: true }) })
        const prepare = adapter.prepare.bind(adapter)
        adapter.prepare = async (...input) => {
          const call = await prepare(...input)
          call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
          return call
        }
        const runner = await Runner.create(join(controller.directory, 'calls'), {
          pem: [controller, receiver].map(service => readFileSync(join(service.directory, 'ca.crt'), 'utf8')).join('\n'), certificates: [],
        })
        const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
          resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
        try {
          const value = `--origin=https://localhost:${receiver.port}`
          const request = { args: [...args, ...(channel === 'separate' ? [`--${flag}`, value]
            : [`--${flag}=${channel === 'upload' ? 'input.txt' : value}`]), ...trailing, '--confirm'],
            ...(channel === 'upload' ? { files: [upload('input.txt', value)] } : {}) }
          const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', payload: request,
            headers: { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` } })
          expect(JSON.parse(await receiver.send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
          expect(response.json(), response.body).toMatchObject({ exitCode })
          const evidence = JSON.parse(await controller.send('/__evidence'))
          expect(evidence.mutations).toBe(exitCode === 0 ? 1 : 0)
          if (exitCode === 0) expect(evidence.requests).toContainEqual(expect.objectContaining({
            method: 'POST', path, canaryReceived: true, body: expect.objectContaining({ [field]: value }),
          }))
          const call = await adapter.prepare(request.args, reference, request)
          expect(call.args).toContain(`--${flag}=private-input`)
          expect(call.args.join(' ')).not.toContain(value)
          expect(response.body).not.toContain('CANARY-awx-token')
        } finally { await app.close(); db.close() }
      })
    })
  }, 60_000,
)

const configurationCases: { args: string[], path: string, body: unknown, input?: RunInput, unconfirmed?: Record<string, unknown>, preview?: unknown, privateValue?: string }[] = [
  ...['create', 'edit'].map(operation => ({
    args: ['organization', operation, ...(operation === 'create' ? [] : ['42']), '--name', 'Synthetic organization',
      '--description', 'Synthetic automation', '--max-hosts', '0', '--default-environment', '7'],
    path: operation === 'create' ? 'organizations/' : 'organizations/42/',
    body: { name: 'Synthetic organization', description: 'Synthetic automation', max_hosts: 0, default_environment: 7 },
  })),
  ...['add', 'remove'].flatMap(operation => [
    ...[
      { kind: 'user', flag: 'user', route: 'users' }, { kind: 'admin', flag: 'user', route: 'admins' },
      { kind: 'team', flag: 'team', route: 'teams' },
      { kind: 'galaxy-credential', flag: 'credential', route: 'galaxy_credentials' },
      { kind: 'instance-group', flag: 'instance-group', route: 'instance_groups' },
      { kind: 'execution-environment', flag: 'execution-environment', route: 'execution_environments' },
      { kind: 'notification-template', flag: 'notification-template', route: 'notification_templates' },
    ].map(({ kind, flag, route }) => ({
      args: ['organization', `${kind}-${operation}`, '42', `--${flag}`, '7'],
      path: `organizations/42/${route}/`, body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
    ...['started', 'success', 'error'].map(event => ({
      args: ['organization', `notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
      path: `organizations/42/notification_templates_${event}/`, body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
    { args: ['team', `user-${operation}`, '42', '--user', '7'], path: 'teams/42/users/',
      body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) } },
  ]),
  ...['create', 'edit'].map(operation => ({
    args: ['team', operation, ...(operation === 'create' ? [] : ['42']), '--name', 'Synthetic team',
      '--organization', '7', '--description', 'Synthetic operators'],
    path: operation === 'create' ? 'teams/' : 'teams/42/',
    body: { name: 'Synthetic team', organization: 7, description: 'Synthetic operators' },
  })),
  ...[
    { flag: 'is-superuser', field: 'is_superuser', value: true },
    { flag: 'is-system-auditor', field: 'is_system_auditor', value: true },
    { flag: 'no-superuser', field: 'is_superuser', value: false },
    { flag: 'no-system-auditor', field: 'is_system_auditor', value: false },
  ].flatMap(({ flag, field, value }) => (value ? ['create', 'edit'] : ['edit']).map(operation => ({
    args: ['user', operation, ...(operation === 'create' ? [] : ['42']), '--username', 'synthetic-person',
      '--first-name', 'Synthetic', '--last-name', 'Person', '--email', 'synthetic@example.test', `--${flag}`],
    path: operation === 'create' ? 'users/' : 'users/42/',
    body: { username: 'synthetic-person', first_name: 'Synthetic', last_name: 'Person', email: 'synthetic@example.test', [field]: value },
  }))),
  ...['create', 'edit'].flatMap(operation => ['file', 'stdin'].map(channel => ({
    args: ['user', operation, operation === 'create' ? 'synthetic-person' : '42', '--password-file', channel === 'stdin' ? '-' : 'password.txt'],
    path: operation === 'create' ? 'users/' : 'users/42/',
    body: { ...(operation === 'create' ? { username: 'synthetic-person' } : {}), password: 'CANARY-user-private-password' },
    input: channel === 'stdin' ? { stdin: 'CANARY-user-private-password\n' } : { files: [upload('password.txt', 'CANARY-user-private-password\n')] },
  }))),
  ...['grant', 'revoke'].flatMap(operation => ['user', 'team'].map(subject => ({
    args: ['role', operation, '42', `--${subject}`, '7'], path: `roles/42/${subject}s/`,
    body: { id: 7, ...(operation === 'revoke' ? { disassociate: true } : {}) },
  }))),
  ...[
    { content: '{"ansible_password":12345678}', bytes: 29, privateValue: '12345678' },
    { content: 'common: &pw CANARY-alias\nansible_password: *pw\n', bytes: 47, privateValue: 'CANARY-alias' },
  ].flatMap(({ content, bytes, privateValue }) => ['inline', 'upload'].map(channel => ({
    args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', channel === 'inline' ? content : 'variables.yml'],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: content }, privateValue,
    input: channel === 'upload' ? { files: [upload('variables.yml', content)] } : {},
    preview: { dry_run: { payload: `[structured input redacted, ${bytes} bytes]` }, input: { variables: `[structured input redacted, ${bytes} bytes]` } },
  }))),
  ...['run', 'a', 'A', 'pending', 'create', 'CONTROLLER_UNREACHABLE', '[redacted]', 'dry_run'].map(value => ({
    args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', JSON.stringify({ mode: value })],
    path: 'hosts/', body: { name: 'synthetic', inventory: 7, variables: JSON.stringify({ mode: value }) },
    preview: { dry_run: { action: 'create', type: 'host', would_send: 'POST hosts/', payload: `[structured input redacted, ${Buffer.byteLength(JSON.stringify({ mode: value }))} bytes]` },
      help: ['Re-run with --confirm to create'] },
  })),
  { args: ['inventory', 'host-create', 'synthetic', '--inventory', '7', '--variables', 'variables.json'], path: 'hosts/',
    body: { name: 'synthetic', inventory: 7, variables: '{"env":"a"}' },
    input: { files: [upload('variables.json', '{"env":"a"}')] } },
  { args: ['credential', 'edit', '42', '--inputs-file', '-'], path: 'credentials/42/', body: { inputs: { password: 'a' } },
    input: { stdin: '{"password":"a"}' } },
  { args: ['team', 'credential-create', '7', '--name', 'Synthetic team credential', '--credential-type', '7', '--inputs-file', 'team.json'], path: 'teams/7/credentials/',
    body: { name: 'Synthetic team credential', credential_type: 7, inputs: { password: 'CANARY-team-password' } },
    input: { files: [upload('team.json', '{"password":"CANARY-team-password"}')] } },
  { args: ['job', 'launch', '43', '--credential-passwords-file', 'passwords.json'], path: 'job_templates/43/launch/',
    unconfirmed: { exitCode: 0 },
    body: { credential_passwords: { ssh_password: 'CANARY-launch-password' } },
    input: { files: [upload('passwords.json', '{"ssh_password":"CANARY-launch-password"}')] } },
  { args: ['credential', 'create', 'Synthetic credential', '--credential-type', '7', '--inputs-file', 'credential.json'], path: 'credentials/',
    body: { name: 'Synthetic credential', credential_type: 7, inputs: { ssh_key_data: 'CANARY-private-key\nsecond-line' } },
    input: { files: [upload('credential.json', '{"ssh_key_data":"CANARY-private-key\\nsecond-line"}')] } },
  { args: ['credential', 'edit', '42', '--inputs-file', '-'], path: 'credentials/42/', body: { inputs: { password: 'CANARY-credential-stdin' } },
    input: { stdin: '{"password":"CANARY-credential-stdin"}' } },
  { args: ['credential', 'create', 'Synthetic stdin credential', '--credential-type', '7', '--inputs-file', '-'], path: 'credentials/',
    body: { name: 'Synthetic stdin credential', credential_type: 7, inputs: { password: 'CANARY-create-stdin' } },
    input: { stdin: '{"password":"CANARY-create-stdin"}' } },
  { args: ['credential', 'edit', '42', '--inputs-file', 'machine.json'], path: 'credentials/42/',
    body: { inputs: { ssh_key_data: 'CANARY-edit-key\nsecond-line', password: 'CANARY-edit-password' } },
    input: { files: [upload('machine.json', '{"ssh_key_data":"CANARY-edit-key\\nsecond-line","password":"CANARY-edit-password"}')] } },
  { args: ['credential', 'copy', '42', '--name', 'Synthetic copied credential'], path: 'credentials/42/copy/',
    body: { name: 'Synthetic copied credential' } },
  { args: ['user', 'create', 'synthetic-person', '--password-file', '-'], path: 'users/', body: { username: 'synthetic-person', password: 'CANARY-user-password' },
    input: { stdin: 'CANARY-user-password\n' } },
  ...['create', 'edit'].flatMap(operation => ['configuration-file', 'config-file'].map(flag => ({
    args: ['notification-template', operation, operation === 'create' ? 'Synthetic notification' : '42',
      ...(operation === 'edit' ? ['--name', 'Synthetic notification'] : []), '--organization', '7', '--notification-type', 'webhook',
      '--description', 'Synthetic webhook', `--${flag}`, 'configuration.json', '--messages-file', 'messages.json'],
    path: operation === 'create' ? 'notification_templates/' : 'notification_templates/42/',
    body: { name: 'Synthetic notification', organization: 7, notification_type: 'webhook', description: 'Synthetic webhook',
      notification_configuration: { token: 'CANARY-notification-token' }, messages: { success: { body: 'CANARY-notification-message' } } },
    input: { files: [upload('configuration.json', '{"token":"CANARY-notification-token"}'),
      upload('messages.json', '{"success":{"body":"CANARY-notification-message"}}')] },
    preview: { input: { notification_configuration: '[structured input redacted, 37 bytes]', messages: '[structured input redacted, 50 bytes]' } },
  }))),
  { args: ['inventory', 'host-bulk-create', '--inventory', '7', '--hosts-file', 'hosts.json'], path: 'bulk/host_create/',
    body: { inventory: 7, hosts: [{ name: 'synthetic-bulk-host', variables: '{"password":"CANARY-bulk-secret"}' }] },
    input: { files: [upload('hosts.json', JSON.stringify([{ name: 'synthetic-bulk-host', variables: '{"password":"CANARY-bulk-secret"}' }]))] } },
  { args: ['inventory', 'host-create', 'synthetic-json-host', '--inventory', '7', '--variables', '{"password":"CANARY-json-variable"}'], path: 'hosts/',
    body: { name: 'synthetic-json-host', inventory: 7, variables: '{"password":"CANARY-json-variable"}' } },
  { args: ['inventory', 'host-create', 'synthetic-yaml-host', '--inventory', '7', '--variables', 'variables.yml'], path: 'hosts/',
    body: { name: 'synthetic-yaml-host', inventory: 7, variables: 'password: CANARY-yaml-variable\n' },
    input: { files: [upload('variables.yml', 'password: CANARY-yaml-variable\n')] } },
  { args: ['inventory', 'create', 'Synthetic inventory', '--organization', '7'], path: 'inventories/', body: { name: 'Synthetic inventory', organization: 7 } },
  { args: ['inventory', 'edit', '42', '--name', 'Updated inventory'], path: 'inventories/42/', body: { name: 'Updated inventory' } },
  ...['create', 'edit'].map(verb => ({
    args: ['inventory', verb, verb === 'create' ? 'Synthetic inventory' : '42', ...(verb === 'create' ? ['--organization', '7'] : []), '--variables', 'inventory.yml'],
    path: verb === 'create' ? 'inventories/' : 'inventories/42/',
    body: { ...(verb === 'create' ? { name: 'Synthetic inventory', organization: 7 } : {}), variables: 'mode: synthetic\npassword: CANARY-inventory-variable\n' },
    input: { files: [upload('inventory.yml', 'mode: synthetic\npassword: CANARY-inventory-variable\n')] },
  })),
  { args: ['inventory', 'host-create', 'synthetic-host', '--inventory', '7'], path: 'hosts/', body: { name: 'synthetic-host', inventory: 7 } },
  { args: ['inventory', 'host-edit', '42', '--name', 'updated-host'], path: 'hosts/42/', body: { name: 'updated-host' } },
  { args: ['inventory', 'host-edit', '42', '--variables', 'variables.json'], path: 'hosts/42/',
    body: { variables: '{"ansible_password":"CANARY-host-edit"}' },
    input: { files: [upload('variables.json', '{"ansible_password":"CANARY-host-edit"}')] } },
  { args: ['inventory', 'group-create', 'Synthetic group', '--inventory', '7'], path: 'inventories/7/groups/', body: { name: 'Synthetic group' } },
  { args: ['inventory', 'group-edit', '42', '--name', 'Updated group'], path: 'groups/42/', body: { name: 'Updated group' } },
  { args: ['inventory', 'group-create', 'Synthetic group', '--inventory', '7', '--variables', '{"ansible_password":"CANARY-group-create"}'],
    path: 'inventories/7/groups/', body: { name: 'Synthetic group', variables: '{"ansible_password":"CANARY-group-create"}' } },
  { args: ['inventory', 'group-edit', '42', '--variables', 'variables.yml'], path: 'groups/42/',
    body: { variables: 'ansible_password: CANARY-group-edit\n' },
    input: { files: [upload('variables.yml', 'ansible_password: CANARY-group-edit\n')] } },
  ...['host', 'child'].flatMap(kind => ['add', 'remove'].map(operation => ({
    args: ['inventory', `group-${operation}-${kind}`, '42', `--${kind}`, '43'],
    path: `groups/42/${kind === 'host' ? 'hosts' : 'children'}/`,
    body: { id: 43, ...(operation === 'remove' ? { disassociate: true } : {}) },
  }))),
  { args: ['inventory', 'source-create', 'Synthetic source', '--inventory', '7', '--source', 'scm'], path: 'inventory_sources/', body: { name: 'Synthetic source', inventory: 7, source: 'scm' } },
  { args: ['inventory', 'source-create', 'Synthetic source', '--inventory', '7', '--source', 'scm', '--source-vars', '{"region":"synthetic-region"}'],
    path: 'inventory_sources/', body: { name: 'Synthetic source', inventory: 7, source: 'scm', source_vars: '{"region":"synthetic-region"}' } },
  { args: ['inventory', 'source-edit', '42', '--name', 'Updated source'], path: 'inventory_sources/42/', body: { name: 'Updated source' } },
  ...['create', 'edit'].flatMap(verb => ['inline', 'upload'].map(channel => ({
    args: ['inventory', `source-${verb}`, verb === 'create' ? 'Synthetic source' : '42', ...(verb === 'create' ? ['--inventory', '7'] : []),
      '--source', 'scm', '--source-project', '8', '--credential', '9', '--source-vars', channel === 'inline' ? '{"password":"CANARY-source-variable"}' : 'source.json',
      verb === 'create' ? '--update-on-launch' : '--no-update-on-launch'],
    path: verb === 'create' ? 'inventory_sources/' : 'inventory_sources/42/',
    body: { ...(verb === 'create' ? { name: 'Synthetic source', inventory: 7 } : {}), source: 'scm', source_project: 8, credential: 9,
      source_vars: '{"password":"CANARY-source-variable"}', update_on_launch: verb === 'create' },
    input: channel === 'upload' ? { files: [upload('source.json', '{"password":"CANARY-source-variable"}')] } : {},
  }))),
  ...['add', 'remove'].flatMap(operation => [
    { args: ['inventory', `source-credential-${operation}`, '42', '--credential', '9'], path: 'inventory_sources/42/credentials/',
      body: { id: 9, ...(operation === 'remove' ? { disassociate: true } : {}) } },
    ...['started', 'success', 'error'].map(event => ({
      args: ['inventory', `source-notification-${operation}`, '42', '--event', event, '--notification-template', '10'],
      path: `inventory_sources/42/notification_templates_${event}/`, body: { id: 10, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
  ]),
  { args: ['template', 'create', 'Synthetic template', '--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml'], path: 'job_templates/', body: { name: 'Synthetic template', inventory: 7, project: 8, playbook: 'synthetic.yml' } },
  { args: ['template', 'edit', '42', '--name', 'Updated template'], path: 'job_templates/42/', body: { name: 'Updated template' } },
  ...['template', 'workflow'].flatMap(noun => ['create', 'edit'].flatMap(verb => ['inline', 'upload'].map(channel => ({
    args: [noun, verb, verb === 'create' ? 'Synthetic automation' : '42',
      ...(verb === 'create' ? noun === 'template' ? ['--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml'] : ['--organization', '7'] : []),
      '--extra-vars', channel === 'inline' ? 'mode: synthetic\npassword: CANARY-template-variable\n' : 'template.yml'],
    path: `${noun === 'template' ? 'job_templates' : 'workflow_job_templates'}/${verb === 'create' ? '' : '42/'}`,
    body: { ...(verb === 'create' ? { name: 'Synthetic automation', ...(noun === 'template'
      ? { inventory: 7, project: 8, playbook: 'synthetic.yml' } : { organization: 7 }) } : {}),
      extra_vars: '{"mode":"synthetic","password":"CANARY-template-variable"}' },
    input: channel === 'upload' ? { files: [upload('template.yml', 'mode: synthetic\npassword: CANARY-template-variable\n')] } : {},
  })))),
  ...['create', 'edit'].map(verb => ({
    args: ['workflow', `node-${verb}`, '42', '--template', '8', '--inventory', '7', '--extra-vars', 'node.json',
      '--limit', 'synthetic-host', '--scm-branch', 'synthetic', '--job-type', 'check', '--job-tags', 'connectivity', '--skip-tags', 'updates', '--verbosity', '2'],
    path: verb === 'create' ? 'workflow_job_templates/42/workflow_nodes/' : 'workflow_job_template_nodes/42/',
    body: { unified_job_template: 8, inventory: 7, extra_data: { mode: 'synthetic', password: 'CANARY-node-variable' },
      limit: 'synthetic-host', scm_branch: 'synthetic', job_type: 'check', job_tags: 'connectivity', skip_tags: 'updates', verbosity: 2 },
    input: { files: [upload('node.json', '{"mode":"synthetic","password":"CANARY-node-variable"}')] },
    preview: { input: { extra_data: '[structured input redacted, 54 bytes]' } },
  })),
  ...['template', 'workflow'].flatMap(noun => ['add', 'remove'].flatMap(operation => [
    ...['label', ...(noun === 'template' ? ['credential', 'instance-group'] : [])].map(kind => ({
      args: [noun, `${kind}-${operation}`, '42', `--${kind}`, '7'],
      path: `${noun === 'template' ? 'job_templates' : 'workflow_job_templates'}/42/${kind.replaceAll('-', '_')}s/`,
      body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
    ...['started', 'success', 'error', ...(noun === 'workflow' ? ['approval'] : [])].map(event => ({
      args: [noun, `notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
      path: `${noun === 'template' ? 'job_templates' : 'workflow_job_templates'}/42/notification_templates_${event === 'approval' ? 'approvals' : event}/`,
      body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
    })),
  ])),
  ...['add', 'remove'].flatMap(operation => ['credential', 'label', 'instance-group'].map(kind => ({
    args: ['workflow', `node-${kind}-${operation}`, '42', `--${kind}`, '7'],
    path: `workflow_job_template_nodes/42/${kind.replaceAll('-', '_')}s/`,
    body: { id: 7, ...(operation === 'remove' ? { disassociate: true } : {}) },
  }))),
  ...['success', 'failure', 'always'].flatMap(on => ['link', 'unlink'].map(operation => ({
    args: ['workflow', `node-${operation}`, '42', '--to', '43', '--on', on],
    path: `workflow_job_template_nodes/42/${on}_nodes/`, body: { id: 43, ...(operation === 'unlink' ? { disassociate: true } : {}) },
  }))),
  { args: ['project', 'create', 'Synthetic project', '--organization', '7'], path: 'projects/', body: { name: 'Synthetic project', organization: 7 } },
  { args: ['project', 'edit', '42', '--name', 'Updated project'], path: 'projects/42/', body: { name: 'Updated project' } },
  ...['create', 'edit'].flatMap(verb => ['inline', 'upload'].map(channel => ({
    args: ['project', verb, verb === 'create' ? 'Synthetic SCM project' : '42', '--organization', '7',
      '--scm-type', 'git', '--scm-url', channel === 'inline' ? 'https://scm.example/repo?ref=main' : 'scm.txt',
      '--scm-branch', 'synthetic-branch', '--credential', '9'],
    path: verb === 'create' ? 'projects/' : 'projects/42/',
    body: { ...(verb === 'create' ? { name: 'Synthetic SCM project' } : {}), organization: 7, scm_type: 'git',
      scm_url: 'https://scm.example/repo?ref=main', scm_branch: 'synthetic-branch', credential: 9 },
    input: channel === 'upload' ? { files: [upload('scm.txt', 'https://scm.example/repo?ref=main')] } : {},
    preview: { dry_run: { payload: { organization: 7, scm_type: 'git', scm_branch: 'synthetic-branch', credential: 9,
      scm_url: '[SCM URL redacted]' } } },
  }))),
  ...['started', 'success', 'error'].map(event => ({
    args: ['project', 'notification-remove', '42', '--event', event, '--notification-template', '7'],
    path: `projects/42/notification_templates_${event}/`, body: { id: 7, disassociate: true },
  })),
  ...['create', 'edit'].flatMap(operation => [false, true].map(attachCredential => ({
    args: ['execution-environment', operation, operation === 'create' ? 'Synthetic environment' : '42',
      '--image', 'registry.example/automation/runner:stable', '--organization', '7',
      '--description', 'Synthetic runner image', '--pull', 'always', ...(attachCredential ? ['--credential', '9'] : [])],
    path: operation === 'create' ? 'execution_environments/' : 'execution_environments/42/',
    body: { ...(operation === 'create' ? { name: 'Synthetic environment' } : {}),
      image: 'registry.example/automation/runner:stable', organization: 7, description: 'Synthetic runner image', pull: 'always',
      ...(attachCredential ? { credential: 9 } : {}) },
    preview: { dry_run: { payload: { image: 'registry.example/automation/runner:stable', organization: 7,
      description: 'Synthetic runner image', pull: 'always', ...(attachCredential ? { credential: 9 } : {}) } } },
  }))),
  { args: ['schedule', 'create', 'Synthetic schedule', '--template', '7', '--rrule', 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY'], path: 'schedules/', body: { name: 'Synthetic schedule', unified_job_template: 7, rrule: 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY' } },
  { args: ['schedule', 'edit', '42', '--name', 'Updated schedule'], path: 'schedules/42/', body: { name: 'Updated schedule' } },
  ...['create', 'edit'].flatMap(operation => ['inline', 'upload'].map(channel => ({
    args: ['schedule', operation, operation === 'create' ? 'Synthetic schedule' : '42', '--template', '7',
      '--inventory', '8', '--limit', 'synthetic-host', '--job-tags', 'configure,verify', '--skip-tags', 'restart',
      '--extra-vars', channel === 'inline' ? '{"mode":"synthetic","password":"CANARY-schedule"}' : 'schedule.yml', '--disabled'],
    path: operation === 'create' ? 'schedules/' : 'schedules/42/',
    body: { ...(operation === 'create' ? { name: 'Synthetic schedule' } : {}), unified_job_template: 7,
      inventory: 8, limit: 'synthetic-host', job_tags: 'configure,verify', skip_tags: 'restart',
      extra_data: { mode: 'synthetic', password: 'CANARY-schedule' }, enabled: false },
    ...(channel === 'upload' ? { input: { files: [upload('schedule.yml', 'mode: synthetic\npassword: CANARY-schedule\n')] } } : {}),
  }))),
  ...[
    { operation: 'credential-add', flag: 'credential', route: 'credentials', remove: false },
    { operation: 'credential-remove', flag: 'credential', route: 'credentials', remove: true },
    { operation: 'label-remove', flag: 'label', route: 'labels', remove: true },
    { operation: 'instance-group-remove', flag: 'instance-group', route: 'instance_groups', remove: true },
  ].map(({ operation, flag, route, remove }) => ({
    args: ['schedule', operation, '42', `--${flag}`, '7'], path: `schedules/42/${route}/`,
    body: { id: 7, ...(remove ? { disassociate: true } : {}) },
  })),
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

test.each([
  { format: 'json', initial: '{"mode":"initial","ansible_password":"CANARY-create"}', updated: '{"mode":"updated","ansible_password":"CANARY-edit"}' },
  { format: 'yml', initial: 'mode: initial\nansible_password: CANARY-create\n', updated: 'mode: updated\nansible_password: CANARY-edit\n' },
])('AWX host and group $format changes persist through inventory and membership reads with writes disabled', async ({ format, initial, updated }) => {
  await withFakeService(async ({ directory, port }) => {
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
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[], input: RunInput = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['inventory', 'host-create', 'synthetic-host', '--inventory', '7', '--enabled', '--variables', initial, '--confirm'])
      await run(['inventory', 'host-create', 'synthetic-sibling', '--inventory', '7', '--confirm'])
      await run(['inventory', 'group-create', 'synthetic-parent', '--inventory', '7', '--variables', initial, '--confirm'])
      await run(['inventory', 'group-create', 'synthetic-child', '--inventory', '7', '--confirm'])
      await run(['inventory', 'group-create', 'synthetic-other-child', '--inventory', '7', '--confirm'])
      allowWrites = false
      expect(await run(['host', 'show', 'synthetic-host'])).toMatchObject({ host: {
        id: 42, name: 'synthetic-host', inventory: '7', enabled: true, variables: { mode: 'initial', ansible_password: '***' },
      } })
      expect(await run(['group', 'show', 'synthetic-parent'])).toMatchObject({ group: {
        id: 42, inventory: '7', variables: { mode: 'initial', ansible_password: '***' }, total_hosts: 0, total_children: 0,
      } })
      allowWrites = true
      await run(['inventory', 'host-edit', 'synthetic-host', '--name', 'synthetic-updated', '--description', 'Updated host', '--disabled', '--variables', `host.${format}`, '--confirm'],
        { files: [upload(`host.${format}`, updated)] })
      await run(['inventory', 'group-edit', 'synthetic-parent', '--description', 'Updated group', '--variables', `group.${format}`, '--confirm'],
        { files: [upload(`group.${format}`, updated)] })
      await run(['inventory', 'group-add-host', 'synthetic-parent', '--host', 'synthetic-updated', '--confirm'])
      await run(['inventory', 'group-add-host', 'synthetic-parent', '--host', 'synthetic-sibling', '--confirm'])
      await run(['inventory', 'group-add-child', 'synthetic-parent', '--child', 'synthetic-child', '--confirm'])
      await run(['inventory', 'group-add-child', 'synthetic-parent', '--child', 'synthetic-other-child', '--confirm'])
      allowWrites = false
      expect(await run(['inventory', 'hosts', '7'])).toMatchObject({ hosts: [{ id: 42, name: 'synthetic-updated', enabled: false }, { id: 43, name: 'synthetic-sibling' }] })
      expect(await run(['inventory', 'groups', '7'])).toMatchObject({ groups: [{ id: 42, name: 'synthetic-parent' }, { id: 43, name: 'synthetic-child' }, { id: 44, name: 'synthetic-other-child' }] })
      expect(await run(['host', 'show', '42'])).toMatchObject({ host: {
        name: 'synthetic-updated', description: 'Updated host', enabled: false,
        variables: { mode: 'updated', ansible_password: '***' }, groups: [{ id: 42, name: 'synthetic-parent' }],
      } })
      expect(await run(['group', 'show', '42'])).toMatchObject({ group: {
        description: 'Updated group', variables: { mode: 'updated', ansible_password: '***' }, total_hosts: 2, total_children: 2,
        hosts: [{ id: 42, name: 'synthetic-updated' }, { id: 43, name: 'synthetic-sibling' }],
        children: [{ id: 43, name: 'synthetic-child' }, { id: 44, name: 'synthetic-other-child' }],
      } })
      allowWrites = true
      await run(['inventory', 'group-remove-host', '42', '--host', '42', '--confirm'])
      await run(['inventory', 'group-remove-child', '42', '--child', '43', '--confirm'])
      allowWrites = false
      expect(await run(['group', 'show', '42'])).toMatchObject({ group: { total_hosts: 1, total_children: 1,
        hosts: [{ id: 43, name: 'synthetic-sibling' }], children: [{ id: 44, name: 'synthetic-other-child' }],
      } })
      expect(await run(['host', 'show', '42'])).toMatchObject({ host: { name: 'synthetic-updated', groups: [] } })
      expect(await run(['group', 'show', '43'])).toMatchObject({ group: { name: 'synthetic-child', inventory: '7' } })
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test.each([
  { kind: 'inventory', create: ['create', 'synthetic-inventory', '--organization', '7'], remove: 'delete',
    list: ['inventory', 'list'], field: 'inventories', empty: '0 inventories found', path: '/api/v2/inventories/42/' },
  { kind: 'source', create: ['source-create', 'synthetic-source', '--inventory', '7', '--source', 'scm'], remove: 'source-delete',
    list: ['inventory-source', 'list'], field: 'inventory_sources', empty: '0 inventory sources found', path: '/api/v2/inventory_sources/42/' },
].flatMap(resource => [
  { outcome: 'removes the resource', allowWrites: true, permission: true, result: { exitCode: 0 }, remaining: resource.empty, count: '0 total', mutations: 2, deletes: 1 },
  { outcome: 'refuses disabled writes', allowWrites: false, permission: true, result: { error: { code: 'FLAG_BLOCKED' } }, remaining: [{ id: 42 }], count: '1 total', mutations: 1, deletes: 0 },
  { outcome: 'preserves the resource on permission denial', allowWrites: true, permission: false,
    result: { exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') }, remaining: [{ id: 42 }], count: '1 total', mutations: 1, deletes: 1 },
].map(scenario => ({ ...resource, ...scenario }))))(
  'AWX $kind deletion $outcome (S4-001)', async ({ create, remove, list, field, path, allowWrites: enabled, permission, result, remaining, count, mutations, deletes }) => {
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
        return { ...call, executable: process.execPath,
          args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      }
      const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
      const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
        resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
      const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
      const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      try {
        const created = await run(['inventory', ...create, '--confirm'])
        expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
        allowWrites = enabled
        await send(`/__awx/configuration-permission?enabled=${permission}`, 'POST')
        const before = JSON.parse(await send('/__evidence'))
        const removed = await run(['inventory', remove, '42', '--confirm'])
        expect(removed.json(), removed.body).toMatchObject(result)
        const evidence = JSON.parse(await send('/__evidence'))
        expect(evidence.mutations).toBe(mutations)
        expect(evidence.requests.slice(before.requests.length)).toHaveLength(deletes)
        expect(evidence.requests.filter((request: { method: string }) => request.method === 'DELETE')).toEqual(
          Array.from({ length: deletes }, () => ({ method: 'DELETE', path, auth: 'Bearer', canaryReceived: true })))
        const listed = await run(list)
        expect(listed.json(), listed.body).toMatchObject({ exitCode: 0 })
        expect(decode(listed.json().stdout)).toMatchObject({ count, [field]: remaining })
      } finally { await app.close(); db.close() }
    })
  }, 60_000,
)

test.each([
  { view: 'default', flags: [], range: '0-4 of 4', body: "Fetching repository\nfatal: unable to access 'https://scm.example/repo?ref=main'\nDocumentation: https://docs.example/help?section=git#retry\nFetch failed\n" },
  { view: 'tail', flags: ['--tail', '3'], range: '1-4 of 4', body: "fatal: unable to access 'https://scm.example/repo?ref=main'\nDocumentation: https://docs.example/help?section=git#retry\nFetch failed\n" },
  { view: 'lines', flags: ['--lines', '0-3'], range: '0-3 of 4', body: "Fetching repository\nfatal: unable to access 'https://scm.example/repo?ref=main'\nDocumentation: https://docs.example/help?section=git#retry\n" },
].flatMap(view => [
  { ...view, reader: 'inferred', command: ['job', 'stdout', '42'], label: 'job_stdout', rejectedUrl: 'https://scm.example/repo?token=CANARY-raw' },
  { ...view, reader: 'explicit', command: ['job', 'stdout', '42', '--type', 'project-update'], label: 'job_stdout', rejectedUrl: 'https://scm.example/repo?token=%43ANARY-encoded' },
  { ...view, reader: 'ad-hoc', command: ['ad-hoc', 'stdout', '42'], label: 'ad_hoc_stdout', rejectedUrl: "https://scm.example/repo?token='CANARY-apostrophe" },
]))('AWX $reader raw $view logs preserve ordinary URLs after SCM input validation (R3-R5)', async ({ command, flags, range, body, label, rejectedUrl }) => {
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
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], input: RunInput = {}) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
    try {
      const rejectedCreate = await run(['project', 'create', 'Synthetic SCM', '--scm-url', rejectedUrl, '--confirm'])
      expect(rejectedCreate.json(), rejectedCreate.body).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT', next: expect.stringContaining('--credential') } })
      expect(rejectedCreate.body).not.toContain('CANARY-')
      const rejectedEdit = await run(['project', 'edit', '42', '--scm-url', 'scm.txt', '--dry-run'], { files: [upload('scm.txt', rejectedUrl)] })
      expect(rejectedEdit.json(), rejectedEdit.body).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT', next: expect.stringContaining('--credential') } })
      expect(rejectedEdit.body).not.toContain('CANARY-')
      expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
      const created = await run(['project', 'create', 'Synthetic SCM', '--scm-type', 'git', '--scm-url', 'https://scm.example/repo?ref=main', '--credential', '9', '--confirm'])
      expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
      const synced = await run(['project', 'sync', '42', '--confirm', '--wait'])
      expect(synced.json(), synced.body).toMatchObject({ exitCode: 0 })
      allowWrites = false
      const response = await run([...command, ...flags])
      expect(response.json(), response.body).toMatchObject({ exitCode: 0, stderr: '' })
      expect(response.body).not.toContain('CANARY-')
      const stdout = response.json().stdout as string
      expect(decode(stdout.split('\nstdout:\n')[0])).toEqual({ [label]: { id: 42, lines: range } })
      expect(stdout).toContain(`\nstdout:\n${body}help[`)
      expect(stdout).toContain(`Run \`awx-axi ${command[0]} stdout 42 --lines 1-200\` to read from the start`)
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX project SCM URLs remain private on later project and activity reads (S8, R1)', async () => {
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
      expect(call.args.join(' ')).not.toContain('CANARY-')
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
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
      await run(['project', 'create', 'Synthetic SCM', '--scm-type', 'git', '--scm-url', 'scm.txt', '--scm-branch', 'main', '--credential', '9', '--confirm'],
        { files: [upload('scm.txt', 'https://scm.example/repo')] })
      await run(['project', 'edit', '42', '--scm-branch', 'updated', '--credential', '10', '--confirm'])
      expect(await run(['project', 'sync', '42', '--dry-run'])).toMatchObject({ dry_run: { action: 'sync', project: 42 } })
      expect(await run(['project', 'sync', '42', '--confirm', '--wait'])).toMatchObject({ job: { id: 42, project: 42, status: 'successful' } })
      allowWrites = false
      expect(await run(['project', 'show', '42'])).toMatchObject({ project: {
        name: 'Synthetic SCM', scm_type: 'git', scm_branch: 'updated', scm_url: '[SCM URL redacted]',
      } })
      expect(await run(['project', 'updates', '42'])).toMatchObject({ updates: [{ id: 42, status: 'successful' }] })
      const createdEvent = await run(['activity-stream', 'show', '1']) as { 'activity-stream': { changes: string } }
      expect(JSON.parse(createdEvent['activity-stream'].changes)).toEqual({ scm_url: '[SCM URL redacted]', name: 'Synthetic SCM' })
      allowWrites = true
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: {
        args: ['project', 'edit', '42', '--name', 'Recovered SCM', '--scm-url', 'https://scm.example/recovered', '--confirm'],
      } })
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi project list --limit 100') } })
      expect(interrupted.body).not.toContain('CANARY-')
      allowWrites = false
      expect(await run(['project', 'list', '--limit', '100'])).toMatchObject({ projects: [{ id: 42, name: 'Recovered SCM' }] })
      expect(await run(['project', 'show', '42'])).toMatchObject({ project: { name: 'Recovered SCM', scm_url: '[SCM URL redacted]' } })
      const editedEvent = await run(['activity-stream', 'show', '2']) as { 'activity-stream': { changes: string } }
      expect(JSON.parse(editedEvent['activity-stream'].changes)).toEqual({ scm_url: '[SCM URL redacted]', name: 'Recovered SCM' })
      expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
        method: 'PATCH', path: '/api/v2/projects/42/', body: { scm_branch: 'updated', credential: 10 },
      }))
      allowWrites = true
      await send('/__awx/write-outcome?drop=false', 'POST')
      await run(['project', 'edit', '42', '--scm-url', `https://scm.example/${'x'.repeat(1100)}`, '--confirm'])
      allowWrites = false
      expect(await run(['activity-stream', 'show', '3'])).toMatchObject({ 'activity-stream': { changes: '[activity changes redacted]' } })
      expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX inventory variables remain private on later reads with writes disabled (S4)', async () => {
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
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[], input: RunInput = {}) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      expect(response.body).not.toContain('CANARY-')
      return decode(response.json().stdout)
    }
    try {
      await run(['inventory', 'create', 'synthetic-inventory', '--organization', '7', '--variables', '{"password":"CANARY-inventory"}', '--confirm'])
      allowWrites = false
      expect(await run(['inventory', 'show', 'synthetic-inventory'])).toMatchObject({ inventory: { id: 42, name: 'synthetic-inventory', variables: { password: '***' } } })
      allowWrites = true
      await run(['inventory', 'edit', '42', '--variables', 'inventory.yml', '--confirm'], { files: [upload('inventory.yml', 'password: CANARY-inventory-edit\n')] })
      await run(['inventory', 'source-create', 'synthetic-source', '--inventory', 'synthetic-inventory', '--source', 'scm', '--credential', '9',
        '--source-project', '8', '--source-vars', '{"region":"synthetic","password":"CANARY-source"}', '--update-on-launch', '--confirm'])
      await run(['inventory', 'source-edit', 'synthetic-source', '--name', 'synthetic-updated', '--credential', '10', '--no-update-on-launch',
        '--source-vars', 'source.json', '--confirm'], { files: [upload('source.json', '{"region":"updated","password":"CANARY-source-edit"}')] })
      await run(['inventory', 'source-credential-add', 'synthetic-updated', '--credential', '11', '--confirm'])
      await run(['inventory', 'source-credential-remove', 'synthetic-updated', '--credential', '11', '--confirm'])
      await run(['inventory', 'source-notification-add', 'synthetic-updated', '--event', 'success', '--notification-template', '12', '--confirm'])
      await run(['inventory', 'source-notification-remove', 'synthetic-updated', '--event', 'success', '--notification-template', '12', '--confirm'])
      expect(await run(['inventory', 'sync', 'synthetic-updated', '--confirm', '--wait'])).toMatchObject({ inventory_update: { id: 42, inventory_source: 42, status: 'successful' } })
      allowWrites = false
      expect(await run(['inventory', 'show', '42'])).toMatchObject({ inventory: { name: 'synthetic-inventory', variables: { password: '***' } } })
      expect(await run(['inventory', 'sources', '42'])).toMatchObject({ inventory_sources: [{ id: 42, name: 'synthetic-updated', source: 'scm', source_vars: 'configured' }] })
      expect(await run(['inventory-source', 'list', '--inventory', '42'])).toMatchObject({ inventory_sources: [{ id: 42, name: 'synthetic-updated', inventory: '42' }] })
      expect(await run(['inventory-source', 'show', 'synthetic-updated'])).toMatchObject({ inventory_source: {
        inventory: '42', credential: '10', source_project: '8', update_on_launch: false,
        source_vars: { region: 'updated', password: '***' }, total_updates: 1, updates: [{ id: 42, status: 'successful' }],
      } })
      expect(await run(['inventory', 'updates', '42'])).toMatchObject({ inventory_updates: [{ id: 42, source: '42 (synthetic-updated)', status: 'successful' }] })
      expect(await run(['inventory', 'constructed-show', '71'])).toMatchObject({ inventory: {
        name: 'Synthetic constructed inventory', variables: { mode: 'synthetic', password: '***' }, source_vars: { region: 'synthetic', token: '***' },
      } })
      allowWrites = true
      await run(['inventory', 'edit', '42', '--variables', 'password: CANARY-awx-token\n', '--confirm'])
      allowWrites = false
      expect(await run(['inventory', 'show', '42'])).toMatchObject({ inventory: { variables: '***' } })
      expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
        method: 'POST', path: '/api/v2/inventory_sources/42/credentials/', body: { id: 11, disassociate: true },
      }))
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

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
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
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
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
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

test.each([
  { title: 'team user', create: ['user', 'create', 'synthetic-person'],
    add: ['team', 'user-add', '7', '--user', '42'], remove: ['team', 'user-remove', '7', '--user', '42'],
    read: ['team', 'users', '7'], present: { users: [{ id: 42, username: 'synthetic-person' }] }, absent: { users: '0 users found for team', count: '0 total' } },
  { title: 'role user', create: ['user', 'create', 'synthetic-person'],
    add: ['role', 'grant', '7', '--user', '42'], remove: ['role', 'revoke', '7', '--user', '42'],
    read: ['role', 'users', '7'], present: { users: [{ id: 42, username: 'synthetic-person' }] }, absent: { users: '0 users found holding role', count: '0 total' } },
  { title: 'role team', create: ['team', 'create', 'Synthetic team', '--organization', '7'],
    add: ['role', 'grant', '7', '--team', '42'], remove: ['role', 'revoke', '7', '--team', '42'],
    read: ['role', 'teams', '7'], present: { teams: [{ id: 42, name: 'Synthetic team' }] }, absent: { teams: '0 teams found holding role', count: '0 total' } },
])('AWX $title membership changes remain readable with writes disabled (S10)', async ({ create, add, remove, read, present, absent }) => {
  await withFakeService(async ({ directory, port }) => {
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
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[]) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      return decode(response.json().stdout)
    }
    try {
      await run([...create, '--confirm'])
      await run([...add, '--confirm'])
      allowWrites = false
      expect(await run(read)).toMatchObject(present)
      allowWrites = true
      await run([...remove, '--confirm'])
      allowWrites = false
      expect(await run(read)).toMatchObject(absent)
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX user privilege removal and interrupted username changes persist with writes disabled (S10)', async () => {
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
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    const run = async (args: string[]) => {
      const response = await request(args)
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      return decode(response.json().stdout)
    }
    try {
      await run(['user', 'create', 'synthetic-person', '--is-superuser', '--is-system-auditor', '--confirm'])
      expect(await run(['user', 'show', 'synthetic-person'])).toMatchObject({ user: {
        id: 42, username: 'synthetic-person', is_superuser: true, is_system_auditor: true,
      } })
      await run(['user', 'edit', 'synthetic-person', '--no-superuser', '--no-system-auditor', '--confirm'])
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await request(['user', 'edit', '42', '--username', 'synthetic-renamed', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi user list --limit 100') } })
      allowWrites = false
      expect(await run(['user', 'list'])).toMatchObject({ users: [
        { id: 42, username: 'synthetic-renamed', is_superuser: false, is_system_auditor: false },
      ] })
      expect(await run(['user', 'show', 'synthetic-renamed'])).toMatchObject({ user: {
        id: 42, username: 'synthetic-renamed', is_superuser: false, is_system_auditor: false,
      } })
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX token revocation requires the tenant switch and confirmation and invalidates the PAT (S10)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = false
    let token = 'CANARY-awx-minted-token'
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`, token, allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = async (args: string[]) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      expect(response.body).not.toContain('CANARY-')
      return response
    }
    try {
      expect((await request(['user', 'list'])).json()).toMatchObject({ exitCode: 0 })
      token = 'CANARY-awx-token'
      const args = ['user', 'token-revoke', '7']
      expect((await request([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await request([...args, '--dry-run'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      allowWrites = true
      expect((await request(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      const preview = await request([...args, '--dry-run'])
      expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { action: 'revoke', would_send: 'DELETE tokens/7/' } })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=false', 'POST')
      const denied = await request([...args, '--confirm'])
      expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=true', 'POST')
      const revoked = await request([...args, '--confirm'])
      expect(decode(revoked.json().stdout)).toMatchObject({ token: { id: 7, status: 'revoked' } })
      token = 'CANARY-awx-minted-token'
      allowWrites = false
      const read = await request(['user', 'list'])
      expect(read.json(), read.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('AUTH_REQUIRED') })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(1)
      expect(evidence.requests).toContainEqual({ method: 'DELETE', path: '/api/v2/tokens/7/', auth: 'Bearer', canaryReceived: true })
      const audit = db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all()
      expect(audit).toContainEqual(expect.objectContaining({ event: 'run-terminal', action: 'write' }))
      expect(lines.join('\n') + JSON.stringify(audit)).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX execution environment image edits and interrupted renames remain readable with writes disabled (S9)', async () => {
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
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
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
      await run(['execution-environment', 'create', '--name', 'Synthetic runner', '--image', 'registry.example/runner:v1', '--confirm'])
      expect(await run(['execution-environment', 'edit', 'Synthetic runner', '--image', 'registry.example/runner:v2',
        '--credential', '9', '--pull', 'missing', '--dry-run'])).toMatchObject({ dry_run: { payload: {
        image: 'registry.example/runner:v2', credential: 9, pull: 'missing' } } })
      expect(await run(['execution-environment', 'show', '42'])).toMatchObject({ execution_environment: { image: 'registry.example/runner:v1' } })
      await run(['execution-environment', 'edit', 'Synthetic runner', '--image', 'registry.example/runner:v2',
        '--credential', '9', '--pull', 'missing', '--confirm'])
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await request(['execution-environment', 'edit', '42', '--name', 'Synthetic renamed runner', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi execution-environment list --limit 100') } })
      allowWrites = false
      expect(await run(['execution-environment', 'list'])).toMatchObject({ execution_environments: [
        { id: 42, name: 'Synthetic renamed runner', image: 'registry.example/runner:v2' },
      ] })
      expect(await run(['execution-environment', 'show', 'Synthetic renamed runner'])).toMatchObject({
        execution_environment: { id: 42, name: 'Synthetic renamed runner', image: 'registry.example/runner:v2' },
      })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests.filter((entry: { method: string }) => entry.method !== 'GET')).toEqual([
        expect.objectContaining({ method: 'POST', path: '/api/v2/execution_environments/',
          body: { name: 'Synthetic runner', image: 'registry.example/runner:v1' } }),
        expect.objectContaining({ method: 'PATCH', path: '/api/v2/execution_environments/42/',
          body: { image: 'registry.example/runner:v2', credential: 9, pull: 'missing' } }),
        expect.objectContaining({ method: 'PATCH', path: '/api/v2/execution_environments/42/', body: { name: 'Synthetic renamed runner' } }),
      ])
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
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
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

test('AWX machine credential writes preserve private inputs and reconcile interrupted team creation (S5-001)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    let allowWrites = true
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], input: RunInput = {}) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...input } })
    try {
      const machine = { username: 'synthetic-ssh', ssh_key_data: '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-synthetic-key\n-----END OPENSSH PRIVATE KEY-----',
        password: 'CANARY-machine-password' }
      const input = { files: [upload('machine.json', JSON.stringify(machine))] }
      const create = ['credential', 'create', 'Synthetic machine', '--credential-type', 'Machine', '--organization', '7', '--inputs-file', 'machine.json', '--confirm']
      const created = await run(create, input)
      expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
      expect(decode(created.json().stdout)).toMatchObject({ credential: { id: 42, name: 'Synthetic machine' } })
      const edited = await run(['credential', 'edit', '42', '--inputs-file', '-', '--confirm'], { stdin: '{"password":"CANARY-replaced-password"}' })
      expect(edited.json(), edited.body).toMatchObject({ exitCode: 0 })
      const copied = await run(['credential', 'copy', '42', '--name', 'Synthetic machine copy', '--confirm'])
      expect(copied.json(), copied.body).toMatchObject({ exitCode: 0 })
      expect(decode(copied.json().stdout)).toMatchObject({ credential: { id: 43, name: 'Synthetic machine copy' } })
      const invalidType = await run(['credential', 'create', 'Synthetic invalid', '--credential-type', '999', '--confirm'])
      expect(invalidType.json(), invalidType.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      const invalidInputs = await run(['credential', 'edit', '42', '--inputs-file', '-', '--confirm'], { stdin: '["CANARY-invalid-input"]' })
      expect(invalidInputs.json(), invalidInputs.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect(JSON.parse(await send('/__evidence'))).toMatchObject({ mutations: 3, requests: expect.arrayContaining([
        expect.objectContaining({ method: 'POST', path: '/api/v2/credentials/', body: { name: 'Synthetic machine', credential_type: 7, organization: 7, inputs: machine } }),
        expect.objectContaining({ method: 'PATCH', path: '/api/v2/credentials/42/', body: { inputs: { password: 'CANARY-replaced-password' } } }),
        expect.objectContaining({ method: 'POST', path: '/api/v2/credentials/42/copy/', body: { name: 'Synthetic machine copy' } }),
      ]) })
      const call = await adapter.prepare(create, reference, input)
      expect(call.args.join(' ')).not.toContain('CANARY-')
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await run(['team', 'credential-create', '7', '--name', 'Synthetic team machine', '--credential-type', '7',
        '--inputs-file', 'machine.json', '--confirm'], { files: [upload('machine.json', '{"password":"CANARY-team-machine"}')] })
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi credential list --limit 100') } })
      allowWrites = false
      const recovered = await run(['credential', 'list', '--limit', '100'])
      expect(recovered.json(), recovered.body).toMatchObject({ exitCode: 0 })
      expect(decode(recovered.json().stdout)).toMatchObject({ credentials: [
        { id: 42, name: 'Synthetic machine' }, { id: 43, name: 'Synthetic machine copy' }, { id: 44, name: 'Synthetic team machine' },
      ] })
      const shown = await run(['credential', 'show', '43'])
      expect(shown.json(), shown.body).toMatchObject({ exitCode: 0 })
      expect(decode(shown.json().stdout)).toMatchObject({ credential: { id: 43, name: 'Synthetic machine copy' } })
      expect(created.body + edited.body + copied.body + invalidType.body + invalidInputs.body + interrupted.body + recovered.body + shown.body
        + lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(db.prepare("SELECT outcome FROM audit WHERE tool = 'awx-axi' AND event = 'run-terminal' AND (action = 'write' OR outcome = 'UNKNOWN_OUTCOME') ORDER BY id").all())
        .toEqual([{ outcome: 'completed' }, { outcome: 'completed' }, { outcome: 'completed' }, { outcome: 'UNKNOWN_OUTCOME' }])
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
      const writes = await app.inject({ url: '/admin/tools/awx-axi?tab=writes', headers: {
        cookie: browserLogin.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
      expect(writes.body).toContain('name="enabled" data-type="boolean"')
      expect(writes.body).not.toContain('name="allowConfigurationWrites"')
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
      const help = await run(['template', 'delete', '--help'])
      expect(help.json(), help.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('template delete') })
      expect((await run(['job', 'cancel', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await run(['job', 'cancel', '42', '--dry-run'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      for (const args of [['template', 'delete', '42'], ['role', 'grant', '42', '--user', '7']]) {
        expect((await run([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
        expect((await run([...args, '--dry-run'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      }
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi', headers,
        payload: { nativeSettings: { allowWrites: true }, expectedRevision: 3 } })).statusCode).toBe(200)
      const written = await run(['job', 'cancel', '42', '--type', 'job', '--confirm'])
      expect(written.json(), written.body).toMatchObject({ exitCode: 0 })
      for (const args of [['template', 'delete', '42'], ['role', 'grant', '42', '--user', '7']]) {
        const before = JSON.parse(await send('/__evidence')).mutations
        const preview = await run([...args, '--dry-run'])
        expect(preview.json(), preview.body).toMatchObject({ exitCode: 0 })
        expect(JSON.parse(await send('/__evidence')).mutations).toBe(before)
        const executed = await run([...args, '--confirm'])
        expect(executed.json(), executed.body).toMatchObject({ exitCode: 0 })
      }
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(3)
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/jobs/42/cancel/', canaryReceived: true }))
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: '/api/v2/job_templates/42/', canaryReceived: true }))
      expect(evidence.requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/roles/42/users/', body: { id: 7 }, canaryReceived: true }))
      const audit = db.prepare("SELECT action, arguments FROM audit WHERE tool = 'awx-axi'").all()
      expect(audit.filter(row => (row as { action: string }).action === 'write')).toHaveLength(3)
      expect(existsSync(join(directory, 'ambient-writes.log'))).toBe(false)
      expect(JSON.stringify(audit)).not.toContain('CANARY-awx-token')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
      const beforeBlocked = JSON.parse(await send('/__evidence'))
      for (const blocked of [
        ['inventory', 'host-bulk-create', '--hosts-file', 'synthetic.json'],
        ['credential', 'create', 'Synthetic credential', '--inputs-file', 'synthetic.json'],
        ['user', 'create', 'synthetic-user', '--password-file', 'synthetic.txt'],
        ['project', 'create', 'Synthetic', '--scm-url', '@synthetic.txt'],
        ['inventory', 'create', 'Synthetic', '--variables', '@synthetic.json'],
        ['template', 'create', 'Synthetic', '--extra-vars', '@synthetic.json'],
      ]) {
        const refused = await run([...blocked, '--confirm'])
        expect(refused.json(), refused.body).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT' } })
      }
      expect(JSON.parse(await send('/__evidence'))).toEqual(beforeBlocked)
      expect(JSON.stringify(db.prepare("SELECT arguments FROM audit WHERE tool = 'awx-axi'").all())).not.toContain('CANARY-input')
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access', headers,
        payload: { enabled: false, expectedRevision: 4 } })).statusCode).toBe(200)
      const tools = await app.inject({ url: '/v1/tools', headers })
      expect(tools.json()).toMatchObject({ tools: [expect.objectContaining({ name: 'awx-axi', readOnly: true })] })
      const beforeOperational = JSON.parse(await send('/__evidence'))
      expect((await run(['job', 'cancel', '42', '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.parse(await send('/__evidence'))).toEqual(beforeOperational)
      const grants = db.prepare("SELECT arguments FROM audit WHERE tool = 'awx-axi' AND event = 'tool-write-access' ORDER BY id").all() as { arguments: string }[]
      expect(grants.map(row => JSON.parse(row.arguments))).toContainEqual(expect.objectContaining({ enabled: false }))
      const legacyUpdate = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access', headers,
        payload: { enabled: false, allowConfigurationWrites: true, expectedRevision: 5 } })
      expect(legacyUpdate.statusCode).toBe(400)
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

test('AWX bulk host create and delete report mixed and uncertain outcomes without trusting limited reads (S12)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = false
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) {
        call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
        return call
      }
      return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], files: ReturnType<typeof upload>[] = []) =>
      app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, ...(files.length ? { files } : {}) } })
    const evidence = async () => JSON.parse(await send('/__evidence'))
    const hostIds = async (...args: string[]) => {
      const listed = decode((await run(['host', 'list', ...args])).json().stdout) as { count: string, hosts: string | { id: number }[] }
      return { count: listed.count, ids: Array.isArray(listed.hosts) ? listed.hosts.map(host => host.id) : [] }
    }
    const create = ['inventory', 'host-bulk-create', '--inventory', '7', '--hosts-file', 'hosts.json']
    const remove = ['inventory', 'host-bulk-delete', '--hosts-file', 'ids.json']
    const names = upload('hosts.json', JSON.stringify([
      { name: 'not-ready', variables: '{"password":"CANARY-bulk-secret"}' }, { name: 'failed' }, { name: 'access-denied' }]))
    try {
      // Reads stay available and bulk previews and confirmations are refused while writes are off.
      for (const [args, files] of [[create, [names]], [remove, [upload('ids.json', '[42]')]]] as const) {
        for (const flag of ['--dry-run', '--confirm']) {
          expect((await run([...args, flag], [...files])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
        }
      }
      expect((await hostIds()).ids).toEqual([])
      expect((await evidence()).mutations).toBe(0)

      allowWrites = true
      const preview = await run([...create, '--dry-run'], [names])
      expect(preview.json(), preview.body).toMatchObject({ exitCode: 0 })
      expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { action: 'create', type: 'hosts', would_send: 'POST bulk/host_create/' } })
      expect(preview.body).not.toContain('CANARY-bulk-secret')
      const idsPreview = await run([...remove, '--dry-run'], [upload('ids.json', '[42,43,99]')])
      expect(decode(idsPreview.json().stdout)).toMatchObject({ dry_run: { action: 'delete', type: 'hosts', would_send: 'POST bulk/host_delete/' } })
      expect((await evidence()).mutations).toBe(0)

      await send('/__awx/configuration-permission?enabled=false', 'POST')
      expect((await run([...create, '--confirm'], [names])).json()).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
      expect((await evidence()).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=true', 'POST')

      const created = await run([...create, '--confirm'], [names])
      expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
      expect(created.body).not.toContain('CANARY-bulk-secret')
      expect((await evidence()).requests).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/v2/bulk/host_create/',
        body: { inventory: 7, hosts: [{ name: 'not-ready', variables: '{"password":"CANARY-bulk-secret"}' },
          { name: 'failed' }, { name: 'access-denied' }] } }))
      // A one-row page proves nothing about the other hosts.
      expect(await hostIds('--limit', '1')).toEqual({ count: '1 of 3 total', ids: [42] })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      // A duplicate batch is rejected atomically by the controller.
      const duplicate = await run([...create, '--confirm'], [names])
      expect(duplicate.json(), duplicate.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      const freshDuplicate = await run([...create, '--confirm'], [upload('hosts.json', '[{"name":"fresh"},{"name":"fresh"}]')])
      expect(freshDuplicate.json(), freshDuplicate.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      for (const variables of [{ password: 'CANARY-bulk-secret' }, ['CANARY-bulk-secret']]) {
        const invalidVariables = await run([...create, '--confirm'], [upload('hosts.json', JSON.stringify([
          { name: 'fresh-valid', variables: '{}' }, { name: 'fresh-invalid', variables },
        ]))])
        expect(invalidVariables.json(), invalidVariables.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
        expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])
      }

      const invalidBatch = await run([...remove, '--confirm'], [upload('ids.json', '[42,43,99]')])
      expect(invalidBatch.json(), invalidBatch.body).toMatchObject({ exitCode: 2, stdout: expect.stringContaining('VALIDATION_ERROR') })
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43, 44])

      const deleted = await run([...remove, '--confirm'], [upload('ids.json', '[42,43,44]')])
      expect(deleted.json(), deleted.body).toMatchObject({ exitCode: 0 })
      expect((await hostIds('--limit', '100')).ids).toEqual([])

      for (const { mode, unconfirmed } of [
        { mode: 'missing', unconfirmed: [42, 43, 44] },
        { mode: 'null', unconfirmed: [42, 43, 44] },
        { mode: 'array', unconfirmed: [42, 43, 44] },
        { mode: 'no-content', unconfirmed: [42, 43, 44] },
        { mode: 'empty', unconfirmed: [42, 43, 44] },
        { mode: 'mixed', unconfirmed: [44] },
        { mode: 'invalid-message', unconfirmed: [44] },
      ]) {
        expect((await run([...create, '--confirm'], [names])).json()).toMatchObject({ exitCode: 0 })
        await send(`/__awx/bulk-delete-response?mode=${mode}`, 'POST')
        const result = await run([...remove, '--confirm'], [upload('ids.json', '[42,43,44]')])
        expect(result.json(), result.body).toMatchObject({ exitCode: 1 })
        expect(decode(result.json().stdout)).toMatchObject({ code: 'PARTIAL_OUTCOME', requested: 3, unconfirmed_hosts: unconfirmed })
        expect(result.json().stdout).not.toContain('status: deleted')
        expect((await hostIds('--limit', '100')).ids).toEqual([])
      }
      await send('/__awx/bulk-delete-response?mode=valid', 'POST')
      expect(db.prepare("SELECT DISTINCT action, outcome, exit_code FROM audit WHERE tool = 'awx-axi' AND error_code = 'PARTIAL_OUTCOME'").all())
        .toEqual([{ action: 'unknown', outcome: 'completed', exit_code: 1 }])

      // Malformed host files are refused by the pinned CLI before any request.
      const before = (await evidence()).mutations
      for (const content of ['{"name":"x"}', '["not-an-id"]', '[0]']) {
        expect((await run([...remove, '--confirm'], [upload('ids.json', content)])).json()).toMatchObject({ exitCode: 2 })
      }
      expect((await evidence()).mutations).toBe(before)

      // A dropped connection leaves the outcome unknown; the recovery read is a limited page.
      expect((await run([...create, '--confirm'], [names])).json()).toMatchObject({ exitCode: 0 })
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await run([...remove, '--confirm'], [upload('ids.json', '[44]')])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringMatching(/awx-axi host list --limit 100.*absence from this limited read does not prove failure/) } })
      await send('/__awx/write-outcome?drop=false', 'POST')
      expect((await hostIds('--limit', '100')).ids).toEqual([42, 43])
      const everything = JSON.stringify(db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all())
      expect(everything).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
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
      expect(db.prepare("SELECT instance, credential_id FROM audit WHERE action = 'save-awx-origin'").all())
        .toEqual([{ instance: 'default', credential_id: store.findCredential('awx-axi')!.id }])
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
