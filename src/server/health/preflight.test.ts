import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createSecureContext, TLSSocket } from 'node:tls'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createTestCertificates } from '../../../test/fake-service/certificates.mjs'
import { healthEndpoints, preflight, preflightEndpoint } from './preflight.js'

const dns = vi.hoisted(() => ({ lookup: vi.fn() }))
const tls = vi.hoisted(() => ({ roots: [] as string[] }))
vi.mock('node:tls', async importOriginal => ({
  ...await importOriginal<typeof import('node:tls')>(), rootCertificates: tls.roots,
}))
vi.mock('node:dns/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: dns.lookup.mockImplementation(original.lookup) }
})

let directory: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-preflight-'))
  createTestCertificates(directory, ['localhost'])
  tls.roots.push(readFileSync(join(directory, 'ca.crt'), 'utf8'))
  mkdirSync(join(directory, 'extra'))
  createTestCertificates(join(directory, 'extra'), ['extra.synthetic.invalid'])
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=synthetic-leaf',
    '-keyout', 'invalid-ca.key', '-out', 'invalid-ca.csr'], { cwd: directory, stdio: 'pipe' })
  execFileSync('openssl', ['ca', '-batch', '-notext', '-rand_serial', '-config', 'authority.cnf',
    '-cert', 'server.crt', '-keyfile', 'server.key', '-extensions', 'server',
    '-in', 'invalid-ca.csr', '-out', 'invalid-ca.crt', '-startdate', '20200101000000Z',
    '-enddate', '20991231235959Z'], { cwd: directory, stdio: 'pipe' })
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  ['falcon-axi', { region: 'us-2' }, ['https://api.us-2.crowdstrike.com/']],
  ['falcon-axi', { region: 'us-1' }, ['https://api.crowdstrike.com/']],
  ['falcon-axi', { region: 'eu-1' }, ['https://api.eu-1.crowdstrike.com/']],
  ['falcon-axi', { region: 'us-gov-1' }, ['https://api.laggar.gcw.crowdstrike.com/']],
  ['falcon-axi', { region: 'us-gov-2' }, ['https://api.us-gov-2.crowdstrike.mil/']],
  ['falcon-axi', { region: 'https://api.crowdstrike.com' }, ['https://api.crowdstrike.com/']],
  ['falcon-axi', { region: 'https://api.us-2.crowdstrike.com' }, ['https://api.us-2.crowdstrike.com/']],
  ['falcon-axi', { region: 'https://api.eu-1.crowdstrike.com' }, ['https://api.eu-1.crowdstrike.com/']],
  ['falcon-axi', { region: 'https://api.laggar.gcw.crowdstrike.com' }, ['https://api.laggar.gcw.crowdstrike.com/']],
  ['falcon-axi', { region: 'https://api.us-gov-2.crowdstrike.mil' }, ['https://api.us-gov-2.crowdstrike.mil/']],
  ['falcon-axi', { region: 'https://api.us-2.crowdstrike.com/' }, ['https://api.us-2.crowdstrike.com/']],
  ['vectra-axi', { origin: 'https://synthetic.invalid' }, ['https://synthetic.invalid/']],
  ['ldap-axi', { url: 'ldaps://directory.test:636' }, ['ldaps://directory.test:636']],
  ['az-axi', {}, ['https://login.microsoftonline.com/', 'https://management.azure.com/']],
  ['mg-axi', {}, ['https://login.microsoftonline.com/', 'https://graph.microsoft.com/']],
] as const)('%s preflights the health destinations in connection order', (tool, credential, expected) => {
  expect(healthEndpoints(tool, credential).map(url => url.href)).toEqual(expected)
})

test('names the DNS stage without opening a connection', async () => {
  await expect(preflightEndpoint(new URL('https://does-not-exist.invalid'))).rejects.toMatchObject({
    code: 'UPSTREAM_NETWORK_FAILED', diagnostic: { stage: 'DNS', host: 'does-not-exist.invalid' },
  })
})

test('names the TCP stage when the destination refuses a connection', async () => {
  const server = createTcpServer()
  await new Promise<void>(resolve => server.listen(0, resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  await expect(preflightEndpoint(new URL(`https://127.0.0.1:${port}`))).rejects.toMatchObject({
    code: 'UPSTREAM_NETWORK_FAILED', diagnostic: { stage: 'TCP', host: '127.0.0.1' },
  })
})

test.each([
  { address: '::1', family: 6 },
  { address: '127.0.0.2', family: 4 },
])('tries another DNS address when $address refuses the connection', async address => {
  const server = createServer({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, 'server.crt')) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  dns.lookup.mockResolvedValueOnce([address, { address: '127.0.0.1', family: 4 }])
  try {
    await expect(preflightEndpoint(new URL(`https://localhost:${(server.address() as { port: number }).port}`),
      readFileSync(join(directory, 'ca.crt'), 'utf8'))).resolves.toBeUndefined()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('verifies a TLS chain, reports untrusted chains and sends no application bytes', async () => {
  let received = ''
  const server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) },
    socket => { socket.on('data', chunk => { received += chunk.toString() }) })
  server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, resolve))
  const endpoint = new URL(`https://localhost:${(server.address() as { port: number }).port}`)
  try {
    await expect(preflightEndpoint(endpoint)).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED',
      diagnostic: { stage: 'TLS', host: 'localhost', trust: 'untrusted', toolCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        issuer: expect.stringContaining('Artium synthetic test CA') } })
    await expect(preflightEndpoint(endpoint, readFileSync(join(directory, 'ca.crt'), 'utf8'))).resolves.toBeUndefined()
    expect(received).toBe('')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('LDAP preflight negotiates StartTLS and verifies TLS before any bind', async () => {
  let request = ''
  let version: string | null = null
  const secureContext = createSecureContext({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, 'server.crt')) })
  const server = createTcpServer(socket => {
    socket.once('data', chunk => {
      request = chunk.toString('hex')
      socket.write(Buffer.from('300c02010178070a010004000400', 'hex'))
      const secure = new TLSSocket(socket, { isServer: true, secureContext })
      secure.on('secure', () => { version = secure.getProtocol() })
      secure.on('error', () => {})
      secure.on('end', () => secure.end())
    })
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const endpoint = new URL(`ldap://localhost:${(server.address() as { port: number }).port}`)
  try {
    await expect(preflight('ldap-axi', { url: endpoint.href, startTls: true, tlsMaxVersion: '1.2',
      caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') })).resolves.toBeUndefined()
    expect(request).toBe('301d02010177188016312e332e362e312e342e312e313436362e3230303337')
    expect(version).toBe('TLSv1.2')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('a configured private CA preserves trust in the default roots', async () => {
  const server = createServer({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, 'server.crt')) })
  server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, resolve))
  try {
    await expect(preflight('vectra-axi', { origin: `https://localhost:${(server.address() as { port: number }).port}`,
      caBundle: readFileSync(join(directory, 'extra', 'ca.crt'), 'utf8') })).resolves.toBeUndefined()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('LDAPS preflight respects the stored TLS version limit', async () => {
  let version: string | null = null
  const server = createServer({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, 'server.crt')) }, socket => { version = socket.getProtocol() })
  await new Promise<void>(resolve => server.listen(0, resolve))
  try {
    await expect(preflight('ldap-axi', { url: `ldaps://localhost:${(server.address() as { port: number }).port}`,
      tlsMaxVersion: '1.2', caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') })).resolves.toBeUndefined()
    expect(version).toBe('TLSv1.2')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test.each([
  { name: 'timeout', respond: (_socket: Socket) => {}, code: 'UPSTREAM_NETWORK_FAILED', message: 'ETIMEDOUT' },
  { name: 'reset', respond: (socket: Socket) => socket.resetAndDestroy(), code: 'UPSTREAM_NETWORK_FAILED', message: 'ECONNRESET' },
  { name: 'close', respond: (socket: Socket) => socket.end(), code: 'UPSTREAM_NETWORK_FAILED', message: 'ECONNRESET' },
  { name: 'rejection', respond: (socket: Socket) => socket.end(Buffer.from('300c02010178070a013504000400', 'hex')),
    code: 'UPSTREAM_TLS_FAILED', message: 'StartTLS negotiation failed' },
  { name: 'malformed response', respond: (socket: Socket) => socket.end(Buffer.from([0, 0])),
    code: 'UPSTREAM_TLS_FAILED', message: 'StartTLS negotiation failed' },
])('classifies LDAP StartTLS $name without discarding the failure stage', async ({ respond, code, message }) => {
  const server = createTcpServer(socket => socket.once('data', () => respond(socket)))
  await new Promise<void>(resolve => server.listen(0, resolve))
  try {
    await expect(preflightEndpoint(new URL(`ldap://localhost:${(server.address() as { port: number }).port}`),
      undefined, 50)).rejects.toMatchObject({
      code, diagnostic: { stage: 'TLS', host: 'localhost', message: expect.stringContaining(message) },
    })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('reports a non-CA issuer as a certificate failure with issuer and trust details', async () => {
  const server = createServer({ key: readFileSync(join(directory, 'invalid-ca.key')),
    cert: readFileSync(join(directory, 'invalid-ca.crt'), 'utf8') + readFileSync(join(directory, 'server.crt'), 'utf8') })
  server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, resolve))
  try {
    await expect(preflightEndpoint(new URL(`https://localhost:${(server.address() as { port: number }).port}`),
      readFileSync(join(directory, 'ca.crt'), 'utf8'))).rejects.toMatchObject({
      code: 'UPSTREAM_TLS_FAILED', diagnostic: { stage: 'TLS', host: 'localhost', toolCode: 'INVALID_PURPOSE',
        issuer: 'CN=localhost', trust: 'untrusted' },
    })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('keeps a stalled TLS handshake in the network category', async () => {
  const server = createTcpServer(socket => socket.resume())
  await new Promise<void>(resolve => server.listen(0, resolve))
  try {
    await expect(preflightEndpoint(new URL(`https://localhost:${(server.address() as { port: number }).port}`),
      undefined, 50)).rejects.toMatchObject({
      code: 'UPSTREAM_NETWORK_FAILED', diagnostic: { stage: 'TLS', host: 'localhost' },
    })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
