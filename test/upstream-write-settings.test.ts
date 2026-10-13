import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test, vi } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const load = (tool: string, path: string) => import(new URL(`../tools/node_modules/@knowttl/${tool}/dist/${path}`, import.meta.url).href)

afterEach(() => vi.unstubAllEnvs())

test.each([
  ['az-axi', { allowWrites: 'boolean', subscriptions: 'string[]' }, 'writeSubscriptions', 'server-owned'],
  ['vectra-axi', { 'writes.allowWrites': 'boolean', 'writes.operations': 'string[]' }, 'scope.operations', 'server-owned'],
  ['mg-axi', { 'writes.allowWrites': 'boolean', 'writes.operations': 'string[]' }, 'scope.operations', undefined],
])('%s inventory records native write fields and pinned provenance', (tool, fields, resolvedField, disposition) => {
  const inventory = JSON.parse(readFileSync(join(root, `tools/inventories/${tool}.json`), 'utf8'))
  expect(inventory.nativeWriteSettings).toMatchObject({ default: 'disabled',
    profileFields: fields, scope: { resolvedField } })
  expect(inventory.nativeWriteSettings.disposition).toBe(disposition)
  expect(inventory.nativeWriteSettings.sources).toHaveLength(2)
  for (const source of inventory.nativeWriteSettings.sources) {
    expect(source.sha256).toBe(createHash('sha256')
      .update(readFileSync(join(root, `tools/node_modules/@knowttl/${tool}/${source.path}`))).digest('hex'))
  }
})

test('Azure configured write subscriptions cannot be widened by read-scope overrides', async () => {
  vi.stubEnv('AZ_AXI_PROFILE', '')
  vi.stubEnv('AZ_AXI_READ_ONLY', '')
  vi.stubEnv('AZ_AXI_SUBSCRIPTION', 'synthetic-env-subscription')
  const { resolveProfile } = await load('az-axi', 'lib/config.js')
  const { enforceGates } = await load('az-axi', 'lib/gates.js')
  const directory = mkdtempSync(join(root, '.tmp-write-settings-'))
  const config = join(directory, 'config.json')
  try {
    writeFileSync(config, JSON.stringify({ defaultProfile: 'synthetic', profiles: { synthetic: {
      auth: 'token', allowWrites: true, subscriptions: ['synthetic-config-subscription'],
    } } }))
    const fromEnv = resolveProfile({ config })
    const fromFlag = resolveProfile({ config, subscriptions: ['synthetic-flag-subscription'] })
    expect(fromEnv.subscriptions).toEqual(['synthetic-env-subscription'])
    expect(fromFlag.subscriptions).toEqual(['synthetic-flag-subscription'])
    expect(fromEnv.writeSubscriptions).toEqual(['synthetic-config-subscription'])
    expect(fromFlag.writeSubscriptions).toEqual(['synthetic-config-subscription'])
    expect(enforceGates(fromFlag, { method: 'PATCH', path: '/subscriptions/synthetic-config-subscription/resourceGroups/synthetic' },
      'write', { execute: true })).toBe(true)
    expect(() => enforceGates(fromFlag, { method: 'PATCH', path: '/subscriptions/synthetic-flag-subscription/resourceGroups/synthetic' },
      'write', { execute: true })).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION_NOT_WRITABLE' }))
    expect(() => enforceGates({ ...fromFlag, allowWrites: false }, { method: 'PATCH', path: '/subscriptions/synthetic-config-subscription/resourceGroups/synthetic' },
      'write', { execute: true })).toThrow(expect.objectContaining({ code: 'WRITES_DISABLED' }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  [{ kind: 'qux', apiVersion: '2.5', auth: 'token', token: { env: 'CANARY_TOKEN' } }],
  [{ kind: 'qux', apiVersion: '2.5', auth: 'oauth', clientId: 'synthetic', clientSecret: { env: 'CANARY_SECRET' } }],
  [{ kind: 'rux', apiVersion: '3.4', auth: 'oauth', clientId: 'synthetic', clientSecret: { env: 'CANARY_SECRET' } }],
])('Vectra %j write settings enforce the configured operation scope', async variant => {
  vi.stubEnv('VECTRA_AXI_READ_ONLY', 'false')
  const { loadConfig } = await load('vectra-axi', 'src/profiles.js')
  const { createMutationCoordinator } = await load('vectra-axi', 'src/writes.js')
  const { SecretRedactor } = await load('vectra-axi', 'src/redact.js')
  const directory = mkdtempSync(join(root, '.tmp-write-settings-'))
  const config = join(directory, 'config.json')
  try {
    writeFileSync(config, JSON.stringify({ version: 1, profiles: { synthetic: { ...variant, origin: 'https://appliance.test',
      writes: { allowWrites: true, operations: ['synthetic.allowed'] },
    } } }), { mode: 0o600 })
    const profile = { ...loadConfig(config).config.profiles.synthetic, name: 'synthetic' }
    const coordinator = createMutationCoordinator({ profile, configPath: config, redactor: new SecretRedactor(),
      transport: async () => { throw new Error('Unexpected synthetic network request') } })
    const definition = { operation: 'synthetic.allowed', method: 'PATCH', path: `/api/v${variant.apiVersion}/synthetic`,
      effect: 'write', target: 'synthetic' }
    expect(coordinator.preview(definition).operation).toBe('synthetic.allowed')
    profile.writes.operations.push('synthetic.outside')
    expect(() => coordinator.preview({ ...definition, operation: 'synthetic.outside' }))
      .toThrow(expect.objectContaining({ code: 'OPERATION_NOT_WRITABLE' }))
    const disabled = createMutationCoordinator({ profile: { ...profile, writes: undefined }, configPath: config,
      redactor: new SecretRedactor(), transport: async () => { throw new Error('Unexpected synthetic network request') } })
    expect(() => disabled.preview(definition)).toThrow(expect.objectContaining({ code: 'WRITES_DISABLED' }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each([
  ['delegated', { token: { stored: true } }],
  ['application', { auth: 'client-secret', clientSecret: { env: 'CANARY_SECRET' } }],
])('Graph %s write settings enforce the configured operation scope', async (mode, credentials) => {
  vi.stubEnv('MG_AXI_READ_ONLY', 'false')
  const { validateProfile } = await load('mg-axi', 'profiles.js')
  const { createMutationCoordinator } = await load('mg-axi', 'mutations.js')
  const profile = validateProfile({ mode, ...credentials, tenantId: '00000000-0000-0000-0000-000000000001',
    clientId: '00000000-0000-0000-0000-000000000002', cloud: 'commercial', allowDeviceCode: false,
    enabledPacks: ['entra'], sensitiveAreas: [], preview: false,
    writes: { allowWrites: true, operations: ['synthetic.allowed'] } })
  const coordinator = createMutationCoordinator({ profile,
    transport: async () => { throw new Error('Unexpected synthetic network request') } })
  const definition = { operation: 'synthetic.allowed', method: 'PATCH', version: 'v1.0',
    path: '/v1.0/users/synthetic', effect: 'write', target: 'synthetic' }
  expect(coordinator.preview(definition).operation).toBe('synthetic.allowed')
  expect(() => coordinator.preview({ ...definition, operation: 'synthetic.outside' }))
    .toThrow(expect.objectContaining({ code: 'OPERATION_NOT_WRITABLE' }))
  const disabled = createMutationCoordinator({ profile: { ...profile, writes: undefined },
    transport: async () => { throw new Error('Unexpected synthetic network request') } })
  expect(() => disabled.preview(definition)).toThrow(expect.objectContaining({ code: 'WRITES_DISABLED' }))
})
