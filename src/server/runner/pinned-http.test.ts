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
import { createInspectionCertificates } from '../../../test/fake-service/certificates.mjs'
import { createGhAdapter } from '../adapters/gh.js'
import { createKubernetesAdapter } from '../adapters/kubernetes.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { pinnedHttp } from './pinned-http.js'
import { Runner } from './runner.js'
import { loadTrustedCa } from '../trusted-ca.js'

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

function requestRelay(socketPath: string) {
  return new Promise<{ status: number, body: string }>((resolve, reject) => {
    const outgoing = request({ socketPath, agent: false, path: '/api/v3/rate_limit', headers: {
      host: new URL(endpoint).host, authorization: 'token CANARY-managed-token',
    } }, incoming => {
      let body = ''
      incoming.on('data', chunk => { body += chunk })
      incoming.once('end', () => resolve({ status: incoming.statusCode!, body }))
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function relayRequest(saved: readonly CredentialTrust[], ca?: string) {
  const socketPath = join(directory, 'relay.sock')
  const relay = await pinnedHttp(socketPath, saved, ca)
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
])('rejects $certificate with pin $leaf, sends no application data and remains usable (#276)', async ({ certificate, leaf, anchor }) => {
  serve(certificate)
  const saved = [{ ...trust()[0], pem: pem(anchor), leafFingerprint: new X509Certificate(pem(leaf)).fingerprint256 }, ...trust()]
  const socketPath = join(directory, 'recovery.sock')
  const relay = await pinnedHttp(socketPath, saved)
  try {
    expect((await requestRelay(socketPath)).status).toBe(502)
    expect(applicationRequests).toEqual([])
    serve('leaf')
    expect(await requestRelay(socketPath)).toEqual({ status: 200, body: '{"remaining":4999}' })
    expect(applicationRequests).toEqual(['token CANARY-managed-token'])
  } finally { await relay.close() }
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

test('kubectl client-certificate pins remain refused before spawn', async () => {
  const call = await (await createKubernetesAdapter({ getCredential: async () => ({ origin: endpoint,
    auth: 'certificate', clientCertificate: pem('leaf'), privateKey: 'CANARY-private-key', certificateAuthority: pem('ca') }) },
  join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))).prepare(
    ['get', 'pods'], { id: 'synthetic-credential', tool: 'kubernetes-axi', revision: 1 })
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    await expect(runner.run('synthetic-user', process.execPath, ['-e', 'process.exit(0)'], call.environment, call.secrets,
      { ...call.limits, credentialTrust: trust() })).rejects.toMatchObject({ code: 'INVALID_INPUT', processStarted: false })
  } finally { await runner.shutdown() }
})

const kubectlTest = process.platform === 'linux' && process.arch === 'x64' ? test : test.skip
const kubernetesBinary = join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js')
async function kubernetesCall(runner: Runner, args: string[], saved = trust(), token = 'CANARY-kubernetes-token', signal?: AbortSignal) {
  const adapter = await createKubernetesAdapter({ getCredential: async () => ({ origin: endpoint,
    auth: 'token', token, certificateAuthority: pem('ca') }), getSettings: () => ({ allowWrites: true }) },
  kubernetesBinary, join(directory, 'workflow'))
  const call = await adapter.prepare(args, { id: 'synthetic-credential', tool: 'kubernetes-axi', revision: 1 })
  return runner.run('synthetic-user', call.executable, [call.args[0], '--json', ...call.args.slice(1)], call.environment, call.secrets,
    { ...call.limits, signal, credentialTrust: saved, kubernetesRequests: { root: join(directory, 'workflow'), scope: 'a'.repeat(64) } }, {}, call.files)
}

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

kubectlTest('pinned Kubernetes workflow preparation preserves identity binding across relay instances', async () => {
  kubernetes = true
  const runner = await Runner.create(join(directory, 'calls'))
  const prepare = ['prepare', '--', 'create', 'configmap', 'synthetic-new', '--from-literal=mode=prepared']
  try {
    serve('rotated')
    expect((await kubernetesCall(runner, prepare)).exitCode).not.toBe(0)
    expect(applicationRequests).toEqual([])
    serve('leaf')
    const prepared = await kubernetesCall(runner, prepare)
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const { request } = JSON.parse(prepared.stdout)
    const preview = await kubernetesCall(runner, ['preview', request])
    expect(preview.exitCode, preview.stdout + preview.stderr).toBe(0)
    const { digest } = JSON.parse(preview.stdout)
    expect(methods.every(method => method === 'GET')).toBe(true)
    const changed = await kubernetesCall(runner, ['confirm', request, '--digest', digest], trust(), 'CANARY-other-token')
    expect(JSON.parse(changed.stdout).error.code).toBe('PREVIEW_MISMATCH')
    const confirmed = await kubernetesCall(runner, ['confirm', request, '--digest', digest])
    expect(confirmed.exitCode, confirmed.stdout + confirmed.stderr).toBe(0)
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ state: 'complete', results: [{ outcome: 'committed' }] })
    expect(methods).toContain('POST')
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

test.each([['--native-config', '/synthetic/helper-config'], ['--trust-exec'], ['--tls-server-name', 'synthetic.invalid']])(
  'Kubernetes keeps identity overrides refused: %j', async (...args) => {
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
