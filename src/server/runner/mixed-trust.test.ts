import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createInspectionCertificates } from '../../../test/fake-service/certificates.mjs'
import { credentialFetch } from '../credential-tls.js'
import { createProxmoxAdapter } from '../adapters/proxmox.js'
import { inspectEndpoint, preflightEndpoint, preflight } from '../health/preflight.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { pinnedHttp } from './pinned-http.js'
import { Runner } from './runner.js'

vi.mock('./runtime-trust.js', async () => {
  const { build } = await import('esbuild')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { execFileSync } = await import('node:child_process')
  const directory = mkdtempSync(join(process.cwd(), '.certificate-bootstrap-'))
  try {
    await build({ entryPoints: ['src/server/runner/runtime-trust.ts', 'src/server/credential-tls.ts',
      'src/server/ldap-starttls.ts', 'src/server/certificate-endpoint.ts'],
      outbase: 'src/server', outdir: directory, platform: 'node', format: 'esm' })
    const moduleUrl = pathToFileURL(join(directory, 'runner/runtime-trust.js')).href
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `import * as bootstrap from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(bootstrap))`], { encoding: 'utf8' }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

const directory = mkdtempSync(join(tmpdir(), 'artium-mixed-trust-'))
const pem = (name: string) => readFileSync(join(directory, name + '.crt'), 'utf8')
let endpoint: string
let runner: Runner
let requests = 0
const server = createServer((incoming, response) => {
  requests++
  response.end(incoming.url === '/api2/json/version' ? '{"data":{"version":"8.0","release":"8.0","repoid":"synthetic"}}' : 'accepted')
})
beforeAll(async () => {
  createInspectionCertificates(directory, 'http://localhost:1/unused-issuer')
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `https://localhost:${(server.address() as { port: number }).port}`
  runner = await Runner.create(join(directory, 'calls'))
})
afterAll(async () => {
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

test.each(['node', 'python', 'token', 'preflight', 'inspection', 'relay'] as const)('%s enforces mixed CA and pin trust on the data connection (#436)', async family => {
  for (const scenario of cases) {
    server.setSecureContext({ key: readFileSync(join(directory, 'server.key')), cert: pem(scenario.certificate) + pem('intermediate') })
    requests = 0
    const trust = savedTrust(scenario.mode)
    if (family === 'node' || family === 'python') {
      const result = await runner.run('synthetic-user', family === 'node' ? process.execPath : '/usr/bin/python3',
        family === 'node' ? ['-e', `fetch(${JSON.stringify(endpoint)}).then(r => r.text()).then(console.log).catch(e => { console.error(e.cause?.message || e.message); process.exitCode = 1 })`]
          : ['-c', `import requests; print(requests.get(${JSON.stringify(endpoint)}, timeout=3).text)`],
        {}, [], { credentialTrust: trust, timeoutMs: 15_000, ...(family === 'python' ? { runtime: 'python' as const } : {}) })
      expect(result.exitCode === 0, result.stdout + result.stderr).toBe(scenario.accepted)
      if (!scenario.accepted) expect(result.stderr).toContain('stored certificate fingerprint differs')
    } else if (family === 'token') {
      const result = credentialFetch(endpoint, { method: 'GET' }, trust)
      if (scenario.accepted) expect(await (await result).text()).toBe('accepted')
      else await expect(result).rejects.toMatchObject({ code: 'CERTIFICATE_PIN_MISMATCH' })
    } else if (family === 'preflight') {
      const result = preflightEndpoint(new URL(endpoint), undefined, undefined, undefined, trust)
      if (scenario.accepted) await expect(result).resolves.toBeUndefined()
      else await expect(result).rejects.toMatchObject({ diagnostic: { toolCode: 'CERTIFICATE_PIN_MISMATCH' } })
    } else if (family === 'inspection') {
      expect((await inspectEndpoint(new URL(endpoint), undefined, undefined, undefined, trust)).verificationError)
        .toBe(scenario.accepted ? undefined : 'CERTIFICATE_PIN_MISMATCH')
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
        expect(result).toBe(scenario.accepted ? 200 : 502)
      } finally { await relay.close() }
    }
    expect(requests).toBe(scenario.accepted && family !== 'preflight' && family !== 'inspection' ? 1 : 0)
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
    expect(result.exitCode === 0, result.stderr).toBe(certificate === 'mismatch')
    expect(requests).toBe(certificate === 'mismatch' ? 1 : 0)
    const check = preflight('proxmox-axi', { origin: endpoint, certificatePin: pin }, trust)
    if (certificate === 'mismatch') await expect(check).resolves.toBeUndefined()
    else await expect(check).rejects.toMatchObject({ diagnostic: { toolCode: 'CERTIFICATE_PIN_MISMATCH' } })
  }
})
