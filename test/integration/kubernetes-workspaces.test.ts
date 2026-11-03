import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createKubernetesAdapter } from '../../src/server/adapters/kubernetes.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

const prefix = '/v1/tools/kubernetes-axi/workspaces'
const user = 'synthetic-development-user'
const secret = 'CANARY-workspace-credential+/='
const binary = Buffer.from([0, 255, 254, 128, 13, 10, 1, 0])
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const descriptor = (path: string, bytes = binary) => ({ path, bytes: bytes.length, sha256: digest(bytes) })
let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: { authorization: string }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  directory = await mkdtemp(join(tmpdir(), 'artium-workspaces-test-'))
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  db = openStore(join(directory, 'data', 'artium.db'), key)
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'kubernetes-axi'")
  const credentials = createCredentialStore(db, key)
  credentials.replaceCredential('kubernetes-axi', { origin: 'https://127.0.0.1:1', auth: 'token',
    namespace: 'synthetic', certificateAuthority: 'CANARY-CA-PEM', token: secret }, 0, user, Date.now())
  const adapter = await createKubernetesAdapter(new EmbeddedSecretSource(credentials), join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')),
    resolver: new SharedIdentityResolver(credentials), adapters: [adapter], credentialStore: credentials, environment: {} })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, user)}` }
  await app.ready()
})
afterEach(async () => {
  await app.close()
  db.close()
  await rm(directory, { recursive: true, force: true })
  vi.useRealTimers()
})
async function create(files = [descriptor('nested/input.bin')], lifetimeSeconds = 300) {
  const response = await app.inject({ method: 'POST', url: prefix, headers, payload: { files, lifetimeSeconds } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json<{ id: string }>().id
}
const upload = (id: string, path: string, bytes = binary) => app.inject({ method: 'PUT',
  url: `${prefix}/${id}/files/${path}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })

test('an authenticated caller round trips a recursive tree with exact binary hashes', async () => {
  const manifest = Buffer.from('apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: synthetic\n')
  const id = await create([descriptor('nested/input.bin'), descriptor('manifests/config.yaml', manifest)])
  expect((await upload(id, 'nested/input.bin')).statusCode).toBe(200)
  expect((await upload(id, 'manifests/config.yaml', manifest)).statusCode).toBe(200)
  const status = await app.inject({ url: `${prefix}/${id}`, headers })
  expect(status.json().ready).toBe(true)
  const result = await app.inject({ url: `${prefix}/${id}/files/nested/input.bin`, headers })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.rawPayload).toEqual(binary)
  expect(result.headers['x-artium-content-sha256']).toBe(digest(binary))
  expect((await upload(id, 'nested/input.bin')).statusCode).toBe(400)
  expect((await app.inject({ method: 'DELETE', url: `${prefix}/${id}`, headers })).statusCode).toBe(204)
  expect((await app.inject({ url: `${prefix}/${id}/files/nested/input.bin`, headers })).statusCode).toBe(404)
})

test.each([
  { files: [descriptor('../outside')] },
  { files: [descriptor('/outside')] },
  { files: [descriptor('a\\outside')] },
  { files: [descriptor('tree/link'), { ...descriptor('tree/outside'), link: '/outside' }] },
  { files: [{ ...descriptor('large'), bytes: 100 * 1024 * 1024 + 1 }] },
  { files: ['a', 'b', 'c'].map(path => ({ ...descriptor(path), bytes: 100 * 1024 * 1024 })) },
  { files: [descriptor('a'), descriptor('a/b')] },
  { files: [descriptor('a'), descriptor('a')] },
])('refuses unsafe or oversized manifests before upload: %j', async payload => {
  const response = await app.inject({ method: 'POST', url: prefix, headers, payload })
  expect(response.statusCode).toBe(400)
})

test.each([Buffer.from('corrupt'), Buffer.concat([binary, Buffer.from([1])])])('a failed upload invalidates the workspace: %j', async bytes => {
  const id = await create()
  expect((await upload(id, 'nested/input.bin', bytes)).statusCode).toBe(400)
  expect((await app.inject({ url: `${prefix}/${id}`, headers })).statusCode).toBe(404)
})

test('workspace identifiers do not authorize another user or login family', async () => {
  const id = await create()
  expect((await upload(id, 'nested/input.bin')).statusCode).toBe(200)
  db.exec("INSERT INTO users (id, username, display_name, source, must_change) VALUES ('other', 'other', 'Other', 'sso', 0); INSERT INTO user_roles (user_id, role_id) VALUES ('other', 'synthetic-role')")
  for (const token of [issueTestAccessToken(db, 'other'), issueTestAccessToken(db, user)]) {
    const stranger = { authorization: `Bearer ${token}` }
    for (const method of ['GET', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `${prefix}/${id}`, headers: stranger })).statusCode).toBe(404)
    }
    expect((await app.inject({ url: `${prefix}/${id}/files/nested/input.bin`, headers: stranger })).statusCode).toBe(404)
  }
  expect((await app.inject({ url: `${prefix}/${id}`, headers })).json().ready).toBe(true)
})

test('removing the owning caller grant prevents artifact retrieval', async () => {
  const id = await create()
  expect((await upload(id, 'nested/input.bin')).statusCode).toBe(200)
  db.prepare('DELETE FROM role_tools WHERE tool = ?').run('kubernetes-axi')
  const result = await app.inject({ url: `${prefix}/${id}/files/nested/input.bin`, headers })
  expect(result.statusCode).toBe(403)
  expect(result.rawPayload).not.toEqual(binary)
})

test.each([secret, Buffer.from(secret).toString('base64')])('configured credential material cannot be returned as a binary artifact: %s', async value => {
  const bytes = Buffer.from(`prefix\0${value}\xff`)
  const id = await create([descriptor('credential.bin', bytes)])
  expect((await upload(id, 'credential.bin', bytes)).statusCode).toBe(200)
  const result = await app.inject({ url: `${prefix}/${id}/files/credential.bin`, headers })
  expect(result.statusCode).toBe(500)
  expect(result.body).not.toContain(value)
  expect(result.json().error.code).toBe('SECRET_IN_OUTPUT')
})

test('workspace expiry refuses bytes and invalidates the handle', async () => {
  const id = await create()
  expect((await upload(id, 'nested/input.bin')).statusCode).toBe(200)
  vi.setSystemTime(Date.now() + 301000)
  const expired = await app.inject({ url: `${prefix}/${id}/files/nested/input.bin`, headers })
  expect(expired.json().error.code).toBe('TOKEN_EXPIRED')
  expect((await app.inject({ url: `${prefix}/${id}`, headers })).statusCode).toBe(404)
})

test('workspace bytes stream beyond the ordinary request-body limit', async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 98)
  const id = await create([descriptor('large.bin', bytes)])
  const sent = await upload(id, 'large.bin', bytes)
  expect(sent.statusCode, sent.body).toBe(200)
  const received = await app.inject({ url: `${prefix}/${id}/files/large.bin`, headers })
  expect(received.statusCode, received.body).toBe(200)
  expect(received.rawPayload.equals(bytes)).toBe(true)
  expect(received.headers['x-artium-content-sha256']).toBe(digest(bytes))
})

test('workspace reservations have a per-user bound and deletion frees a slot', async () => {
  const ids = await Promise.all(Array.from({ length: 4 }, () => create()))
  const refused = await app.inject({ method: 'POST', url: prefix, headers, payload: { files: [descriptor('next.bin')] } })
  expect(refused.json().error.code).toBe('TOO_MANY_CALLS')
  expect((await app.inject({ method: 'DELETE', url: `${prefix}/${ids[0]}`, headers })).statusCode).toBe(204)
  const next = await create()
  expect((await upload(next, 'nested/input.bin')).statusCode).toBe(200)
})

test('a session grant cannot bypass the existing administrator write switch', async () => {
  db.prepare("UPDATE tools SET native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ sessions: { grants: { [user]: ['exec'] } } }))
  const refused = await app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/sessions', headers,
    payload: { kind: 'exec', argv: ['prepare', '--', 'exec', 'synthetic-pod', '--', 'true'] } })
  expect(refused.json().error.code).toBe('FLAG_BLOCKED')
  expect((await app.inject({ url: '/v1/tools/kubernetes-axi/sessions', headers })).json().sessions).toEqual([])
})

test('session kinds require explicit caller grants before any worker is admitted', async () => {
  const refused = await app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/sessions', headers,
    payload: { kind: 'logs', argv: ['logs', 'synthetic-pod', '--follow'] } })
  expect(refused.json().error.code).toBe('TOOL_NOT_GRANTED')
})
