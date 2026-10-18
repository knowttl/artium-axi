import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createTestCertificates } from '../../test/fake-service/certificates.mjs'
import { withFakeService } from '../../test/fake-service/fixture.js'
import { installTrustedCa, loadTrustedCa } from './trusted-ca.js'
import { mintAzureToken } from './adapters/azure-tokens.js'
import { FakeTokenTransport, azureTestTenant, azureTestToken } from '../../test/fixtures/azure-token-transport.js'

let directory: string
let pem: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ca-test-'))
  createTestCertificates(directory, ['localhost'])
  pem = readFileSync(join(directory, 'ca.crt'), 'utf8')
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('no configured bundle leaves trust unchanged', () => {
  expect(loadTrustedCa({})).toBeUndefined()
  const before = getCACertificates('default')
  installTrustedCa(undefined)
  expect(getCACertificates('default')).toEqual(before)
})

test.each(['', 'missing', '.'])('unreadable bundle %j is refused with a safe startup error', file => {
  expect(() => loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, file) }))
    .toThrow('ARTIUM_AXI_EXTRA_CA_FILE must be a readable PEM bundle.')
})

test.each([
  ['empty', ''], ['non-PEM', 'not a certificate'],
  ['malformed certificate', '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----'],
  ['truncated certificate', '-----BEGIN CERTIFICATE-----\ninvalid'],
  ['trailing data', 'unexpected data'],
  ...['PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY']
    .map(label => [label, `-----BEGIN ${label}-----\nCANARY-key\n-----END ${label}-----`]),
])('refuses %s without exposing file contents', (name, invalid) => {
  const file = join(directory, 'invalid.pem')
  writeFileSync(file, name === 'empty' || name === 'non-PEM' ? invalid : pem + invalid)
  expect(() => loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: file })).toThrow('ARTIUM_AXI_EXTRA_CA_FILE')
  try { loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: file }) }
  catch (error) { expect(String(error)).not.toContain('CANARY-key') }
})

test('loads every certificate and exposes metadata without PEM contents', () => {
  const file = join(directory, 'multiple.pem')
  writeFileSync(file, pem + readFileSync(join(directory, 'server.crt'), 'utf8'))
  const bundle = loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: file })!
  expect(bundle.certificates).toHaveLength(2)
  expect(bundle.certificates[0]).toEqual({ subject: 'CN=Artium synthetic test CA',
    issuer: 'CN=Artium synthetic test CA', expiresAt: '2099-12-31T23:59:59.000Z',
    fingerprint: new X509Certificate(pem).fingerprint256 })
  expect(JSON.stringify(bundle.certificates)).not.toContain('BEGIN CERTIFICATE')
})

test.each([
  ['2099-12-02T00:00:00Z', 'expires within 30 days'],
  ['2100-01-01T00:00:00Z', 'has expired'],
])('warns about certificate expiry at %s using only its fingerprint', (now, message) => {
  const warnings: string[] = []
  loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }, warning => warnings.push(warning), Date.parse(now))
  expect(warnings).toEqual([`ARTIUM_AXI_EXTRA_CA_FILE: certificate ${new X509Certificate(pem).fingerprint256} ${message}.`])
})

test('server global fetch honors the installed additional default CAs', async () => {
  await withFakeService(async ({ directory, port }) => {
    const defaults = getCACertificates('default')
    try {
      installTrustedCa(loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
      const response = await fetch(`https://localhost:${port}/`, { signal: AbortSignal.timeout(3000) })
      expect(await response.json()).toEqual({ value: [] })
      const fingerprints = getCACertificates('default').map(pem => new X509Certificate(pem).fingerprint256)
      expect(fingerprints).toEqual(expect.arrayContaining(defaults.map(pem => new X509Certificate(pem).fingerprint256)))
    } finally { setDefaultCACertificates(defaults) }
  })
})

test('Azure token acquisition uses server default trust through its abortable fetch transport', async () => {
  const network = new FakeTokenTransport()
  const server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) }, (request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const url = 'https://login.microsoftonline.com' + request.url
      void (request.method === 'POST' ? network.sendPostRequestAsync(url, { body }) : network.sendGetRequestAsync(url))
        .then(result => { response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result.body)) })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const defaults = getCACertificates('default')
  const send = globalThis.fetch
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://login.microsoftonline.com') throw new Error('Unexpected synthetic token origin')
    return send(new URL(url.pathname + url.search, `https://localhost:${port}`), options)
  })
  try {
    installTrustedCa(loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const token = await mintAzureToken({ auth: 'secret', tenantId: azureTestTenant,
      clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret' }, 'arm', undefined, AbortSignal.timeout(5000))
    expect(token.accessToken).toBe(azureTestToken)
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0].form.get('client_secret')).toBe('CANARY-azure-secret')
  } finally {
    fetch.mockRestore()
    setDefaultCACertificates(defaults)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
