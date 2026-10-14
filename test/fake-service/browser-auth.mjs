import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createApp } from '../../dist/src/server/app.js'
import { Audit } from '../../dist/src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../dist/src/server/policy/identity-resolver.js'
import { Runner } from '../../dist/src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../dist/src/server/store/key-provider.js'
import { seedToolUser } from '../../dist/test/fixtures/tokens.js'
import { EmbeddedSecretSource } from '../../dist/src/server/store/secret-source.js'
import { createFalconAdapter } from '../../dist/src/server/adapters/falcon.js'
import { createVectraAdapter } from '../../dist/src/server/adapters/vectra.js'
import { createMgAdapter } from '../../dist/src/server/adapters/mg.js'
import { createAzAdapter } from '../../dist/src/server/adapters/az.js'
import { createLdapAdapter } from '../../dist/src/server/adapters/ldap.js'
import { loadCredentialProfile } from '../../dist/src/server/adapters/credential-profile.js'
import { AzureTokenCache } from '../../dist/src/server/adapters/azure-token-cache.js'
import { FakeTokenTransport } from '../../dist/test/fixtures/azure-token-transport.js'
import { createTestCertificates } from './certificates.mjs'

const directory = mkdtempSync(join(tmpdir(), 'artium-browser-'))
createTestCertificates(directory, ['localhost'])
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const db = openStore(join(directory, 'artium.db'), key)
await seedToolUser(db)
db.exec('UPDATE users SET administrator = 1, must_change = 1')
db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
  SELECT 'synthetic-ordinary', 'synthetic-ordinary', 'Ordinary', password_hash, 0 FROM users LIMIT 1;
  INSERT INTO user_roles VALUES ('synthetic-ordinary', 'synthetic-role')`)
const store = createCredentialStore(db, key)
const source = new EmbeddedSecretSource(store)
const profile = tool => loadCredentialProfile(tool, join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))
const adapters = [createFalconAdapter(source), createVectraAdapter(source, join(directory, 'writes.log'), profile('vectra-axi')),
  createMgAdapter(source, join(directory, 'mg-writes.log'), profile('mg-axi')),
  createAzAdapter(source, join(directory, 'az-writes.log'), new AzureTokenCache(new FakeTokenTransport())),
  createLdapAdapter(source, profile('ldap-axi'))]
const deliveryFile = join(directory, 'ldap-delivery.json')
// Use the real preparation and secret scan, replacing only the executable boundary.
for (const adapter of adapters) {
  const prepare = adapter.prepare.bind(adapter)
  adapter.prepare = async (...args) => {
    const prepared = await prepare(...args)
    const invalid = prepared.secrets.includes('CANARY-invalid')
    return { ...prepared, executable: process.execPath,
      ...(adapter.name === 'ldap-axi' ? { environment: { ...prepared.environment, ARTIUM_TEST_READY_FILE: deliveryFile } } : {}),
      args: [fileURLToPath(new URL('../fake-tool/fake-axi.mjs', import.meta.url)),
        ...(adapter.name === 'ldap-axi' ? ['ldap-delivery'] : ['exit', invalid ? '1' : '0'])],
      limits: { timeoutMs: 5000 } }
  }
}
const server = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), adapters,
  credentialStore: store, resolver: new SharedIdentityResolver(store), environment: { ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' } })
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
server.get('/test/tools/:tool', async request => {
  const reference = store.findCredential(request.params.tool)
  return { stored: reference ? store.readCredential(reference) : null,
    delivered: request.params.tool === 'ldap-axi' && existsSync(deliveryFile) ? JSON.parse(readFileSync(deliveryFile, 'utf8')) : null }
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
  console.log(JSON.stringify({ url: `https://localhost:${proxy.address().port}`, spki, clock: `${address.origin}/test/clock`,
    certificatePem: readFileSync(join(directory, 'server.crt'), 'utf8') + readFileSync(join(directory, 'server.key'), 'utf8') }))
})
async function close() {
  await new Promise(resolve => proxy.close(resolve))
  await server.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
