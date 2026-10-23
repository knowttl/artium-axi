import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const load = (tool: string, path: string) => import(new URL(`../tools/node_modules/@knowttl/${tool}/dist/${path}`, import.meta.url).href)
const inventory = (tool: string) => JSON.parse(readFileSync(join(root, `tools/inventories/${tool}.json`), 'utf8'))
const azInventory = inventory('az-axi')
const mgInventory = inventory('mg-axi')
const vectraInventory = inventory('vectra-axi') as { commands: { command: string, flags: Record<string, string> }[] }
const vectra = await load('vectra-axi', 'src/catalogue.js')
const az = await load('az-axi', 'lib/router.js')
const mg = await load('mg-axi', 'catalogue.js')
type Route = { command: string; flags: Record<string, string>; flagAliases: Record<string, string>;
  shortFlags: Record<string, string>; positionalInput: boolean }
const routes = new Map<string, Route>(azInventory.commands.map((route: Route) => [route.command, route]))

test.each(vectraInventory.commands.flatMap((route: { command: string, flags: Record<string, string> }) =>
  Object.entries(route.flags).map(([flag, kind]) => ({ command: route.command, flag, value: kind === 'boolean' ? true : 'synthetic' }))))(
  'Vectra pinned parser accepts $command --$flag', ({ command, flag, value }) => {
    const args = [...command.split(' '), `--${flag}`, ...(value === true ? [] : [value])]
    expect(vectra.parseInvocation(args).flags.get(flag)).toBe(value)
  })

test.each([
  ['graph query', 'rg query', 'graph-query'],
  ['monitor log-analytics query', 'logs query', 'analytics-query'],
])('%s keeps canonical query flags separate from positional %s', (canonical, alias, queryFlag) => {
  expect(routes.get(canonical)?.positionalInput).toBe(false)
  expect(routes.get(alias)?.positionalInput).toBe(true)
  expect(routes.get(canonical)?.flags[queryFlag]).toBe('value')
  expect(routes.get(alias)?.flags).not.toHaveProperty(queryFlag)
  expect(() => az.routeArgv([...canonical.split(' '), 'synthetic-query'])).toThrow()
  expect(az.routeArgv([...canonical.split(' '), `--${queryFlag}`, 'synthetic-query']).argv)
    .toEqual([...alias.split(' '), '--', 'synthetic-query'])
  expect(az.routeArgv([...alias.split(' '), 'synthetic-query']).argv)
    .toEqual([...alias.split(' '), '--', 'synthetic-query'])
  expect(() => az.routeArgv([...alias.split(' '), `--${queryFlag}`, 'synthetic-query'])).toThrow()
})

test.each([
  ['rbac list', 'role assignment list', 'assignee', 'principal'],
  ['activity list', 'monitor activity-log list', 'offset', 'since'],
])('%s refuses the flag alias accepted by %s', (canonical, alias, input, target) => {
  expect(routes.get(canonical)?.flagAliases).not.toHaveProperty(input)
  expect(routes.get(alias)?.flagAliases[input]).toBe(target)
  expect(() => az.routeArgv([...canonical.split(' '), `--${input}`, 'synthetic'])).toThrow()
  expect(az.routeArgv([...alias.split(' '), `--${input}`, 'synthetic']).argv)
    .toEqual([...canonical.split(' '), `--${target}=synthetic`, '--'])
})

test.each([
  ['account list', 's', 'subscription'],
  ['resource list', 'g', 'resource-group'],
  ['resource list', 'n', 'name'],
  ['security alert update', 'l', 'location'],
  ['logs query', 'w', 'workspace'],
  ['logs query', 't', 'timespan'],
  ['graph query', 'q', 'graph-query'],
])('%s records short -%s mapped to %s', (command, short, target) => {
  expect(routes.get(command)?.shortFlags[short]).toBe(target)
  expect(az.routeArgv([...command.split(' '), `-${short}`, 'synthetic']).argv)
    .toEqual(az.routeArgv([...command.split(' '), `--${target}`, 'synthetic']).argv)
})

test('Azure graph subscription aliases include short expansion and canonical first', () => {
  expect(routes.get('graph query')?.flagAliases).toEqual({ first: 'limit', subscription: 'subscriptions' })
  expect(routes.get('graph query')?.shortFlags.s).toBe('subscriptions')
  expect(routes.get('rg query')?.shortFlags.s).toBe('subscription')
  expect(routes.get('rg query')?.flags).not.toHaveProperty('management-groups')
  expect(az.routeArgv(['graph', 'query', '-s', 'synthetic-a', 'synthetic-b', '--first', '5']).argv)
    .toEqual(['rg', 'query', '--limit=5', '--subscription=synthetic-a,synthetic-b', '--'])
  expect(routes.get('account list')?.shortFlags.h).toBe('help')
  expect(az.routeArgv(['account', 'list', '-h']).help).toBeDefined()
})

test('Azure passthrough inventories only its own accepted wrapper and name flags', async () => {
  expect(routes.get('az group show')?.flags).toEqual({ profile: 'value', config: 'value', full: 'boolean',
    fields: 'value', help: 'boolean', name: 'value', subscription: 'value' })
  expect(routes.get('az group show')?.flagAliases).toEqual({ 'resource-group': 'name' })
  expect(routes.get('az group show')?.shortFlags).toEqual({ h: 'help', n: 'name', g: 'name' })
  const passthrough = await load('az-axi', 'commands/az.js')
  await expect(passthrough.run(['group', 'show', '--tenant', 'synthetic']))
    .rejects.toThrow('unsupported passthrough argument')
})

test('Graph inventory records universal help and the required API path', () => {
  expect(new Set(mgInventory.commands.map((route: Route) => route.flags.help))).toEqual(new Set(['boolean']))
  expect(mgInventory.commands.find((route: Route) => route.command === 'api get').positionalInput)
    .toMatchObject({ name: 'path', required: true })
  expect(mg.resolveCommand(['api', 'get', '/users']).positional).toBe('/users')
  expect(() => mg.resolveCommand(['api', 'get'])).toThrow('missing path')
  expect(() => mg.resolveCommand(['api', 'get', '/users', '/groups'])).toThrow('unexpected argument')
  expect(mg.resolveCommand(['api', 'get', '--help']).flags.help).toBe(true)
})

test('Graph native environment defaults exclude profile-selected example names', () => {
  expect(mgInventory.environment.map((entry: { name: string }) => entry.name))
    .toEqual(['MG_AXI_CONFIG', 'MG_AXI_PROFILE', 'MG_AXI_READ_ONLY', 'MG_AXI_WRITE_LOG', 'AZURE_FEDERATED_TOKEN_FILE'])
  expect(mgInventory.dynamicCredentialEnvironment).toEqual([
    { profileField: 'clientSecret.env', transport: 'client-secret value', defaultEnvironment: 'MG_AXI_CLIENT_SECRET' },
    { profileField: 'privateKey.env', transport: 'private-key value', defaultEnvironment: 'MG_AXI_PRIVATE_KEY' },
    { profileField: 'token.env', transport: 'token or assertion value', defaultEnvironment: 'MG_AXI_TOKEN' },
  ])
})

test.each([
  ['arm', 'AZ_AXI_ARM_TOKEN'], ['graph', 'AZ_AXI_GRAPH_TOKEN'], ['logs', 'AZ_AXI_LOGS_TOKEN'],
  ['registry', 'AZ_AXI_REGISTRY_TOKEN'], ['storage', 'AZ_AXI_STORAGE_TOKEN'], ['vault', 'AZ_AXI_VAULT_TOKEN'],
])('Azure %s environment record distinguishes default from profile-selected credentials', async (resource, name) => {
  const { secretRefFor } = await load('az-axi', 'lib/config.js')
  expect(azInventory.environment).toContainEqual({ name, disposition: 'set by server' })
  expect(azInventory.dynamicCredentialEnvironment).toContainEqual({ profileField: `${resource}Token.env`,
    transport: 'token value', defaultEnvironment: name, disposition: 'server-owned' })
  expect(secretRefFor({}, resource)).toEqual({ env: name })
  expect(secretRefFor({ [`${resource}Token`]: { env: 'CANARY_SELECTED_TOKEN' } }, resource))
    .toEqual({ env: 'CANARY_SELECTED_TOKEN' })
})

test('Vectra records native selectors separately from profile-selected token and OAuth secrets', () => {
  const vectra = inventory('vectra-axi')
  expect(vectra.environment.map((entry: { name: string }) => entry.name))
    .toEqual(['VECTRA_AXI_CONFIG', 'VECTRA_AXI_PROFILE', 'VECTRA_AXI_READ_ONLY', 'VECTRA_AXI_WRITE_LOG'])
  expect(vectra.dynamicCredentialEnvironment).toEqual([
    { profileField: 'token.env', transport: 'token value', disposition: 'server-owned' },
    { profileField: 'clientSecret.env', transport: 'client-secret value', disposition: 'server-owned' },
    { profileField: 'tokenEnv', transport: 'deprecated token value', disposition: 'server-owned' },
    { profileField: 'secretEnv', transport: 'deprecated client-secret value', disposition: 'server-owned' },
  ])
})

test.each([undefined, 'CANARY_ASSERTION_FILE'])('Graph federated source %s reads and refreshes the selected assertion file', tokenFileEnv => {
  const directory = mkdtempSync(join(root, '.tmp-federated-'))
  const assertionFile = join(directory, 'assertion.txt')
  const sdk = `export class ConfidentialClientApplication {
    constructor(config) { this.config = config }
    async acquireTokenByClientCredential() {
      return { authority: this.config.auth.authority + '/',
        accessToken: await this.config.auth.clientAssertion(), expiresOn: new Date('2030-01-01') }
    }
  }`
  const sdkUrl = `data:text/javascript,${encodeURIComponent(sdk)}`
  const loader = `export async function resolve(name, context, next) {
    if (name === '@azure/msal-node') return { url: ${JSON.stringify(sdkUrl)}, shortCircuit: true }
    return next(name, context)
  }`
  const program = `import { register } from 'node:module'
    import { writeFileSync } from 'node:fs'
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)})
    const { MsalApplicationProvider } = await import(process.argv[1])
    const provider = new MsalApplicationProvider()
    const profile = { tenantId: '00000000-0000-0000-0000-000000000001',
      clientId: '00000000-0000-0000-0000-000000000002', cloud: 'commercial',
      auth: 'federated', token: process.argv[3] ? { file: process.argv[2] } : { env: 'MG_AXI_TOKEN' } }
    const first = await provider.acquire(profile, ['https://graph.microsoft.com/.default'])
    writeFileSync(process.argv[2], 'CANARY-rotated\\n')
    const second = await provider.acquire(profile, ['https://graph.microsoft.com/.default'])
    console.log(JSON.stringify([first.token, second.token]))`
  try {
    writeFileSync(assertionFile, 'CANARY-first\n', { mode: 0o600 })
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program,
      new URL('../tools/node_modules/@knowttl/mg-axi/dist/msal-app-provider.js', import.meta.url).href,
      assertionFile, tokenFileEnv ?? ''], { encoding: 'utf8', timeout: 3000,
      env: { PATH: process.env.PATH, AZURE_FEDERATED_TOKEN_FILE: tokenFileEnv ? join(directory, 'unused.txt') : assertionFile,
        CANARY_ASSERTION_FILE: assertionFile } })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['CANARY-first', 'CANARY-rotated'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
