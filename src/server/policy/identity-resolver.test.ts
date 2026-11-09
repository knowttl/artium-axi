import { expect, test } from 'vitest'
import { FakeCredentialStore } from '../../../test/fixtures/credential-store.js'
import { SharedIdentityResolver } from './identity-resolver.js'

test.each(['synthetic-analyst', 'synthetic-administrator'])('shared identity selects the tool credential for %s', async userId => {
  const reference = { id: 'synthetic-falcon', tool: 'falcon-axi' as const }
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference, value: {} },
    { reference: { id: 'synthetic-vectra', tool: 'vectra-axi' }, value: {} },
  ]))
  expect(await resolver.resolve(userId, 'falcon-axi')).toEqual({ ...reference, revision: 1 })
})

test('tool without a shared identity is unavailable', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore())
  await expect(resolver.resolve('synthetic-user', 'az-axi')).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' })
})

const instances = new SharedIdentityResolver(new FakeCredentialStore([
  { reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {} },
  { reference: { id: 'synthetic-production', tool: 'falcon-axi' }, name: 'production', value: {} },
  { reference: { id: 'synthetic-retired', tool: 'falcon-axi' }, name: 'retired', enabled: false, value: {} },
  { reference: { id: 'synthetic-only-disabled', tool: 'vectra-axi' }, name: 'retired', enabled: false, value: {} },
]))

test('named instance is selected by name', async () => {
  expect(await instances.resolve('synthetic-user', 'falcon-axi', 'production')).toMatchObject({ id: 'synthetic-production' })
})

test.each([
  ['falcon-axi', undefined, 'INSTANCE_REQUIRED'],
  ['falcon-axi', 'staging', 'INSTANCE_NOT_FOUND'],
  ['falcon-axi', 'retired', 'INSTANCE_DISABLED'],
  ['vectra-axi', undefined, 'INSTANCE_DISABLED'],
] as const)('%s with instance %s fails with %s', async (tool, instance, code) => {
  await expect(instances.resolve('synthetic-user', tool, instance)).rejects.toMatchObject({ code })
})
