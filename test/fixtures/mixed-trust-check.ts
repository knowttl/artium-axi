import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createInspectionCertificates } from '../fake-service/certificates.mjs'
import { credentialFetch } from '../../src/server/credential-tls.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { inspectEndpoint, preflightEndpoint, preflight } from '../../src/server/health/preflight.js'
import type { CredentialTrust } from '../../src/server/store/trusted-certificates.js'
import { pinnedHttp } from '../../src/server/runner/pinned-http.js'
import { Runner } from '../../src/server/runner/runner.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-mixed-trust-'))
const pem = (name: string) => readFileSync(join(directory, name + '.crt'), 'utf8')
let endpoint: string
let runner: Runner
let requests = 0
const server = createServer((incoming, response) => {
  requests++
  response.end(incoming.url === '/api2/json/version' ? '{"data":{"version":"8.0","release":"8.0","repoid":"synthetic"}}' : 'accepted')
})
before(async () => {
  createInspectionCertificates(directory, 'http://localhost:1/unused-issuer')
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `https://localhost:${(server.address() as { port: number }).port}`
  runner = await Runner.create(join(directory, 'calls'))
})
after(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})

const cases = [
  { mode: 'mixed', certificate: 'rotated', accepted: false },
  { mode: 'mixed', certificate: 'leaf', accepted: true },
  { mode: 'ca', certificate: 'rotated', accepted: true },
  { mode: 'pin', certificate: 'leaf', accepted: true },
] as const

function savedTrust(mode: typeof cases[number]['mode']): CredentialTrust[] {
  const record = { endpoint, pem: pem('intermediate'), fingerprint: new X509Certificate(pem('intermediate')).fingerprint256,
    leafFingerprint: new X509Certificate(pem('leaf')).fingerprint256 }
  return mode === 'mixed' ? [{ ...record, mode: 'ca' }, { ...record, mode: 'pin' }]
    : [{ ...record, mode }]
}

for (const family of ['node', 'python', 'token', 'preflight', 'inspection', 'relay'] as const) test(`${family} enforces mixed CA and pin trust on the data connection (#436)`, async () => {
  for (const scenario of cases) {
    server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(scenario.certificate) + pem('intermediate') })
    requests = 0
    const trust = savedTrust(scenario.mode)
    if (family === 'node' || family === 'python') {
      const result = await runner.run('synthetic-user', family === 'node' ? process.execPath : '/usr/bin/python3',
        family === 'node' ? ['-e', `fetch(${JSON.stringify(endpoint)}).then(r => r.text()).then(console.log).catch(e => { console.error(e.cause?.message || e.message); process.exitCode = 1 })`]
          : ['-c', `import requests; print(requests.get(${JSON.stringify(endpoint)}, timeout=3).text)`],
        {}, [], { credentialTrust: trust, timeoutMs: 15_000, ...(family === 'python' ? { runtime: 'python' as const } : {}) })
      assert.equal(result.exitCode === 0, scenario.accepted, result.stdout + result.stderr)
      if (!scenario.accepted) assert.match(result.stderr, /stored certificate fingerprint differs/)
    } else if (family === 'token') {
      const result = credentialFetch(endpoint, { method: 'GET' }, trust)
      if (scenario.accepted) assert.equal(await (await result).text(), 'accepted')
      else await assert.rejects(result, { code: 'CERTIFICATE_PIN_MISMATCH' })
    } else if (family === 'preflight') {
      const result = preflightEndpoint(new URL(endpoint), undefined, undefined, undefined, trust)
      if (scenario.accepted) assert.equal(await result, undefined)
      else await assert.rejects(result, (error: { diagnostic?: { toolCode?: string } }) => error.diagnostic?.toolCode === 'CERTIFICATE_PIN_MISMATCH')
    } else if (family === 'inspection') {
      assert.equal((await inspectEndpoint(new URL(endpoint), undefined, undefined, undefined, trust)).verificationError,
        scenario.accepted ? undefined : 'CERTIFICATE_PIN_MISMATCH')
    } else {
      const socketPath = join(directory, 'relay.sock')
      const relay = await pinnedHttp(socketPath, trust)
      try {
        const result = await new Promise<number>((resolve, reject) => {
          const outgoing = request({ socketPath, agent: false, path: '/', headers: { host: new URL(endpoint).host } }, incoming => {
            incoming.resume()
            incoming.once('end', () => resolve(incoming.statusCode!))
          })
          outgoing.once('error', reject)
          outgoing.end()
        })
        assert.equal(result, scenario.accepted ? 200 : 502)
      } finally { await relay.close() }
    }
    assert.equal(requests, scenario.accepted && family !== 'preflight' && family !== 'inspection' ? 1 : 0)
  }
})

test('Proxmox replaceHostname accepts only its exact pin under a different name (#436)', async () => {
  const pin = { origin: endpoint, sha256: new X509Certificate(pem('mismatch')).fingerprint256.replaceAll(':', '').toLowerCase(), replaceHostname: true }
  const trust = savedTrust('mixed').map(record => ({ ...record, pem: pem('ca'), leafFingerprint: new X509Certificate(pem('mismatch')).fingerprint256 }))
  const call = await createProxmoxAdapter({ getCredential: async () => ({ origin: endpoint, auth: 'api-token',
    tokenId: 'reader@pve!test', token: 'CANARY-token', certificatePin: pin }) })
    .prepare(['get', '/version'], { id: 'synthetic-credential', tool: 'proxmox-axi', revision: 1 })
  for (const certificate of ['mismatch', 'server']) {
    server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(certificate) })
    requests = 0
    const result = await runner.run('synthetic-user', call.executable,
      [join(process.cwd(), 'tools/node_modules/@knowttl/proxmox-axi/bin/proxmox-axi.mjs'), ...call.args.slice(1)],
      call.environment, call.secrets, { ...call.limits, credentialTrust: trust, timeoutMs: 15_000 }, {}, call.files)
    assert.equal(result.exitCode === 0, certificate === 'mismatch', result.stderr)
    assert.equal(requests, certificate === 'mismatch' ? 1 : 0)
    const check = preflight('proxmox-axi', { origin: endpoint, certificatePin: pin }, trust)
    if (certificate === 'mismatch') assert.equal(await check, undefined)
    else await assert.rejects(check, (error: { diagnostic?: { toolCode?: string } }) => error.diagnostic?.toolCode === 'CERTIFICATE_PIN_MISMATCH')
  }
})
