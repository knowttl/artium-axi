import { expect, test } from 'vitest'
import { FakeCredentialStore } from '../../../test/fixtures/credential-store.js'
import { EmbeddedSecretSource } from './secret-source.js'

const reference = { id: 'synthetic-falcon', tool: 'falcon-axi' as const }

test('embedded source retrieves the selected credential from its store', async () => {
  const value = { clientId: 'CANARY-id', clientSecret: 'CANARY-secret', region: 'us-2' }
  const source = new EmbeddedSecretSource(new FakeCredentialStore([{ reference, value }]))
  expect(await source.getCredential(reference)).toEqual(value)
})

test('missing credential is unavailable', async () => {
  const source = new EmbeddedSecretSource(new FakeCredentialStore())
  await expect(source.getCredential(reference)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
})

test.each([
  { ...reference, id: 'other-id' },
  { ...reference, tool: 'vectra-axi' as const },
])('missing credential is unavailable for %j', async selected => {
  const source = new EmbeddedSecretSource(new FakeCredentialStore([{ reference, value: {} }]))
  await expect(source.getCredential(selected)).rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
})
