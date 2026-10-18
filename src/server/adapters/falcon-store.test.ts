import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createFalconAdapter } from './falcon.js'
import { SharedIdentityResolver } from '../policy/identity-resolver.js'
import { EmbeddedSecretSource } from '../store/secret-source.js'
import { createCredentialStore, openStore } from '../store/db.js'
import { encryptCredential } from '../store/crypto.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { Runner } from '../runner/runner.js'
import { FakeCredentialStore } from '../../../test/fixtures/credential-store.js'

let directory: string
const reference = { id: 'synthetic-falcon', tool: 'falcon-axi' as const }
const credential = { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-2', memberCid: 'synthetic-member' }
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 3).toString('base64') })

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'artium-falcon-store-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

test('Falcon prepares the persisted shared credential after database reopen', async () => {
  const file = join(directory, 'artium.db')
  const db = openStore(file, provider)
  const row = encryptCredential(reference.id, reference.tool, Buffer.from(JSON.stringify(credential)), provider.getKey())
  db.prepare('UPDATE tools SET pinned_version = ? WHERE name = ?').run('0.3.0', reference.tool)
  db.prepare('INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag) VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag)').run(row)
  db.close()
  const reopened = openStore(file, provider)
  try {
    const store = createCredentialStore(reopened, provider)
    expect(store.findCredential('az-axi')).toBeUndefined()
    expect(store.readCredential({ ...reference, id: 'missing' })).toBeUndefined()
    expect(store.readCredential({ ...reference, tool: 'vectra-axi' })).toBeUndefined()
    const identity = await new SharedIdentityResolver(store).resolve('synthetic-user', 'falcon-axi')
    const adapter = createFalconAdapter(new EmbeddedSecretSource(store))
    const prepared = await adapter.prepare(['detection', 'list', '--help'], identity)
    expect(prepared).toEqual({
      executable: '/opt/falcon-axi/bin/falcon-axi',
      args: ['detection', 'list', '--help', '--region', 'us-2', '--member-cid', 'synthetic-member'],
      environment: { FALCON_CLIENT_ID: credential.clientId, FALCON_CLIENT_SECRET: credential.clientSecret, FALCON_AXI_READ_ONLY: 'true' },
      secrets: [credential.clientId, credential.clientSecret], files: [], limits: { runtime: 'python', timeoutMs: 60_000 },
    })
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const result = await runner.run('synthetic-user', process.execPath, ['-e', 'console.log(process.env.FALCON_CLIENT_ID === "CANARY-falcon-id" && process.env.FALCON_CLIENT_SECRET === "CANARY-falcon-secret")'], prepared.environment, prepared.secrets)
      expect(result.stdout).toBe('true\n')
      expect(result.exitCode).toBe(0)
      await expect(runner.run('synthetic-user', process.execPath, ['-e', 'console.log(process.env.FALCON_CLIENT_SECRET)'], prepared.environment, prepared.secrets))
        .rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
    } finally { await runner.shutdown() }
  } finally { reopened.close() }
})

test.each([['--region=us-1'], ['--member-cid', 'other'], ['--'], ['auth', 'login']])('security stored Falcon rejects %j before secret retrieval', async (...args) => {
  const getCredential = vi.fn()
  await expect(createFalconAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([{}, { ...credential, clientSecret: '' }, { ...credential, clientSecret: 7 }])('invalid stored Falcon credential is unavailable', async value => {
  const source = new EmbeddedSecretSource(new FakeCredentialStore([{ reference, value }]))
  await expect(createFalconAdapter(source).prepare([], reference)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})

test('Falcon refuses an identity selected for another tool before retrieval', async () => {
  const getCredential = vi.fn()
  await expect(createFalconAdapter({ getCredential }).prepare([], { ...reference, tool: 'vectra-axi' }))
    .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
  expect(getCredential).not.toHaveBeenCalled()
})
