import { expect, test, vi } from 'vitest'
import { createAzAdapter } from './az.js'
import { createFalconAdapter } from './falcon.js'
import { createMgAdapter } from './mg.js'
import { createVectraAdapter } from './vectra.js'
import { AzureTokenCache } from './azure-token-cache.js'
import { CredentialProfile } from './credential-profile.js'
import { FakeTokenTransport, azureTestTenant } from '../../../test/fixtures/azure-token-transport.js'
import type { ToolName } from '../store/credential-store.js'
import type { SecretSource } from '../store/secret-source.js'
import azSchema from '../../../test/fixtures/az-credential.schema.json' with { type: 'json' }

const identity = { tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222' }
const cases = [
  { tool: 'falcon-axi', credential: { clientId: 'synthetic-client', clientSecret: 'CANARY-secret', region: 'us-2' },
    args: ['auth', 'status'], create: (source: SecretSource, profile?: CredentialProfile) => createFalconAdapter(source, '/tmp/writes.log', profile) },
  { tool: 'vectra-axi', credential: { kind: 'qux', apiVersion: '2.5', origin: 'https://appliance.test', auth: 'token', token: 'CANARY-token' },
    args: ['health', 'list'], create: (source: SecretSource, profile?: CredentialProfile) => createVectraAdapter(source, '/tmp/writes.log', profile) },
  { tool: 'mg-axi', credential: { ...identity, auth: 'secret', clientSecret: 'CANARY-secret' },
    args: ['entra', 'user', 'list'], create: (source: SecretSource, profile?: CredentialProfile) => createMgAdapter(source, '/tmp/writes.log', profile) },
  { tool: 'az-axi', credential: { ...identity, auth: 'secret', clientSecret: 'CANARY-secret' },
    args: ['account', 'list'], create: (source: SecretSource, profile?: CredentialProfile) => createAzAdapter(source, '/tmp/writes.log', new AzureTokenCache(new FakeTokenTransport()), profile) },
] as const

test.each(cases)('$tool defaults to read-only and follows only its own explicit switch', async ({ tool, credential, args, create }) => {
  const value: Record<string, unknown> = { ...credential }
  const adapter = create({ getCredential: async () => value })
  const reference = { id: 'synthetic', tool, revision: 1 }
  const key = `${tool.toUpperCase().replaceAll('-', '_')}_READ_ONLY`
  expect((await adapter.prepare(args, reference)).environment[key]).toBe('true')
  const settings = tool === 'mg-axi' || tool === 'vectra-axi'
    ? { writes: { allowWrites: true, operations: ['synthetic.operation'] } } : { allowWrites: true }
  Object.assign(value, settings)
  expect((await adapter.prepare(args, reference)).environment[key]).toBe('false')
  Object.assign(value, tool === 'mg-axi' || tool === 'vectra-axi'
    ? { writes: { allowWrites: false, operations: ['synthetic.operation'] } } : { allowWrites: false })
  expect((await adapter.prepare(args, reference)).environment[key]).toBe('true')
})

test.each(cases.filter(item => item.tool !== 'az-axi'))('$tool schema-driven adapter enforces the host switch', async ({ tool, credential, args, create }) => {
  const schema = { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(Object.keys(credential).map(name => [name, { type: 'string' }])) }
  if (tool !== 'falcon-axi') Object.assign(schema.properties, { writes: { type: 'object' } })
  const profile = new CredentialProfile(schema, tool as ToolName)
  const value: Record<string, unknown> = { ...credential }
  const adapter = create({ getCredential: async () => value }, profile)
  const reference = { id: 'synthetic', tool, revision: 1 }
  const key = `${tool.toUpperCase().replaceAll('-', '_')}_READ_ONLY`
  expect((await adapter.prepare(args, reference)).environment[key]).toBe('true')
  Object.assign(value, tool === 'falcon-axi' ? { allowWrites: true }
    : { writes: { allowWrites: true, operations: ['synthetic.operation'] } })
  const prepared = await adapter.prepare(args, reference)
  expect(prepared.environment[key]).toBe('false')
  if (tool === 'falcon-axi') expect(JSON.parse(prepared.files[0].content as string).profiles.artium).not.toHaveProperty('allowWrites')
})

test('Azure refuses a classified write before credential access when the stored switch is off', async () => {
  const getCredential = vi.fn()
  const network = new FakeTokenTransport()
  const adapter = createAzAdapter({ getCredential, getSettings: () => ({}) }, '/tmp/writes.log', new AzureTokenCache(network))
  await expect(adapter.prepare(['tag', 'update', '--resource-id', '/subscriptions/synthetic/resourceGroups/synthetic',
    '--tags', 'synthetic=true', '--execute'], { id: 'synthetic', tool: 'az-axi', revision: 1 }))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
  expect(network.requests).toEqual([])
})

test.each([
  { allowWrites: undefined, readOnly: 'true' },
  { allowWrites: false, readOnly: 'true' },
  { allowWrites: true, readOnly: 'false' },
])('Azure token-profile adapter sets read-only to $readOnly for allowWrites $allowWrites', async ({ allowWrites, readOnly }) => {
  const adapter = createAzAdapter({ getCredential: async () => ({ ...identity, auth: 'secret', clientSecret: 'CANARY-secret', allowWrites }) },
    '/tmp/writes.log', new AzureTokenCache(new FakeTokenTransport()), new CredentialProfile(azSchema))
  const prepared = await adapter.prepare(['account', 'list'], { id: 'synthetic', tool: 'az-axi', revision: 1 })
  expect(prepared.environment.AZ_AXI_READ_ONLY).toBe(readOnly)
})
