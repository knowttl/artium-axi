import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:tls'
import { beforeAll, afterAll, vi } from 'vitest'
import { createTestCertificates } from '../fake-service/certificates.mjs'

const transport = vi.hoisted(() => ({ port: 0, ca: '', sockets: new WeakSet<object>(),
  local: (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) }))

// Redirect only non-loopback preflight connections. Existing local transport
// fixtures keep their real DNS, TCP and certificate verification behavior.
vi.mock('node:dns/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:dns/promises')>()
  return { ...original, lookup: vi.fn((host, options) => transport.local(host)
    ? original.lookup(host, options) : Promise.resolve([{ address: '127.0.0.1', family: 4 }])) }
})
vi.mock('node:net', async importOriginal => {
  const original = await importOriginal<typeof import('node:net')>()
  return { ...original, connect: vi.fn((options: import('node:net').NetConnectOpts) => {
    if (!('host' in options) || !options.host || transport.local(options.host)) return original.connect(options)
    const socket = original.connect({ host: '127.0.0.1', port: transport.port })
    transport.sockets.add(socket)
    return socket
  }) }
})
vi.mock('node:tls', async importOriginal => {
  const original = await importOriginal<typeof import('node:tls')>()
  return { ...original, connect: vi.fn((options: import('node:tls').ConnectionOptions) => original.connect(
    options.socket && transport.sockets.has(options.socket)
      ? { ...options, servername: 'localhost', ca: transport.ca } : options)) }
})

let directory: string
let server: ReturnType<typeof createServer>
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-preflight-transport-'))
  createTestCertificates(directory, ['localhost'])
  transport.ca = readFileSync(join(directory, 'ca.crt'), 'utf8')
  server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) })
  server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  transport.port = (server.address() as { port: number }).port
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
})
