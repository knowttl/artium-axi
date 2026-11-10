import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { allowRawApi, issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

const credential = { mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph-secret',
  tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' }
const writeSettings = { writes: { allowWrites: true, operations: ['mg.entra.group.member.add'] } }
const rawPath = '/users/00000000-0000-0000-0000-000000000004/synthetic-raw'

let directory: string
let db: ReturnType<typeof openStore>
let app: ReturnType<typeof createApp>
let headers: Record<string, string>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-mg-raw-writes-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  allowRawApi(db, 'mg-axi')
  store.replaceCredential('mg-axi', credential, 0, 'synthetic-development-user', Date.now())
  db.prepare("UPDATE tools SET enabled = 1, native_settings = ? WHERE name = 'mg-axi'").run(JSON.stringify(writeSettings))
  const adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'),
    loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!)
  const prepare = adapter.prepare.bind(adapter)
  adapter.prepare = async (...input) => {
    const call = await prepare(...input)
    return { ...call, executable: process.execPath, args: [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args] }
  }
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}),
    runner: await Runner.create(join(directory, 'calls')), adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const call = async (args: string[]) => (await app.inject({ method: 'POST', url: '/v1/tools/mg-axi/run', headers, payload: { args } })).json()
const run = async (args: string[]) => {
  const response = await call(args)
  return response.error ? response : { ...response, output: decode(response.stdout) as Record<string, any> }
}
const execute = (method: string) => ['api', method, rawPath, '--body', '{"displayName":"Synthetic"}', '--execute', '--confirm', rawPath]

test.each(['post', 'put', 'patch', 'delete'])('api %s sends one request once the tool mode and role allow raw writes', async method => {
  expect(await run(execute(method))).toMatchObject({ exitCode: 0, output: { fakeSends: 1,
    rawRequest: { method: method.toUpperCase(), body: { displayName: 'Synthetic' } } } })
})

test.each(['get', 'post', 'put', 'patch', 'delete'])('api %s query values are redacted in the audit', async method => {
  await call(['api', method, rawPath, '--query', 'access_token=CANARY-secret'])
  await call(['api', method, rawPath, '--query=access_token=CANARY-inline'])
  const records = db.prepare("SELECT arguments FROM audit WHERE event = 'run-start' ORDER BY id").all() as { arguments: string }[]
  expect(records.map(record => JSON.parse(record.arguments))).toEqual([
    ['api', method, rawPath, '--query', '[redacted]'],
    ['api', method, rawPath, '--query=[redacted]'],
  ])
})

test.each(['post', 'put', 'patch', 'delete'])('api %s previews without sending', async method => {
  expect(await run(['api', method, rawPath, '--body', '{"displayName":"Synthetic"}']))
    .toMatchObject({ exitCode: 0, output: { fakeSends: 0 } })
})

test.each([
  ['the tool mode is off', "UPDATE tools SET raw_api_mode = 'off' WHERE name = 'mg-axi'"],
  ['the tool mode is read', "UPDATE tools SET raw_api_mode = 'read' WHERE name = 'mg-axi'"],
  ['the role has no raw access', "UPDATE role_tools SET raw_api = 0 WHERE tool = 'mg-axi'"],
])('api patch is denied before the native tool starts when %s', async (_name, change) => {
  db.exec(change)
  expect(await run(execute('patch'))).toMatchObject({ error: { code: 'RAW_API_DENIED' } })
  expect(await call(['api', 'patch', '--help'])).toMatchObject({ exitCode: 0 })
})

test('a raw write still needs the administrator write switch', async () => {
  db.prepare("UPDATE tools SET native_settings = '{}' WHERE name = 'mg-axi'").run()
  expect(await run(execute('patch'))).toMatchObject({ output: { error: { code: 'WRITES_DISABLED' }, fakeSends: 0 } })
})

test('the native batch denial stays in force', async () => {
  expect(await run(['api', 'post', '/$batch', '--body', '{}', '--execute', '--confirm', '/$batch']))
    .toMatchObject({ output: { error: { code: 'POLICY_DENIED' }, fakeSends: 0 } })
})
