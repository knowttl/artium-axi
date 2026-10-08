import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../../dist/src/server/app.js'
import { Audit } from '../../dist/src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../dist/src/server/policy/identity-resolver.js'
import { Runner } from '../../dist/src/server/runner/runner.js'
import { openStore } from '../../dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../dist/src/server/store/key-provider.js'
import { seedToolUser } from '../../dist/test/fixtures/tokens.js'
import { FakeCredentialStore } from '../../dist/test/fixtures/credential-store.js'
import { createTestCertificates } from './certificates.mjs'

const directory = mkdtempSync(join(tmpdir(), 'artium-browser-'))
createTestCertificates(directory, ['localhost'])
const db = openStore(join(directory, 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
await seedToolUser(db)
db.exec('UPDATE users SET administrator = 1, must_change = 1')
const server = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), adapters: [],
  resolver: new SharedIdentityResolver(new FakeCredentialStore([])), environment: { ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' } })
let offset = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + offset
// Harness-only loopback control; never registered by production createApp.
server.post('/test/clock', async request => {
  const { advanceMs } = request.body
  if (!Number.isSafeInteger(advanceMs) || advanceMs < 0) throw new Error('Invalid fake clock advance')
  offset += advanceMs
  return { now: Date.now() }
})
const address = new URL(await server.listen({ host: '127.0.0.1', port: 0 }))
const proxy = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) }, (request, response) => {
  const upstream = httpRequest({ hostname: '127.0.0.1', port: address.port, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-proto': 'https' } }, reply => {
    response.writeHead(reply.statusCode, reply.headers)
    reply.pipe(response)
  })
  upstream.on('error', () => { response.writeHead(502); response.end() })
  request.pipe(upstream)
})
proxy.listen(0, '127.0.0.1', () => {
  const cert = new X509Certificate(readFileSync(join(directory, 'server.crt')))
  const spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  console.log(JSON.stringify({ url: `https://localhost:${proxy.address().port}`, spki, clock: `${address.origin}/test/clock` }))
})
async function close() {
  await new Promise(resolve => proxy.close(resolve))
  await server.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
