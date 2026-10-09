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
