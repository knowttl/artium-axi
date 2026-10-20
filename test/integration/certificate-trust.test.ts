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
import { exchangeAwxPassword } from '../../src/server/adapters/awx-login.js'
import { ldapStartTlsRequest, startLdapTls } from '../../src/server/ldap-starttls.js'
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
      ? ['-e', `fetch(${JSON.stringify(endpoint)}).then(r => r.text()).then(console.log).catch(e => { console.error(e.cause?.message || e.message); process.exitCode = 1 })`]
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
  { certificate: 'leaf', chain: false, reason: 'sent no intermediate', count: 2, expired: false, matchesHostname: true },
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
  expect(result).not.toHaveProperty('pem')
  expect(bytes).toBe(0)
})

test('inspection reports leaf and intermediate expiry and warns without blocking CA trust', async () => {
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')),
    cert: pem('short-leaf') + pem('short-intermediate') })
  const result = await inspect()
  expect(result.chain[0].expiresAt).toBe(new Date(new X509Certificate(pem('short-leaf')).validTo).toISOString())
  expect(result.anchor.expiresAt).toBe(new Date(new X509Certificate(pem('short-intermediate')).validTo).toISOString())
  expect(result.warnings).toEqual(expect.arrayContaining([
    `Leaf expires within seven days (${result.chain[0].expiresAt}).`,
    `Trust anchor expires within seven days (${result.anchor.expiresAt}).`,
    expect.stringMatching(/intermediate trust anchor will rotate.*long-lived root.*server-wide bundle/),
  ]))
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates[0].mode).toBe('ca')
})

test('inspection does not warn about short validity for long-lived certificates', async () => {
  serve('leaf', true)
  const result = await inspect()
  expect(result.warnings).toEqual([])
})

test.each(['ca', 'pin'] as const)('default trust refuses saving %s trust without an audit change', async mode => {
  serve('leaf', true)
  setDefaultCACertificates([...defaults, pem('ca')])
  const result = await inspect()
  expect(result.verificationError).toBeNull()
  const response = await request('POST', '/trust', { inspectionId: result.inspectionId, mode })
  expect(response.statusCode).toBe(400)
  expect(response.json().error.message).toContain('No trust is needed')
  expect(result.reason).toContain('No trust is needed')
  expect((await request('GET')).json().certificates).toEqual([])
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
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

test.each([
  { chain: false, mode: 'pin' }, { chain: true, mode: 'ca' },
] as const)('an empty-subject leaf can be inspected, trusted and listed with its SAN (chain: $chain)', async ({ chain, mode }) => {
  serve('empty-subject', chain)
  const result = await inspect()
  expect(result.chain[0]).toMatchObject({ subject: 'DNS:localhost', matchesHostname: true, selfSigned: false })
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId, mode })).statusCode).toBe(200)
  const listed = adminCertificateRoutes.list.response.parse((await request('GET')).json()).certificates[0]
  expect(listed.mode).toBe(mode)
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

test.each([
  { runtime: 'node', certificate: 'leaf' }, { runtime: 'python', certificate: 'leaf' },
  { runtime: 'node', certificate: 'rotated' }, { runtime: 'python', certificate: 'rotated' },
] as const)('$runtime accepts $certificate through a confirmed presented intermediate without the root', async ({ runtime, certificate }) => {
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('leaf') + pem('intermediate') })
  const result = await inspect()
  expect(result.chain).toHaveLength(2)
  expect(result.anchor.fingerprint).toBe(new X509Certificate(pem('intermediate')).fingerprint256)
  expect((await request('GET')).json().certificates).toEqual([])
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates[0].mode).toBe('ca')
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(certificate) + pem('intermediate') })
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  await expect(preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  expect(passed.stdout.trim()).toBe('ok')
})

test.each(['expired', 'mismatch'])('warnings do not block confirmation of %s', async name => {
  serve(name)
  const result = await inspect()
  expect(result.warnings.length).toBeGreaterThan(0)
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })).statusCode).toBe(200)
})

test.each([
  { certificate: 'root-issued', issuer: 'root', renewed: 'server', runtime: 'node' },
  { certificate: 'root-issued', issuer: 'root', renewed: 'server', runtime: 'python' },
  { certificate: 'leaf', issuer: 'valid', renewed: 'rotated', runtime: 'node' },
  { certificate: 'leaf', issuer: 'valid', renewed: 'rotated', runtime: 'python' },
] as const)('$runtime trusts a fetched private $issuer only after confirmation and accepts renewal', async ({ certificate, issuer, renewed, runtime }) => {
  serve(certificate)
  issuerMode = issuer
  const result = await inspect()
  expect(issuerRequests).toBe(1)
  expect(result.anchor.ca).toBe(true)
  expect(result.chain).toHaveLength(2)
  expect((await request('GET')).json().certificates).toEqual([])
  expect(db.prepare('SELECT action FROM audit').all()).toEqual([])
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates[0].mode).toBe('ca')
  serve(renewed)
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  await expect(preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
})

test('a non-self-signed leaf without an obtainable issuer requires explicit pinning', async () => {
  serve('leaf')
  issuerMode = 'unrelated'
  const result = await inspect()
  expect(result.anchor.ca).toBe(false)
  expect(result.chain[0].selfSigned).toBe(false)
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(400)
  const rejected = await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'ca' })
  expect(rejected.statusCode).toBe(400)
  expect(rejected.json().error.message).toContain('CA trust is unavailable')
  expect((await request('GET')).json().certificates).toEqual([])
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates[0].mode).toBe('pin')
  expect((await runtimeCall('node')).exitCode).toBe(0)
})

test.each(['node', 'python'] as const)('%s requires confirmation of a missing intermediate below a confirmed root', async runtime => {
  serve('server', true)
  const original = await inspect()
  expect((await request('POST', '/trust', { inspectionId: original.inspectionId })).statusCode).toBe(200)
  const saved = (await request('GET')).json().certificates
  setDefaultCACertificates([...defaults, pem('ca')])
  serve('leaf')
  const result = await inspect()
  expect(result.anchor.fingerprint).toBe(new X509Certificate(pem('intermediate')).fingerprint256)
  expect((await request('GET')).json().certificates).toEqual(saved)
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
  expect((await request('POST', '/trust', { inspectionId: result.inspectionId })).statusCode).toBe(200)
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
})

test.each([
  { mode: 'ca', runtime: 'node' }, { mode: 'ca', runtime: 'python' },
  { mode: 'pin', runtime: 'node' }, { mode: 'pin', runtime: 'python' },
] as const)('$runtime rejects an expired confirmed anchor in $mode mode', async ({ mode, runtime }) => {
  serve('server', true)
  const original = await inspect()
  expect((await request('POST', '/trust', { inspectionId: original.inspectionId, mode })).statusCode).toBe(200)
  const reference = store.findCredential('vectra-axi')!
  const credential = store.readCredential(reference) as Record<string, unknown>
  const valid = readCredentialTrust(db, reference)
  await expect(preflight('vectra-axi', credential, valid)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, valid)).text()).toBe('ok')
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  db.prepare('UPDATE trusted_certificates SET pem = ?, fingerprint = ?')
    .run(pem('expired-ca'), new X509Certificate(pem('expired-ca')).fingerprint256)
  serve('server')
  const expired = readCredentialTrust(db, reference)
  bytes = 0
  await expect(preflight('vectra-axi', credential, expired)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  await expect(credentialFetch(endpoint, { method: 'GET' }, expired)).rejects.toMatchObject({ code: 'CERT_HAS_EXPIRED' })
  const rejected = await runtimeCall(runtime)
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr).toMatch(/expired|CERT_HAS_EXPIRED/)
  expect(bytes).toBe(0)
})

test.each([
  { mode: 'pin', certificate: 'rotated', chain: 'intermediate' },
  { mode: 'ca', certificate: 'other-ca-leaf', chain: 'other-ca' },
] as const)('a second $mode confirmation keeps the first certificate trusted', async ({ mode, certificate, chain }) => {
  serve('leaf', true)
  const first = await inspect()
  expect((await request('POST', '/trust', { inspectionId: first.inspectionId, mode })).statusCode).toBe(200)
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(certificate) + pem(chain) })
  const second = await inspect()
  expect((await request('POST', '/trust', { inspectionId: second.inspectionId, mode })).statusCode).toBe(200)
  expect((await request('GET')).json().certificates.map((item: { leaf: { fingerprint: string } }) => item.leaf.fingerprint).sort())
    .toEqual([first.chain[0].fingerprint, second.chain[0].fingerprint].sort())
  expect((await runtimeCall('node')).exitCode).toBe(0)
  serve('leaf', true)
  expect((await runtimeCall('node')).exitCode).toBe(0)
  expect((await runtimeCall('python')).exitCode).toBe(0)
})

test.each([
  { first: 'pin', second: 'ca' }, { first: 'ca', second: 'pin' },
] as const)('switching from $first to $second replaces the other mode', async ({ first, second }) => {
  serve('leaf', true)
  const original = await inspect()
  await request('POST', '/trust', { inspectionId: original.inspectionId, mode: first })
  serve('rotated', true)
  const rotated = await inspect()
  expect((await request('POST', '/trust', { inspectionId: rotated.inspectionId, mode: second })).statusCode).toBe(200)
  const listed = (await request('GET')).json().certificates
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ mode: second, leaf: { fingerprint: rotated.chain[0].fingerprint } })
  expect((await runtimeCall('node')).exitCode).toBe(0)
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

test('legacy pins migrate once with accurate audit reasons for every retained pin', async () => {
  const selfSigned = await inspect()
  await request('POST', '/trust', { inspectionId: selfSigned.inspectionId })
  serve('leaf', true)
  const ca = await inspect()
  await request('POST', '/trust', { inspectionId: ca.inspectionId, mode: 'pin' })
  db.prepare(`INSERT INTO trusted_certificates
    SELECT 'synthetic-no-issuer-pin', credential_id, endpoint, ?, ?, ?, ?, 'pin', created_at, created_by FROM trusted_certificates LIMIT 1`)
    .run(new X509Certificate(pem('root-issued')).fingerprint256, new X509Certificate(pem('root-issued')).fingerprint256,
      pem('root-issued'), pem('root-issued'))
  db.exec('ALTER TABLE trusted_certificates RENAME TO legacy_copy')
  db.exec(readFileSync('src/server/store/migrations/020-trusted-certificates.sql', 'utf8'))
  db.exec(`INSERT INTO trusted_certificates SELECT * FROM legacy_copy;
    DROP TABLE legacy_copy; DELETE FROM migrations WHERE version = 21; DELETE FROM audit`)
  db.prepare(`INSERT INTO trusted_certificates
    SELECT 'synthetic-legacy-repair', credential_id, endpoint, ?, ?, ?, ?, 'intermediate', created_at, created_by
    FROM trusted_certificates LIMIT 1`).run(new X509Certificate(pem('intermediate')).fingerprint256,
    new X509Certificate(pem('empty-subject')).fingerprint256, pem('intermediate'), pem('empty-subject'))
  migrate(db)
  validateSchema(db)
  expect((await request('GET')).json().certificates.map((item: { mode: string }) => item.mode).sort()).toEqual(['ca', 'pin', 'pin'])
  expect(db.prepare('SELECT action, tool, target_id FROM audit ORDER BY action').all()).toEqual([
    { action: 'keep-certificate-pin-no-issuing-ca-stored', tool: 'vectra-axi', target_id: new X509Certificate(pem('root-issued')).fingerprint256 },
    { action: 'keep-self-signed-certificate-pin', tool: 'vectra-axi', target_id: selfSigned.anchor.fingerprint },
    { action: 'migrate-certificate-to-ca-trust', tool: 'vectra-axi', target_id: ca.anchor.fingerprint },
  ])
  migrate(db)
  expect(db.prepare('SELECT count(*) AS count FROM audit').get()).toEqual({ count: 3 })
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  const credential = store.readCredential(reference) as Record<string, unknown>
  for (const certificate of ['leaf', 'rotated', 'self-signed']) {
    serve(certificate, certificate !== 'self-signed')
    await expect(preflight('vectra-axi', credential, trust)).resolves.toBeUndefined()
    expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
    for (const runtime of ['node', 'python'] as const) {
      const passed = await runtimeCall(runtime)
      expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
      expect(passed.stdout.trim()).toBe('ok')
    }
  }
  tlsServer.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('other-ca-leaf') + pem('other-ca') })
  bytes = 0
  await expect(preflight('vectra-axi', credential, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toThrow()
  for (const runtime of ['node', 'python'] as const) expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
})

test.each(['node', 'python'] as const)('%s mixed CA and leaf trust does not promote the pinned leaf issuer to a CA', async runtime => {
  serve('leaf', true)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId })
  db.prepare(`INSERT INTO trusted_certificates
    SELECT 'synthetic-root-issued-pin', credential_id, endpoint, ?, ?, ?, ?, 'pin', created_at, created_by
    FROM trusted_certificates`).run(new X509Certificate(pem('ca')).fingerprint256,
    new X509Certificate(pem('root-issued')).fingerprint256, pem('ca'), pem('root-issued'))
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  const credential = store.readCredential(reference) as Record<string, unknown>
  serve('root-issued')
  await expect(preflight('vectra-axi', credential, trust)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
  const passed = await runtimeCall(runtime)
  expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0)
  serve('server')
  bytes = 0
  await expect(preflight('vectra-axi', credential, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toThrow()
  expect((await runtimeCall(runtime)).exitCode).not.toBe(0)
  expect(bytes).toBe(0)
})

test.each(['redirect', 'oversized', 'unrelated', 'stalled'] as const)('AIA refuses %s issuer responses without adding trust', async mode => {
  serve('leaf')
  issuerMode = mode
  setDefaultCACertificates([...defaults, pem('ca')])
  const result = await inspect()
  expect(issuerRequests).toBe(1)
  expect((await request('GET')).json().certificates).toEqual([])
})

test('AIA rejects issuer URLs outside HTTP and HTTPS', async () => {
  serve('non-http')
  const result = await inspect()
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

test.each([
  { runtime: 'node', initial: 'leaf', rotated: 'rotated', chain: true },
  { runtime: 'python', initial: 'leaf', rotated: 'rotated', chain: true },
  { runtime: 'node', initial: 'self-signed', rotated: 'self-signed-rotated', chain: false },
  { runtime: 'python', initial: 'self-signed', rotated: 'self-signed-rotated', chain: false },
] as const)('$runtime explains rotation of $initial before sending data', async ({ runtime, initial, rotated, chain }) => {
  serve(initial, chain)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })
  expect((await runtimeCall(runtime)).exitCode).toBe(0)
  serve(rotated, chain)
  bytes = 0
  const rejected = await runtimeCall(runtime)
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr).toContain('stored certificate fingerprint differs from the presented one')
  expect(rejected.stderr).toContain('re-inspect')
  expect(rejected.stderr).not.toContain('BEGIN CERTIFICATE')
  expect(rejected.stderr).not.toContain(result.chain[0].fingerprint)
  expect(rejected.stderr).not.toContain(new X509Certificate(pem(rotated)).fingerprint256)
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
  expect(rejected.stderr).toContain('stored certificate fingerprint differs from the presented one')
  expect(rejected.stderr).toContain('re-inspect')
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

test.each([
  { runtime: 'node', initial: 'leaf', rotated: 'rotated', chain: true },
  { runtime: 'python', initial: 'leaf', rotated: 'rotated', chain: true },
  { runtime: 'node', initial: 'self-signed', rotated: 'self-signed-rotated', chain: false },
  { runtime: 'python', initial: 'self-signed', rotated: 'self-signed-rotated', chain: false },
] as const)('$runtime explains LDAP StartTLS rotation of $initial without sending data', async ({ runtime, initial, rotated, chain }) => {
  serve(initial, chain)
  let invalidUpgrades = 0
  const startTlsServer = net.createServer(socket => {
    socket.on('error', () => {})
    socket.once('data', packet => {
      if (packet.toString('hex') !== ldapStartTlsRequest) {
        invalidUpgrades++
        socket.destroy()
        return
      }
      socket.write(Buffer.from('300c02010178070a010004000400', 'hex'))
      tlsServer.emit('connection', socket)
    })
  })
  startTlsServer.listen(0, '127.0.0.1')
  await once(startTlsServer, 'listening')
  try {
    const port = (startTlsServer.address() as { port: number }).port
    const url = `ldap://localhost:${port}`
    const reference = store.replaceCredential('ldap-axi', { url }, 0, 'synthetic-development-user', Date.now())
    const inspection = await app.inject({ method: 'POST', url: '/v1/admin/tools/ldap-axi/certificates/inspect', headers, payload: {} })
    expect(inspection.statusCode, inspection.body).toBe(200)
    const result = certificateInspectionSchema.parse(inspection.json())
    const saved = await app.inject({ method: 'POST', url: '/v1/admin/tools/ldap-axi/certificates/trust', headers,
      payload: { inspectionId: result.inspectionId, mode: 'pin' } })
    expect(saved.statusCode, saved.body).toBe(200)
    const trust = readCredentialTrust(db, reference)
    const run = () => runner.run('synthetic-development-user', runtime === 'node' ? process.execPath : '/usr/bin/python3',
      runtime === 'node' ? ['-e', `
        const net = require('node:net');
        const tls = require('node:tls');
        const ldapStartTlsRequest = ${JSON.stringify(ldapStartTlsRequest)};
        const startLdapTls = ${startLdapTls.toString()};
        const raw = net.connect({ host: 'localhost', port: ${port} });
        raw.once('connect', async () => {
          await startLdapTls(raw);
          const secure = tls.connect({ socket: raw, servername: 'localhost' }, () => secure.write('GET / HTTP/1.1\\r\\n\\r\\n'));
          secure.on('data', data => console.log(data.toString()));
          secure.once('error', error => { console.error(error.message); process.exitCode = 1 });
        });
      `] : ['-c', `
import socket, ssl
raw = socket.create_connection(('localhost', ${port}), timeout=3)
raw.sendall(bytes.fromhex(${JSON.stringify(ldapStartTlsRequest)}))
raw.makefile('rb').read(14)
with ssl.create_default_context().wrap_socket(raw, server_hostname='localhost') as secure:
    secure.sendall(b'GET / HTTP/1.1\\r\\n\\r\\n')
    print(secure.recv(4096).decode())
`], {}, [], { timeoutMs: 5000, credentialTrust: trust, ...(runtime === 'python' ? { runtime: 'python' as const } : {}) })
    await expect(preflight('ldap-axi', { url }, trust)).resolves.toBeUndefined()
    const passed = await run()
    expect(passed.exitCode, passed.stderr).toBe(0)
    expect(passed.stdout).toContain('ok')
    serve(rotated, chain)
    bytes = 0
    await expect(preflight('ldap-axi', { url }, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED',
      diagnostic: { toolCode: 'CERTIFICATE_PIN_MISMATCH', message: expect.stringContaining('re-inspect') } })
    const rejected = await run()
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr).toContain('stored certificate fingerprint differs from the presented one')
    expect(rejected.stderr).toContain('re-inspect')
    expect(rejected.stderr).not.toContain('BEGIN CERTIFICATE')
    expect(rejected.stderr).not.toContain(result.chain[0].fingerprint)
    expect(rejected.stderr).not.toContain(new X509Certificate(pem(rotated)).fingerprint256)
    expect(invalidUpgrades).toBe(0)
    expect(bytes).toBe(0)
  } finally { await new Promise<void>(resolve => startTlsServer.close(() => resolve())) }
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

test.each([
  { initial: 'leaf', rotated: 'rotated', chain: true },
  { initial: 'self-signed', rotated: 'self-signed-rotated', chain: false },
])('server preflight and token transport explain rotation of $initial', async ({ initial, rotated, chain }) => {
  serve(initial, chain)
  const result = await inspect()
  await request('POST', '/trust', { inspectionId: result.inspectionId, mode: 'pin' })
  const reference = store.findCredential('vectra-axi')!
  const trust = readCredentialTrust(db, reference)
  await expect(preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust)).resolves.toBeUndefined()
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
  serve(rotated, chain)
  bytes = 0
  const preflightError = await preflight('vectra-axi', store.readCredential(reference) as Record<string, unknown>, trust).catch(error => error)
  expect(preflightError).toMatchObject({ code: 'UPSTREAM_TLS_FAILED', diagnostic: {
    toolCode: 'CERTIFICATE_PIN_MISMATCH', message: expect.stringContaining('stored certificate fingerprint differs from the presented one'),
  } })
  expect(preflightError.diagnostic.message).toContain('re-inspect')
  const tokenError = await credentialFetch(endpoint, { method: 'GET' }, trust).catch(error => error)
  expect(tokenError).toMatchObject({ code: 'CERTIFICATE_PIN_MISMATCH',
    message: expect.stringContaining('stored certificate fingerprint differs from the presented one') })
  expect(tokenError.message).toContain('re-inspect')
  const signInError = await exchangeAwxPassword({ origin: endpoint, signIn: 'password',
    username: 'synthetic-user', password: 'CANARY-never-sent' }, trust, () => {}).catch(error => error)
  expect(signInError).toMatchObject({ code: 'UPSTREAM_TLS_FAILED',
    message: expect.stringContaining('stored certificate fingerprint differs from the presented one') })
  expect(signInError.message).toContain('re-inspect')
  for (const error of [preflightError, tokenError, signInError]) {
    const text = JSON.stringify(error) + error.message
    expect(text).not.toContain('BEGIN CERTIFICATE')
    expect(text).not.toContain(result.chain[0].fingerprint)
    expect(text).not.toContain(new X509Certificate(pem(rotated)).fingerprint256)
  }
  expect(bytes).toBe(0)
})
