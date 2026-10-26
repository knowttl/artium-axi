import { expect, test, vi } from 'vitest'
import { SecretScanner } from '../runner/scan.js'
import { createMgAdapter } from './mg.js'

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
  ['security', 'hunting', 'query', '--file', 'hunt.kql'],
  ['security', 'hunting', 'query', '--help'],
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
