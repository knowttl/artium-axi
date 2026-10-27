import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { expect, test, vi } from 'vitest'
import { FakeTokenTransport, azureTestTenant, azureTestToken } from '../../../test/fixtures/azure-token-transport.js'
import { SecretScanner } from '../runner/scan.js'
import { createAzAdapter, azCredentialSchema } from './az.js'
import { AzureTokenCache } from './azure-token-cache.js'
import { azureAudiences } from './azure-tokens.js'
import { loadCredentialProfile } from './credential-profile.js'
import { decode, encode } from '@toon-format/toon'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { toolView } from '../../cli/views.js'
import { redactArguments } from '../audit/redact.js'

const reference = { id: 'synthetic-azure', tool: 'az-axi' as const, revision: 1 }
const credential = { auth: 'secret' as const, tenantId: azureTestTenant,
  clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
  subscriptions: ['synthetic-subscription'], allowWrites: true,
  workspaces: { synthetic: '33333333-3333-4333-8333-333333333333' } }
const writeLog = '/data/tool-logs/az-axi/writes.log'

test.each([
  { args: ['graph', 'query', 'Resources | count'], safe: ['graph', 'query', '[redacted]'] },
  { args: ['--full', 'rg', 'query', 'Resources | count'], safe: ['--full', 'rg', 'query', '[redacted]'] },
  { args: ['monitor', 'log-analytics', 'query', 'Heartbeat | count'], safe: ['monitor', 'log-analytics', 'query', '[redacted]'] },
])('positional KQL is redacted even when upstream rejects its spelling: $args', ({ args, safe }) => {
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog)
  adapter.validateArgs(args)
  expect(redactArguments(args, adapter.sensitiveArguments(args))).toEqual(safe)
})

test('unknown Azure flags identify the flag and valid command flags before credential access', () => {
  const adapter = createAzAdapter({ getCredential: vi.fn() }, writeLog)
  expect(() => adapter.validateArgs(['rg', 'query', '--graph-query', 'Resources | count']))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: 'Unknown flag --graph-query for az-axi rg query.',
      next: expect.stringContaining('--file') }))
})

test('Azure query help retains usable input examples with the hosted executable', () => {
  const upstream = spawnSync(process.execPath, ['tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', 'rg', 'query', '--help'],
    { encoding: 'utf8' })
  expect(upstream.status).toBe(0)
  const hosted = rewriteSuggestions(upstream.stdout, 'az-axi')
  expect(hosted).toContain('artium-axi az-axi rg query --file query.kql')
  expect(hosted).toContain('cat query.kql | artium-axi az-axi rg query')
  expect(rewriteSuggestions(hosted, 'az-axi')).toBe(hosted)
})

test('hosted discovery advertises only flags accepted by the managed adapter', () => {
  const view = toolView({ name: 'az-axi', status: 'ok', version: '0.1.12' })
  const help = JSON.parse(view.split('upstreamHelp: ')[1]) as string
  const flags = help.split('\n').find(line => line.startsWith('Flags: '))!.slice(7).split(', ')
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog)
  expect(flags).not.toEqual(expect.arrayContaining(['--config', '--profile', '--tenant']))
  for (const flag of flags) {
    adapter.validateArgs(['sub', 'list', flag, ...(['--help', '--full'].includes(flag) ? [] : ['1'])])
  }
})

test.each([
  [], ['sub', 'list'], ['account', 'list'], ['doctor'], ['auth', 'status'],
  ['storage', 'blob', 'list'], ['keyvault', 'secret', 'list'], ['acr', 'repository', 'list'],
  ['monitor', 'metrics', 'list'], ['vm', 'list'], ['network', 'nsg', 'list'],
  ['policy', 'assignment', 'list'], ['role', 'definition', 'list'], ['security', 'pricing', 'list'],
].map(args => [args]))('forwarded Azure help omits managed selectors: %j', args => {
  const upstream = spawnSync(process.execPath, ['tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', ...args, '--help'],
    { encoding: 'utf8' })
  expect(upstream.status).toBe(0)
  const hosted = rewriteSuggestions(upstream.stdout, 'az-axi')
  expect(hosted).not.toMatch(/--(?:config|profile|tenant)\b/)
  expect(hosted).toContain('--full')
  expect(hosted).toContain('--subscription')
  expect(hosted).not.toMatch(/(?<!artium-axi )\baz-axi(?=\s|$)/)
  expect(rewriteSuggestions(hosted, 'az-axi')).toBe(hosted)
})

test.each(['json', 'toon'])('Azure %s invalid-input help filters declarations without changing data', format => {
  const upstream = spawnSync(process.execPath, ['tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', 'sub', 'list', '--invalid'],
    { encoding: 'utf8' })
  expect(upstream.status).toBe(2)
  const error = decode(upstream.stdout) as { code: string, help: string[] }
  const value = { ...error, data: { help: 'Flags: --config, --profile, --tenant', name: '--profile' } }
  const input = format === 'json' ? JSON.stringify(value) : encode(value)
  const output = rewriteSuggestions(input, 'az-axi')
  const parsed = (format === 'json' ? JSON.parse(output) : decode(output)) as typeof value
  expect(parsed.code).toBe('UNKNOWN_FLAG')
  expect(parsed.help.join('\n')).not.toMatch(/--(?:config|profile|tenant)\b/)
  expect(parsed.help.join('\n')).toContain('--subscription')
  expect(parsed.help.join('\n')).toContain('Run `artium-axi az-axi sub list --help` for usage')
  expect(parsed.data).toEqual(value.data)
  expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
})

test.each(['json', 'toon'].flatMap(format => ['Run', 'Check current state before trying again:'].flatMap(prose =>
  ['', 'artium-axi '].flatMap(prefix => [
    '--config /tmp/call/az-profile.json --profile artium --tenant synthetic',
    "--config='/tmp/call with spaces/az-profile.json' --profile=artium --tenant=synthetic",
  ].map(selectors => ({ format, prose, prefix, selectors }))))))(
  'hosted $format $prose recovery retains its read target with prefix "$prefix" and $selectors',
  async ({ format, prose, prefix, selectors }) => {
    const target = 'https://management.azure.com/subscriptions/synthetic-subscription/resourceGroups/synthetic?api-version=2022-12-01'
    const command = `az-axi api GET '${target}' --full`
    const value = { error: { code: 'UNKNOWN_OUTCOME' }, help: [`${prose} \`${prefix}${command} ${selectors}\``] }
    const input = format === 'json' ? JSON.stringify(value) : encode(value)
    const output = rewriteSuggestions(input, 'az-axi')
    const parsed = (format === 'json' ? JSON.parse(output) : decode(output)) as typeof value
    expect(parsed).toEqual({ ...value, help: [`${prose} \`artium-axi ${command}\``] })
    expect(rewriteSuggestions(output, 'az-axi')).toBe(output)
    const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog,
      new AzureTokenCache(new FakeTokenTransport()))
    const call = await adapter.prepare(['api', 'GET', target, '--full'], reference)
    expect(call.args).toEqual(['api', 'GET', target, '--full'])
    expect(call.environment.ARTIUM_SECRET_0).toBe(azureTestToken)
  })

test.each([
  [['sub', 'list'], 'armToken'],
  [['logs', 'query', 'Heartbeat', '-w', 'synthetic'], 'logsToken'],
  [['api', '/v1.0/users', '--resource=graph'], 'graphToken'],
  [['storage', 'blob', 'list', '--account-name=synthetic', '--container-name=synthetic'], 'storageToken'],
  [['keyvault', 'secret', 'list', '--vault-name=synthetic'], 'vaultToken'],
  [['acr', 'repository', 'list', '--name=synthetic'], 'registryToken'],
] as const)('migrated az profile uses the brokered %s token through its shipped schema: %s', async (args, field) => {
  const transport = new FakeTokenTransport()
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog,
    new AzureTokenCache(transport), loadCredentialProfile('az-axi', 'tools/node_modules/@knowttl/az-axi/axi-credential.schema.json'))
  const call = await adapter.prepare(args, reference)
  expect(call.files[0].name).toBe('az-axi/config.json')
  expect(JSON.parse(String(call.files[0].content))).toEqual({ version: 1, defaultProfile: 'artium', profiles: {
    artium: { auth: 'token', tenantId: credential.tenantId, subscriptions: credential.subscriptions,
      allowWrites: true, workspaces: credential.workspaces, [field]: { env: 'ARTIUM_SECRET_0' } },
  } })
  expect(call.environment).toEqual({ ARTIUM_SECRET_0: azureTestToken, AZ_AXI_READ_ONLY: 'false', AZ_AXI_WRITE_LOG: writeLog })
  expect(transport.requests).toHaveLength(1)
  expect(call.secrets).toEqual(expect.arrayContaining([credential.clientSecret, azureTestToken]))
})

test.each([
  ['empty dashboard', [], 'arm'],
  ['explicit dashboard', ['home'], 'arm'],
  ['sub list', ['sub', 'list'], 'arm'],
  ['activity fetch budget', ['activity', 'list', '--all', '--max-rows', '2000'], 'arm'],
  ['metrics fetch budget', ['monitor', 'metrics', 'list', '--max-rows=2000'], 'arm'],
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
    AZ_AXI_READ_ONLY: 'false', ARTIUM_SECRET_0: azureTestToken })
  expect(JSON.parse(call.files[0].content as string)).toEqual({ version: 1, defaultProfile: 'artium', profiles: {
    artium: { auth: 'token', tenantId: credential.tenantId, subscriptions: credential.subscriptions,
      allowWrites: true, workspaces: credential.workspaces, [`${resource}Token`]: { env: 'ARTIUM_SECRET_0' } },
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

test.each([
  { command: ['graph', 'query'], flag: 'file' },
  { command: ['rg', 'query'], flag: 'file' },
  { command: ['logs', 'query', '-w', 'synthetic'], flag: 'file' },
  { command: ['monitor', 'log-analytics', 'query', '-w', 'synthetic'], flag: 'file' },
  { command: ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--api-version=2022-12-01'], flag: 'body-file' },
].flatMap(route => ['separated', 'equals'].flatMap(syntax => ['input.json', '-input.json'].map(name => ({ ...route, syntax, name })))))(
  '$command accepts the uploaded $name through $syntax --$flag', async ({ command, flag, syntax, name }) => {
    const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(new FakeTokenTransport()))
    const args = [...command, ...(syntax === 'equals' ? [`--${flag}=${name}`] : [`--${flag}`, name]), '--full']
    const input = { files: [{ name, contentBase64: 'c3ludGhldGlj' }] }
    adapter.validateArgs(args, input)
    const call = await adapter.prepare(args, reference, input)
    expect(call.args).toEqual([...command, `--${flag}`, name, '--full'])
    expect(call.fileArguments).toEqual([command.length + 1])
  })

test.each(['file', 'body-file'].flatMap(flag => ['separated', 'equals'].map(syntax => ({ flag, syntax }))))(
  '--$flag rejects an unmatched dash-prefixed leaf in $syntax form', ({ flag, syntax }) => {
    const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog)
    const command = flag === 'file' ? ['rg', 'query'] : ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic']
    const args = [...command, ...(syntax === 'equals' ? [`--${flag}=-missing.json`] : [`--${flag}`, '-missing.json'])]
    expect(() => adapter.validateArgs(args, { files: [{ name: '-input.json', contentBase64: 'c3ludGhldGlj' }] }))
      .toThrow(expect.objectContaining({ code: syntax === 'equals' ? 'UNSUPPORTED_INPUT' : 'INVALID_INPUT' }))
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
    .prepare(['sub', 'list'], { id: reference.id, tool: reference.tool })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})

test.each([[['sub', 'list', '--help']], [['home', '--help']], [['--help']], [['--version']]])('local call %j does not mint a token', async args => {
  const transport = new FakeTokenTransport()
  await createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(transport)).prepare(args, reference)
  expect(transport.requests).toEqual([])
})

test.each([
  ['api', 'PUT', '/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--execute'],
  ['api', '--execute', 'patch', '/subscriptions/synthetic-subscription/resourceGroups/synthetic'],
  ['--full', 'api', 'DELETE', '/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--execute=true'],
  ['api', 'POST', '/subscriptions/synthetic-subscription/resourceGroups/synthetic/action', '--execute'],
  ['tag', 'update', '--subscription=synthetic-subscription', '--resource-id=/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--operation=merge', '--tags=synthetic=yes', '--execute'],
  ['security', 'alert', 'update', '-s', 'synthetic-subscription', '-l', 'synthetic', '-n', 'synthetic', '--status=resolve', '--execute'],
  ['defender', 'alerts', 'update', '-s', 'synthetic-subscription', '-l', 'synthetic', '-n', 'synthetic', '--status=resolve', '--execute'],
  ['sentinel', 'incident', 'update', '-s', 'synthetic-subscription', '-g', 'synthetic', '--workspace-name=synthetic', '-n', 'synthetic', '--status=Closed', '--execute'],
  ['sentinel', 'incident', 'comment', 'create', '-s', 'synthetic-subscription', '-g', 'synthetic', '--workspace-name=synthetic', '--incident-id=synthetic', '--message=synthetic', '--execute'],
  ['network', 'nsg', 'rule', 'create', '-s', 'synthetic-subscription', '-g', 'synthetic', '--nsg-name=synthetic', '-n', 'synthetic', '--execute'],
].map(args => [args]))('executed mutation %j carries accepted read recovery guidance', async args => {
  const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(new FakeTokenTransport()))
  const call = await adapter.prepare(args, reference)
  expect(call.write).toBeDefined()
  expect(call.write!.operation).toBeTruthy()
  expect(call.write!.target).toContain('synthetic')
  adapter.validateArgs(call.write!.checkArgs)
  const check = await adapter.prepare(call.write!.checkArgs, reference)
  expect(check.write).toBeUndefined()
})

test.each([
  ['api', 'GET', '/subscriptions', '--execute'],
  ['api', 'HEAD', '/subscriptions', '--execute'],
  ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic'],
  ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--execute=false'],
  ['api', 'PATCH', '/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--execute', '--help'],
  ['api', 'POST', '/providers/Microsoft.ResourceGraph/resources', '--execute'],
  ['api', 'POST', '/subscriptions/synthetic/providers/Microsoft.Resources/deployments/synthetic/whatIf', '--execute'],
  ['api', 'POST', '/subscriptions/synthetic/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults', '--execute'],
  ['api', 'POST', '/subscriptions/synthetic/providers/Microsoft.SecurityInsights/incidents/11111111-1111-4111-8111-111111111111/alerts', '--execute'],
  ['api', 'POST', '/v1.0/directoryObjects/getByIds', '--resource=graph', '--execute'],
  ['api', 'POST', '/v1/workspaces/synthetic/query', '--resource=logs', '--execute'],
  ['tag', 'update', '--resource-id=/subscriptions/synthetic-subscription/resourceGroups/synthetic', '--execute=false'],
].map(args => [args]))('read, help or preview %j has no ambiguous-write mapping', async args => {
  const call = await createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(new FakeTokenTransport()))
    .prepare(args, reference)
  expect(call.write).toBeUndefined()
})
