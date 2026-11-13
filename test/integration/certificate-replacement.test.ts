import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:tls'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, migrate, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { readCredentialTrust } from '../../src/server/store/trusted-certificates.js'
import { preflight } from '../../src/server/health/preflight.js'
import { credentialFetch } from '../../src/server/credential-tls.js'
import { savedCertificateTrust } from '../../src/server/credential-tls-settings.js'
import { createInspectionCertificates } from '../fake-service/certificates.mjs'
import { seedToolUser } from '../fixtures/tokens.js'

vi.unmock('../../src/server/health/preflight.js')

const directory = mkdtempSync(join(tmpdir(), 'artium-replacement-'))
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const pem = (name: string) => readFileSync(join(directory, name + '.crt'), 'utf8')
const fingerprint = (name: string) => new X509Certificate(pem(name)).fingerprint256.replaceAll(':', '').toLowerCase()
let bytes = 0
const server = createServer(socket => socket.on('data', chunk => {
  bytes += chunk.length
  socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
}))
let endpoint: string
let db: ReturnType<typeof openStore>
let store: ReturnType<typeof createCredentialStore>
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
function serve(name: string, ca = 'intermediate') {
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(name) + pem(ca) + pem('ca') })
}

beforeAll(async () => {
  createInspectionCertificates(directory, 'http://127.0.0.1:1/issuer')
  execFileSync('openssl', ['x509', '-in', 'self-signed.crt', '-signkey', 'server.key', '-preserve_dates',
    '-clrext', '-extfile', 'inspection.cnf', '-extensions', 'root', '-out', 'self-signed-ca.crt'], { cwd: directory, stdio: 'pipe' })
  execFileSync('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '101',
    '-subj', '/CN=Artium synthetic test CA', '-days', '3650', '-extfile', 'inspection.cnf', '-extensions', 'root', '-out', 'self-issued.crt'], { cwd: directory, stdio: 'pipe' })
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `https://localhost:${(server.address() as { port: number }).port}`
})
beforeEach(async () => {
  bytes = 0
  serve('leaf')
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  store = createCredentialStore(db, provider)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db),
    credentialStore: store, resolver: new SharedIdentityResolver(store, db), environment: {}, adapters: [] })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  headers = { authorization: 'Bearer ' + login.json().accessToken }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  headers['x-artium-reauth-ticket'] = reauth.json().ticket
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(join(directory, 'data'), { recursive: true, force: true })
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

test.each([
  ['self-signed leaf with a matching paired fingerprint', 'self-signed-ca', 'self-signed-ca', [], 'pin'],
  ['issuing CA with a paired leaf fingerprint', 'intermediate', 'leaf', [], 'ca'],
  ['self-signed pin', 'ca', 'ca', [], 'pin'],
  ['self-issued certificate signed by another key', 'self-issued', 'self-issued', [], 'ca'],
  ['self-signed certificate without a paired fingerprint', 'ca', undefined, [], 'ca'],
  ['self-signed certificate with a different paired fingerprint', 'ca', 'leaf', [], 'ca'],
  ['explicit CA record', 'ca', 'ca', [{ mode: 'ca' }], 'ca'],
  ['explicit pin record', 'ca', undefined, [{ mode: 'pin' }], 'pin'],
  ['saved ordinary leaf', 'leaf', 'leaf', [], 'pin'],
] as const)('saved trust resolves %s', (_name, saved, paired, records, mode) => {
  expect(savedCertificateTrust('unifi-axi', { tls: { trustedCertificatePem: pem(saved),
    peerFingerprintSha256: paired && fingerprint(paired) } }, records).mode).toBe(mode)
})

test.each([
  ['self-signed-ca', 'self-signed-rotated'],
  ['ca', 'root-issued'],
])('a manually saved self-signed CA-capable leaf %s renews only as a confirmed strict pin', async (oldLeaf, newLeaf) => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key',
    tls: { trustedCertificatePem: pem(oldLeaf), peerFingerprintSha256: fingerprint(oldLeaf) } }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  serve(newLeaf)
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ rotation: true, trustMode: 'pin' })
  const payload = { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'pin', replace: true, fillFields: true }
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { ...payload, confirmedFingerprint: 'unconfirmed' } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { ...payload, mode: 'ca' } })).statusCode).toBe(400)
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload })
  expect(saved.statusCode, saved.body).toBe(200)
  const reference = store.findInstance('unifi-axi', 'rotation')!
  const value = store.readCredential(reference) as Record<string, unknown>
  expect(value.tls).toEqual({ trustedCertificatePem: pem(newLeaf), peerFingerprintSha256: fingerprint(newLeaf) })
  const trust = readCredentialTrust(db, reference)
  expect(trust.map(item => item.mode)).toEqual(['pin'])
  await expect(preflight('unifi-axi', value, trust)).resolves.toBeUndefined()
  server.setSecureContext({ key: readFileSync(join(directory, oldLeaf === 'ca' ? 'ca.key' : 'server.key')), cert: pem(oldLeaf) })
  await expect(preflight('unifi-axi', value, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  serve('leaf')
  await expect(preflight('unifi-axi', value, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})

test.each([
  ['unifi-axi', () => ({ origin: endpoint, apiKey: 'CANARY-key', tls: { trustedCertificatePem: pem('leaf'), peerFingerprintSha256: fingerprint('leaf') } })],
  ['proxmox-axi', () => ({ origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token',
    caBundle: pem('leaf'), certificatePin: { origin: endpoint, sha256: fingerprint('leaf'), replaceHostname: true } })],
  ['technitium-axi', () => ({ origin: endpoint, auth: 'token', tokenKind: 'api', token: 'CANARY-token', caFile: pem('leaf') })],
  ['ldap-axi', () => ({ url: endpoint.replace('https:', 'ldaps:'), auth: 'simple', bindDn: 'cn=reader,dc=synthetic,dc=test', password: 'CANARY-password', caFile: pem('leaf') })],
  ['vectra-axi', () => ({ kind: 'qux', apiVersion: '2.5', origin: endpoint, auth: 'token', token: 'CANARY-token', caBundle: pem('leaf') })],
] as const)('%s replaces shared strict trust and refuses both old and sibling leaves', async (tool, value) => {
  store.createInstance(tool, { name: 'rotation', description: '' }, value(), 'synthetic-development-user', Date.now())
  const base = `/v1/admin/tools/${tool}/instances/rotation/certificates`
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  serve('rotated')
  const inspection = await inspect()
  expect(inspection).toMatchObject({ rotation: true, trustMode: 'pin' })
  const payload = { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'pin', replace: true, fillFields: true }
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { ...payload, confirmedFingerprint: 'unconfirmed' } })).statusCode).toBe(400)
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers: { authorization: headers.authorization }, payload })).json().error.code).toBe('REAUTH_REQUIRED')
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { ...payload, mode: 'ca' } })).statusCode).toBe(400)
  expect(store.readCredential(store.findInstance(tool, 'rotation')!)).toEqual(value())
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload })
  expect(saved.statusCode, saved.body).toBe(200)
  const reference = store.findInstance(tool, 'rotation')!
  const next = store.readCredential(reference) as Record<string, unknown>
  if (tool === 'proxmox-axi') expect(next.certificatePin).toEqual({ origin: endpoint, sha256: fingerprint('rotated'), replaceHostname: true })
  const trust = readCredentialTrust(db, reference)
  expect(trust.map(item => item.mode)).toEqual(['pin'])
  await expect(preflight(tool, next, trust)).resolves.toBeUndefined()
  serve('leaf')
  bytes = 0
  await expect(preflight(tool, next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  serve('empty-subject')
  await expect(preflight(tool, next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
  expect(bytes).toBe(0)
})

test('pin replacement removes normalized legacy records through tool routes', async () => {
  const mode = 'pin'
  const reference = store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: endpoint, auth: 'token', token: 'CANARY-token' }, 0, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/vectra-axi/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const first = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: first.inspectionId, confirmedFingerprint: first.chain[0].fingerprint, mode } })).statusCode).toBe(200)
  db.prepare('UPDATE trusted_certificates SET endpoint = ?').run(endpoint.toUpperCase())
  serve('other-ca-leaf', 'other-ca')
  const second = await inspect()
  expect(second).toMatchObject({ trustMode: mode, rotation: true, previousFingerprints: [first.chain[0].fingerprint] })
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: second.inspectionId, confirmedFingerprint: second.chain[0].fingerprint, mode, replace: true } })).statusCode).toBe(200)
  const trust = readCredentialTrust(db, reference)
  expect(trust.map(item => ({ mode: item.mode, endpoint: item.endpoint }))).toEqual([{ mode, endpoint: endpoint + '/' }])
  expect(await (await credentialFetch(endpoint, { method: 'GET' }, trust)).text()).toBe('ok')
  serve('leaf')
  bytes = 0
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toThrow()
  expect(bytes).toBe(0)
})

test('a changed Kubernetes CA requires manual update', async () => {
  store.createInstance('kubernetes-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'token', token: 'CANARY-token', certificateAuthority: pem('other-ca') }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/kubernetes-axi/instances/rotation/certificates'
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ rotation: false, trustMode: 'ca', reason: 'The issuing CA changed; update the CA manually.' })
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'ca', replace: true, fillFields: true } })
  expect(saved.statusCode, saved.body).toBe(400)
  const reference = store.findInstance('kubernetes-axi', 'rotation')!
  expect(store.readCredential(reference)).toMatchObject({ certificateAuthority: pem('other-ca') })
})

test.each([
  ['unifi-axi', () => ({ origin: endpoint, apiKey: 'CANARY-key', tls: { trustedCertificatePem: pem('ca'), peerFingerprintSha256: fingerprint('leaf') } })],
  ['proxmox-axi', () => ({ origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token', caBundle: pem('ca'), certificatePin: { origin: endpoint, sha256: fingerprint('leaf'), replaceHostname: true } })],
] as const)('%s retains manually configured CA with a paired fingerprint on renewal', async (tool, value) => {
  store.createInstance(tool, { name: 'rotation', description: '' }, value(), 'synthetic-development-user', Date.now())
  const base = `/v1/admin/tools/${tool}/instances/rotation/certificates`
  serve('rotated')
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ rotation: true, trustMode: 'ca', verificationError: 'CERTIFICATE_PIN_MISMATCH' })
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'ca', replace: true } })
  expect(response.statusCode, response.body).toBe(200)
  const reference = store.findInstance(tool, 'rotation')!
  const next = store.readCredential(reference) as Record<string, unknown>
  if (tool === 'unifi-axi') expect(next.tls).toEqual({ trustedCertificatePem: pem('ca'), peerFingerprintSha256: fingerprint('rotated') })
  else expect(next).toMatchObject({ caBundle: pem('ca'), certificatePin: { origin: endpoint, sha256: fingerprint('rotated'), replaceHostname: true } })
  const trust = readCredentialTrust(db, reference)
  expect(trust).toEqual([])
  await expect(preflight(tool, next, trust)).resolves.toBeUndefined()
  serve('leaf')
  await expect(preflight(tool, next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})

test('a verified CA is retained when the server omits its issuer', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key', tls: { trustedCertificatePem: pem('ca'), peerFingerprintSha256: fingerprint('leaf') } }, 'synthetic-development-user', Date.now())
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem('root-issued') })
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ rotation: true, trustMode: 'ca', anchor: { fingerprint: new X509Certificate(pem('ca')).fingerprint256 } })
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'ca', replace: true } })
  expect(response.statusCode, response.body).toBe(200)
  const reference = store.findInstance('unifi-axi', 'rotation')!
  expect(readCredentialTrust(db, reference)).toEqual([])
  await expect(preflight('unifi-axi', store.readCredential(reference) as Record<string, unknown>, readCredentialTrust(db, reference))).resolves.toBeUndefined()
})

test.each([false, true])('mode mismatch with replace=%s leaves endpoint pin intact', async replace => {
  const reference = store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: endpoint, auth: 'token', token: 'CANARY-token' }, 0, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/vectra-axi/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const first = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: first.inspectionId, confirmedFingerprint: first.chain[0].fingerprint, mode: 'pin' } })).statusCode).toBe(200)
  const before = readCredentialTrust(db, reference)
  serve('rotated')
  const renewal = await inspect()
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', replace, fillFields: false } })
  expect(response.statusCode).toBe(400)
  expect(readCredentialTrust(db, reference)).toEqual(before)
})

test.each([false, true])('initial trust with fillFields=%s cannot add a second pin', async fillFields => {
  const reference = store.replaceCredential('vectra-axi', { kind: 'qux', apiVersion: '2.5', origin: endpoint, auth: 'token', token: 'CANARY-token' }, 0, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/vectra-axi/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'pin' } })).statusCode).toBe(200)
  const before = readCredentialTrust(db, reference)
  serve('rotated')
  const renewal = await inspect()
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'pin', fillFields, replace: false } })
  expect(response.statusCode).toBe(400)
  expect(readCredentialTrust(db, reference)).toEqual(before)
})

test.each(['tool', 'instance'] as const)('%s rejects an inspection older than a confirmed endpoint pin', async scope => {
  const value = { kind: 'qux' as const, apiVersion: '2.5' as const, origin: endpoint, auth: 'token' as const, token: 'CANARY-token' }
  const reference = scope === 'tool'
    ? store.replaceCredential('vectra-axi', value, 0, 'synthetic-development-user', Date.now())
    : store.createInstance('vectra-axi', { name: 'rotation', description: '' }, value, 'synthetic-development-user', Date.now())
  const base = scope === 'tool' ? '/v1/admin/tools/vectra-axi/certificates' : '/v1/admin/tools/vectra-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const confirm = (inspection: any, replace: boolean) => app.inject({ method: 'POST', url: base + '/trust', headers,
    payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'pin', replace } })
  const initial = await inspect()
  expect((await confirm(initial, false)).statusCode).toBe(200)
  serve('rotated')
  const older = await inspect()
  serve('empty-subject')
  const newer = await inspect()
  expect((await confirm(newer, true)).statusCode).toBe(200)
  const rejected = await confirm(older, true)
  expect(rejected.statusCode).toBe(409)
  expect(rejected.json().error.message).toContain('Inspect the certificate again')
  const trust = readCredentialTrust(db, reference)
  expect(trust.map(item => item.leafFingerprint)).toEqual([newer.chain[0].fingerprint])
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).resolves.toMatchObject({ status: 200 })
  serve('rotated')
  await expect(credentialFetch(endpoint, { method: 'GET' }, trust)).rejects.toThrow()
})

test('CA fingerprint replacement leaves a different endpoint CA record untouched', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key', tls: { trustedCertificatePem: pem('ca'), peerFingerprintSha256: fingerprint('leaf') } }, 'synthetic-development-user', Date.now())
  const reference = store.findInstance('unifi-axi', 'rotation')!
  db.prepare('INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-ca', reference.id, endpoint.toUpperCase(), new X509Certificate(pem('intermediate')).fingerprint256, new X509Certificate(pem('leaf')).fingerprint256, pem('intermediate'), pem('leaf'), 'ca', Date.now(), 'synthetic-development-user')
  const before = readCredentialTrust(db, reference)
  serve('rotated')
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ rotation: true, trustMode: 'ca' })
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'ca', replace: true } })
  expect(response.statusCode, response.body).toBe(200)
  expect(readCredentialTrust(db, reference)).toEqual(before)
  const next = store.readCredential(store.findInstance('unifi-axi', 'rotation')!) as Record<string, unknown>
  expect(next.tls).toEqual({ trustedCertificatePem: pem('ca'), peerFingerprintSha256: fingerprint('rotated') })
  await expect(preflight('unifi-axi', next, before)).resolves.toBeUndefined()
})

test.each([
  ['ca', true],
  ['other-ca', false],
] as const)('CA renewal verifies the saved %s certificate as well as endpoint trust', async (savedCa, verified) => {
  const value = { origin: endpoint, apiKey: 'CANARY-key', tls: { trustedCertificatePem: pem(savedCa), peerFingerprintSha256: fingerprint(savedCa) } }
  const reference = store.createInstance('unifi-axi', { name: 'rotation', description: '' }, value, 'synthetic-development-user', Date.now())
  db.prepare('INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-ca', reference.id, endpoint, new X509Certificate(pem('intermediate')).fingerprint256, new X509Certificate(pem('leaf')).fingerprint256, pem('intermediate'), pem('leaf'), 'ca', Date.now(), 'synthetic-development-user')
  serve('rotated')
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ trustMode: 'ca', rotation: verified })
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'ca', replace: true } })
  expect(response.statusCode, response.body).toBe(verified ? 200 : 400)
  const next = store.readCredential(store.findInstance('unifi-axi', 'rotation')!) as Record<string, unknown>
  expect(next.tls).toEqual({ trustedCertificatePem: pem(savedCa), peerFingerprintSha256: fingerprint(verified ? 'rotated' : savedCa) })
})

test('standalone Proxmox pin can be replaced', async () => {
  const pin = { origin: endpoint, sha256: fingerprint('leaf'), replaceHostname: false }
  store.createInstance('proxmox-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token', certificatePin: pin }, 'synthetic-development-user', Date.now())
  serve('rotated')
  const base = '/v1/admin/tools/proxmox-axi/instances/rotation/certificates'
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ trustMode: 'pin', rotation: true })
  const response = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'pin', replace: true } })
  expect(response.statusCode, response.body).toBe(200)
  const reference = store.findInstance('proxmox-axi', 'rotation')!
  const value = store.readCredential(reference) as Record<string, unknown>
  expect(value.certificatePin).toEqual({ ...pin, sha256: fingerprint('rotated') })
  expect(value.caBundle).toBeUndefined()
  await expect(preflight('proxmox-axi', value, readCredentialTrust(db, reference))).resolves.toBeUndefined()
  serve('leaf')
  await expect(preflight('proxmox-axi', value, readCredentialTrust(db, reference))).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})

test('same CA renewal does not offer replacement without a leaf fingerprint', async () => {
  store.createInstance('vectra-axi', { name: 'rotation', description: '' }, { kind: 'qux', apiVersion: '2.5', origin: endpoint, auth: 'token', token: 'CANARY-token' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/vectra-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const first = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: first.inspectionId, confirmedFingerprint: first.chain[0].fingerprint, mode: 'ca' } })).statusCode).toBe(200)
  serve('rotated')
  expect(await inspect()).toMatchObject({ rotation: false, trustMode: 'ca', verificationError: null })
})

test('UniFi replaces CA setup without losing its required leaf fingerprint', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  const caRecord = db.prepare('SELECT * FROM trusted_certificates').all()
  expect(await inspect()).toMatchObject({ rotation: false, trustMode: 'ca' })
  serve('rotated')
  const renewal = await inspect()
  expect(renewal).toMatchObject({ rotation: true, trustMode: 'ca', verificationError: 'CERTIFICATE_PIN_MISMATCH' })
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', fillFields: true, replace: true } })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(db.prepare('SELECT * FROM trusted_certificates').all()).toEqual(caRecord)
  const after = await inspect()
  expect(after).toMatchObject({ rotation: false, trustMode: 'ca', verificationError: null, previousFingerprints: [] })
  expect(after.warnings).not.toContain('This endpoint was previously trusted with a different fingerprint. This may be rotation or interception.')
  const listed = (await app.inject({ method: 'GET', url: base, headers })).json()
  expect(listed.certificates[0].leaf.fingerprint).toBe(renewal.chain[0].fingerprint)
  const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost' } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!
  const login = await app.inject({ method: 'POST', url: '/login', headers: { host: 'localhost', origin: 'http://localhost',
    cookie: loginPage.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ _csrf: csrf, username: 'synthetic-user', password: 'CANARY-local-password' }).toString() })
  const page = await app.inject({ method: 'GET', url: '/admin/tools/unifi-axi/instances/rotation', headers: { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } })
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain(renewal.chain[0].fingerprint)
  const reference = store.findInstance('unifi-axi', 'rotation')!
  const next = store.readCredential(reference) as Record<string, unknown>
  expect(next.tls).toEqual({ trustedCertificatePem: pem('intermediate'), peerFingerprintSha256: fingerprint('rotated') })
  const trust = readCredentialTrust(db, reference)
  expect(trust.map(item => item.mode)).toEqual(['ca'])
  await expect(preflight('unifi-axi', next, trust)).resolves.toBeUndefined()
  serve('leaf')
  await expect(preflight('unifi-axi', next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})

test('Proxmox CA replacement also updates its separate pin without changing pin options', async () => {
  const pin = { origin: endpoint, sha256: fingerprint('leaf'), replaceHostname: true }
  store.createInstance('proxmox-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token', caBundle: pem('ca'), certificatePin: pin }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/proxmox-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  serve('rotated')
  const renewal = await inspect()
  expect(renewal.trustMode).toBe('ca')
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', replace: true } })
  expect(saved.statusCode, saved.body).toBe(200)
  const reference = store.findInstance('proxmox-axi', 'rotation')!
  const next = store.readCredential(reference) as Record<string, unknown>
  expect(next.certificatePin).toEqual({ ...pin, sha256: fingerprint('rotated') })
  const trust = readCredentialTrust(db, reference)
  expect(trust).toEqual([])
  await expect(preflight('proxmox-axi', next, trust)).resolves.toBeUndefined()
  serve('leaf')
  await expect(preflight('proxmox-axi', next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})

test('a hand-edited CA fingerprint keeps the table and re-inspection on the saved leaf', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/certificates/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/certificates/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  serve('rotated')
  const instance = store.findInstance('unifi-axi', 'rotation')!
  const tool = (await app.inject({ method: 'GET', url: '/v1/admin/tools/unifi-axi', headers })).json()
  const value = store.readCredential(instance) as { tls: Record<string, unknown> }
  const edited = await app.inject({ method: 'PATCH', url: base + '/credential', headers, payload: { expectedId: instance.id, expectedRevision: instance.revision,
    expectedToolRevision: tool.revision, value: { ...value, tls: { ...value.tls, peerFingerprintSha256: fingerprint('rotated') } } } })
  expect(edited.statusCode, edited.body).toBe(200)
  serve('leaf')
  const mismatch = await inspect()
  expect(mismatch).toMatchObject({ rotation: true, verificationError: 'CERTIFICATE_PIN_MISMATCH' })
  expect((await app.inject({ method: 'GET', url: base + '/certificates', headers })).json().certificates[0]).toMatchObject({ leaf: null, leafFingerprint: new X509Certificate(pem('rotated')).fingerprint256 })
  serve('rotated')
  const after = await inspect()
  expect(after).toMatchObject({ rotation: false, verificationError: null, previousFingerprints: [] })
  expect(after.warnings).not.toContain('This endpoint was previously trusted with a different fingerprint. This may be rotation or interception.')
  const listed = (await app.inject({ method: 'GET', url: base + '/certificates', headers })).json()
  expect(listed.certificates[0]).toMatchObject({ leaf: { fingerprint: new X509Certificate(pem('rotated')).fingerprint256 }, leafFingerprint: new X509Certificate(pem('rotated')).fingerprint256 })
  const reference = store.findInstance('unifi-axi', 'rotation')!
  const next = store.readCredential(reference) as Record<string, unknown>
  const trust = readCredentialTrust(db, reference)
  await expect(preflight('unifi-axi', next, trust)).resolves.toBeUndefined()
  serve('leaf')
  await expect(preflight('unifi-axi', next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})

test('removing one CA record keeps the confirmed leaf for the remaining record', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  serve('rotated')
  const renewal = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', fillFields: true, replace: true } })).statusCode).toBe(200)
  const reference = store.findInstance('unifi-axi', 'rotation')!
  db.prepare('INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-second-ca', reference.id, endpoint, new X509Certificate(pem('ca')).fingerprint256, new X509Certificate(pem('leaf')).fingerprint256, pem('ca'), pem('leaf'), 'ca', Date.now(), 'synthetic-development-user')
  expect((await app.inject({ method: 'DELETE', url: base, headers, payload: { id: 'synthetic-second-ca' } })).statusCode, 'remove').toBe(200)
  const after = await inspect()
  expect(after).toMatchObject({ rotation: false, verificationError: null, previousFingerprints: [] })
  const listed = (await app.inject({ method: 'GET', url: base, headers })).json()
  expect(listed.certificates).toHaveLength(1)
  expect(listed.certificates[0].leaf.fingerprint).toBe(renewal.chain[0].fingerprint)
})

test('saving unrelated credentials preserves a CA leaf without a fingerprint', async () => {
  store.createInstance('proxmox-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/proxmox-axi/instances/rotation'
  const initial = (await app.inject({ method: 'POST', url: base + '/certificates/inspect', headers, payload: {} })).json()
  expect((await app.inject({ method: 'POST', url: base + '/certificates/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  const instance = store.findInstance('proxmox-axi', 'rotation')!
  const tool = (await app.inject({ method: 'GET', url: '/v1/admin/tools/proxmox-axi', headers })).json()
  const value = store.readCredential(instance) as Record<string, unknown>
  const saved = await app.inject({ method: 'PATCH', url: base + '/credential', headers, payload: { expectedId: instance.id, expectedRevision: instance.revision, expectedToolRevision: tool.revision, value: { ...value, token: 'CANARY-new-token' } } })
  expect(saved.statusCode, saved.body).toBe(200)
  const listed = (await app.inject({ method: 'GET', url: base + '/certificates', headers })).json()
  expect(listed.certificates[0].leaf.fingerprint).toBe(initial.chain[0].fingerprint)
  expect(listed.certificates[0].leaf.expiresAt).toBe(initial.chain[0].expiresAt)
})

test('editing an endpoint and fingerprint only updates the new endpoint', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation'
  const initial = (await app.inject({ method: 'POST', url: base + '/certificates/inspect', headers, payload: {} })).json()
  expect((await app.inject({ method: 'POST', url: base + '/certificates/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  const instance = store.findInstance('unifi-axi', 'rotation')!
  const newEndpoint = 'https://localhost:1/'
  db.prepare('INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-other-endpoint', instance.id, newEndpoint, new X509Certificate(pem('ca')).fingerprint256, new X509Certificate(pem('leaf')).fingerprint256, pem('ca'), pem('leaf'), 'ca', Date.now(), 'synthetic-development-user')
  const tool = (await app.inject({ method: 'GET', url: '/v1/admin/tools/unifi-axi', headers })).json()
  const value = store.readCredential(instance) as { tls: Record<string, unknown> }
  const saved = await app.inject({ method: 'PATCH', url: base + '/credential', headers, payload: { expectedId: instance.id, expectedRevision: instance.revision, expectedToolRevision: tool.revision, value: { ...value, origin: 'https://localhost:1', tls: { ...value.tls, peerFingerprintSha256: fingerprint('rotated') } } } })
  expect(saved.statusCode, saved.body).toBe(200)
  const listed = (await app.inject({ method: 'GET', url: base + '/certificates', headers })).json()
  expect(listed.certificates.find((item: { endpoint: string }) => item.endpoint === endpoint + '/').leafFingerprint).toBe(initial.chain[0].fingerprint)
  expect(listed.certificates.find((item: { endpoint: string }) => item.endpoint === newEndpoint).leafFingerprint).toBe(new X509Certificate(pem('rotated')).fingerprint256)
})

test('moving to an endpoint without a fingerprint clears its old leaf', async () => {
  store.createInstance('proxmox-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/proxmox-axi/instances/rotation'
  const initial = (await app.inject({ method: 'POST', url: base + '/certificates/inspect', headers, payload: {} })).json()
  expect((await app.inject({ method: 'POST', url: base + '/certificates/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  const instance = store.findInstance('proxmox-axi', 'rotation')!
  const newEndpoint = 'https://localhost:1/'
  db.prepare('INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-other-endpoint', instance.id, newEndpoint, new X509Certificate(pem('ca')).fingerprint256, new X509Certificate(pem('leaf')).fingerprint256, pem('ca'), pem('leaf'), 'ca', Date.now(), 'synthetic-development-user')
  const tool = (await app.inject({ method: 'GET', url: '/v1/admin/tools/proxmox-axi', headers })).json()
  const value = store.readCredential(instance) as Record<string, unknown>
  const saved = await app.inject({ method: 'PATCH', url: base + '/credential', headers, payload: { expectedId: instance.id, expectedRevision: instance.revision, expectedToolRevision: tool.revision, value: { ...value, origin: 'https://localhost:1' } } })
  expect(saved.statusCode, saved.body).toBe(200)
  const listed = (await app.inject({ method: 'GET', url: base + '/certificates', headers })).json()
  expect(listed.certificates.find((item: { endpoint: string }) => item.endpoint === endpoint + '/').leafFingerprint).toBe(initial.chain[0].fingerprint)
  expect(listed.certificates.find((item: { endpoint: string }) => item.endpoint === newEndpoint)).toMatchObject({ leaf: null, leafFingerprint: null })
})

test('upgrading a confirmed CA renewal preserves the displayed leaf', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  serve('rotated')
  const renewal = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', replace: true } })).statusCode).toBe(200)
  db.exec('ALTER TABLE certificate_endpoint_state DROP COLUMN confirmed_leaf_fingerprint; DELETE FROM migrations WHERE version = 37')
  migrate(db)
  expect((await app.inject({ method: 'GET', url: base, headers })).json().certificates[0].leaf.fingerprint).toBe(renewal.chain[0].fingerprint)
  const after = await inspect()
  expect(after.previousFingerprints).toEqual([])
  expect(after.warnings).not.toContain('This endpoint was previously trusted with a different fingerprint. This may be rotation or interception.')
})

test.each(['edit', 'remove'] as const)('clearing a confirmed leaf through %s does not revive an old leaf', async action => {
  store.createInstance('proxmox-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/proxmox-axi/instances/rotation'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/certificates/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/certificates/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  const initialInstance = store.findInstance('proxmox-axi', 'rotation')!
  const initialTool = (await app.inject({ method: 'GET', url: '/v1/admin/tools/proxmox-axi', headers })).json()
  const initialValue = store.readCredential(initialInstance) as Record<string, unknown>
  const pinned = await app.inject({ method: 'PATCH', url: base + '/credential', headers, payload: { expectedId: initialInstance.id, expectedRevision: initialInstance.revision, expectedToolRevision: initialTool.revision, value: { ...initialValue, certificatePin: { origin: endpoint, sha256: fingerprint('leaf'), replaceHostname: false } } } })
  expect(pinned.statusCode, pinned.body).toBe(200)
  serve('rotated')
  const renewal = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/certificates/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', replace: true } })).statusCode).toBe(200)
  const instance = store.findInstance('proxmox-axi', 'rotation')!
  if (action === 'edit') {
    const tool = (await app.inject({ method: 'GET', url: '/v1/admin/tools/proxmox-axi', headers })).json()
    const value = store.readCredential(instance) as Record<string, unknown>
    const edited = await app.inject({ method: 'PATCH', url: base + '/credential', headers, payload: { expectedId: instance.id, expectedRevision: instance.revision, expectedToolRevision: tool.revision, value: { ...value, certificatePin: null } } })
    expect(edited.statusCode, edited.body).toBe(200)
  } else {
    db.prepare('UPDATE certificate_endpoint_state SET confirmed_leaf_pem = NULL, confirmed_leaf_fingerprint = NULL WHERE credential_id = ?').run(instance.id)
    db.prepare('INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-second-ca', instance.id, endpoint, new X509Certificate(pem('ca')).fingerprint256, new X509Certificate(pem('leaf')).fingerprint256, pem('ca'), pem('leaf'), 'ca', Date.now(), 'synthetic-development-user')
    expect((await app.inject({ method: 'DELETE', url: base + '/certificates', headers, payload: { id: 'synthetic-second-ca' } })).statusCode).toBe(200)
  }
  expect((await app.inject({ method: 'GET', url: base + '/certificates', headers })).json().certificates[0]).toMatchObject({ leaf: null, leafFingerprint: null })
  const after = await inspect()
  expect(after.previousFingerprints).toEqual([])
  expect(after.warnings).not.toContain('This endpoint was previously trusted with a different fingerprint. This may be rotation or interception.')
  expect((await app.inject({ method: 'GET', url: base + '/certificates', headers })).json().certificates[0]).toMatchObject({ leaf: null, leafFingerprint: null })
})
