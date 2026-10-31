import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: ReturnType<typeof openStore>
let app: ReturnType<typeof createApp>
let headers: Record<string, string>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ado-gate-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  store.replaceCredential('ado-axi', { org: 'synthetic-org', project: 'Synthetic Project', auth: 'pat',
    token: 'CANARY-ado-pat', allowWrites: true }, 0, 'synthetic-development-user', Date.now())
  db.exec(`UPDATE tools SET enabled = 1, native_settings = '{"allowWrites":true}' WHERE name = 'ado-axi'`)
  const adapter = createAdoAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  adapter.prepare = async (...input) => {
    const call = await prepare(...input)
    return { ...call, executable: process.execPath,
      args: [join(process.cwd(), 'test/fake-tool/ado-gate-child.mjs'), ...call.args],
      environment: { ...call.environment, ARTIUM_TEST_ADO_RECORD: join(directory, 'children.jsonl') } }
  }
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}),
    runner: await Runner.create(join(directory, 'calls')), adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  // Ambient server settings must never unlock a read child.
  vi.stubEnv('ADO_AXI_WRITES', '1')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const run = (args: string[], extra = {}) => app.inject({ method: 'POST', url: '/v1/tools/ado-axi/run', headers,
  payload: { args, ...extra } })

test.each(['project list', 'query run synthetic-query', 'area list', 'iteration list', 'work-item link types',
  'security group list', 'service-endpoint list', 'variable-group list', 'agent list --pool 1', 'pool list', 'queue list',
  'user list', 'team list', 'repo policy list', 'pipeline show 7', 'pipeline variable list --pipeline 7',
  'pipeline release list', 'pipeline folder list', 'pipeline runs artifact list 8', 'work-item delete --help'])(
  '%s runs a child without the write switch even when server writes are enabled', async command => {
    const result = await run(command.split(' '))
    expect(result.json(), result.body).toMatchObject({ exitCode: 0, stdout: '{"writes":null}\n' })
  })

test.each([
  ['work-item', 'update', '42', '--title', 'Synthetic title'],
  ['work-item', 'delete', '42', '--if-rev', '3'],
  ['wi', 'delete', '42', '--if-rev', '3', '--destroy', '--confirm-destroy'],
  ['work-item', 'links', 'remove', '42', '--index', '0', '--if-rev', '3'],
  ['pipeline', 'create', '--definition', '{"name":"Synthetic"}'],
  ['pipeline', 'update', '7', '--definition', '{"name":"Synthetic"}'],
  ['pipeline', 'delete', '7', '--if-rev', '3', '--confirm-delete'],
  ['pipeline', 'build', 'cancel', '8'],
  ['pipeline', 'build', 'tag', 'add', '8', '--tag', 'Synthetic'],
  ['pipeline', 'runs', 'tag', 'remove', '8', '--tag', 'Synthetic'],
  ['pipeline', 'folder', 'create', '--path', '\\Synthetic'],
  ['pipeline', 'folder', 'delete', '--path', '\\Synthetic', '--confirm-delete'],
  ['pipeline', 'release', 'create', '--definition', '7'],
  ['repo', 'create', '--name', 'Synthetic'],
  ['repo', 'update', '--repo', 'Synthetic', '--disabled', 'true'],
  ['repo', 'delete', '--repo', 'Synthetic', '--confirm-delete'],
  ['repo', 'import', '--repo', 'Synthetic', '--source-url', 'https://git.test/synthetic.git'],
  ['repo', 'policy', 'create', '--policy-json', '{}'],
  ['repo', 'policy', 'update', '7', '--policy-json', '{}'],
  ['repo', 'policy', 'delete', '7', '--if-rev', '3', '--confirm-delete'],
].map(args => [args]))('%j only reaches the child with the write switch after host authorization', async args => {
  db.exec("UPDATE tools SET native_settings = '{}' WHERE name = 'ado-axi'")
  expect((await run(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
  expect(existsSync(join(directory, 'children.jsonl'))).toBe(false)
  db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'ado-axi'`)
  const result = await run(args)
  expect(result.json(), result.body).toMatchObject({ exitCode: 0, stdout: '{"writes":"1"}\n' })
  expect(readFileSync(join(directory, 'children.jsonl'), 'utf8')).toBe('{"writes":"1"}\n')
})

test.each([
  { args: ['project', 'list'], environment: { ADO_AXI_WRITES: '1' } },
  { args: ['project', 'list'], env: { ADO_AXI_WRITES: '1' } },
  { args: ['project', 'list', '--ADO_AXI_WRITES=1'] },
])('refuses client environment injection before starting the child: %j', async ({ args, ...extra }) => {
  expect((await run(args, extra)).json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  expect(existsSync(join(directory, 'children.jsonl'))).toBe(false)
})

test('raw API writes receive the native switch only after path and host write authorization', async () => {
  const args = ['api', '_apis/wit/workitems/42', '--method', 'PATCH', '--body', '[]']
  expect((await run(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
  expect(existsSync(join(directory, 'children.jsonl'))).toBe(false)
  vi.stubEnv('ARTIUM_AXI_ADO_API_WRITE_PATHS', '{"PATCH":["_apis/wit/workitems/*"]}')
  expect((await run(args)).json()).toMatchObject({ exitCode: 0, stdout: '{"writes":"1"}\n' })
  expect((await run(['api', '_apis/wit/workitems/42'])).json()).toMatchObject({ exitCode: 0, stdout: '{"writes":null}\n' })
})

test.each([
  ['work-item', 'attach', '42', '--file', '/tmp/synthetic.txt'],
  ['work-item', 'attachment', 'get', '42', '--name', 'synthetic.txt'],
  ['pipeline', 'runs', 'artifact', 'download', '8', '--name', 'synthetic', '--out', '/tmp/synthetic.zip'],
].map(args => [args]))('refuses unsupported file transport before starting the child: %j', async args => {
  expect((await run(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
  expect(existsSync(join(directory, 'children.jsonl'))).toBe(false)
})
