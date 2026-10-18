import { expect, test } from 'vitest'
import { FakeCredentialStore } from '../../../test/fixtures/credential-store.js'
import { SharedIdentityResolver } from './identity-resolver.js'

test.each(['synthetic-analyst', 'synthetic-administrator'])('shared identity selects the tool credential for %s', async userId => {
  const reference = { id: 'synthetic-falcon', tool: 'falcon-axi' as const }
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference, value: {} },
    { reference: { id: 'synthetic-vectra', tool: 'vectra-axi' }, value: {} },
  ]))
  expect(await resolver.resolve(userId, 'falcon-axi')).toEqual(reference)
})

test('tool without a shared identity is unavailable', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore())
  await expect(resolver.resolve('synthetic-user', 'az-axi')).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' })
})
