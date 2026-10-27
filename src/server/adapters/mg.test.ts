import { expect, test, vi } from 'vitest'
import { SecretScanner } from '../runner/scan.js'
import { createMgAdapter } from './mg.js'
import { loadCredentialProfile } from './credential-profile.js'

const reference = { id: 'synthetic-graph', tool: 'mg-axi' as const, revision: 1 }
const identity = { tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' }
const writes = { allowWrites: true, operations: ['mg.entra.group.member.add'] }

test.each([
  { ...identity, auth: 'secret', clientSecret: 'CANARY-graph-secret' },
  { ...identity, auth: 'certificate', privateKey: 'CANARY-graph-key', thumbprint: 'AB'.repeat(20) },
])('$auth profile references the supplied holder and retains native policy', async credential => {
  const call = await createMgAdapter({ getCredential: async () => ({ ...credential, writes }) }, '/tmp/writes.log')
    .prepare(['entra', 'user', 'list'], reference)
  const profile = JSON.parse(call.files[0].content as string).profiles.artium
  const holder = profile.credentialRef.secretEnv ?? profile.credentialRef.keyEnv
  const secret = 'clientSecret' in credential ? credential.clientSecret : credential.privateKey
  expect(call.environment[holder]).toBe(secret)
  expect(profile).toMatchObject({ mode: 'application', allowDeviceCode: false, writes })
  expect(profile.enabledPacks).toEqual(['entra'])
  expect(call.files[0].content).not.toContain(secret)
  for (const value of call.secrets) {
    expect(new SecretScanner(call.secrets).scan('stdout', Buffer.from(encodeURIComponent(value)))).toBe(true)
    expect(new SecretScanner(call.secrets).scan('stderr', Buffer.from(Buffer.from(value).toString('base64')))).toBe(true)
  }
})

test.each([
  ['entra', 'user', 'list', '--profile=other'], ['entra', 'user', 'list', '--config', '/data/artium.db'],
  ['login'], ['profile', 'create'], ['setup', 'hooks'], ['update'], ['api', 'POST', '/users'],
  ['api', 'PUT', '/users'], ['api', 'PATCH', '/users'], ['api', 'DELETE', '/users'],
  ['api', 'HEAD', '/users'], ['api', 'OPTIONS', '/users'],
  ['entra', 'user', 'list', '--scopes', 'https://graph.microsoft.com/User.Read.All'],
].map(args => [args]))('blocked override or command refuses credential retrieval: %j', async args => {
  const getCredential = vi.fn()
  await expect(createMgAdapter({ getCredential }, '/tmp/writes.log').prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('only cursor stdin is accepted as input', async () => {
  const adapter = createMgAdapter({ getCredential: async () => ({ ...identity, auth: 'secret', clientSecret: 'CANARY-secret' }) }, '/tmp/writes.log')
  expect(() => adapter.validateArgs(['entra', 'user', 'list'], { stdin: 'unreviewed' })).toThrow()
  expect(() => adapter.validateArgs(['entra', 'user', 'list'], { files: [{ name: 'input', contentBase64: '' }] })).toThrow()
  const call = await adapter.prepare(['entra', 'user', 'list', '--cursor=-'], reference, { stdin: 'opaque' })
  expect(call.args).toEqual(['entra', 'user', 'list', '--cursor=-'])
  expect(JSON.parse(call.files[0].content as string).profiles.artium.writes).toBeUndefined()
})

test.each([
  ['entra', 'user', 'list', '--full', 'extra'],
  ['entra', 'user', 'list', '--cursor', 'synthetic-cursor', 'extra'],
].map(args => [args]))('trailing positional arguments are named before credential retrieval: %j', async args => {
  const getCredential = vi.fn()
  const adapter = createMgAdapter({ getCredential }, '/tmp/writes.log')
  const error = { code: 'INVALID_INPUT', message: 'Unexpected argument "extra" for mg-axi entra user list.' }
  expect(() => adapter.validateArgs(args)).toThrow(expect.objectContaining(error))
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject(error)
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([
  ['api'], ['api', '--help'], ['api', 'gte', '/users'],
].map(args => [args]))('invalid API commands name the problem before credential retrieval: %j', async args => {
  const getCredential = vi.fn()
  const adapter = createMgAdapter({ getCredential }, '/tmp/writes.log')
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('command "api') })
  expect(getCredential).not.toHaveBeenCalled()
})

test('reviewed API GET retains its path and flags', async () => {
  const adapter = createMgAdapter({ getCredential: async () => ({ ...identity, auth: 'secret', clientSecret: 'CANARY-secret' }) }, '/tmp/writes.log')
  const args = ['api', 'get', '/users', '--full']
  expect(() => adapter.validateArgs(args)).not.toThrow()
  expect((await adapter.prepare(args, reference)).args).toEqual(args)
})

const hunting = ['security', 'hunting', 'query', '--file=query.kql']
const query = 'DeviceEvents | where ActionType == "CANARY-query" | take 1'
const upload = { name: 'query.kql', contentBase64: Buffer.from(query).toString('base64') }

test.each([false, true])('hunting requires explicit administrator opt-in with published profile: %s', async published => {
  let enabledPacks = ['entra']
  const adapter = createMgAdapter({ getCredential: async () => ({ ...identity, ...(published ? { mode: 'application' } : {}),
    auth: published ? 'client-secret' : 'secret', clientSecret: 'CANARY-secret', enabledPacks }) }, '/tmp/writes.log',
  published ? loadCredentialProfile('mg-axi', 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json') : undefined)
  await expect(adapter.prepare(hunting, reference, { files: [upload] })).rejects.toMatchObject({
    code: 'FLAG_BLOCKED', message: expect.stringContaining('enabledPacks') })
  enabledPacks = ['entra', 'security']
  const call = await adapter.prepare(hunting, reference, { files: [upload] })
  expect(call.args).toEqual(['security', 'hunting', 'query', '--file', 'query.kql'])
  expect(call.fileArguments).toEqual([4])
  expect(JSON.parse(call.files[0].content as string).profiles.artium.enabledPacks).toEqual(enabledPacks)
  expect(new SecretScanner(call.secrets).scan('stdout', Buffer.from(query))).toBe(true)
  expect(new SecretScanner(call.secrets).scan('stderr', Buffer.from('CANARY-secret'))).toBe(true)
})

test.each([
  { files: [] },
  { files: [upload, { ...upload, name: 'extra.kql' }] },
  { files: [{ ...upload, name: '../query.kql' }] },
  { files: [{ ...upload, contentBase64: Buffer.alloc(65537, 65).toString('base64') }] },
  { files: [{ ...upload, contentBase64: Buffer.from([0xff]).toString('base64') }] },
  { files: [{ ...upload, contentBase64: Buffer.from('a\0b').toString('base64') }] },
  { files: [upload], stdin: query },
])('hunting refuses unreviewed upload case %# without retrieving credentials', async input => {
  const getCredential = vi.fn()
  await expect(createMgAdapter({ getCredential }, '/tmp/writes.log').prepare(hunting, reference, input))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['../query.kql', '/tmp/query.kql', 'other.kql', '-'])('hunting refuses caller paths: %s', async name => {
  const adapter = createMgAdapter({ getCredential: vi.fn() }, '/tmp/writes.log')
  await expect(adapter.prepare(['security', 'hunting', 'query', '--file', name], reference, { files: [upload] }))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test('hunting accepts the exact byte cap', async () => {
  const adapter = createMgAdapter({ getCredential: async () => ({ ...identity,
    auth: 'secret', clientSecret: 'CANARY-secret', enabledPacks: ['entra', 'security'] }) }, '/tmp/writes.log')
  const call = await adapter.prepare(hunting, reference,
    { files: [{ ...upload, contentBase64: Buffer.alloc(65536, 65).toString('base64') }] })
  expect(call.fileArguments).toEqual([4])
})

test.each([
  [...hunting, query],
  ['security', 'hunting', 'query', '--file=' + query + '\n'],
].map(args => [args]))('hunting diagnostic case %# does not echo query arguments', args => {
  const adapter = createMgAdapter({ getCredential: vi.fn() }, '/tmp/writes.log')
  expect(() => adapter.validateArgs(args, { files: [upload] }))
    .toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: 'The request input is invalid.' }))
})
