import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { protectedResultLimits } from '../../src/server/config.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

async function withReadService(check: (context: {
  app: ReturnType<typeof createApp>, db: ReturnType<typeof openStore>, headers: { authorization: string },
  send: (path: string, method?: string) => Promise<string>,
  run: (args: string[], files?: { name: string, contentBase64: string }[]) => Promise<Awaited<ReturnType<ReturnType<typeof createApp>['inject']>>>, lines: string[], directory: string,
}) => Promise<void>) {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec(`UPDATE tools SET enabled = 1 WHERE name = 'awx-axi';
      INSERT INTO users (id, username, display_name, password_hash)
        SELECT 'synthetic-other-user', 'synthetic-other', 'Synthetic Other', password_hash FROM users WHERE id = 'synthetic-development-user';
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-other-user', 'synthetic-role')`)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('awx-axi', { origin: `https://localhost:${port}`, token: 'CANARY-awx-token' }, 0, 'synthetic-development-user', Date.now())
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter],
      resolver: new SharedIdentityResolver(store, db), credentialStore: store, environment: {} })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[], files?: { name: string, contentBase64: string }[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args, files } })
    try { await check({ app, db, headers, send, run, lines, directory }) }
    finally { await app.close(); db.close() }
  })
}

const securityCommands = [
  'organization create', 'organization edit', 'organization delete',
  'organization admin-add', 'organization admin-remove', 'organization user-add', 'organization user-remove',
  'organization team-add', 'organization team-remove',
  'user create', 'user edit', 'user delete', 'user token-create', 'user token-revoke',
  'team create', 'team edit', 'team delete', 'team user-add', 'team user-remove',
  'role grant', 'role revoke',
]

test('AWX security administration defaults off even with writes and deletes enabled', async () => {
  await withReadService(async ({ db, run, send }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true,"allowDeletes":true}' WHERE name = 'awx-axi'`)
    for (const command of securityCommands) {
      for (const flag of ['--dry-run', '--confirm']) {
        const response = await run([...command.split(' '), '42', flag])
        expect(response.json(), command).toMatchObject({ error: { code: 'FLAG_BLOCKED',
          next: expect.stringContaining('Allow security administration') } })
      }
    }
    db.exec(`UPDATE tools SET raw_api_mode = 'read-writes', raw_api_routes = '{"get":[],"write":["PATCH **"]}' WHERE name = 'awx-axi';
      UPDATE role_tools SET raw_api = 1 WHERE tool = 'awx-axi'`)
    for (const path of ['users/42/', 'teams/42/', 'roles/7/users/', 'tokens/8/', 'organizations/42/',
      'organizations/42/users/', 'organizations/42/admins/', 'organizations/42/teams/', 'teams/42/users/']) {
      const response = await run(['api', 'patch', path, '--confirm'])
      expect(response.json(), path).toMatchObject({ error: { code: 'FLAG_BLOCKED',
        next: expect.stringContaining('Allow security administration') } })
    }
    expect(JSON.parse(await send('/__evidence'))).toEqual({ requests: [], mutations: 0 })
  })
}, 60_000)

test('AWX ordinary configuration still previews and executes with only Allow writes', async () => {
  await withReadService(async ({ db, run, send }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    const args = ['inventory', 'create', 'Synthetic inventory', '--organization', '7']
    const preview = await run([...args, '--dry-run'])
    expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { would_send: 'POST inventories/' } })
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
    const created = await run([...args, '--confirm'])
    expect(created.json(), created.body).toMatchObject({ exitCode: 0 })
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(1)
  })
}, 60_000)

test('AWX ordinary associations and team credentials need only Allow writes', async () => {
  await withReadService(async ({ db, run, send }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}', raw_api_mode = 'read-writes',
      raw_api_routes = '{"get":[],"write":["POST **"]}' WHERE name = 'awx-axi';
      UPDATE role_tools SET raw_api = 1 WHERE tool = 'awx-axi'`)
    const files = [{ name: 'body.json', contentBase64: Buffer.from('{"id":7}').toString('base64') }]
    const cases = [
      ...['add', 'remove'].flatMap(action => [
        ['organization', `galaxy-credential-${action}`, '42', '--credential', '7'],
        ['organization', `instance-group-${action}`, '42', '--instance-group', '7'],
        ['organization', `execution-environment-${action}`, '42', '--execution-environment', '7'],
        ['organization', `notification-template-${action}`, '42', '--notification-template', '7'],
        ['organization', `notification-${action}`, '42', '--event', 'success', '--notification-template', '7'],
      ]),
      ['team', 'credential-create', '7', '--name', 'Synthetic credential', '--credential-type', '7'],
      ...['galaxy_credentials', 'instance_groups', 'execution_environments', 'notification_templates', 'notification_templates_success']
        .map(path => ['api', 'post', `organizations/42/${path}/`, '--body-file', 'body.json']),
      ['api', 'post', 'teams/7/credentials/', '--body-file', 'body.json'],
    ]
    for (const args of cases) {
      const before = JSON.parse(await send('/__evidence')).mutations
      const inputFiles = args[0] === 'api' ? files : undefined
      const preview = await run([...args, '--dry-run'], inputFiles)
      expect(preview.json(), preview.body).toMatchObject({ exitCode: 0 })
      const confirmed = await run([...args, '--confirm'], inputFiles)
      expect(confirmed.json(), confirmed.body).toMatchObject({ exitCode: 0 })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(before + 1)
    }
  })
}, 60_000)

test('AWX security administration requires a matching preview for each confirmed mutation', async () => {
  await withReadService(async ({ db, run, send, lines }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true,"allowSecurityAdministration":true}' WHERE name = 'awx-axi'`)
    for (const args of [
      ['user', 'create', 'synthetic-person'],
      ['organization', 'create', 'Synthetic organization'],
      ['team', 'create', 'Synthetic team', '--organization', '7'],
      ['role', 'grant', '7', '--user', '42'],
      ['user', 'token-create', '42'],
    ]) {
      const refused = await run([...args, '--confirm'])
      expect(refused.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED', next: expect.stringContaining('--dry-run') } })
      const before = JSON.parse(await send('/__evidence')).mutations
      const preview = await run([...args, '--dry-run'])
      expect(preview.json(), preview.body).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('dry_run') })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(before)
      const confirmed = await run([...args, '--confirm'])
      expect(confirmed.json(), confirmed.body).toMatchObject({ exitCode: 0 })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(before + 1)
      expect(confirmed.body).not.toContain('CANARY-')
      expect((await run([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    }
    expect(lines.join('\n') + JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
  })
}, 60_000)

test.each([
  { args: ['job', 'list', '--fields', 'id,name,status'], expected: { jobs: [expect.objectContaining({ id: 42 })] } },
  { args: ['job', 'events', '42', '--type', 'job'], expected: { events: [expect.objectContaining({ id: 5, failed: true })] } },
  { args: ['job', 'stdout', '42', '--type', 'project-update', '--full'], expected: { job_stdout: { id: 42, lines: '0-4 of 4' } } },
  { args: ['job', 'stdout', '42', '--type', 'project-update', '--ansi'], expected: { job_stdout: { id: 42, lines: '0-4 of 4' } } },
])('AWX read flags are accepted with writes disabled: $args', async ({ args, expected }) => {
  await withReadService(async ({ run, send }) => {
    const response = await run(args)
    expect(response.json(), response.body).toMatchObject({ exitCode: 0, stderr: '' })
    const stdout = response.json().stdout as string
    expect(decode(args[1] === 'stdout' ? stdout.split('\nstdout:\n')[0] : stdout)).toMatchObject(expected)
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
  })
}, 60_000)

test.each(['job', 'workflow', 'project-update', 'inventory-update', 'ad-hoc', 'system'])('AWX %s stdout download is a one-time protected result of the bounded redacted log', async type => {
  await withReadService(async ({ app, db, run, lines, directory, headers }) => {
    const response = await run(['job', 'stdout', '42', '--type', type, '--download', '42.log'])
    expect(response.json(), response.body).toMatchObject({ exitCode: 0, stderr: '' })
    const output = decode(response.json().stdout) as { job_stdout_download: Record<string, unknown>, result: { path: string, operation: string } }
    expect(output).toMatchObject({ job_stdout_download: { id: '42', name: '42.log', lines: 5 }, result: { operation: 'stdout-download' } })
    expect(response.body).not.toMatch(/Fetch failed|CANARY-/)
    const other = await app.inject({ method: 'GET', url: output.result.path,
      headers: { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-other-user')}` } })
    expect(other.statusCode).toBe(404)
    const downloaded = await app.inject({ method: 'GET', url: output.result.path, headers })
    expect(downloaded.statusCode, downloaded.body).toBe(200)
    expect(downloaded.body).toContain('Fetch failed\n')
    expect(downloaded.body).not.toContain('CANARY-')
    expect(downloaded.headers['cache-control']).toBe('no-store')
    expect((await app.inject({ method: 'GET', url: output.result.path, headers })).statusCode).toBe(404)
    expect(lines.join('\n') + JSON.stringify(db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all())).not.toMatch(/CANARY-|Fetch failed/)
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  })
}, 60_000)

test.each([
  { text: '', lines: 0 },
  { text: '\n', lines: 1 },
  { text: 'first', lines: 1 },
  { text: 'first\n', lines: 1 },
  { text: 'first\nsecond', lines: 2 },
])('AWX stdout download counts lines including empty output (R3): $text', async ({ text, lines }) => {
  await withReadService(async ({ app, run, send, headers }) => {
    await send(`/__awx/stdout-response?status=200&text=${encodeURIComponent(text)}`, 'POST')
    const response = await run(['job', 'stdout', '42', '--type', 'project-update', '--download', '42.log'])
    expect(response.json(), response.body).toMatchObject({ exitCode: 0, stderr: '' })
    const output = decode(response.json().stdout) as { result: { path: string } }
    expect(output).toMatchObject({ job_stdout_download: { bytes: Buffer.byteLength(text), lines } })
    const downloaded = await app.inject({ method: 'GET', url: output.result.path, headers })
    expect(downloaded.statusCode, downloaded.body).toBe(200)
    expect(downloaded.body).toBe(text)
  })
}, 60_000)

test.each([
  { status: 403, code: 'FORBIDDEN' },
  { status: 404, code: 'NOT_FOUND' },
])('AWX stdout download reports controller refusal $status without a result', async ({ status, code }) => {
  await withReadService(async ({ run, send, db, directory }) => {
    await send(`/__awx/stdout-response?status=${status}`, 'POST')
    const response = await run(['job', 'stdout', '42', '--type', 'project-update', '--download', '42.log'])
    expect(response.json(), response.body).toMatchObject({ exitCode: 1 })
    expect(decode(response.json().stdout)).toMatchObject({ code, error: 'Job stdout download: Synthetic stdout download refused.' })
    expect(response.body).not.toMatch(/TEMP_UNAVAILABLE|job_stdout_download|CANARY-/)
    expect(db.prepare("SELECT * FROM audit WHERE event = 'protected-result'").all()).toEqual([])
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  })
}, 60_000)

test('AWX stdout download beyond the managed limit fails without a result', async () => {
  await withReadService(async ({ run, send, db, directory }) => {
    await send(`/__awx/stdout-padding?bytes=${protectedResultLimits.bytes + 1}`, 'POST')
    const response = await run(['job', 'stdout', '42', '--type', 'project-update', '--download', '42.log'])
    expect(response.json(), response.body).toMatchObject({ exitCode: 1 })
    expect(decode(response.json().stdout)).toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
    expect(response.json()).not.toHaveProperty('result')
    expect(response.body).not.toMatch(/CANARY-|Fetch failed/)
    expect(db.prepare("SELECT * FROM audit WHERE event = 'protected-result'").all()).toEqual([])
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  })
}, 60_000)

test.each(['../42.log', '/tmp/42.log', '.hidden'])('AWX stdout download refuses the caller-selected path %s before any request', async name => {
  await withReadService(async ({ run, send }) => {
    const response = await run(['job', 'stdout', '42', '--download', name])
    expect(response.json(), response.body).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
  })
}, 60_000)
