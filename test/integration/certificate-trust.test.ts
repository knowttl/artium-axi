import { X509Certificate } from 'node:crypto'
import * as dns from 'node:dns/promises'
import * as net from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, getCACertificates, setDefaultCACertificates } from 'node:tls'
import type Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, migrate, openStore, validateSchema } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { adminCertificateRoutes, certificateInspectionSchema, nativeSettingsSchemas } from '../../src/shared/api.js'
import { certificateDetails } from '../../src/server/certificate-inspection.js'
import { toolEndpoints } from '../../src/server/tool-endpoints.js'
import { readCredentialTrust } from '../../src/server/store/trusted-certificates.js'
import { preflight } from '../../src/server/health/preflight.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { credentialFetch } from '../../src/server/credential-tls.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { createInspectionCertificates } from '../fake-service/certificates.mjs'
import { seedToolUser } from '../fixtures/tokens.js'

vi.unmock('../../src/server/health/preflight.js')
vi.mock('node:dns/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: vi.fn(original.lookup) }
})
vi.mock('node:net', async importOriginal => {
  const original = await importOriginal<typeof import('node:net')>()
  return { ...original, connect: vi.fn(original.connect) }
})

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let runner: Runner
let store: ReturnType<typeof createCredentialStore>
let headers: Record<string, string>
let endpoint: string
let bytes = 0
let issuerRequests = 0
let issuerMode: 'valid' | 'redirect' | 'oversized' | 'unrelated' | 'stalled' | 'root' = 'valid'
const defaults = getCACertificates('default')
const tlsServer = createServer(socket => socket.on('data', chunk => {
  bytes += chunk.length
  socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
}))
const issuerServer = createHttpServer((_request, response) => {
  issuerRequests++
  if (issuerMode === 'stalled') return
  if (issuerMode === 'redirect') { response.writeHead(302, { location: '/issuer' }).end(); return }
  response.end(issuerMode === 'oversized' ? Buffer.alloc(128 * 1024 + 1)
    : new X509Certificate(pem(issuerMode === 'unrelated' ? 'self-signed' : issuerMode === 'root' ? 'ca' : 'intermediate')).raw)
})
const pem = (name: string) => readFileSync(join(directory, name + '.crt'), 'utf8')
const base = '/v1/admin/tools/vectra-axi/certificates'
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
function request(method: 'GET' | 'POST' | 'DELETE', path = '', payload?: Record<string, unknown>, proof = headers) {
  return app.inject({ method, url: base + path, headers: proof, ...(payload === undefined ? {} : { payload }) })
}
function serve(name: string, chain = false) {
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')),
    cert: pem(name) + (chain ? pem('intermediate') + pem('ca') : '') })
}
async function inspect() {
  const response = await request('POST', '/inspect', {})
  expect(response.statusCode, response.body).toBe(200)
  return certificateInspectionSchema.parse(response.json())
}
function runtimeCall(runtime: 'node' | 'python', trusted = true) {
  const trust = trusted ? readCredentialTrust(db, store.findCredential('vectra-axi')!) : []
  return runner.run('synthetic-development-user', runtime === 'node' ? process.execPath : '/usr/bin/python3',
    runtime === 'node'
      ? ['-e', `fetch(${JSON.stringify(endpoint)}).then(r => r.text()).then(console.log).catch(e => { console.error(e.cause?.code || e.message); process.exitCode = 1 })`]
      : ['-c', `import requests; print(requests.get(${JSON.stringify(endpoint)}, timeout=3).text)`],
    {}, [], { ...(runtime === 'python' ? { runtime: 'python' as const } : {}), timeoutMs: 5000, credentialTrust: trust })
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-certificate-trust-'))
  issuerServer.listen(0, '127.0.0.1')
  await once(issuerServer, 'listening')
  createInspectionCertificates(directory, `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}/issuer`)
  tlsServer.on('tlsClientError', () => {})
  tlsServer.listen(0, '127.0.0.1')
  await once(tlsServer, 'listening')
  endpoint = `https://localhost:${(tlsServer.address() as { port: number }).port}`
})
beforeEach(async () => {
  bytes = 0
  issuerRequests = 0
  issuerMode = 'valid'
  serve('self-signed')
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
    SELECT 'synthetic-other', 'synthetic-other', 'Other', password_hash, 1, 0 FROM users LIMIT 1`)
  store = createCredentialStore(db, provider)
  store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: endpoint,
    auth: 'token', token: 'CANARY-never-sent' }, 0, 'synthetic-development-user', Date.now())
  runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, runner, audit: new Audit(db),
    credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {}, adapters: [] })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login',
    payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  headers = { authorization: 'Bearer ' + login.json().accessToken }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  headers['x-artium-reauth-ticket'] = reauth.json().ticket
  db.exec('DELETE FROM audit')
})
afterEach(async () => {
  setDefaultCACertificates(defaults)
  await app.close()
  db.close()
  rmSync(join(directory, 'data'), { recursive: true, force: true })
})
afterAll(async () => {
  await Promise.all([new Promise<void>(resolve => tlsServer.close(() => resolve())),
    new Promise<void>(resolve => issuerServer.close(() => resolve()))])
  rmSync(directory, { recursive: true, force: true })
})

test.each([
  { certificate: 'self-signed', chain: false, reason: 'self-signed', count: 1, expired: false, matchesHostname: true },
  { certificate: 'leaf', chain: true, reason: 'CA this server does not trust', count: 3, expired: false, matchesHostname: true },
  { certificate: 'leaf', chain: false, reason: 'sent no intermediate', count: 1, expired: false, matchesHostname: true },
  { certificate: 'expired', chain: false, reason: 'expired', count: 1, expired: true, matchesHostname: true },
  { certificate: 'mismatch', chain: false, reason: 'hostname does not match', count: 1, expired: false, matchesHostname: false },
])('inspection explains $certificate without sending credentials or requests', async ({ certificate, chain, reason, count, expired, matchesHostname }) => {
  serve(certificate, chain)
  const result = await inspect()
  expect(result.reason).toContain(reason)
  expect(result.chain).toHaveLength(count)
  expect(result.chain[0]).toMatchObject({ subject: expect.any(String), issuer: expect.any(String),
    subjectAlternativeNames: expect.stringContaining('DNS:'), keyType: 'rsa', keyBits: 2048,
    signatureAlgorithm: expect.stringContaining('sha256'), fingerprint: new X509Certificate(pem(certificate)).fingerprint256,
    expired, matchesHostname })
  expect(result.hostname).toBe('localhost')
  expect(result.repairAvailable).toBe(false)
  expect(result).not.toHaveProperty('pem')
  expect(bytes).toBe(0)
})

test('one confirmation stores an exact credential pin, records its subject and fingerprint, and removal is audited', async () => {
  const result = await inspect()
  const trusted = await request('POST', '/trust', { inspectionId: result.inspectionId })
  expect(trusted.statusCode, trusted.body).toBe(200)
  const listed = (await request('GET')).json().certificates
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ mode: 'pin', endpoint: endpoint + '/',
    certificate: { fingerprint: result.chain[0].fingerprint }, leaf: { fingerprint: result.chain[0].fingerprint } })
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(400)
  const other = store.replaceCredential('ldap-axi', { url: 'ldaps://directory.synthetic.test' }, 0, 'synthetic-development-user', Date.now())
  expect(db.prepare('SELECT * FROM trusted_certificates WHERE credential_id = ?').all(other.id)).toEqual([])
  expect((await request('DELETE', '', { id: listed[0].id })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates).toEqual([])
  const audit = db.prepare('SELECT action, subject, target_id, user_id FROM audit ORDER BY id').all()
  expect(audit).toEqual(['trust-certificate', 'remove-trusted-certificate'].map(action => ({ action,
    subject: result.chain[0].subject, target_id: result.chain[0].fingerprint, user_id: 'synthetic-development-user' })))
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY')
})

test('a private complete chain pins its issuing CA and retains the observed leaf fingerprint', async () => {
  serve('leaf', true)
  const result = await inspect()
  expect(result.anchor.fingerprint).toBe(new X509Certificate(pem('intermediate')).fingerprint256)
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates[0]).toMatchObject({
    certificate: { fingerprint: result.anchor.fingerprint }, leaf: { fingerprint: result.chain[0].fingerprint } })
})

test.each([false, true])('an empty-subject leaf can be inspected, trusted and listed with its SAN (chain: %s)', async chain => {
  serve('empty-subject', chain)
  const result = await inspect()
  expect(result.chain[0]).toMatchObject({ subject: 'DNS:localhost', matchesHostname: true, selfSigned: false })
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  const listed = adminCertificateRoutes.list.response.parse((await request('GET')).json()).certificates[0]
  expect(listed.leaf.subject).toBe('DNS:localhost')
  expect(listed.certificate.subject).toBe(result.anchor.subject)
  expect(loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'empty-subject.crt') })!.certificates[0].subject)
    .toBe('DNS:localhost')
  expect(db.prepare("SELECT subject FROM audit WHERE action = 'trust-certificate'").get())
    .toEqual({ subject: result.anchor.subject })
})

test('missing subject and issuer names never establish a self-signed match', () => {
  const certificate = new X509Certificate(pem('nameless'))
  expect(certificate.verify(certificate.publicKey)).toBe(true)
  expect(certificateDetails(certificate, 'localhost')).toMatchObject({ subject: '(no subject)', selfSigned: false })
  expect(loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'nameless.crt') })!.certificates[0].subject)
    .toBe('(no subject)')
})

test('a changed endpoint certificate prominently flags the previously trusted fingerprint', async () => {
  const previous = await inspect()
  await request('POST', '/trust', { inspectionId: previous.inspectionId })
  serve('leaf', true)
  const changed = await inspect()
  expect(changed.previousFingerprints).toEqual([previous.chain[0].fingerprint])
  expect(changed.warnings).toEqual(expect.arrayContaining([expect.stringContaining('different fingerprint')]))
})

test.each(['expired', 'mismatch'])('warnings do not block confirmation of %s', async name => {
  serve(name)
  const result = await inspect()
  expect(result.warnings.length).toBeGreaterThan(0)
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
})

test('a missing intermediate is fetched and saved automatically only when the chain reaches an existing trusted root', async () => {
  serve('leaf')
  setDefaultCACertificates([...defaults, pem('ca')])
  const result = await inspect()
  expect(issuerRequests).toBe(1)
  expect(result.repairAvailable).toBe(true)
  expect(result.reason).toContain('root this server already trusts')
  expect((await request('GET')).json().certificates[0]).toMatchObject({ mode: 'intermediate',
    certificate: { fingerprint: new X509Certificate(pem('intermediate')).fingerprint256 } })
  expect(db.prepare('SELECT action FROM audit').all()).toEqual([{ action: 'repair-certificate-chain' }])
  expect(bytes).toBe(0)
})

test('an AIA-advertised private root requires administrator confirmation', async () => {
  serve('root-issued')
  issuerMode = 'root'
  const result = await inspect()
  expect(issuerRequests).toBe(1)
  expect(result.repairAvailable).toBe(false)
  expect((await request('GET')).json().certificates).toEqual([])
  expect(db.prepare('SELECT action FROM audit').all()).toEqual([])
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  expect((await runtimeCall('node')).exitCode).toBe(0)
})

test('automatic intermediate repair preserves an existing confirmed pin and requires confirmation for rotation', async () => {
  serve('leaf', true)
  const original = await inspect()
  await request('POST', '/trust', { inspectionId: original.inspectionId, mode: 'pin' })
  const pin = db.prepare('SELECT * FROM trusted_certificates').get()
  setDefaultCACertificates([...defaults, pem('ca')])
  serve('leaf')
  expect((await inspect()).repairAvailable).toBe(true)
  expect(db.prepare('SELECT * FROM trusted_certificates').all()).toEqual([pin])
  expect((await runtimeCall('node')).exitCode).toBe(0)
  expect((await runtimeCall('python')).exitCode).toBe(0)
  serve('rotated-aia')
  const rotated = await inspect()
  expect(rotated.repairAvailable).toBe(false)
  expect(rotated.previousFingerprints).toEqual([original.chain[0].fingerprint])
  expect(db.prepare('SELECT * FROM trusted_certificates').all()).toEqual([pin])
  bytes = 0
  expect((await runtimeCall('node')).exitCode).not.toBe(0)
  expect((await runtimeCall('python')).exitCode).not.toBe(0)
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  await expect(preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust))
    .rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toMatchObject({ code: 'CERTIFICATE_PIN_MISMATCH' })
  expect(bytes).toBe(0)
  expect((await request('POST', '/trust', { inspectionId: rotated.inspectionId })).statusCode).toBe(200)
  expect((await runtimeCall('node')).exitCode).toBe(0)
  expect((await runtimeCall('python')).exitCode).toBe(0)
})

test.each(['node', 'python'] as const)('%s accepts a renewed leaf under the default trusted CA', async runtime => {
  serve('leaf', true)
  const result = await inspect()
  const response = await request('POST', '/trust', { inspectionId: result.inspectionId })
  expect(response.statusCode).toBe(200)
  expect((await request('GET')).json().certificates[0].mode).toBe('ca')
  serve('rotated', true)
  const renewed = await runtimeCall(runtime)
  expect(renewed.exitCode, renewed.stdout + renewed.stderr).toBe(0)
  expect(renewed.stdout.trim()).toBe('ok')
})

test('server preflight and token transport accept a renewed leaf under the default trusted CA', async () => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId })
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  const credential = store.readCredential(reference) as Record<string, unknown>
  serve('rotated', true)
  await expect(preflight('vectra-axi', credential, trust)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
})

test.each([
  { mode: 'ca', runtime: 'node' }, { mode: 'pin', runtime: 'node' },
  { mode: 'ca', runtime: 'python' }, { mode: 'pin', runtime: 'python' },
] as const)('$runtime rejects a different CA at the same endpoint in $mode mode', async ({ mode, runtime }) => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode })
  setDefaultCACertificates([...defaults, pem('other-ca')])
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('other-ca-leaf') + pem('other-ca') })
  bytes = 0
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
})

test.each(['ca', 'pin'] as const)('server transports reject a different CA at the same endpoint in %s mode', async mode => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode })
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  const credential = store.readCredential(reference) as Record<string, unknown>
  setDefaultCACertificates([...defaults, pem('other-ca')])
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('other-ca-leaf') + pem('other-ca') })
  bytes = 0
  await expect(preflight('vectra-axi', credential, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toThrow()
  expect(bytes).toBe(0)
})

test('legacy CA pins migrate once while self-signed pins remain pinned and both decisions are audited', async () => {
  const selfSigned = await inspect()
  await request('POST', '/trust', { inspectionId: selfSigned.inspectionId })
  const selfSignedId = (await request('GET')).json().certificates[0].id
  serve('leaf', true)
  const ca = await inspect()
  await request('POST', '/trust', { inspectionId: ca.inspectionId, mode: 'pin' })
  // Keep a second legacy entry to exercise both upgrade decisions in one store.
  db.prepare(`INSERT INTO trusted_certificates
    SELECT ?, credential_id, endpoint, ?, ?, ?, ?, 'pin', created_at, created_by FROM trusted_certificates`)
    .run(selfSignedId, selfSigned.anchor.fingerprint, selfSigned.chain[0].fingerprint, pem('self-signed'), pem('self-signed'))
  db.exec('ALTER TABLE trusted_certificates RENAME TO legacy_copy')
  db.exec(readFileSync('src/server/store/migrations/020-trusted-certificates.sql', 'utf8'))
  db.exec(`INSERT INTO trusted_certificates SELECT * FROM legacy_copy;
    DROP TABLE legacy_copy; DELETE FROM migrations WHERE version = 21; DELETE FROM audit`)
  migrate(db)
  validateSchema(db)
  expect((await request('GET')).json().certificates.map((item: { mode: string }) => item.mode).sort()).toEqual(['ca', 'pin'])
  expect(db.prepare('SELECT action, tool, target_id FROM audit ORDER BY action').all()).toEqual([
    { action: 'keep-self-signed-certificate-pin', tool: 'vectra-axi', target_id: selfSigned.anchor.fingerprint },
    { action: 'migrate-certificate-to-ca-trust', tool: 'vectra-axi', target_id: ca.anchor.fingerprint },
  ])
  migrate(db)
  expect(db.prepare('SELECT count(*) AS count FROM audit').get()).toEqual({ count: 2 })
})

test.each(['redirect', 'oversized', 'unrelated', 'stalled'] as const)('AIA refuses %s issuer responses without adding trust', async mode => {
  serve('leaf')
  issuerMode = mode
  setDefaultCACertificates([...defaults, pem('ca')])
  const result = await inspect()
  expect(issuerRequests).toBe(1)
  expect(result.repairAvailable).toBe(false)
  expect((await request('GET')).json().certificates).toEqual([])
})

test('AIA rejects issuer URLs outside HTTP and HTTPS', async () => {
  serve('non-http')
  const result = await inspect()
  expect(result.repairAvailable).toBe(false)
  expect(issuerRequests).toBe(0)
  expect((await request('GET')).json().certificates).toEqual([])
})

test.each([
  { method: 'GET', path: '', payload: undefined },
  { method: 'POST', path: '/inspect', payload: {} },
  { method: 'POST', path: '/trust', payload: { inspectionId: 'synthetic' } },
  { method: 'DELETE', path: '', payload: { id: 'synthetic' } },
] as const)('$method $path requires administrator capability and recent reauthentication', async route => {
  const { 'x-artium-reauth-ticket': _ticket, ...missing } = headers
  expect((await request(route.method, route.path, route.payload, missing)).json()).toMatchObject({ error: { code: 'REAUTH_REQUIRED' } })
  db.exec("UPDATE users SET administrator = 0 WHERE id = 'synthetic-development-user'")
  expect((await request(route.method, route.path, route.payload)).json()).toMatchObject({ error: { code: 'ADMIN_REQUIRED' } })
})

test.each([{ hostname: 'arbitrary.synthetic.test' }, { endpoint: 'https://arbitrary.synthetic.test' },
  { endpointIndex: 99 }, { endpointIndex: -1 }, { pem: '-----BEGIN PRIVATE KEY-----' }])('inspection refuses caller-supplied destinations and certificate material: %j', async payload => {
  expect((await request('POST', '/inspect', payload)).statusCode).toBe(400)
  expect(issuerRequests).toBe(0)
})

test('an inspection cannot confirm a credential revision that changed after the handshake', async () => {
  const result = await inspect()
  store.replaceCredential('vectra-axi', { origin: endpoint, token: 'CANARY-replaced' }, 1, 'synthetic-development-user', Date.now())
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(409)
  expect((await request('GET')).json().certificates).toEqual([])
})

test.each([
  { runtime: 'node', certificate: 'self-signed', chain: false },
  { runtime: 'python', certificate: 'self-signed', chain: false },
  { runtime: 'node', certificate: 'leaf', chain: true },
  { runtime: 'python', certificate: 'leaf', chain: true },
] as const)('$runtime verifies $certificate only after confirmation and fails after removal', async ({ runtime, certificate, chain }) => {
  serve(certificate, chain)
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
  const result = await inspect()
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  expect(passed.stdout.trim()).toBe('ok')
  const pin = (await request('GET')).json().certificates[0]
  await request('DELETE', '', { id: pin.id })
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
})

test.each(['node', 'python'] as const)('%s rejects a different valid leaf under the same confirmed CA before sending data', async runtime => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })
  expect((await runtimeCall(runtime)).exitCode).toBe(0)
  serve('rotated', true)
  bytes = 0
  const rejected = await runtimeCall(runtime)
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr).toMatch(/fingerprint changed|CERTIFICATE_PIN_MISMATCH/)
  expect(bytes).toBe(0)
})

test.each(['node', 'python'] as const)('%s isolates mg-axi login and Graph trust when both use the same private root', async runtime => {
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('server') + pem('ca') })
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId })
  const reference = store.replaceCredential('mg-axi', {}, 0, 'synthetic-development-user', Date.now())
  const port = Number(new URL(endpoint).port)
  db.prepare('UPDATE trusted_certificates SET credential_id = ?, endpoint = ?').run(reference.id, `https://login.synthetic.test:${port}/`)
  const args = runtime === 'node'
    ? ['-e', `const tls = require('node:tls');
      const connect = host => new Promise(resolve => {
        const socket = tls.connect({ host: '127.0.0.1', port: ${port}, servername: host }, () => socket.write('GET / HTTP/1.1\\r\\n\\r\\n'));
        socket.on('data', () => {});
        socket.once('end', () => resolve('accepted'));
        socket.once('error', () => resolve('rejected'));
      });
      (async () => console.log(JSON.stringify([await connect('login.synthetic.test'), await connect('graph.synthetic.test'), await connect('login.synthetic.test')])))();`]
    : ['-c', `import json, os, socket, ssl
context = ssl.create_default_context(cafile=os.environ['REQUESTS_CA_BUNDLE'])
outcomes = []
for host in ['login.synthetic.test', 'graph.synthetic.test', 'login.synthetic.test']:
    try:
        with socket.create_connection(('127.0.0.1', ${port}), timeout=3) as tcp:
            with context.wrap_socket(tcp, server_hostname=host) as secure:
                secure.sendall(b'GET / HTTP/1.1\\r\\n\\r\\n')
                secure.recv(4096)
        outcomes.append('accepted')
    except ssl.SSLError:
        outcomes.append('rejected')
print(json.dumps(outcomes))`]
  const run = () => runner.run('synthetic-development-user', runtime === 'node' ? process.execPath : '/usr/bin/python3',
    args, {}, [], { timeoutMs: 5000, ...(runtime === 'python' ? { runtime: 'python' as const } : {}),
      credentialTrust: readCredentialTrust(db, reference) })
  bytes = 0
  const isolated = await run()
  expect(isolated.exitCode, isolated.stdout + isolated.stderr).toBe(0)
  expect(JSON.parse(isolated.stdout)).toEqual(['accepted', 'rejected', 'accepted'])
  expect(bytes).toBe(2 * Buffer.byteLength('GET / HTTP/1.1\r\n\r\n'))
  db.prepare(`INSERT INTO trusted_certificates
    SELECT 'synthetic-graph-pin', credential_id, ?, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by
    FROM trusted_certificates WHERE credential_id = ?`).run(`https://graph.synthetic.test:${port}/`, reference.id)
  const confirmed = await run()
  expect(confirmed.exitCode, confirmed.stdout + confirmed.stderr).toBe(0)
  expect(JSON.parse(confirmed.stdout)).toEqual(['accepted', 'accepted', 'accepted'])
})

test('server token transport isolates endpoints sharing a private root', async () => {
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('server') + pem('ca') })
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId })
  const trust = readCredentialTrust(db, store.findCredential('vectra-axi')!)
  let received = 0
  const other = createServer({ key: readFileSync(join(directory, 'server.key')), cert: pem('server') + pem('ca') },
    socket => socket.on('data', chunk => { received += chunk.length; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok') }))
  other.on('tlsClientError', () => {})
  other.listen(0, '127.0.0.1')
  await once(other, 'listening')
  const otherEndpoint = `https://localhost:${(other.address() as { port: number }).port}/`
  try {
    expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
    await expect(credentialFetch(otherEndpoint, { method: 'GET' }, trust)).rejects.toThrow()
    expect(received).toBe(0)
    expect(await (await credentialFetch(otherEndpoint, { method: 'GET' }, [...trust, { ...trust[0], endpoint: otherEndpoint }])).text()).toBe('ok')
  } finally { await new Promise<void>(resolve => other.close(() => resolve())) }
})

test('az-axi Graph confirmation enables only the confirmed endpoint in the runner', async () => {
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('server') + pem('ca') })
  const reference = store.replaceCredential('az-axi', { auth: 'secret', tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-never-sent' }, 0, 'synthetic-development-user', Date.now())
  const port = Number(new URL(endpoint).port)
  const run = () => runner.run('synthetic-development-user', process.execPath, ['-e', `
    const net = require('node:net');
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function(...args) {
      const options = args[0];
      if (options && typeof options === 'object' && Number(options.port) === 443) {
        options.host = '127.0.0.1'; options.port = ${port};
      }
      return connect.apply(this, args);
    };
    const tls = require('node:tls');
    const read = host => new Promise(resolve => {
      const socket = tls.connect({ host, port: 443, servername: host }, () => socket.write('GET / HTTP/1.1\\r\\n\\r\\n'));
      socket.on('data', () => {});
      socket.once('end', () => resolve('accepted'));
      socket.once('error', () => resolve('rejected'));
    });
    (async () => console.log(JSON.stringify([await read('graph.microsoft.com'), await read('login.microsoftonline.com') ])))();
  `], {}, [], { timeoutMs: 5000, credentialTrust: readCredentialTrust(db, reference) })
  expect(JSON.parse((await run()).stdout)).toEqual(['rejected', 'rejected'])
  const connect = vi.mocked(net.connect).getMockImplementation()!
  const originalLookup = vi.mocked(dns.lookup).getMockImplementation()!
  const lookup = vi.mocked(dns.lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
  const local = vi.mocked(net.connect).mockImplementation(((options: net.NetConnectOpts) =>
    (connect as typeof net.connect)({ ...options, host: '127.0.0.1', port })) as typeof net.connect)
  let inspection
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/admin/tools/az-axi/certificates/inspect', headers,
      payload: { endpointIndex: 2 } })
    expect(response.statusCode, response.body).toBe(200)
    inspection = certificateInspectionSchema.parse(response.json())
  } finally { lookup.mockImplementation(originalLookup); local.mockImplementation(connect) }
  expect(inspection.hostname).toBe('graph.microsoft.com')
  expect(bytes).toBe(0)
  expect((await app.inject({ method: 'POST', url: '/v1/admin/tools/az-axi/certificates/trust', headers,
    payload: { inspectionId: inspection.inspectionId } })).statusCode).toBe(200)
  const confirmed = await run()
  expect(confirmed.exitCode, confirmed.stdout + confirmed.stderr).toBe(0)
  expect(JSON.parse(confirmed.stdout)).toEqual(['accepted', 'rejected'])
})

test('saved Azure service names supply inspection destinations without accepting request hosts', async () => {
  const reference = store.replaceCredential('az-axi', {}, 0, 'synthetic-development-user', Date.now())
  const settings = nativeSettingsSchemas['az-axi'].parse({ tlsDestinations: {
    storageAccounts: ['synthetic'], keyVaults: ['synthetic-vault'], registries: ['syntheticregistry'],
  } })
  db.prepare('UPDATE tools SET native_settings = ? WHERE name = ?').run(JSON.stringify(settings), reference.tool)
  const saved = store.readCredential(reference) as Record<string, unknown>
  expect(toolEndpoints('az-axi', saved).map(url => url.hostname)).toEqual([
    'login.microsoftonline.com', 'management.azure.com', 'graph.microsoft.com', 'api.loganalytics.io',
    'synthetic.blob.core.windows.net', 'synthetic-vault.vault.azure.net', 'syntheticregistry.azurecr.io',
  ])
  const response = await app.inject({ method: 'POST', url: '/v1/admin/tools/az-axi/certificates/inspect', headers,
    payload: { endpointIndex: 4, hostname: 'arbitrary.synthetic.test' } })
  expect(response.statusCode).toBe(400)
  expect(bytes).toBe(0)
})

test.each([
  { storageAccounts: ['synthetic.blob.core.windows.net'] }, { storageAccounts: ['synthetic/evil'] },
  { keyVaults: ['synthetic.vault.azure.net'] }, { keyVaults: ['synthetic--vault'] },
  { registries: ['synthetic.azurecr.io'] }, { registries: ['synthetic@evil'] },
])('Azure inspection rejects invalid saved service names: %j', tlsDestinations => {
  expect(nativeSettingsSchemas['az-axi'].safeParse({ tlsDestinations }).success).toBe(false)
  expect(() => toolEndpoints('az-axi', { tlsDestinations })).toThrow()
})

test.each(['node', 'python'] as const)('%s enforces legacy mixed-case LDAP endpoint pins', async runtime => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })
  db.prepare('UPDATE trusted_certificates SET endpoint = ?, pem = ?').run(
    `LDAPS://LOCALHOST:${new URL(endpoint).port}`, pem('ca'))
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  serve('rotated', true)
  bytes = 0
  const rejected = await runtimeCall(runtime)
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr).toMatch(/fingerprint changed|CERTIFICATE_PIN_MISMATCH/)
  expect(bytes).toBe(0)
})

test('LDAP preflight and rotation inspection match equivalent saved endpoints', async () => {
  serve('leaf', true)
  const url = `LDAPS://LOCALHOST:${new URL(endpoint).port}`
  const reference = store.replaceCredential('ldap-axi', { url }, 0, 'synthetic-development-user', Date.now())
  const ldapRequest = (path: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/admin/tools/ldap-axi/certificates' + path, headers, payload })
  const previous = certificateInspectionSchema.parse((await ldapRequest('/inspect', {})).json())
  expect((await ldapRequest('/trust', { inspectionId: previous.inspectionId, mode: 'pin' })).statusCode).toBe(200)
  db.prepare('UPDATE trusted_certificates SET endpoint = ? WHERE credential_id = ?').run(url, reference.id)
  const trust = readCredentialTrust(db, reference)
  const credential = { url: url.toLowerCase() + '/' }
  await expect(preflight('ldap-axi', credential, trust)).resolves.toBeUndefined()
  serve('rotated', true)
  await expect(preflight('ldap-axi', credential, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  const changed = certificateInspectionSchema.parse((await ldapRequest('/inspect', {})).json())
  expect(changed.previousFingerprints).toEqual([previous.chain[0].fingerprint])
  expect(changed.warnings).toEqual(expect.arrayContaining([expect.stringContaining('different fingerprint')]))
  expect(bytes).toBe(0)
})

test.each(['node', 'python'] as const)('%s uses a fetched intermediate without adding a new trust anchor', async runtime => {
  serve('leaf')
  setDefaultCACertificates([...defaults, pem('ca')])
  const result = await inspect()
  expect(result.repairAvailable).toBe(true)
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  expect(passed.stdout.trim()).toBe('ok')
  setDefaultCACertificates(defaults)
  bytes = 0
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
})

test.each(['ldap-axi', 'vectra-axi'] as const)('%s explicit CA files retain default roots after automatic intermediate repair', async tool => {
  serve('leaf')
  setDefaultCACertificates([...defaults, pem('ca')])
  const adapter = tool === 'ldap-axi'
    ? createLdapAdapter({ getCredential: async () => ({ url: endpoint.replace('https:', 'ldaps:'),
      auth: 'simple', bindDn: 'uid=reader', bindPassword: 'CANARY-ldap' }) })
    : createVectraAdapter({ getCredential: async () => ({ kind: 'qux', apiVersion: '2.5', origin: endpoint,
      auth: 'token', token: 'CANARY-vectra', caBundle: pem('self-signed') }) }, join(directory, 'writes.log'),
    loadCredentialProfile('vectra-axi', join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json'))!)
  const call = await adapter.prepare(tool === 'ldap-axi' ? ['auth', 'status'] : ['health', 'list'],
    { id: 'synthetic-credential', tool, revision: 1 })
  const files = call.files.filter(file => file.appendTrustedCa)
  expect(files).toHaveLength(1)
  const args = ['-e', `const fs = require('node:fs');
    require('node:https').get(${JSON.stringify(endpoint)}, {
      ca: fs.readFileSync(${JSON.stringify(files[0].name)}), agent: false
    }, response => response.pipe(process.stdout)).on('error', error => { console.error(error.code); process.exitCode = 1 })`]
  const run = () => runner.run('synthetic-development-user', process.execPath, args, call.environment, call.secrets,
    { ...call.limits, credentialTrust: readCredentialTrust(db, store.findCredential('vectra-axi')!) }, {}, call.files)
  expect((await run()).exitCode).not.toBe(0)
  expect((await inspect()).repairAvailable).toBe(true)
  const passed = await run()
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  expect(passed.stdout).toBe('ok')
  setDefaultCACertificates(defaults)
  bytes = 0
  expect((await run()).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
})

test.each([
  { runtime: 'node', certificate: 'expired' }, { runtime: 'python', certificate: 'expired' },
  { runtime: 'node', certificate: 'mismatch' }, { runtime: 'python', certificate: 'mismatch' },
] as const)('$runtime preserves date and hostname verification after confirming $certificate', async ({ runtime, certificate }) => {
  serve(certificate, true)
  setDefaultCACertificates([...defaults, pem('ca')])
  const result = await inspect()
  expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('does not bypass')]))
  await request('POST', '/trust', { inspectionId: result.inspectionId })
  expect((await request('GET')).json().certificates[0].mode).toBe('ca')
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
})

test('server preflight and token transport enforce the same confirmed fingerprint as children', async () => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  await expect(preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
  serve('rotated', true)
  bytes = 0
  await expect(preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toMatchObject({ code: 'CERTIFICATE_PIN_MISMATCH' })
  expect(bytes).toBe(0)
})
