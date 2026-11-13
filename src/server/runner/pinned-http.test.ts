import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const gh = join(process.cwd(), 'tools/node_modules/.bin/gh')
const pem = (name: string) => readFileSync(join(directory, name + '.crt'), 'utf8')
let endpoint: string
let applicationRequests: string[] = []
const server = createServer((incoming, response) => {
  applicationRequests.push(incoming.headers.authorization ?? '')
  if (incoming.url?.endsWith('/held')) return
  response.setHeader('content-type', 'application/json')
  response.end('{"remaining":4999}')
})
const trust = (): CredentialTrust[] => [{ endpoint, pem: pem('intermediate'), fingerprint: new X509Certificate(pem('intermediate')).fingerprint256,
  leafFingerprint: new X509Certificate(pem('leaf')).fingerprint256, mode: 'pin' }]
function serve(name: string) {
  server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(name) + pem('intermediate') })
}
beforeAll(async () => {
  createInspectionCertificates(directory, 'http://localhost:1/unused-issuer')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `https://localhost:${(server.address() as { port: number }).port}`
})
beforeEach(() => { applicationRequests = []; serve('leaf') })
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

test.each(['token', 'device'] as const)('native gh carries the managed %s identity through the enforced runner connection', async auth => {
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

test.each(['token', 'device'] as const)('bundled gh-axi enforces the pin for the managed %s identity', async auth => {
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

test('kubectl remains refused before spawn until its data transport supports pins', async () => {
  const call = await (await createKubernetesAdapter({ getCredential: async () => ({ origin: endpoint,
    auth: 'token', token: 'CANARY-kubernetes-token', certificateAuthority: pem('ca') }) },
  join(process.cwd(), 'tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js'))).prepare(
    ['get', 'pods'], { id: 'synthetic-credential', tool: 'kubernetes-axi', revision: 1 })
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    await expect(runner.run('synthetic-user', process.execPath, ['-e', 'process.exit(0)'], call.environment, call.secrets,
      { ...call.limits, credentialTrust: trust() })).rejects.toMatchObject({ code: 'INVALID_INPUT', processStarted: false })
  } finally { await runner.shutdown() }
})

test('runner cancellation closes the pinned gh connection and removes the private relay', async () => {
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
