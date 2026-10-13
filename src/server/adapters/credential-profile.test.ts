import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import schema from '../../../test/fixtures/axi-credential.schema.json' with { type: 'json' }
import azSchema from '../../../test/fixtures/az-credential.schema.json' with { type: 'json' }
import { CredentialProfile, loadCredentialProfile } from './credential-profile.js'
import { createMgAdapter } from './mg.js'

const identity = { mode: 'application', tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222' }
const credential = { ...identity, auth: 'client-secret', clientSecret: 'CANARY-host-secret' }
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'artium-profile-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

test('loads a shipped schema and retains legacy handling only when it is absent', () => {
  const path = join(directory, 'axi-credential.schema.json')
  expect(loadCredentialProfile('mg-axi', path)).toBeUndefined()
  writeFileSync(path, JSON.stringify(schema))
  expect(loadCredentialProfile('mg-axi', path)?.credentialSchema.safeParse(credential).success).toBe(true)
  writeFileSync(path, '{')
  expect(() => loadCredentialProfile('mg-axi', path)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
})

test.each([
  { ...credential, unknown: true },
  { ...credential, clientSecret: '' },
  { ...credential, clientSecret: '   ' },
  { ...credential, clientSecret: { env: 'OTHER_SECRET' } },
  { ...credential, tenantId: 'invalid' },
  { ...identity, auth: 'certificate', privateKey: 'CANARY-key', thumbprintSha256: 'a'.repeat(40) },
  { ...credential, privateKey: 'CANARY-key' },
])('schema rejects invalid replacement without echoing it', value => {
  const result = new CredentialProfile(schema).credentialSchema.safeParse(value)
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('CANARY-')
})

test('writes one versioned profile with generic secret holders and host policy', () => {
  const profile = new CredentialProfile(schema)
  const prepared = profile.prepare('mg-axi', credential, join(directory, 'writes.log'), true)
  expect(prepared.environment).toEqual({ ARTIUM_SECRET_0: credential.clientSecret,
    MG_AXI_READ_ONLY: 'true', MG_AXI_WRITE_LOG: join(directory, 'writes.log') })
  expect(prepared.secrets).toEqual([credential.clientSecret])
  expect(prepared.files[0].name).toBe('mg-axi/config.json')
  expect(JSON.parse(String(prepared.files[0].content))).toEqual({ version: 1, defaultProfile: 'artium',
    profiles: { artium: { ...credential, clientSecret: { env: 'ARTIUM_SECRET_0' } } } })
  expect(JSON.stringify(prepared.files)).not.toContain(credential.clientSecret)
  expect(profile.metadata(credential)).toEqual({ ...identity, auth: 'client-secret' })
})

test('accepts the approved federated application profile without changing its mode or auth kind', () => {
  const profile = new CredentialProfile(schema)
  const prepared = profile.prepare('mg-axi', { ...identity, auth: 'federated', token: 'CANARY-federated-token' }, join(directory, 'writes.log'), false)
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium).toEqual({ ...identity, auth: 'federated', token: { env: 'ARTIUM_SECRET_0' } })
  expect(prepared.secrets).toEqual(['CANARY-federated-token'])
})

test('prepares a published delegated Graph profile with host token material', () => {
  const profile = loadCredentialProfile('mg-axi', join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!
  const value = { mode: 'delegated', tenantId: identity.tenantId, clientId: identity.clientId, token: 'CANARY-delegated-token' }
  const prepared = profile.prepare('mg-axi', value, join(directory, 'writes.log'), false)
  expect(prepared.environment.ARTIUM_SECRET_0).toBe(value.token)
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium).toEqual({ ...value, token: { env: 'ARTIUM_SECRET_0' } })
  expect(profile.metadata(value)).toEqual({ mode: value.mode, tenantId: value.tenantId, clientId: value.clientId })
})

test.each([' CANARY-token', 'CANARY-token ', 'CANARY token', 'CANARY-token\n', 'CANARY-token\r\n',
  'CANARY\ttoken', 'CANARY\u00a0token'])('published Vectra refuses whitespace token %j before preparation', token => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const value = { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token }
  expect(profile.credentialSchema.safeParse(value).success).toBe(false)
  expect(() => profile.prepare('vectra-axi', value, join(directory, 'writes.log'), false))
    .toThrow(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE' }))
})

test('published Vectra retains whitespace in OAuth secret material', () => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const value = { kind: 'qux', apiVersion: '2.5', auth: 'oauth', origin: 'https://appliance.test',
    clientId: 'synthetic', clientSecret: 'CANARY secret\n' }
  expect(profile.prepare('vectra-axi', value, join(directory, 'writes.log'), false).environment.ARTIUM_SECRET_0)
    .toBe(value.clientSecret)
})

test.each([
  { kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-token', origin: 'https://appliance.test' },
  { kind: 'qux', apiVersion: '2.5', auth: 'oauth', clientId: 'synthetic', clientSecret: 'CANARY-secret', origin: 'https://appliance.test:8443' },
  { kind: 'rux', apiVersion: '3.4', auth: 'oauth', clientId: 'synthetic', clientSecret: 'CANARY-secret', origin: 'https://[::1]:8443' },
])('published Vectra prepares canonical origin $origin for $kind $auth', value => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const prepared = profile.prepare('vectra-axi', value, join(directory, 'writes.log'), false)
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium.origin).toBe(value.origin)
  expect(profile.metadata(value).origin).toBe(value.origin)
})

test.each(['https://appliance.test:443', 'https://APPLIANCE.test', 'https://appliance.test:08443',
  'https://appliance.test/', 'https://appliance.test/path', 'https://appliance.test?query',
  'https://appliance.test#fragment', 'https://user:password@appliance.test', 'http://appliance.test',
  'https://appliance.test\n', 'invalid'])('published Vectra refuses noncanonical origin %j before preparation', origin => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const value = { kind: 'qux', apiVersion: '2.5', auth: 'token', origin, token: 'CANARY-token' }
  expect(profile.credentialSchema.safeParse(value).success).toBe(false)
  expect(() => profile.prepare('vectra-axi', value, join(directory, 'writes.log'), false))
    .toThrow(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE' }))
})

test('uses SHA-256 certificate fields in the migrated adapter while retaining argument policy', async () => {
  const value = { ...identity, auth: 'certificate', privateKey: 'CANARY-private-key', thumbprintSha256: 'a'.repeat(64) }
  const profile = new CredentialProfile(schema)
  const adapter = createMgAdapter({ getCredential: async () => value }, join(directory, 'writes.log'), profile)
  const prepared = await adapter.prepare(['entra', 'user', 'list'], { id: 'synthetic', tool: 'mg-axi', revision: 1 })
  expect(prepared.environment.ARTIUM_SECRET_0).toBe(value.privateKey)
  expect(String(prepared.files[0].content)).toContain('thumbprintSha256')
  await expect(adapter.prepare(['auth', 'login'], { id: 'synthetic', tool: 'mg-axi' })).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test('extracts nested and referenced secrets for draft 2020-12 schemas', () => {
  const profile = new CredentialProfile({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    additionalProperties: false, required: ['keys'], properties: { keys: { type: 'array', items: {
      $ref: '#/$defs/key',
    } } }, $defs: { key: { 'x-secret': true, type: 'object', additionalProperties: false,
      required: ['env'], properties: { env: { type: 'string' } } } } })
  const prepared = profile.prepare('falcon-axi', { keys: ['CANARY-a', 'CANARY-b'] }, join(directory, 'writes.log'), false)
  expect(prepared.environment).toMatchObject({ ARTIUM_SECRET_0: 'CANARY-a', ARTIUM_SECRET_1: 'CANARY-b' })
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium.keys).toEqual([{ env: 'ARTIUM_SECRET_0' }, { env: 'ARTIUM_SECRET_1' }])
})

test('validates the materialized SecretRef against the shipped schema', () => {
  const invalid = structuredClone(schema)
  invalid.$defs.secret.oneOf[0].properties!.env!.pattern = '^OTHER_'
  expect(() => new CredentialProfile(invalid).prepare('mg-axi', credential, join(directory, 'writes.log'), false))
    .toThrow(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE' }))
})

test('accepts all approved flat az token fields without translating their names', () => {
  const profile = new CredentialProfile(azSchema)
  const value = { auth: 'token', tenantId: identity.tenantId, armToken: 'CANARY-arm', logsToken: 'CANARY-logs',
    graphToken: 'CANARY-graph', storageToken: 'CANARY-storage', vaultToken: 'CANARY-vault', registryToken: 'CANARY-registry' }
  const prepared = profile.prepare('az-axi', value, join(directory, 'writes.log'), true)
  expect(prepared.environment).toEqual({ ARTIUM_SECRET_0: value.armToken, ARTIUM_SECRET_1: value.logsToken,
    ARTIUM_SECRET_2: value.graphToken, ARTIUM_SECRET_3: value.storageToken, ARTIUM_SECRET_4: value.vaultToken,
    ARTIUM_SECRET_5: value.registryToken, AZ_AXI_READ_ONLY: 'true', AZ_AXI_WRITE_LOG: join(directory, 'writes.log') })
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium).toEqual({ auth: 'token', tenantId: value.tenantId,
    armToken: { env: 'ARTIUM_SECRET_0' }, logsToken: { env: 'ARTIUM_SECRET_1' }, graphToken: { env: 'ARTIUM_SECRET_2' },
    storageToken: { env: 'ARTIUM_SECRET_3' }, vaultToken: { env: 'ARTIUM_SECRET_4' }, registryToken: { env: 'ARTIUM_SECRET_5' } })
  expect(prepared.secrets).toEqual([value.armToken, value.logsToken, value.graphToken, value.storageToken, value.vaultToken, value.registryToken])
  expect(profile.metadata(value)).toEqual({ auth: 'token', tenantId: value.tenantId })
})

test('accepts the approved az ambient kind without injecting a secret', () => {
  const value = { auth: 'az', tenantId: identity.tenantId }
  const prepared = new CredentialProfile(azSchema).prepare('az-axi', value, join(directory, 'writes.log'), false)
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium).toEqual(value)
  expect(prepared.environment).toEqual({ AZ_AXI_READ_ONLY: 'false', AZ_AXI_WRITE_LOG: join(directory, 'writes.log') })
  expect(prepared.secrets).toEqual([])
})
