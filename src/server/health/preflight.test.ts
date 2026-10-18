import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createSecureContext, TLSSocket } from 'node:tls'
import { createServer as createTcpServer } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createTestCertificates } from '../../../test/fake-service/certificates.mjs'
import { healthEndpoints, preflightEndpoint } from './preflight.js'

let directory: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-preflight-'))
  createTestCertificates(directory, ['localhost'])
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  ['falcon-axi', { region: 'us-2' }, ['https://api.us-2.crowdstrike.com/']],
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
  const secureContext = createSecureContext({ key: readFileSync(join(directory, 'server.key')),
    cert: readFileSync(join(directory, 'server.crt')) })
  const server = createTcpServer(socket => {
    socket.once('data', chunk => {
      request = chunk.toString('hex')
      socket.write(Buffer.from('300c02010178070a010004000400', 'hex'))
      const secure = new TLSSocket(socket, { isServer: true, secureContext })
      secure.on('error', () => {})
      secure.on('end', () => secure.end())
    })
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const endpoint = new URL(`ldap://localhost:${(server.address() as { port: number }).port}`)
  try {
    await expect(preflightEndpoint(endpoint, readFileSync(join(directory, 'ca.crt'), 'utf8'))).resolves.toBeUndefined()
    expect(request).toBe('301d02010177188016312e332e362e312e342e312e313436362e3230303337')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
