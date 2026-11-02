import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createNetworkReadAdapter } from './network-reads.js'
import { toolPaths } from '../config.js'
import { Runner } from '../runner/runner.js'
import { preflight } from '../health/preflight.js'
import { inspectCertificate } from '../certificate-inspection.js'
import { createInspectionCertificates } from '../../../test/fake-service/certificates.mjs'

const source = { getCredential: async () => ({ origin: 'https://synthetic.invalid', apiKey: 'CANARY-unifi-key' }) }

let directory: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-native-unifi-'))
  createInspectionCertificates(directory, 'http://issuer.synthetic.invalid/issuer')
  execFileSync('openssl', ['req', '-x509', '-key', 'server.key', '-subj', '/CN=synthetic-IP', '-days', '3650',
    '-addext', 'subjectAltName=IP:127.0.0.2,IP:::2', '-addext', 'basicConstraints=CA:FALSE', '-out', 'ip.crt'],
  { cwd: directory, stdio: 'pipe' })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  { host: '127.0.0.2', certificate: 'ip', trust: 'ip', success: true },
  { host: '[::2]', certificate: 'ip', trust: 'ip', success: true },
  { host: 'localhost', certificate: 'self-signed', trust: 'self-signed', success: true },
  { host: '127.0.0.2', certificate: 'self-signed', trust: 'self-signed', success: false },
  { host: '127.0.0.2', certificate: 'ip', trust: 'self-signed', success: false },
  { host: 'localhost', certificate: 'server', trust: 'ca', success: false },
  { host: 'localhost', certificate: 'expired', trust: 'expired', success: false },
])('native UniFi alternate routing verifies $host with $certificate and trust $trust', async ({ host, certificate, trust, success }) => {
  const pem = readFileSync(join(directory, `${trust}.crt`), 'utf8')
  const requests: unknown[] = []
  const server = createServer({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, `${certificate}.crt`)) }, (request, response) => {
    requests.push({ path: request.url, key: request.headers['x-api-key'] })
    response.end(JSON.stringify({ applicationVersion: '10.6.109' }))
  })
  server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const previous = toolPaths['unifi-axi']
  Object.assign(toolPaths, { 'unifi-axi': join(process.cwd(), 'tools/node_modules/@knowttl/unifi-axi/dist/bin.js') })
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const credential = { origin: `https://${host}:${(server.address() as { port: number }).port}`, apiKey: 'CANARY-unifi-key', tls: {
      connectAddress: '127.0.0.1', trustedCertificatePem: pem, peerFingerprintSha256: new X509Certificate(pem).fingerprint256.replaceAll(':', ''),
    } }
    const adapter = createNetworkReadAdapter('unifi-axi', { getCredential: async () => credential })
    const call = await adapter.prepare(['info'], { id: 'synthetic', tool: 'unifi-axi', revision: 1 })
    const result = await runner.run('synthetic', call.executable, call.args, call.environment, call.secrets, call.limits, {}, call.files)
    if (success) {
      expect(result.exitCode, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('10.6.109')
      expect(requests).toEqual([{ path: '/proxy/network/integration/v1/info', key: 'CANARY-unifi-key' }])
      await expect(preflight('unifi-axi', credential)).resolves.toBeUndefined()
      const inspection = await inspectCertificate(new URL(credential.origin), pem, undefined, '127.0.0.1')
      expect(inspection.chain[0].matchesHostname).toBe(true)
      expect(inspection.hostname).toBe(host.replace(/^\[|\]$/g, ''))
    } else {
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('TLS_REJECTED')
      expect(requests).toEqual([])
    }
  } finally {
    await runner.shutdown()
    Object.assign(toolPaths, { 'unifi-axi': previous })
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test.each([[], ['--help'], ['--site', 'synthetic-site']])('UniFi retains the empty-command dashboard for %j', async (...args) => {
  const call = await createNetworkReadAdapter('unifi-axi', source).prepare(args, { id: 'synthetic', tool: 'unifi-axi', revision: 1 })
  expect(call.args.slice(1)).toEqual(args)
  expect(call.invocation?.command).toBe('home')
})

test.each([['home'], ['home', '--help']])('UniFi rejects the unsupported explicit home command %j', (...args) => {
  expect(() => createNetworkReadAdapter('unifi-axi', source).validateArgs(args)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test.each(['status', 'log', 'wait'])('Proxmox task %s rejects journal input', action => {
  const adapter = createNetworkReadAdapter('proxmox-axi', source)
  expect(() => adapter.validateArgs(['task', action, '--journal', 'synthetic-intent'])).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})
