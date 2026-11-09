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

test('named instance is not found when the tool has no credentials', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore())
  await expect(resolver.resolve('synthetic-user', 'az-axi', 'missing')).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' })
})

const instances = new SharedIdentityResolver(new FakeCredentialStore([
  { reference: { id: 'synthetic-production', tool: 'falcon-axi' }, name: 'production', value: {} },
  { reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {} },
  { reference: { id: 'synthetic-retired', tool: 'falcon-axi' }, name: 'retired', enabled: false, value: {} },
  { reference: { id: 'synthetic-only-disabled', tool: 'vectra-axi' }, name: 'retired', enabled: false, value: {} },
]))

test('named instance is selected by name', async () => {
  expect(await instances.resolve('synthetic-user', 'falcon-axi', 'production')).toMatchObject({ id: 'synthetic-production' })
})

test('run selection retains read-only state without changing the reference', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {}, readOnly: true },
  ]))
  const expected = { reference: { id: 'synthetic-lab', tool: 'falcon-axi', revision: 1 }, readOnly: true }
  expect(await resolver.resolveForRun('synthetic-user', 'falcon-axi', 'lab')).toEqual(expected)
  expect(await resolver.resolveForRun('synthetic-user', 'falcon-axi')).toEqual(expected)
  expect(await resolver.resolve('synthetic-user', 'falcon-axi')).toEqual(expected.reference)
})

test.each([
  ['falcon-axi', 'staging', 'INSTANCE_NOT_FOUND'],
  ['falcon-axi', 'retired', 'INSTANCE_DISABLED'],
  ['vectra-axi', undefined, 'INSTANCE_DISABLED'],
] as const)('%s with instance %s fails with %s', async (tool, instance, code) => {
  await expect(instances.resolve('synthetic-user', tool, instance)).rejects.toMatchObject({ code })
})

test('ambiguous selection lists enabled instances in sorted order', async () => {
  await expect(instances.resolve('synthetic-user', 'falcon-axi')).rejects.toMatchObject({
    code: 'INSTANCE_REQUIRED',
    next: 'Ask the user which instance to use, then run artium-axi --instance <lab|production> falcon-axi ...',
  })
})
