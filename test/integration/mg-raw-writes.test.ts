import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'
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
let adapter: ReturnType<typeof createMgAdapter>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-mg-raw-writes-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  allowRawApi(db, 'mg-axi')
  store.replaceCredential('mg-axi', credential, 0, 'synthetic-development-user', Date.now())
  db.prepare("UPDATE tools SET enabled = 1, native_settings = ? WHERE name = 'mg-axi'").run(JSON.stringify(writeSettings))
  adapter = createMgAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'),
    loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!)
  const prepare = adapter.prepare.bind(adapter)
  adapter.prepare = async (...input) => {
    const call = await prepare(...input)
    return { ...call, executable: process.execPath, args: [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args] }
  }
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}),
    runner: await Runner.create(join(directory, 'calls')), adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), environment: {} })
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
  expect(await run(execute('patch'))).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
})

const userPath = '/users/00000000-0000-0000-0000-000000000004'
const batch = (requests: unknown[]) => ['api', 'post', '/$batch', '--body', JSON.stringify({ requests }), '--execute', '--confirm', '/$batch']
const entry = (id: string, method: string, url: string) => ({ id, method, url })

test.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('delegated batch checks the inner %s command', async method => {
  const grant = (commands: string[]) => {
    const minted = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic',
      scope: { tools: [{ tool: 'mg-axi', commands }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 600000 }, [adapter])
    return { authorization: `Bearer ${exchangeDelegation(db, minted.token).accessToken}` }
  }
  const args = batch([entry('1', method, rawPath)])
  if (method === 'PATCH') args.splice(3, 2, `--body=${args[4]}`)
  headers = grant(['api post'])
  if (method !== 'POST') expect(await run(args)).toMatchObject({ error: { code: 'DELEGATED_SCOPE_DENIED' } })
  headers = grant([...new Set(['api post', `api ${method.toLowerCase()}`])])
  expect(await run(args)).toMatchObject({ exitCode: 0, output: { fakeSends: 1 } })
})

test('a batch is sent once when every inner request passes the policy of its single call', async () => {
  const requests = [entry('1', 'GET', userPath), entry('2', 'GET', `${userPath}/drive`), entry('3', 'PATCH', `${userPath}/synthetic-raw`)]
  expect(await run(batch(requests))).toMatchObject({ exitCode: 0, output: { fakeSends: 1, rawRequest: { method: 'POST', body: { requests } } } })
})

const singleWrite = (method: string, url: string) => ['api', method.toLowerCase(), url, '--body', '{}', '--execute', '--confirm', url]

test('a file route write passes the single-call policy once the lifted denials apply', async () => {
  expect(await run(singleWrite('PATCH', `${userPath}/drive/synthetic-item`))).toMatchObject({ exitCode: 0, output: { fakeSends: 1 } })
})

test.each([
  ['a mail route while the mail pack is off', 'PATCH', `${userPath}/messages/synthetic-message`],
  ['a security route while the security pack is off', 'POST', '/security/alerts_v2/synthetic-alert'],
])('%s is refused alone and inside a batch before anything is sent', async (_name, method, url) => {
  expect(await run(singleWrite(method, url))).toMatchObject({ output: { error: { code: 'POLICY_DENIED' }, fakeSends: 0 } })
  expect(await run(batch([entry('1', 'GET', userPath), entry('2', method, url)])))
    .toMatchObject({ output: { error: { code: 'POLICY_DENIED' }, fakeSends: 0 } })
})

test('a nested batch is refused before anything is sent', async () => {
  expect(await run(batch([entry('1', 'POST', '/$batch')]))).toMatchObject({ output: { error: { code: 'POLICY_DENIED' }, fakeSends: 0 } })
})

test.each([
  ['an empty request list', []],
  ['a request without a leading slash', [entry('1', 'GET', 'users')]],
  ['an unsupported method', [entry('1', 'TRACE', userPath)]],
  ['duplicate identifiers', [entry('1', 'GET', userPath), entry('1', 'GET', userPath)]],
  ['more than twenty requests', Array.from({ length: 21 }, (_, index) => entry(String(index), 'GET', userPath))],
])('a batch with %s is refused before anything is sent', async (_name, requests) => {
  expect(await run(batch(requests))).toMatchObject({ output: { error: { code: 'POLICY_DENIED' }, fakeSends: 0 } })
})

test.each([
  ['the tool mode is off', "UPDATE tools SET raw_api_mode = 'off' WHERE name = 'mg-axi'"],
  ['the tool mode is read', "UPDATE tools SET raw_api_mode = 'read' WHERE name = 'mg-axi'"],
  ['the role has no raw access', "UPDATE role_tools SET raw_api = 0 WHERE tool = 'mg-axi'"],
])('a batch is denied before the native tool starts when %s', async (_name, change) => {
  db.exec(change)
  expect(await run(batch([entry('1', 'GET', userPath)]))).toMatchObject({ error: { code: 'RAW_API_DENIED' } })
})

test('a file route read succeeds when raw read-writes and role access are enabled', async () => {
  expect(await run(['api', 'get', `${userPath}/drive`])).toMatchObject({ exitCode: 0, output: { fakeReads: 1 } })
})

test.each([
  ['read mode', "UPDATE tools SET raw_api_mode = 'read' WHERE name = 'mg-axi'", { output: { error: { code: 'POLICY_DENIED' }, fakeReads: 0 } }],
  ['off mode', "UPDATE tools SET raw_api_mode = 'off' WHERE name = 'mg-axi'", { error: { code: 'RAW_API_DENIED' } }],
  ['no role access', "UPDATE role_tools SET raw_api = 0 WHERE tool = 'mg-axi'", { error: { code: 'RAW_API_DENIED' } }],
])('a file route read is denied with %s', async (_name, change, expected) => {
  db.exec(change)
  expect(await run(['api', 'get', `${userPath}/drive`])).toMatchObject(expected)
})
