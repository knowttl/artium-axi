import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request, type IncomingMessage } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decode } from '@toon-format/toon'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createInspectionCertificates, createTestClientCertificate } from '../../../test/fake-service/certificates.mjs'
import { createGhAdapter } from '../adapters/gh.js'
import { createKubernetesAdapter } from '../adapters/kubernetes.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { pinnedHttp, type PinnedHttpUpstream } from './pinned-http.js'
import { Runner } from './runner.js'
import { loadTrustedCa } from '../trusted-ca.js'
import { createCredentialStore, openStore } from '../store/db.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { EmbeddedSecretSource } from '../store/secret-source.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-go-pin-'))
const gh = join(directory, 'gh')
const ghSupported = process.platform === 'linux' && process.arch === 'x64'
const ghTest = ghSupported ? test : test.skip
const ghSkip = ghSupported ? '' : ` (no pinned gh for ${process.platform}/${process.arch})`
const pem = (name: string) => readFileSync(join(directory, name + '.crt'), 'utf8')
let endpoint: string
let applicationRequests: string[] = []
let kubernetes = false
let methods: string[] = []
let storedIdentity: { certificate: string, privateKey: string }
let otherStoredIdentity: { certificate: string, privateKey: string }
const server = createServer((incoming, response) => {
  applicationRequests.push(incoming.headers.authorization ?? '')
  methods.push(incoming.method!)
  if (incoming.url?.split('?')[0].endsWith('/held')) return
  response.setHeader('content-type', 'application/json')
  if (kubernetes) {
    const path = incoming.url!.split('?')[0]
    if (path === '/version') return response.end('{"major":"1","minor":"32","gitVersion":"v1.32.2"}')
    if (path === '/api') return response.end('{"kind":"APIVersions","apiVersion":"v1","versions":["v1"]}')
    if (path === '/apis') return response.end('{"kind":"APIGroupList","apiVersion":"v1","groups":[]}')
    if (path === '/api/v1') return response.end(JSON.stringify({ kind: 'APIResourceList', apiVersion: 'v1', groupVersion: 'v1', resources: [
      { name: 'configmaps', singularName: '', namespaced: true, kind: 'ConfigMap', verbs: ['get', 'list', 'create'] },
    ] }))
    if (incoming.method === 'POST' && path === '/api/v1/namespaces/default/configmaps') {
      incoming.resume()
      return response.end('{"kind":"ConfigMap","apiVersion":"v1","metadata":{"name":"synthetic-new","namespace":"default","uid":"synthetic-uid","resourceVersion":"1"},"data":{"mode":"prepared"}}')
    }
    response.writeHead(404)
    return response.end('{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}')
  }
  response.end('{"remaining":4999}')
})
const trust = (): CredentialTrust[] => [{ endpoint, pem: pem('intermediate'), fingerprint: new X509Certificate(pem('intermediate')).fingerprint256,
  leafFingerprint: new X509Certificate(pem('leaf')).fingerprint256, mode: 'pin' }]
function serve(name: string) {
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(name) + pem('intermediate') })
}
beforeAll(async () => {
  if (ghSupported) await promisify(execFile)(process.execPath, ['scripts/install-gh.mjs', 'tools/gh-source.json', gh])
  else console.warn(`Skipping native gh and kubectl transport tests: no verified pins for ${process.platform}/${process.arch}`)
  createInspectionCertificates(directory, 'http://localhost:1/unused-issuer')
  createTestClientCertificate(directory)
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
  const db = openStore(join(directory, 'credentials.db'), provider)
  try {
    db.exec("INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'unusable')")
    const store = createCredentialStore(db, provider)
    const reference = store.replaceCredential('kubernetes-axi', { origin: 'https://localhost', auth: 'certificate',
      clientCertificate: pem('client'), privateKey: readFileSync(join(directory, 'client.key'), 'utf8') }, 0, 'synthetic-user', Date.now())
    const credential = await new EmbeddedSecretSource(store).getCredential(reference) as { clientCertificate: string, privateKey: string }
    storedIdentity = { certificate: credential.clientCertificate, privateKey: credential.privateKey }
    const otherReference = store.replaceCredential('kubernetes-axi', { origin: 'https://localhost', auth: 'certificate',
      clientCertificate: pem('client-only'), privateKey: readFileSync(join(directory, 'server.key'), 'utf8') }, 1, 'synthetic-user', Date.now())
    const otherCredential = await new EmbeddedSecretSource(store).getCredential(otherReference) as { clientCertificate: string, privateKey: string }
    otherStoredIdentity = { certificate: otherCredential.clientCertificate, privateKey: otherCredential.privateKey }
  } finally { db.close() }
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `https://localhost:${(server.address() as { port: number }).port}`
}, 120_000)
beforeEach(() => { applicationRequests = []; methods = []; kubernetes = false; serve('leaf') })
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

function requestRelay(socketPath: string, target = endpoint, headers: Record<string, string> = {}) {
  return new Promise<{ status: number, body: string }>((resolve, reject) => {
    const outgoing = request({ socketPath, agent: false, path: '/api/v3/rate_limit', headers: {
      ...headers, host: new URL(target).host, authorization: 'token CANARY-managed-token',
    } }, incoming => {
      let body = ''
      incoming.on('data', chunk => { body += chunk })
      incoming.once('end', () => resolve({ status: incoming.statusCode!, body }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function relayRequest(saved: readonly CredentialTrust[], ca?: string, options?: PinnedHttpUpstream) {
  const socketPath = join(directory, 'relay.sock')
  const relay = await pinnedHttp(socketPath, saved, ca, options)
  try {
    return await requestRelay(socketPath)
  } finally { await relay.close() }
}

test('the application connection accepts the exact leaf and preserves the managed token', async () => {
  expect(await relayRequest(trust())).toEqual({ status: 200, body: '{"remaining":4999}' })
  expect(applicationRequests).toEqual(['token CANARY-managed-token'])
})

test.each([
  { certificate: 'rotated', leaf: 'leaf', anchor: 'intermediate' },
  { certificate: 'other-ca-leaf', leaf: 'other-ca-leaf', anchor: 'intermediate' },
  { certificate: 'mismatch', leaf: 'leaf', anchor: 'ca' },
  { certificate: 'expired', leaf: 'leaf', anchor: 'ca' },
  { certificate: 'mismatch', leaf: 'mismatch', anchor: 'ca' },
  { certificate: 'expired', leaf: 'expired', anchor: 'ca' },
  { certificate: 'rotated', leaf: 'leaf', anchor: 'intermediate', serverName: 'localhost' },
  { certificate: 'other-ca-leaf', leaf: 'other-ca-leaf', anchor: 'intermediate', serverName: 'localhost' },
  { certificate: 'expired', leaf: 'expired', anchor: 'ca', serverName: 'localhost' },
])('rejects $certificate with pin $leaf and name $serverName, sends no application data and remains usable (#276)', async ({ certificate, leaf, anchor, serverName }) => {
  serve(certificate)
  const saved = [{ ...trust()[0], pem: pem(anchor), leafFingerprint: new X509Certificate(pem(leaf)).fingerprint256 }, ...trust()]
  const socketPath = join(directory, 'recovery.sock')
  const relay = await pinnedHttp(socketPath, saved, undefined, serverName ? { endpoint, serverName } : undefined)
  try {
    expect((await requestRelay(socketPath)).status).toBe(502)
    expect(applicationRequests).toEqual([])
    serve('leaf')
    expect(await requestRelay(socketPath)).toEqual({ status: 200, body: '{"remaining":4999}' })
    expect(applicationRequests).toEqual(['token CANARY-managed-token'])
  } finally { await relay.close() }
})

test('the host server name controls SNI and hostname verification on the pinned data connection', async () => {
  serve('mismatch')
  const saved = [{ ...trust()[0], pem: pem('ca'), leafFingerprint: new X509Certificate(pem('mismatch')).fingerprint256 }]
  let serverName: string | undefined
  const observe = (socket: import('node:tls').TLSSocket) => { serverName = socket.servername || undefined }
  server.on('secureConnection', observe)
  try {
    expect(await relayRequest(saved, undefined, { endpoint, serverName: 'other.synthetic.test' }))
      .toEqual({ status: 200, body: '{"remaining":4999}' })
    expect(serverName).toBe('other.synthetic.test')
    expect(applicationRequests).toEqual(['token CANARY-managed-token'])
  } finally { server.off('secureConnection', observe) }
})

test.each(['malformed certificate', 'malformed key', 'mismatched key'])('rejects a %s without stopping the relay', async scenario => {
  const identity = {
    certificate: scenario === 'malformed certificate' ? 'invalid' : storedIdentity.certificate,
    privateKey: scenario === 'malformed key' ? 'invalid' : scenario === 'mismatched key'
      ? readFileSync(join(directory, 'server.key'), 'utf8') : storedIdentity.privateKey,
  }
  const socketPath = join(directory, 'invalid-identity.sock')
  const relay = await pinnedHttp(socketPath, trust(), undefined, { endpoint, clientIdentity: identity })
  try {
    const failure = { status: 502, body: '{"message":"Upstream TLS connection failed"}' }
    expect(await requestRelay(socketPath)).toEqual(failure)
    expect(await requestRelay(socketPath)).toEqual(failure)
    expect(applicationRequests).toEqual([])
  } finally { await relay.close() }
})

test.each([
  { scenario: 'correct client and leaf', client: 'client', certificate: 'leaf', pin: 'leaf', serverName: 'localhost',
    status: 200, body: 'authenticated', peers: ['synthetic-kubernetes-client'] },
  { scenario: 'wrong client certificate', client: 'other-ca-leaf', certificate: 'leaf', pin: 'leaf', serverName: 'localhost',
    status: 502, body: '{"message":"Upstream TLS connection failed"}', peers: [] },
  { scenario: 'wrong leaf pin', client: 'client', certificate: 'rotated', pin: 'leaf', serverName: 'localhost',
    status: 502, body: '{"message":"CERTIFICATE_PIN_MISMATCH"}', peers: [] },
  { scenario: 'wrong server name', client: 'client', certificate: 'leaf', pin: 'leaf', serverName: 'other.synthetic.test',
    status: 502, body: '{"message":"Upstream TLS connection failed"}', peers: [] },
  { scenario: 'expired pinned server', client: 'client', certificate: 'expired', pin: 'expired', serverName: 'localhost',
    status: 502, body: '{"message":"Upstream TLS connection failed"}', peers: [] },
])('mutual TLS with $scenario returns $status (#276)', async ({ client, certificate, pin, serverName, status, body, peers }) => {
  const received: string[] = []
  const mutual = createServer({ requestCert: true, rejectUnauthorized: true, ca: pem('ca'),
    key: readFileSync(join(directory, 'server.key')), cert: pem(certificate) + pem('intermediate') }, (incoming, response) => {
    received.push((incoming.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN as string)
    response.end('authenticated')
  })
  mutual.listen(0, '127.0.0.1')
  await once(mutual, 'listening')
  const target = `https://127.0.0.1:${(mutual.address() as { port: number }).port}`
  const saved = [{ ...trust()[0], endpoint: target, pem: pem('ca'), leafFingerprint: new X509Certificate(pem(pin)).fingerprint256 }]
  const socketPath = join(directory, 'mutual.sock')
  const relay = await pinnedHttp(socketPath, saved, undefined, { endpoint: target, serverName,
    clientIdentity: client === 'client' ? storedIdentity
      : { certificate: pem(client), privateKey: readFileSync(join(directory, 'server.key'), 'utf8') } })
  try {
    expect(await requestRelay(socketPath, target)).toEqual({ status, body })
    expect(received).toEqual(peers)
  } finally {
    await relay.close()
    mutual.closeAllConnections()
    await new Promise<void>(resolve => mutual.close(() => resolve()))
  }
})

test('host TLS options never follow incoming endpoint or TLS headers to another endpoint', async () => {
  const received: string[] = []
  const other = createServer({ requestCert: true, rejectUnauthorized: false, ca: pem('ca'),
    key: readFileSync(join(directory, 'server.key')), cert: pem('leaf') + pem('intermediate') }, (incoming, response) => {
    received.push((incoming.socket as import('node:tls').TLSSocket).getPeerCertificate().subject?.CN as string ?? 'anonymous')
    response.end('other endpoint')
  })
  other.listen(0, '127.0.0.1')
  await once(other, 'listening')
  const target = `https://localhost:${(other.address() as { port: number }).port}`
  const socketPath = join(directory, 'isolated.sock')
  const relay = await pinnedHttp(socketPath, [...trust(), { ...trust()[0], endpoint: target }], undefined, {
    endpoint, serverName: 'other.synthetic.test',
    clientIdentity: storedIdentity,
  })
  try {
    expect(await requestRelay(socketPath, target, { servername: 'other.synthetic.test',
      'x-tls-server-name': 'other.synthetic.test', 'x-client-certificate': pem('client').replaceAll('\n', '') }))
      .toEqual({ status: 200, body: 'other endpoint' })
    expect(received).toEqual(['anonymous'])
  } finally {
    await relay.close()
    other.closeAllConnections()
    await new Promise<void>(resolve => other.close(() => resolve()))
  }
})

test('a pin cannot make an unrelated endpoint trusted', async () => {
  expect((await relayRequest([{ ...trust()[0], endpoint: 'https://unrelated.invalid' }])).status).toBe(502)
  expect(applicationRequests).toEqual([])
})

test('a pin for another endpoint does not restrict a normally trusted connection', async () => {
  expect((await relayRequest([{ ...trust()[0], endpoint: 'https://unrelated.invalid' }], pem('ca'))).status).toBe(200)
  expect(applicationRequests).toEqual(['token CANARY-managed-token'])
})

test.each([
  { origin: 'https://github.com', api: 'https://api.github.com' },
  { origin: 'https://synthetic.ghe.com', api: 'https://api.synthetic.ghe.com' },
])('saved pins for $api enable the relay independently of the web origin', async ({ origin, api }) => {
  const call = await createGhAdapter({ getCredential: async () => ({ origin, auth: 'token', token: 'CANARY-managed-token' }) })
    .prepare(['api', '/rate_limit'], { id: 'synthetic-credential', tool: 'gh-axi', revision: 1 })
  const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
  const client = `const fs=require('node:fs'),http=require('node:http');
    const socketPath=JSON.parse(fs.readFileSync('gh/config.yml','utf8').split(': ').slice(1).join(': '));
    http.get({socketPath,agent:false,headers:{host:${JSON.stringify(new URL(endpoint).host)}}},res=>res.pipe(process.stdout))
      .on('error',()=>{process.exitCode=1});`
  try {
    const result = await runner.run('synthetic-user', process.execPath, ['-e', client], call.environment, call.secrets,
      { ...call.limits, credentialTrust: [{ ...trust()[0], endpoint: api }] })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ remaining: 4999 })
    expect(applicationRequests).toEqual([''])
  } finally { await runner.shutdown() }
})

ghTest.each(['token', 'device'] as const)(`native gh carries the managed %s identity through the enforced runner connection${ghSkip}`, async auth => {
  const call = await createGhAdapter({ getCredential: async () => ({ origin: endpoint, auth,
    ...(auth === 'token' ? { token: 'CANARY-managed-token' } : { accessToken: 'CANARY-managed-token', login: 'synthetic-user' }) }),
  }).prepare(['api', '/rate_limit'], { id: 'synthetic-credential', tool: 'gh-axi', revision: 1 })
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const run = () => runner.run('synthetic-user', gh, call.args, call.environment, call.secrets,
      { ...call.limits, credentialTrust: trust() })
    const matching = await run()
    expect(matching.exitCode, matching.stderr).toBe(0)
    expect(JSON.parse(matching.stdout)).toEqual({ remaining: 4999 })
    expect(applicationRequests).toEqual(['token CANARY-managed-token'])
    applicationRequests = []
    serve('rotated')
    expect((await run()).exitCode).not.toBe(0)
    expect(applicationRequests).toEqual([])
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { await runner.shutdown() }
})

ghTest.each(['token', 'device'] as const)(`bundled gh-axi enforces the pin for the managed %s identity${ghSkip}`, async auth => {
  const call = await createGhAdapter({ getCredential: async () => ({ origin: endpoint, auth,
    ...(auth === 'token' ? { token: 'CANARY-managed-token' } : { accessToken: 'CANARY-managed-token', login: 'synthetic-user' }) }),
  }).prepare(['api', '/rate_limit'], { id: 'synthetic-credential', tool: 'gh-axi', revision: 1 })
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const run = () => runner.run('synthetic-user', process.execPath,
      [join(process.cwd(), 'tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...call.args],
      { ...call.environment, GH_BIN: gh }, call.secrets, { ...call.limits, credentialTrust: trust() })
    const matching = await run()
    expect(matching.exitCode, matching.stderr).toBe(0)
    expect(decode(matching.stdout)).toMatchObject({ remaining: 4999 })
    expect(applicationRequests).toEqual(['token CANARY-managed-token'])
    applicationRequests = []
    serve('rotated')
    expect((await run()).exitCode).not.toBe(0)
    expect(applicationRequests).toEqual([])
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { await runner.shutdown() }
})

const kubectlTest = process.platform === 'linux' && process.arch === 'x64' ? test : test.skip
const kubernetesBinary = join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js')
async function kubernetesCall(runner: Runner, args: string[], saved = trust(), token = 'CANARY-kubernetes-token', signal?: AbortSignal,
  identity?: Record<string, string>) {
  const adapter = await createKubernetesAdapter({ getCredential: async () => ({ origin: endpoint,
    ...(identity ?? { auth: 'token', token }), certificateAuthority: pem('ca') }), getSettings: () => ({ allowWrites: true }) },
  kubernetesBinary, join(directory, 'workflow'))
  const call = await adapter.prepare(args, { id: 'synthetic-credential', tool: 'kubernetes-axi', revision: 1 })
  return runner.run('synthetic-user', call.executable, [call.args[0], '--json', ...call.args.slice(1)], call.environment, call.secrets,
    { ...call.limits, signal, credentialTrust: saved, kubernetesRequests: { root: join(directory, 'workflow'), scope: 'a'.repeat(64) } }, {}, call.files)
}

kubectlTest.each([
  { scenario: 'correct pin and client', certificate: 'leaf', pin: 'leaf', client: 'client', success: true },
  { scenario: 'wrong pin', certificate: 'rotated', pin: 'leaf', client: 'client', success: false },
  { scenario: 'wrong server name', certificate: 'mismatch', pin: 'mismatch', client: 'client', success: false },
  { scenario: 'wrong client certificate', certificate: 'leaf', pin: 'leaf', client: 'other-ca-leaf', success: false },
  { scenario: 'expired server certificate', certificate: 'expired', pin: 'expired', client: 'client', success: false },
].flatMap(scenario => [
  { ...scenario, args: ['version'], requests: 1 },
  { ...scenario, args: ['native', '--', 'get', '--raw=/version'], requests: 2 },
]))('managed certificate $args with $scenario enforces exact pins (#276)', async ({ certificate, pin, client, success, args, requests }) => {
  const received: string[] = []
  const mutual = createServer({ requestCert: true, rejectUnauthorized: true, ca: pem('ca'),
    key: readFileSync(join(directory, 'server.key')), cert: pem(certificate) + pem('intermediate') }, (incoming, response) => {
    received.push((incoming.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN as string)
    response.setHeader('content-type', 'application/json')
    response.end('{"major":"1","minor":"32","gitVersion":"v1.32.2"}')
  })
  mutual.listen(0, '127.0.0.1')
  await once(mutual, 'listening')
  const origin = `https://localhost:${(mutual.address() as { port: number }).port}`
  const saved = [{ ...trust()[0], endpoint: origin, pem: pem('ca'), leafFingerprint: new X509Certificate(pem(pin)).fingerprint256 }]
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const result = await kubernetesCall(runner, args, saved, undefined, undefined, {
      origin, auth: 'certificate', clientCertificate: client === 'client' ? storedIdentity.certificate : pem(client),
      privateKey: client === 'client' ? storedIdentity.privateKey : readFileSync(join(directory, 'server.key'), 'utf8'),
    })
    expect(result.exitCode === 0, result.stdout + result.stderr).toBe(success)
    expect(received).toEqual(success ? Array(requests).fill('synthetic-kubernetes-client') : [])
    expect(result.stdout + result.stderr).not.toContain(storedIdentity.privateKey)
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally {
    await runner.shutdown()
    mutual.closeAllConnections()
    await new Promise<void>(resolve => mutual.close(() => resolve()))
  }
})

kubectlTest('managed certificate capability is refused for another cluster endpoint', async () => {
  const adapter = await createKubernetesAdapter({ getCredential: async () => ({ origin: endpoint,
    auth: 'certificate', clientCertificate: storedIdentity.certificate, privateKey: storedIdentity.privateKey,
    certificateAuthority: pem('ca') }) }, kubernetesBinary)
  const call = await adapter.prepare(['version'], { id: 'synthetic-credential', tool: 'kubernetes-axi', revision: 1 })
  const config = call.files.find(file => file.name === 'kubernetes-axi/config.json')!
  const content = JSON.parse(String(config.content))
  content.profiles.artium.origin = endpoint.replace('localhost', '127.0.0.1')
  config.content = JSON.stringify(content)
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const result = await runner.run('synthetic-user', call.executable, call.args, call.environment, call.secrets,
      { ...call.limits, credentialTrust: trust() }, {}, call.files)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('original cluster endpoint')
    expect(applicationRequests).toEqual([])
  } finally { await runner.shutdown() }
})

test('pinned certificate child receives a private file and only the endpoint certificate capability', async () => {
  const adapter = await createKubernetesAdapter({ getCredential: async () => ({ origin: endpoint,
    auth: 'certificate', clientCertificate: storedIdentity.certificate, privateKey: storedIdentity.privateKey,
    certificateAuthority: pem('ca') }) }, kubernetesBinary)
  const call = await adapter.prepare(['version'], { id: 'synthetic-credential', tool: 'kubernetes-axi', revision: 1 })
  const probe = `export async function main(args, host) {
    const fs = await import('node:fs');
    const key = JSON.parse(fs.readFileSync('kubernetes-axi/config.json', 'utf8')).profiles.artium.privateKey;
    process.stdout.write(JSON.stringify({ secrets: Object.keys(process.env).filter(name => name.startsWith('ARTIUM_SECRET_')),
      mode: fs.statSync(key.file).mode & 511, endpoint: host.transport.endpoint, capabilities: host.transport.capabilities }));
  }`
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const result = await runner.run('synthetic-user', call.executable, call.args, call.environment, call.secrets,
      { ...call.limits, systemCaBundle: { ...call.limits.systemCaBundle as import('./runner.js').GoTransportTrust & { transport: 'kubectl' },
        hostModule: 'data:text/javascript,' + encodeURIComponent(probe) }, credentialTrust: trust() }, {}, call.files)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ secrets: [], mode: 0o600, endpoint, capabilities: { clientCertificate: true } })
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { await runner.shutdown() }
})

kubectlTest.each([
  { args: ['version'], requests: 1 },
  { args: ['native', '--', 'get', '--raw=/version'], requests: 2 },
])('pinned kubectl carries the managed token through the relay: $args', async ({ args, requests }) => {
  kubernetes = true
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const result = await kubernetesCall(runner, args)
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ gitVersion: 'v1.32.2' })
    expect(applicationRequests).toEqual(Array(requests).fill('Bearer CANARY-kubernetes-token'))
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { await runner.shutdown() }
})

kubectlTest.each(['rotated', 'other-ca-leaf', 'mismatch', 'expired'])('kubectl rejects %s before application data (#276)', async certificate => {
  kubernetes = true
  serve(certificate)
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    expect((await kubernetesCall(runner, ['version'])).exitCode).not.toBe(0)
    expect(applicationRequests).toEqual([])
    serve('leaf')
    expect((await kubernetesCall(runner, ['version'])).exitCode).toBe(0)
    expect(applicationRequests).toEqual(['Bearer CANARY-kubernetes-token'])
  } finally { await runner.shutdown() }
})

kubectlTest('an unrelated Kubernetes pin does not restrict the original trusted endpoint', async () => {
  kubernetes = true
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const result = await kubernetesCall(runner, ['version'], [{ ...trust()[0], endpoint: 'https://unrelated.invalid' }])
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(applicationRequests).toEqual(['Bearer CANARY-kubernetes-token'])
  } finally { await runner.shutdown() }
})

kubectlTest.each([
  { auth: 'token', mode: 'pin' }, { auth: 'certificate', mode: 'ca' },
] as const)('Kubernetes $auth workflow with $mode trust preserves identity binding across calls', async ({ auth, mode }) => {
  kubernetes = true
  const runner = await Runner.create(join(directory, 'calls'))
  const prepare = ['prepare', '--', 'create', 'configmap', 'synthetic-new', '--from-literal=mode=prepared']
  const saved = [{ ...trust()[0], mode }]
  const identity = auth === 'certificate' ? { auth, clientCertificate: storedIdentity.certificate, privateKey: storedIdentity.privateKey } : undefined
  const run = (args: string[]) => kubernetesCall(runner, args, saved, undefined, undefined, identity)
  try {
    serve('other-ca-leaf')
    expect((await run(prepare)).exitCode).not.toBe(0)
    expect(applicationRequests).toEqual([])
    serve('leaf')
    const prepared = await run(prepare)
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const { request } = JSON.parse(prepared.stdout)
    const preview = await run(['preview', request])
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0)
    const { digest } = JSON.parse(preview.stdout)
    expect(methods.every(method => method === 'GET')).toBe(true)
    const changedIdentity = auth === 'certificate'
      ? { auth, clientCertificate: otherStoredIdentity.certificate, privateKey: otherStoredIdentity.privateKey } : undefined
    const changed = await kubernetesCall(runner, ['confirm', request, '--digest', digest], saved, 'CANARY-other-token', undefined, changedIdentity)
    expect(JSON.parse(changed.stdout).error.code).toBe('PREVIEW_MISMATCH')
    const confirmed = await run(['confirm', request, '--digest', digest])
    expect(confirmed.exitCode, confirmed.stdout + confirmed.stderr).toBe(0)
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ state: 'complete', results: [{ outcome: 'committed' }] })
    expect(methods).toContain('POST')
  } finally { await runner.shutdown() }
})

kubectlTest.each([
  ['prepare', '--', 'create', 'configmap', 'synthetic-new', '--from-literal=mode=prepared'],
  ['server-dry-run', '--', 'create', 'configmap', 'synthetic-new', '--from-literal=mode=prepared'],
  ['preview', '11111111-1111-4111-8111-111111111111'],
  ['confirm', '11111111-1111-4111-8111-111111111111', '--digest', 'a'.repeat(64)],
])('pinned certificate workflow stays refused pending stable identity binding: %j', async (...args) => {
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    await expect(kubernetesCall(runner, args, trust(), undefined, undefined, {
      auth: 'certificate', clientCertificate: storedIdentity.certificate, privateKey: storedIdentity.privateKey,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', processStarted: false,
      message: 'certificate-pinned changes need kubernetes-axi binding fix' })
    expect(applicationRequests).toEqual([])
  } finally { await runner.shutdown() }
})

test('hosted Kubernetes byte sessions keep refusing saved pins', async () => {
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    expect(() => runner.caBundleFor(endpoint, trust())).toThrow('hosted byte sessions require issuing CA trust')
    expect(applicationRequests).toEqual([])
  } finally { await runner.shutdown() }
})

kubectlTest('cancellation closes the pinned kubectl connection and removes the relay', async () => {
  kubernetes = true
  const runner = await Runner.create(join(directory, 'calls'))
  const controller = new AbortController()
  let reached!: (incoming: IncomingMessage) => void
  const held = new Promise<IncomingMessage>(resolve => { reached = resolve })
  const listener = (incoming: IncomingMessage) => { if (incoming.url?.split('?')[0].endsWith('/held')) reached(incoming) }
  server.on('request', listener)
  const running = kubernetesCall(runner, ['native', '--', 'get', '--raw=/api/v1/namespaces/default/configmaps/held'], trust(), 'CANARY-kubernetes-token', controller.signal)
  const cancelled = expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
  try {
    const incoming = await Promise.race([held, running.then(result => { throw new Error(result.stdout + result.stderr) })])
    const closed = once(incoming.socket, 'close')
    controller.abort()
    await cancelled
    await closed
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { controller.abort(); server.off('request', listener); await runner.shutdown() }
})

test.each([
  { operation: 'exec', args: ['synthetic-pod', '--', 'true'], code: 'FLAG_BLOCKED' },
  { operation: 'attach', args: ['synthetic-pod'], code: 'FLAG_BLOCKED' },
  { operation: 'port-forward', args: ['synthetic-pod', '8080:80'], code: 'INVALID_INPUT' },
])('Kubernetes refuses direct $operation upgrades without contacting the cluster', async ({ operation, args, code }) => {
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    await expect(kubernetesCall(runner, ['prepare', '--', operation, ...args])).rejects.toMatchObject({ code })
    expect(applicationRequests).toEqual([])
  } finally { await runner.shutdown() }
})

test.each([
  { identity: 'ExecCredential helper', args: ['--native-config', '/synthetic/helper-config', '--trust-exec'] },
  { identity: 'native kubeconfig certificate', args: ['--native-config', '/synthetic/certificate-config'] },
  { identity: 'unmanaged client certificate', args: ['--client-certificate', '/synthetic/client.crt'] },
  { identity: 'server-name override', args: ['--tls-server-name', 'synthetic.invalid'] },
])('Kubernetes keeps $identity refused', async ({ args }) => {
    const adapter = await createKubernetesAdapter({ getCredential: async () => ({}) }, kubernetesBinary)
    expect(() => adapter.validateArgs([...args, 'version'])).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
  })

ghTest(`runner cancellation closes the pinned gh connection and removes the private relay${ghSkip}`, async () => {
  const call = await createGhAdapter({ getCredential: async () => ({ origin: endpoint, auth: 'token', token: 'CANARY-managed-token' }) })
    .prepare(['api', '/held'], { id: 'synthetic-credential', tool: 'gh-axi', revision: 1 })
  const runner = await Runner.create(join(directory, 'calls'))
  const controller = new AbortController()
  const reached = once(server, 'request')
  const running = runner.run('synthetic-user', gh, call.args, call.environment, call.secrets,
    { ...call.limits, credentialTrust: trust(), signal: controller.signal })
  const cancelled = expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
  try {
    const [incoming] = await reached
    const closed = once(incoming.socket, 'close')
    controller.abort()
    await cancelled
    await closed
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { controller.abort(); await runner.shutdown() }
})
