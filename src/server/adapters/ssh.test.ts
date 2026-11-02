import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createSshAdapter } from './ssh.js'
import { SshHosts } from '../store/ssh-hosts.js'
import { openStore } from '../store/db.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { encryptCredential } from '../store/crypto.js'
import { seedToolUser } from '../../../test/fixtures/tokens.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-ssh-profile-'))
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
const db = openStore(join(directory, 'data', 'artium.db'), provider)
const adapter = createSshAdapter(new SshHosts(db, provider), join(directory, 'writes.log'),
  join(process.cwd(), 'tools/node_modules/@knowttl/ssh-axi/dist/hosted.js'))
beforeAll(async () => {
  await seedToolUser(db)
  const plain = Buffer.from(JSON.stringify({ privateKey: 'CANARY-ordinary-key', passphrase: 'CANARY-passphrase' }))
  const encrypted = encryptCredential('ordinary', 'ssh-axi', plain, provider.getKey())
  plain.fill(0)
  db.prepare(`INSERT INTO ssh_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, updated_at)
    VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, 1)`).run(encrypted)
  db.exec(`INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses, enabled)
    VALUES ('synthetic', '127.0.0.1', 22, '["ssh-ed25519 YWJj"]', '["127.0.0.1"]', 1);
    INSERT INTO ssh_bindings (host_id, username, credential_id) VALUES ('synthetic', 'ordinary', 'ordinary');
    INSERT INTO ssh_grants (host_id, user_id, shell) VALUES ('synthetic', 'synthetic-development-user', 1)`)
})
afterAll(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

test('SSH discovery supplies only the caller ordinary binding without decrypting keys', async () => {
  const allowed = await adapter.prepareForCaller!(['host', 'list'], 'synthetic-development-user')
  expect(allowed.trustedIpc).toEqual({ revision: 1, hosts: [{ id: 'synthetic', address: '127.0.0.1', port: 22, username: 'ordinary' }] })
  expect(allowed.secrets).toEqual([])
  expect((await adapter.prepareForCaller!([], 'other')).trustedIpc).toEqual({ revision: 1, hosts: [] })
})
test('SSH doctor supplies SecretRefs and forces read-only ordinary authentication', async () => {
  const prepared = await adapter.prepareForCaller!(['doctor', 'synthetic'], 'synthetic-development-user')
  expect(prepared.environment).toMatchObject({ SSH_AXI_READ_ONLY: 'true', ARTIUM_SECRET_0: 'CANARY-ordinary-key', ARTIUM_SECRET_1: 'CANARY-passphrase' })
  expect(JSON.parse(String(prepared.files[0].content)).profiles.artium).toMatchObject({ username: 'ordinary', privateKey: { env: 'ARTIUM_SECRET_0' } })
  expect(JSON.stringify(prepared.args)).not.toContain('CANARY')
})
test.each([['exec', 'synthetic', '--command', 'id', '--confirm'], ['connection', 'open', 'synthetic'],
  ['doctor', 'synthetic', '--sudo'], ['doctor', 'synthetic', '--config', '/tmp/other'], ['auth', 'status'],
  ['doctor'], ['host', 'show', 'synthetic', 'extra']].map(args => ({ args })))('SSH refuses unadmitted arguments $args before selecting credentials', ({ args }) => {
  expect(() => adapter.validateArgs(args)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(FLAG_BLOCKED|INVALID_INPUT)$/) }))
})
test('SSH hides unauthorized host handles and rejects caller-controlled input', async () => {
  await expect(adapter.prepareForCaller!(['doctor', 'synthetic'], 'other')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(() => adapter.validateArgs(['doctor', 'synthetic'], { stdin: 'CANARY' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_INPUT' }))
})
