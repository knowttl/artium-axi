import { X509Certificate } from 'node:crypto'
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
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { readCredentialTrust } from '../../src/server/store/trusted-certificates.js'
import { preflight } from '../../src/server/health/preflight.js'
import { credentialFetch } from '../../src/server/credential-tls.js'
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
  ['unifi-axi', () => ({ origin: endpoint, apiKey: 'CANARY-key', tls: { trustedCertificatePem: pem('leaf'), peerFingerprintSha256: fingerprint('leaf') } })],
  ['proxmox-axi', () => ({ origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token',
    caBundle: pem('ca'), certificatePin: { origin: endpoint, sha256: fingerprint('leaf'), replaceHostname: true } })],
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

test.each(['pin', 'ca'] as const)('%s replacement removes normalized legacy records through tool routes', async mode => {
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

test('Kubernetes replaces its shared CA while retaining CA trust', async () => {
  store.createInstance('kubernetes-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'token', token: 'CANARY-token', certificateAuthority: pem('other-ca') }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/kubernetes-axi/instances/rotation/certificates'
  const inspection = (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  expect(inspection).toMatchObject({ rotation: true, trustMode: 'ca' })
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: inspection.inspectionId, confirmedFingerprint: inspection.chain[0].fingerprint, mode: 'ca', replace: true, fillFields: true } })
  expect(saved.statusCode, saved.body).toBe(200)
  const reference = store.findInstance('kubernetes-axi', 'rotation')!
  expect(store.readCredential(reference)).toMatchObject({ certificateAuthority: pem('intermediate') })
  serve('rotated')
  await expect(preflight('kubernetes-axi', store.readCredential(reference) as Record<string, unknown>, readCredentialTrust(db, reference))).resolves.toBeUndefined()
})

test('UniFi replaces CA setup without losing its required leaf fingerprint', async () => {
  store.createInstance('unifi-axi', { name: 'rotation', description: '' }, { origin: endpoint, apiKey: 'CANARY-key' }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/unifi-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca', fillFields: true } })).statusCode).toBe(200)
  expect(await inspect()).toMatchObject({ rotation: false, trustMode: 'ca' })
  serve('rotated')
  const renewal = await inspect()
  expect(renewal).toMatchObject({ rotation: true, trustMode: 'ca', verificationError: 'CERTIFICATE_PIN_MISMATCH' })
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', fillFields: true, replace: true } })
  expect(saved.statusCode, saved.body).toBe(200)
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
  store.createInstance('proxmox-axi', { name: 'rotation', description: '' }, { origin: endpoint, auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token', caBundle: pem('other-ca'), certificatePin: pin }, 'synthetic-development-user', Date.now())
  const base = '/v1/admin/tools/proxmox-axi/instances/rotation/certificates'
  const inspect = async () => (await app.inject({ method: 'POST', url: base + '/inspect', headers, payload: {} })).json()
  const initial = await inspect()
  expect((await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: initial.inspectionId, confirmedFingerprint: initial.chain[0].fingerprint, mode: 'ca' } })).statusCode).toBe(200)
  serve('rotated')
  const renewal = await inspect()
  expect(renewal.trustMode).toBe('ca')
  const saved = await app.inject({ method: 'POST', url: base + '/trust', headers, payload: { inspectionId: renewal.inspectionId, confirmedFingerprint: renewal.chain[0].fingerprint, mode: 'ca', replace: true } })
  expect(saved.statusCode, saved.body).toBe(200)
  const reference = store.findInstance('proxmox-axi', 'rotation')!
  const next = store.readCredential(reference) as Record<string, unknown>
  expect(next.certificatePin).toEqual({ ...pin, sha256: fingerprint('rotated') })
  const trust = readCredentialTrust(db, reference)
  expect(trust.map(item => item.mode)).toEqual(['ca'])
  await expect(preflight('proxmox-axi', next, trust)).resolves.toBeUndefined()
  serve('leaf')
  await expect(preflight('proxmox-axi', next, trust)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
})
