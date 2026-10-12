import { generateKeyPairSync } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { FakeTokenTransport, azureTestTenant, azureTestToken } from '../../../test/fixtures/azure-token-transport.js'
import { SecretScanner } from '../runner/scan.js'
import { createAzAdapter, azCredentialSchema } from './az.js'
import { AzureTokenCache } from './azure-token-cache.js'
import { azureAudiences } from './azure-tokens.js'

const reference = { id: 'synthetic-azure', tool: 'az-axi' as const, revision: 1 }
const credential = { auth: 'secret' as const, tenantId: azureTestTenant,
  clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
  subscriptions: ['synthetic-subscription'], allowWrites: true,
  workspaces: { synthetic: '33333333-3333-4333-8333-333333333333' } }
const writeLog = '/data/tool-logs/az-axi/writes.log'

test.each([
  ['sub list', ['sub', 'list'], 'arm'],
  ['subscription override', ['group', 'list', '-s', 'other', '--subscription=third'], 'arm'],
  ['leading subscription', ['--subscription=other', 'group', 'list'], 'arm'],
  ['canonical query', ['monitor', 'log-analytics', 'query', '--analytics-query', 'Heartbeat', '-w', 'synthetic'], 'logs'],
  ['alias query', ['logs', 'query', 'Heartbeat', '-w', 'synthetic'], 'logs'],
  ['literal query', ['logs', 'query', '-w', 'synthetic', '--', '--help'], 'logs'],
  ['Graph API', ['api', '/v1.0/users', '--resource=graph'], 'graph'],
  ['storage', ['storage', 'blob', 'list', '--account-name=synthetic', '--container-name=synthetic'], 'storage'],
  ['vault', ['keyvault', 'secret', 'list', '--vault-name=synthetic'], 'vault'],
  ['registry', ['acr', 'repository', 'list', '--name=synthetic'], 'registry'],
] as const)('%s selects only the required token and retains native settings', async (_name, args, resource) => {
  const transport = new FakeTokenTransport()
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(transport))
  const call = await adapter.prepare(args, reference)
  expect(transport.requests.map(request => request.form.get('scope'))).toEqual([`${azureAudiences[resource]}/.default`])
  expect(call.environment).toEqual({ AZ_AXI_CONFIG: 'az-profile.json', AZ_AXI_WRITE_LOG: writeLog,
    ARTIUM_SECRET_0: azureTestToken })
  expect(JSON.parse(call.files[0].content as string)).toEqual({ defaultProfile: 'artium', profiles: {
    artium: { auth: 'token', tenant: credential.tenantId, subscriptions: credential.subscriptions,
      allowWrites: true, workspaces: credential.workspaces, tokenEnv: { [resource]: 'ARTIUM_SECRET_0' } },
  } })
  if (_name !== 'leading subscription') expect(call.args).toEqual(args)
  expect(call.secrets).toEqual(expect.arrayContaining([credential.clientSecret, azureTestToken]))
})

test.each([
  [['rg', 'query'], ['--subscription=other']],
  [['logs', 'query', '-w', 'synthetic'], ['--subscription=other']],
  [['rg', 'query'], ['--subscription', 'other']],
  [['logs', 'query', '-w', 'synthetic'], ['--subscription', 'other']],
  [['rg', 'query'], ['-s', 'other']],
  [['logs', 'query', '-w', 'synthetic'], ['-s', 'other']],
  [['rg', 'query'], ['-s=other']],
  [['logs', 'query', '-w', 'synthetic'], ['-s=other']],
  [['rg', 'query'], ['--management-group=synthetic']],
  [['logs', 'query', '-w', 'synthetic'], ['--full']],
  [['rg', 'query'], ['--fields=name', '--limit=12']],
] as const)('leading selectors stay before the literal query: %j %j', async (command, selectors) => {
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(new FakeTokenTransport()))
  const query = 'Resources | where name == "--subscription=literal"\n| take 1'
  const args = [...selectors, ...command, '--', query]
  adapter.validateArgs(args)
  const call = await adapter.prepare(args, reference)
  expect(call.args).toEqual([...command, ...selectors, '--', query])
  expect(JSON.parse(call.files[0].content as string).profiles.artium.subscriptions).toEqual(credential.subscriptions)
})

test.each([
  [['sub', 'list'], undefined],
  [['sub', 'list'], []],
  [['api', '/v1.0/users', '--resource=graph'], undefined],
  [['api', '/v1.0/users', '--resource=graph'], []],
] as const)('write-enabled credentials without write subscriptions prepare reads: %j %j', async (args, subscriptions) => {
  const adapter = createAzAdapter({ getCredential: async () => ({ ...credential, subscriptions }) }, writeLog,
    new AzureTokenCache(new FakeTokenTransport()))
  const call = await adapter.prepare(args, reference)
  expect(call.args).toEqual(args)
  const profile = JSON.parse(call.files[0].content as string).profiles.artium
  expect(profile.allowWrites).toBe(true)
  expect(profile.subscriptions).toEqual(subscriptions)
})

test.each([
  ['config', 'list'], ['setup'], ['az', 'group', 'list'], ['update'],
  ['sub', 'list', '--profile=other'], ['--tenant=other', 'sub', 'list'],
  ['sub', 'list', '--config', '/data/artium.db'], ['sub', 'list', '--tenant', 'other'],
  ['api', '/v1.0/users', '--resource=graph', '--resource=arm'],
].map(args => [args]))('unsafe or unsupported route fails before credential access: %j', async args => {
  const getCredential = vi.fn()
  await expect(createAzAdapter({ getCredential }, writeLog).prepare(args, reference)).rejects.toBeDefined()
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['file', 'body-file'])('%s only transports an uploaded leaf and normalizes equals syntax', async flag => {
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(new FakeTokenTransport()))
  const args = flag === 'file' ? ['logs', 'query', '-w', 'synthetic'] : ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--api-version=2022-12-01']
  await expect(adapter.prepare([...args, `--${flag}=/data/artium.db`], reference)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  await expect(adapter.prepare([...args, `--${flag}=-`], reference, { stdin: 'synthetic' })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  const call = await adapter.prepare([...args, `--${flag}=input.json`], reference,
    { files: [{ name: 'input.json', contentBase64: 'c3ludGhldGlj' }] })
  expect(call.args.slice(-2)).toEqual([`--${flag}`, 'input.json'])
  expect(call.fileArguments).toEqual([call.args.length - 1])
})

test('certificate preparation keeps the key and exact assertion in the scan set', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const transport = new FakeTokenTransport()
  const value = { auth: 'certificate', tenantId: credential.tenantId, clientId: credential.clientId,
    privateKey, thumbprintSha256: 'ab'.repeat(32), allowWrites: true }
  const call = await createAzAdapter({ getCredential: async () => value }, writeLog, new AzureTokenCache(transport))
    .prepare(['sub', 'list'], reference)
  const assertion = transport.requests[0].form.get('client_assertion')!
  expect(call.secrets).toEqual(expect.arrayContaining([privateKey, assertion, azureTestToken]))
  expect(call.files[0].content).not.toContain(privateKey)
  for (const secret of [privateKey, assertion, azureTestToken]) {
    const scanner = new SecretScanner(call.secrets)
    expect(scanner.scan('stdout', Buffer.from(encodeURIComponent(secret)))).toBe(true)
  }
})

test('invalid profile or missing revision fails safely', async () => {
  expect(azCredentialSchema.safeParse({ ...credential, tokenEnv: { arm: 'OTHER' } }).success).toBe(false)
  await expect(createAzAdapter({ getCredential: async () => credential }, writeLog)
    .prepare(['sub', 'list'], { id: reference.id, tool: reference.tool })).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
})

test.each([[['sub', 'list', '--help']], [['--version']], [[]]])('local call %j does not mint a token', async args => {
  const transport = new FakeTokenTransport()
  await createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(transport)).prepare(args, reference)
  expect(transport.requests).toEqual([])
})
