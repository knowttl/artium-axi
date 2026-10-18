import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import schema from '../../../test/fixtures/axi-credential.schema.json' with { type: 'json' }
import azSchema from '../../../test/fixtures/az-credential.schema.json' with { type: 'json' }
import { CredentialProfile, loadCredentialProfile } from './credential-profile.js'
import { createMgAdapter } from './mg.js'
import { formatNames } from 'ajv-formats/dist/formats.js'
import { credentialFormats, standardCredentialFormats } from './credential-input.js'

const identity = { mode: 'application', tenantId: '11111111-1111-4111-8111-111111111111', clientId: '22222222-2222-4222-8222-222222222222' }
const credential = { ...identity, auth: 'client-secret', clientSecret: 'CANARY-host-secret' }

test('every custom credential format explicitly declares its normalization policy', () => {
  for (const format of Object.values(credentialFormats)) {
    expect(typeof format.normalize === 'function' || format.normalize === 'none').toBe(true)
  }
  expect(Object.keys(standardCredentialFormats).sort()).toEqual([...formatNames].sort())
  expect(new Set(Object.values(standardCredentialFormats))).toEqual(new Set(['none']))
})

test.each([
  ['https://appliance.test/', 'https://appliance.test', 'canonicalized format'],
  ['https://appliance.test:443', 'https://appliance.test', 'canonicalized format'],
  ['https://Appliance.Test', 'https://appliance.test', 'canonicalized format'],
  [' https://appliance.test ', 'https://appliance.test', 'removed surrounding whitespace'],
  ['HTTPS://Appliance.Test:443/', 'https://appliance.test', 'canonicalized format'],
])('normalizes rejected origin %j at the save boundary', (origin, expected, reason) => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const input = { kind: 'qux', apiVersion: '2.5', auth: 'token', origin, token: 'CANARY-token' }
  expect(profile.credentialSchema.safeParse(input).success).toBe(false)
  const normalized = profile.parseInput(input)
  expect(normalized.value).toEqual({ ...input, origin: expected })
  expect(normalized.normalizations).toEqual([{ field: 'origin', reason }])
  expect(profile.parseInput(normalized.value)).toEqual({ value: normalized.value, normalizations: [] })
  expect(input.origin).toBe(origin)
})

test.each([' CANARY-token', 'CANARY-token ', 'CANARY-token\n'])('normalizes rejected token ends without reporting secret material', token => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  const result = profile.parseInput({ kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token })
  expect(result.value.token).toBe('CANARY-token')
  expect(result.normalizations).toEqual([{ field: 'token', reason: 'removed surrounding whitespace' }])
  expect(JSON.stringify(result.normalizations)).not.toContain('CANARY')
})

test.each(['https://appliance.test/path', 'https://appliance.test?query', 'http://appliance.test',
  'https://CANARY-user:CANARY-password@appliance.test', 'https://applia\nnce.test', 'https://appliance.test\\'])('rejects ambiguous origin %j with a safe field reason', origin => {
  const profile = loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!
  expect(() => profile.parseInput({ kind: 'qux', apiVersion: '2.5', auth: 'token', origin, token: 'CANARY-token' }))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('origin') }))
  try { profile.parseInput({ kind: 'qux', apiVersion: '2.5', auth: 'token', origin, token: 'CANARY-token' }) }
  catch (error) { expect(String(error)).not.toContain('CANARY') }
})

test('valid values stay byte for byte unchanged even when another field needs normalization', () => {
  const profile = new CredentialProfile(schema)
  const input = { ...credential, tenantId: ` ${identity.tenantId} `, clientSecret: ' CANARY secret\r\n' }
  const result = profile.parseInput(input)
  expect(result.value).toEqual({ ...input, tenantId: identity.tenantId })
  expect(result.normalizations).toEqual([{ field: 'tenantId', reason: 'removed surrounding whitespace' }])
  expect(profile.parseInput(result.value)).toEqual({ value: result.value, normalizations: [] })
})

test.each([
  [{ type: 'string', pattern: '^\\S+$' }, ' synthetic ', 'synthetic'],
  [{ enum: ['simple'] }, ' simple\n', 'simple'],
  [{ type: 'string', contentMediaType: 'application/x-pem-file', pattern: '^-----BEGIN [\\s\\S]*-----END KEY-----$' },
    ' \r\n-----BEGIN KEY-----\r\nCANARY interior line\r\n-----END KEY-----\r\n',
    '-----BEGIN KEY-----\nCANARY interior line\n-----END KEY-----'],
])('uses generic schema rules for %j', (field, input, expected) => {
  const profile = new CredentialProfile({ type: 'object', properties: { value: field } })
  const result = profile.parseInput({ value: input })
  expect(result.value.value).toBe(expected)
  expect(result.normalizations).toHaveLength(1)
  expect(profile.parseInput(result.value).normalizations).toEqual([])
})

test.each(['ldaps://DIRECTORY.test:636/', 'ldap://directory.test/', 'ldaps://directory.test:636'])('preserves already valid LDAP URL %j', url => {
  const profile = loadCredentialProfile('ldap-axi', join(process.cwd(), 'tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json'))!
  const value = { url, auth: 'simple', bindDn: 'uid=synthetic', bindPassword: 'CANARY password', startTls: url.startsWith('ldap:') }
  expect(profile.parseInput(value)).toEqual({ value, normalizations: [] })
})

test.each([
  [' LDAPS://DIRECTORY.test:636/ ', 'ldaps://directory.test'],
  [' LDAP://DIRECTORY.test:389/ ', 'ldap://directory.test'],
])('canonicalizes rejected LDAP URL %j using its registered format', (url, expected) => {
  const profile = loadCredentialProfile('ldap-axi', join(process.cwd(), 'tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json'))!
  const result = profile.parseInput({ url, auth: 'simple', bindDn: 'uid=synthetic', bindPassword: 'CANARY password', startTls: expected.startsWith('ldap:') })
  expect(result.value.url).toBe(expected)
  expect(result.normalizations).toEqual([{ field: 'url', reason: 'canonicalized format' }])
  expect(profile.parseInput(result.value)).toEqual({ value: result.value, normalizations: [] })
})

test('boolean input is never coerced from a string', () => {
  const profile = new CredentialProfile({ type: 'object', properties: { enabled: { type: 'boolean' } } })
  expect(profile.parseInput({ enabled: true })).toEqual({ value: { enabled: true }, normalizations: [] })
  expect(() => profile.parseInput({ enabled: ' true ' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT',
    message: 'enabled must be boolean.' }))
})

test('conditional missing-secret errors name the required field and selector without values', () => {
  const profile = new CredentialProfile(schema)
  expect(() => profile.parseInput(identity)).toThrow(expect.objectContaining({ message: expect.stringContaining('auth') }))
  expect(() => profile.parseInput({ ...identity, auth: 'client-secret' }))
    .toThrow(expect.objectContaining({ message: expect.stringContaining('clientSecret is required for the selected auth') }))
  expect(() => profile.parseInput({ ...identity, auth: 'federated', token: 'CANARY interior whitespace' })).not.toThrow()
})

test.each([
  [{ unexpected: 'CANARY-unsupported-value' }, 'unexpected is an unsupported field.'],
  [{ pageSize: 0 }, 'pageSize must be >= 1.'],
  [{ pageSize: 1001 }, 'pageSize must be <= 1000.'],
])('reports safe LDAP field diagnostics for %j', (fields, message) => {
  const profile = loadCredentialProfile('ldap-axi', join(process.cwd(), 'tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json'))!
  const value = { url: 'ldaps://directory.test', auth: 'simple', bindDn: 'uid=synthetic', bindPassword: 'CANARY-password', ...fields }
  expect(() => profile.parseInput(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message }))
  const result = profile.credentialSchema.safeParse(value)
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('CANARY')
})

test.each([
  ['minimum', 0, '>='],
  ['maximum', 2, '<='],
  ['exclusiveMinimum', 1, '>'],
  ['exclusiveMaximum', 1, '<'],
])('reports the numeric %s bound', (keyword, value, comparison) => {
  const profile = new CredentialProfile({ type: 'object', properties: { value: { type: 'number', [keyword]: 1 } } })
  expect(() => profile.parseInput({ value })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT',
    message: `value must be ${comparison} 1.` }))
})

test.each(['oneOf', 'anyOf'])('preserves %s conflicts alongside concrete field diagnostics', keyword => {
  const { oneOf, ...common } = schema
  const profile = new CredentialProfile({ ...common, [keyword]: oneOf })
  const value = { ...credential, privateKey: 'CANARY-key', tenantId: 'CANARY-invalid-tenant' }
  const result = profile.credentialSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Expected invalid credential')
  expect(result.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['tenantId'], message: 'tenantId must match the uuid format.' }),
    expect.objectContaining({ path: [], message: expect.stringMatching(/^(?=.*auth)(?=.*clientSecret)(?=.*privateKey).*must satisfy the selected credential field combination/) }),
  ]))
  expect(() => profile.parseInput(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT',
    message: expect.stringContaining('must satisfy the selected credential field combination') }))
  expect(JSON.stringify(result)).not.toContain('CANARY')
})

test.each([
  ['armToken', 'arm'],
  ['logsToken', 'logs'],
  ['graphToken', 'graph'],
  ['storageToken', 'storage'],
  ['vaultToken', 'vault'],
  ['registryToken', 'registry'],
])('names published Azure %s and tokenEnv.%s conflicts without values', (token, resource) => {
  const profile = loadCredentialProfile('az-axi', join(process.cwd(), 'tools/node_modules/@knowttl/az-axi/axi-credential.schema.json'))!
  const value = { auth: 'token', [token]: 'CANARY-secret', tokenEnv: { [resource]: 'CANARY_ENV' } }
  const message = `${token}, tokenEnv.${resource} must not be used in this field combination.`
  expect(() => profile.parseInput(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message }))
  const result = profile.credentialSchema.safeParse(value)
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('CANARY')
})

test('published Azure accepts tokens and environment entries for different resources', () => {
  const profile = loadCredentialProfile('az-axi', join(process.cwd(), 'tools/node_modules/@knowttl/az-axi/axi-credential.schema.json'))!
  const value = { auth: 'token', armToken: 'CANARY-secret', tokenEnv: { logs: 'SYNTHETIC_ENV' } }
  expect(profile.parseInput(value)).toEqual({ value, normalizations: [] })
})

test.each(['arm', 'logs', 'graph', 'storage', 'vault', 'registry'])('normalizes published Azure tokenEnv.%s', resource => {
  const profile = loadCredentialProfile('az-axi', join(process.cwd(), 'tools/node_modules/@knowttl/az-axi/axi-credential.schema.json'))!
  const value = { auth: 'token', tokenEnv: { [resource]: ' SYNTHETIC_ENV ' } }
  expect(profile.credentialSchema.safeParse(value).success).toBe(false)
  const result = profile.parseInput(value)
  expect(result).toEqual({ value: { auth: 'token', tokenEnv: { [resource]: 'SYNTHETIC_ENV' } },
    normalizations: [{ field: `tokenEnv.${resource}`, reason: 'removed surrounding whitespace' }] })
  expect(profile.parseInput(result.value)).toEqual({ value: result.value, normalizations: [] })
  expect(value.tokenEnv[resource]).toBe(' SYNTHETIC_ENV ')
})

test.each(['synthetic.entry', 'synthetic/entry', 'synthetic~entry'])('reports dictionary normalization for %s', name => {
  const profile = new CredentialProfile({ type: 'object', properties: { entries: { type: 'object',
    additionalProperties: { type: 'string', pattern: '^\\S+$' } } } })
  const result = profile.parseInput({ entries: { [name]: ' synthetic ' } })
  expect(result).toEqual({ value: { entries: { [name]: 'synthetic' } },
    normalizations: [{ field: `entries.${name}`, reason: 'removed surrounding whitespace' }] })
  expect(profile.parseInput(result.value)).toEqual({ value: result.value, normalizations: [] })
})

test('preserves valid dictionary values while normalizing a rejected sibling', () => {
  const profile = new CredentialProfile({ type: 'object', properties: {
    accepted: { type: 'object', additionalProperties: { type: 'string' } },
    rejected: { type: 'object', additionalProperties: { type: 'string', pattern: '^\\S+$' } },
  } })
  const value = { accepted: { entry: ' CANARY interior whitespace\n' }, rejected: { entry: ' synthetic ' } }
  expect(profile.parseInput(value)).toEqual({ value: { ...value, rejected: { entry: 'synthetic' } },
    normalizations: [{ field: 'rejected.entry', reason: 'removed surrounding whitespace' }] })
})

test.each([
  ['type', { type: 'string' }, true, 'value must be string.'],
  ['required', { type: 'object', required: ['nested'] }, {}, 'value.nested is required.'],
  ['additionalProperties', { type: 'object', additionalProperties: false }, { unexpected: 'CANARY-value' }, 'value.unexpected is an unsupported field.'],
  ['propertyNames', { type: 'object', propertyNames: { enum: ['allowed'] } }, { 'CANARY-name': 'synthetic' }, 'value must use property names that satisfy the schema.'],
  ['pattern', { type: 'string', pattern: '^synthetic$' }, 'CANARY-value', 'value must match the required character pattern.'],
  ['format', { type: 'string', format: 'uuid' }, 'CANARY-value', 'value must match the uuid format.'],
  ['enum', { enum: ['synthetic'] }, 'CANARY-value', 'value must match an allowed choice.'],
  ['const', { const: 'synthetic' }, 'CANARY-value', 'value must match an allowed choice.'],
  ['minLength', { type: 'string', minLength: 5 }, 'abc', 'value must have a length >= 5.'],
  ['maxLength', { type: 'string', maxLength: 2 }, 'CANARY-value', 'value must have a length <= 2.'],
  ['minItems', { type: 'array', minItems: 2 }, ['CANARY-value'], 'value must contain at least 2 items.'],
  ['maxItems', { type: 'array', maxItems: 0 }, ['CANARY-value'], 'value must contain at most 0 items.'],
  ['uniqueItems', { type: 'array', uniqueItems: true }, ['CANARY-value', 'CANARY-value'], 'value must contain unique items.'],
  ['not', { type: 'object', not: { required: ['first', 'second'] } }, { first: 'CANARY-a', second: 'CANARY-b' },
    'value.first, value.second must not be used in this field combination.'],
  ['allOf', { allOf: [{ type: 'string', maxLength: 2 }] }, 'CANARY-value', 'value must have a length <= 2.'],
  ['oneOf', { oneOf: [{ type: 'string', minLength: 20 }, { type: 'string', maxLength: 2 }] }, 'CANARY-value', 'value must have a length >= 20.'],
  ['anyOf', { anyOf: [{ type: 'string', minLength: 20 }, { type: 'string', maxLength: 2 }] }, 'CANARY-value', 'value must have a length <= 2.'],
  ['if/then', { type: 'object', if: { required: ['enabled'], properties: { enabled: { const: true } } }, then: { required: ['target'] } },
    { enabled: true }, 'value.target is required for the selected enabled.'],
] as const)('reports the %s rejection without input values', (_keyword, field, value, message) => {
  const profile = new CredentialProfile({ type: 'object', properties: { value: field } })
  expect(() => profile.parseInput({ value })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining(message) }))
  const result = profile.credentialSchema.safeParse({ value })
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('CANARY')
  expect(JSON.stringify(result)).not.toContain('does not satisfy the credential rules')
})

test.each([
  ['mg-axi', { ...credential, sensitiveAreas: ['CANARY-area'] }, 'sensitiveAreas must contain at most 0 items.'],
  ['mg-axi', { ...credential, enabledPacks: ['entra', 'entra'] }, 'enabledPacks must contain unique items.'],
  ['mg-axi', { ...credential, writes: { allowWrites: true, operations: [] } }, 'writes.operations must contain at least 1 item.'],
  ['mg-axi', { ...credential, writes: { allowWrites: true, operations: Array(65).fill('synthetic') } }, 'writes.operations must contain at most 64 items.'],
  ['mg-axi', { ...credential, writes: { allowWrites: true, operations: [''] } }, 'writes.operations.0 must have a length >= 1.'],
  ['mg-axi', { ...credential, writes: { allowWrites: true, operations: ['x'.repeat(257)] } }, 'writes.operations.0 must have a length <= 256.'],
  ['vectra-axi', { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token: 'CANARY-token',
    writes: { allowWrites: true, operations: [] } }, 'writes.operations must contain at least 1 item.'],
  ['az-axi', { auth: 'token', armToken: 'CANARY-token', allowWrites: true, subscriptions: [] }, 'subscriptions must contain at least 1 item for the selected allowWrites.'],
  ['az-axi', { auth: 'token', tokenEnv: { 'CANARY-name': 'SYNTHETIC_ENV' } }, 'tokenEnv must use property names that satisfy the schema.'],
] as const)('reports published %s field constraints for %j', (tool, value, message) => {
  const profile = loadCredentialProfile(tool, join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))!
  expect(() => profile.parseInput(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining(message) }))
  const result = profile.credentialSchema.safeParse(value)
  expect(result.success).toBe(false)
  expect(JSON.stringify(result)).not.toContain('CANARY')
  expect(JSON.stringify(result)).not.toContain('does not satisfy the credential rules')
})

test.each([
  ['vectra-axi', { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token: 'CANARY-token', tokenEnv: 'SYNTHETIC_ENV' },
    'token', 'tokenEnv'],
  ['vectra-axi', { kind: 'qux', apiVersion: '2.5', auth: 'token', origin: 'https://appliance.test', token: 'CANARY-token', clientSecret: 'CANARY-secret' },
    'token', 'clientSecret'],
  ['vectra-axi', { kind: 'qux', apiVersion: '2.5', auth: 'oauth', origin: 'https://appliance.test', clientId: 'synthetic', clientSecret: 'CANARY-secret', secretEnv: 'SYNTHETIC_ENV' },
    'clientSecret', 'secretEnv'],
  ['mg-axi', { ...credential, privateKey: 'CANARY-key' }, 'clientSecret', 'privateKey'],
  ['mg-axi', { ...credential, token: 'CANARY-token' }, 'clientSecret', 'token'],
  ['mg-axi', { ...credential, thumbprintSha256: 'a'.repeat(64) }, 'clientSecret', 'thumbprintSha256'],
  ['mg-axi', { ...identity, auth: 'certificate', privateKey: 'CANARY-key', thumbprintSha256: 'a'.repeat(64), token: 'CANARY-token' }, 'privateKey', 'token'],
  ['mg-axi', { ...identity, auth: 'federated', token: 'CANARY-token', privateKey: 'CANARY-key' }, 'token', 'privateKey'],
] as const)('names published %s alternative conflicts for %j', (tool, value, first, second) => {
  const profile = loadCredentialProfile(tool, join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))!
  const result = profile.credentialSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Expected invalid credential')
  const combination = result.error.issues.find(issue => issue.message.endsWith('must satisfy the selected credential field combination.'))
  expect(combination?.message).toContain(first)
  expect(combination?.message).toContain(second)
  expect(() => profile.parseInput(value)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  expect(JSON.stringify(result)).not.toContain('CANARY')
})
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
