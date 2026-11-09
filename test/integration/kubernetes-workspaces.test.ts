import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { createDelegation, revokeDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'
import type { Adapter } from '../../src/server/adapters/types.js'
import type { MutableCredentialStore } from '../../src/server/store/credential-store.js'
import { Client } from '../../src/cli/http.js'
import { kubernetesHosted } from '../../src/cli/kubernetes.js'

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
let adapter: Adapter<unknown>
let credentials: MutableCredentialStore

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  directory = await mkdtemp(join(tmpdir(), 'artium-workspaces-test-'))
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  db = openStore(join(directory, 'data', 'artium.db'), key)
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'kubernetes-axi'")
  credentials = createCredentialStore(db, key)
  credentials.replaceCredential('kubernetes-axi', { origin: 'https://127.0.0.1:1', auth: 'token',
    namespace: 'synthetic', certificateAuthority: 'CANARY-CA-PEM', token: secret }, 0, user, Date.now())
  adapter = await createKubernetesAdapter(new EmbeddedSecretSource(credentials), join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'), join(directory, 'requests'))
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')),
    resolver: new SharedIdentityResolver(credentials, db), adapters: [adapter], credentialStore: credentials, environment: {} })
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

test('workspace and session bind the instance granted to the caller', async () => {
  const lab = credentials.createInstance('kubernetes-axi', { name: 'lab', description: '' },
    { origin: 'https://127.0.0.1:1', auth: 'token', namespace: 'synthetic', certificateAuthority: 'CANARY-CA-PEM', token: secret }, user, Date.now())
  db.prepare("UPDATE role_tools SET all_instances = 0 WHERE role_id = 'synthetic-role' AND tool = 'kubernetes-axi'").run()
  db.prepare("INSERT INTO role_tool_instances VALUES ('synthetic-role', 'kubernetes-axi', ?)").run(lab.id)
  db.prepare("UPDATE tools SET native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ sessions: { grants: { [user]: ['logs'] } } }))
  const id = await create()
  expect((await upload(id, 'nested/input.bin')).statusCode).toBe(200)
  expect((await app.inject({ url: `${prefix}/${id}`, headers })).statusCode).toBe(200)
  const session = await app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/sessions', headers,
    payload: { kind: 'logs', argv: ['logs', 'synthetic-pod', '--follow'] } })
  expect(session.statusCode, session.body).toBe(200)
  expect((await app.inject({ url: `/v1/tools/kubernetes-axi/sessions/${session.json().id}`, headers })).statusCode).toBe(200)
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

function delegated(commands?: string[], readOnly = false) {
  const grant = createDelegation(db, user, { label: 'Synthetic', scope: { tools: [{ tool: 'kubernetes-axi', ...(commands ? { commands } : {}) }] },
    readOnly, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
  const session = exchangeDelegation(db, grant.token)
  return { id: grant.id, session, headers: { authorization: `Bearer ${session.accessToken}` } }
}

test('an exact workspace create grant completes CLI creation and cleanup without show or delete', async () => {
  const grant = delegated(['workspace create'])
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', ARTIUM_AXI_CA_FILE: '', XDG_CONFIG_HOME: directory })
  client.sessions.write(grant.session, undefined, true)
  const source = join(directory, 'source')
  await mkdir(source, { mode: 0o700 })
  await writeFile(join(source, 'input.bin'), binary)
  const output: string[] = []
  await kubernetesHosted(['workspace', 'create', source, '--json'], () => client, text => output.push(text))
  const workspace = JSON.parse(output.join(''))
  expect(workspace.ready).toBe(true)
  expect(workspace.files).toEqual([{ ...descriptor('input.bin'), state: 'ready' }])
  expect((await app.inject({ url: `${prefix}/${workspace.id}`, headers: grant.headers })).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect((await app.inject({ method: 'DELETE', url: `${prefix}/${workspace.id}`, headers: grant.headers })).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect((await app.inject({ method: 'DELETE', url: `${prefix}/${workspace.id}?operation=create`, headers: grant.headers })).statusCode).toBe(204)
})

test('an exact workspace download grant completes CLI retrieval without show', async () => {
  const grant = delegated(['workspace create', 'workspace download'])
  const created = await app.inject({ method: 'POST', url: prefix, headers: grant.headers, payload: { files: [descriptor('input.bin')] } })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().id
  const uploaded = await app.inject({ method: 'PUT', url: `${prefix}/${id}/files/input.bin`,
    headers: { ...grant.headers, 'content-type': 'application/octet-stream' }, payload: binary })
  expect(uploaded.statusCode, uploaded.body).toBe(200)
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', ARTIUM_AXI_CA_FILE: '', XDG_CONFIG_HOME: directory })
  client.sessions.write(grant.session, undefined, true)
  const destination = join(directory, 'saved')
  await mkdir(destination, { mode: 0o700 })
  await kubernetesHosted(['workspace', 'download', id, 'input.bin', '--output', join(destination, 'input.bin'), '--json'], () => client, () => {})
  expect(await readFile(join(destination, 'input.bin'))).toEqual(binary)
  expect((await app.inject({ url: `${prefix}/${id}`, headers: grant.headers })).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
})

test.each([
  { operation: 'artifact', command: 'session artifact', sibling: 'tunnel' },
  { operation: 'tunnel', command: 'tunnel', sibling: 'artifact' },
])('session $operation metadata does not require a show grant', async ({ operation, command, sibling }) => {
  db.prepare("UPDATE tools SET native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ sessions: { grants: { [user]: ['logs'] } } }))
  const grant = delegated(['session start logs', command])
  const started = await app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/sessions', headers: grant.headers,
    payload: { kind: 'logs', argv: ['logs', 'synthetic-pod', '--follow'] } })
  expect(started.statusCode, started.body).toBe(200)
  const path = `/v1/tools/kubernetes-axi/sessions/${started.json().id}`
  const metadata = await app.inject({ url: `${path}?operation=${operation}`, headers: grant.headers })
  expect(metadata.statusCode, metadata.body).toBe(200)
  expect(metadata.json().id).toBe(started.json().id)
  expect((await app.inject({ url: path, headers: grant.headers })).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect((await app.inject({ url: `${path}?operation=${sibling}`, headers: grant.headers })).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
})

test('delegated session kinds are independently scoped and read-only refuses setup', async () => {
  db.prepare("UPDATE tools SET native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ allowWrites: true, sessions: { grants: { [user]: ['exec', 'port-forward'] } } }))
  const scoped = delegated(['session start exec'])
  const readOnly = delegated(undefined, true)
  const wide = delegated()
  const session = (auth: typeof headers, kind: string, argv: string[]) => app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/sessions', headers: auth, payload: { kind, argv } })
  const port = await session(scoped.headers, 'port-forward', ['prepare', '--', 'port-forward', 'pod', '0:80'])
  expect(port.json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  const denied = await session(readOnly.headers, 'exec', ['prepare', '--', 'exec', 'pod', '--', 'true'])
  expect(denied.json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  const workspace = await app.inject({ method: 'POST', url: prefix, headers: readOnly.headers, payload: { files: [descriptor('input')] } })
  expect(workspace.json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  const tools = await app.inject({ url: '/v1/tools', headers: scoped.headers })
  const commands = tools.json().tools.find((tool: { name: string }) => tool.name === 'kubernetes-axi').commands
  expect(commands).toContain('session start exec')
  expect(commands).not.toContain('session start port-forward')
  const wideTools = await app.inject({ url: '/v1/tools', headers: wide.headers })
  const wideCommands = wideTools.json().tools.find((tool: { name: string }) => tool.name === 'kubernetes-axi').commands
  expect(wideCommands.filter((command: string) => command.startsWith('session start '))).toEqual(['session start exec', 'session start port-forward'])
  const readTools = await app.inject({ url: '/v1/tools', headers: readOnly.headers })
  const readCommands = readTools.json().tools.find((tool: { name: string }) => tool.name === 'kubernetes-axi').commands
  expect(readCommands.filter((command: string) => command.startsWith('session start '))).toEqual([])
})

test.each([
  { allowWrites: true, readOnly: false, expected: ['session start exec', 'session start logs', 'session start port-forward', 'session start watch'] },
  { allowWrites: false, readOnly: false, expected: ['session start logs', 'session start watch'] },
  { allowWrites: true, readOnly: true, expected: [] },
])('hosted discovery applies administrator and delegation policy: %j', async ({ allowWrites, readOnly, expected }) => {
  db.prepare("UPDATE tools SET native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ allowWrites, sessions: { grants: { [user]: ['exec', 'logs', 'port-forward', 'watch'] } } }))
  const grant = delegated(undefined, readOnly)
  const response = await app.inject({ url: '/v1/tools', headers: grant.headers })
  expect(response.statusCode, response.body).toBe(200)
  const tool = response.json().tools.find((tool: { name: string }) => tool.name === 'kubernetes-axi')
  expect(tool.commands.filter((command: string) => command.startsWith('session start '))).toEqual(expected)
})

test.each([
  { commands: undefined, readOnly: false, workspaceStatus: 403, artifactStatus: 403 },
  { commands: ['workspace download', 'session artifact'], readOnly: true, workspaceStatus: 403, artifactStatus: 403 },
  { commands: ['workspace download', 'session artifact'], readOnly: false, workspaceStatus: 404, artifactStatus: 404 },
  { commands: ['workspace download'], readOnly: false, workspaceStatus: 404, artifactStatus: 403 },
  { commands: ['session artifact'], readOnly: false, workspaceStatus: 403, artifactStatus: 404 },
])('download metadata and bytes require writable exact picks: %j', async ({ commands, readOnly, workspaceStatus, artifactStatus }) => {
  const grant = delegated(commands, readOnly)
  const id = '00000000-0000-4000-8000-000000000001'
  for (const [url, status] of [
    [`${prefix}/${id}?operation=download`, workspaceStatus], [`${prefix}/${id}/files/input.bin`, workspaceStatus],
    [`/v1/tools/kubernetes-axi/sessions/${id}?operation=artifact`, artifactStatus],
    [`/v1/tools/kubernetes-axi/sessions/${id}/artifacts/input.bin`, artifactStatus],
  ] as const) {
    const response = await app.inject({ url, headers: grant.headers })
    expect(response.statusCode, url).toBe(status)
  }
  const discovery = await app.inject({ url: '/v1/tools', headers: grant.headers })
  const tool = discovery.json().tools.find((tool: { name: string }) => tool.name === 'kubernetes-axi')
  const discovered = tool?.commands ?? []
  expect(discovered.includes('workspace download')).toBe(workspaceStatus === 404)
  expect(discovered.includes('session artifact')).toBe(artifactStatus === 404)
})

test('delegated workspaces reserve owner capacity and revocation leaves the owner workspace intact', async () => {
  const grant = delegated()
  const make = (auth: typeof headers) => app.inject({ method: 'POST', url: prefix, headers: auth, payload: { files: [descriptor('input')] } })
  const first = await make(grant.headers)
  const second = await make(grant.headers)
  expect(first.statusCode).toBe(200)
  expect(second.statusCode).toBe(200)
  expect((await make(grant.headers)).json().error.code).toBe('TOO_MANY_CALLS')
  const owner = await make(headers)
  expect(owner.statusCode).toBe(200)
  revokeDelegation(db, grant.id, user, false)
  expect((await app.inject({ url: `${prefix}/${first.json().id}`, headers: grant.headers })).statusCode).toBe(401)
  expect((await app.inject({ url: `${prefix}/${owner.json().id}`, headers })).statusCode).toBe(200)
  expect((await make(headers)).statusCode).toBe(200)
})

test('a create session requires an exact credential-issuing pick before credential access', async () => {
  db.prepare("UPDATE tools SET native_settings=? WHERE name='kubernetes-axi'")
    .run(JSON.stringify({ allowWrites: true, acquireCredential: true, sessions: { grants: { [user]: ['create'] } } }))
  const wide = delegated()
  const exact = delegated(['session start create', 'create token'])
  db.exec("DELETE FROM credentials WHERE tool='kubernetes-axi'")
  const start = (auth: typeof headers) => app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/sessions', headers: auth,
    payload: { kind: 'create', argv: ['prepare', '--', 'create', 'token', 'synthetic-account'] } })
  expect((await start(wide.headers)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
  expect((await start(exact.headers)).json().error.code).toBe('CREDENTIAL_NOT_CONFIGURED')
})
