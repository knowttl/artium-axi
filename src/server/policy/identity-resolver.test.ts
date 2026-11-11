import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { FakeCredentialStore } from '../../../test/fixtures/credential-store.js'
import { grantToolAccess } from '../../../test/fixtures/tokens.js'
import { openStore } from '../store/db.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { SharedIdentityResolver } from './identity-resolver.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-identity-resolver-'))
const db = openStore(join(directory, 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
for (const userId of ['synthetic-analyst', 'synthetic-administrator', 'synthetic-user']) grantToolAccess(db, userId)
afterAll(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('a user whose roles grant no access to the tool cannot select its credential', async () => {
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-ungranted', 'synthetic-ungranted', 'Ungranted', 'CANARY-hash')").run()
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([{ reference: { id: 'synthetic-falcon', tool: 'falcon-axi' }, value: {} }]), db)
  await expect(resolver.resolve('synthetic-ungranted', 'falcon-axi')).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' })
  expect(resolver.usableInstances('synthetic-ungranted', 'falcon-axi')).toEqual([])
})

test.each(['synthetic-analyst', 'synthetic-administrator'])('shared identity selects the tool credential for %s', async userId => {
  const reference = { id: 'synthetic-falcon', tool: 'falcon-axi' as const }
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference, value: {} },
    { reference: { id: 'synthetic-vectra', tool: 'vectra-axi' }, value: {} },
  ]), db)
  expect(await resolver.resolve(userId, 'falcon-axi')).toEqual({ ...reference, revision: 1 })
})

test('tool without a shared identity is unavailable', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore(), db)
  await expect(resolver.resolve('synthetic-user', 'az-axi')).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' })
})

test('named instance is not found when the tool has no credentials', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore(), db)
  await expect(resolver.resolve('synthetic-user', 'az-axi', 'missing')).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND' })
})

const instances = new SharedIdentityResolver(new FakeCredentialStore([
  { reference: { id: 'synthetic-production', tool: 'falcon-axi' }, name: 'production', value: {} },
  { reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {} },
  { reference: { id: 'synthetic-retired', tool: 'falcon-axi' }, name: 'retired', enabled: false, value: {} },
  { reference: { id: 'synthetic-only-disabled', tool: 'vectra-axi' }, name: 'retired', enabled: false, value: {} },
]), db)

test('named instance is selected by name', async () => {
  expect(await instances.resolve('synthetic-user', 'falcon-axi', 'production')).toMatchObject({ id: 'synthetic-production' })
})

test('run selection retains read-only state without changing the reference', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {}, readOnly: true },
  ]), db)
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

test('an origin-only AWX credential is excluded from usable instances', async () => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'legacy', tool: 'awx-axi' }, name: 'legacy', value: { origin: 'https://example.invalid' } },
    { reference: { id: 'named', tool: 'awx-axi' }, name: 'named', value: { origin: 'https://example.invalid', token: 'CANARY-token' } },
  ]), db)
  expect(resolver.usableInstances('synthetic-user', 'awx-axi').map(instance => instance.name)).toEqual(['named'])
  expect(await resolver.resolve('synthetic-user', 'awx-axi')).toMatchObject({ id: 'named' })
})

test.each([undefined, 'legacy'])('an enabled origin-only AWX credential is unconfigured for selection %s', async name => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'legacy', tool: 'awx-axi' }, name: 'legacy', value: { origin: 'https://example.invalid' } },
  ]), db)
  await expect(resolver.resolve('synthetic-user', 'awx-axi', name)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' })
})

test.each([undefined, 'legacy'])('a disabled origin-only AWX credential is disabled for selection %s', async name => {
  const resolver = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'legacy', tool: 'awx-axi' }, name: 'legacy', enabled: false, value: { origin: 'https://example.invalid' } },
  ]), db)
  await expect(resolver.resolve('synthetic-user', 'awx-axi', name)).rejects.toMatchObject({ code: 'INSTANCE_DISABLED' })
})
