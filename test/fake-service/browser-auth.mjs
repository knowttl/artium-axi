import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import { syncBuiltinESMExports } from 'node:module'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { createApp } from '../../dist/src/server/app.js'
import { Audit } from '../../dist/src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../dist/src/server/policy/identity-resolver.js'
import { Runner } from '../../dist/src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../dist/src/server/store/db.js'
import { ProviderCredentials } from '../../dist/src/server/store/provider-credentials.js'
import { EnvironmentKeyProvider } from '../../dist/src/server/store/key-provider.js'
import { seedToolUser } from '../../dist/test/fixtures/tokens.js'
import { EmbeddedSecretSource } from '../../dist/src/server/store/secret-source.js'
import { createFalconAdapter } from '../../dist/src/server/adapters/falcon.js'
import { createVectraAdapter } from '../../dist/src/server/adapters/vectra.js'
import { createMgAdapter } from '../../dist/src/server/adapters/mg.js'
import { createAzAdapter } from '../../dist/src/server/adapters/az.js'
import { createLdapAdapter } from '../../dist/src/server/adapters/ldap.js'
import { createGhAdapter } from '../../dist/src/server/adapters/gh.js'
import { loadCredentialProfile } from '../../dist/src/server/adapters/credential-profile.js'
import { AzureTokenCache } from '../../dist/src/server/adapters/azure-token-cache.js'
import { FakeTokenTransport } from '../../dist/test/fixtures/azure-token-transport.js'
import { createTestCertificates } from './certificates.mjs'
import { seedBrowserSso, seedSsoInvitation, seedSsoRules } from '../../dist/test/fixtures/sso.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-browser-'))
createTestCertificates(directory, ['localhost'], 1)
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const db = openStore(join(directory, 'artium.db'), key)
await seedToolUser(db)
db.exec('UPDATE users SET administrator = 1, must_change = 1')
db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
  SELECT 'synthetic-ordinary', 'synthetic-ordinary', 'Ordinary', password_hash, 0 FROM users LIMIT 1;
  INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-ordinary', 'synthetic-role')`)
const store = createCredentialStore(db, key)
const source = new EmbeddedSecretSource(store)
const profile = tool => loadCredentialProfile(tool, join(process.cwd(), `tools/node_modules/@knowttl/${tool}/axi-credential.schema.json`))
const adapters = [createFalconAdapter(source), createVectraAdapter(source, join(directory, 'writes.log'), profile('vectra-axi')),
  createMgAdapter(source, join(directory, 'mg-writes.log'), profile('mg-axi')),
  createAzAdapter(source, join(directory, 'az-writes.log'), new AzureTokenCache(new FakeTokenTransport())),
  createLdapAdapter(source, profile('ldap-axi')), createGhAdapter(source)]
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
let sso
let genericSso
let callbackCookies
const server = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), adapters,
  ...(process.env.ARTIUM_TEST_SSO === '1' ? { ssoFetch: (...args) =>
    (args[0].startsWith('https://generic.example/') ? genericSso : sso).fetch(...args) } : {}),
  credentialStore: store, providerCredentials: new ProviderCredentials(db, key), resolver: new SharedIdentityResolver(store), environment: { ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' } })
let offset = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + offset
// Harness-only loopback control; never registered by production createApp.
server.post('/test/trust-ca', async () => {
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(join(directory, 'ca.crt'), 'utf8')])
  return { trusted: true }
})
server.post('/login/device/code', async request => {
  const input = new URLSearchParams(request.body)
  if (input.get('client_id') !== '178c6fc778ccc68e1d6a' || input.get('scope') !== 'repo read:org gist workflow project') throw new Error('Unexpected device request')
  return { device_code: 'CANARY-browser-device', user_code: 'ABCD-EFGH',
    verification_uri: `https://${request.headers.host}/login/device`, expires_in: 900, interval: 1 }
})
server.post('/login/oauth/access_token', async request => {
  const input = new URLSearchParams(request.body)
  if (input.get('device_code') !== 'CANARY-browser-device') throw new Error('Unexpected device code')
  return { access_token: 'gho_CANARY-browser-device', token_type: 'bearer' }
})
server.get('/api/v3/user', async request => {
  if (request.headers.authorization !== 'Bearer gho_CANARY-browser-device') throw new Error('Unexpected device token')
  return { login: 'synthetic-machine' }
})
server.post('/test/clock', async request => {
  const { advanceMs } = request.body
  if (!Number.isSafeInteger(advanceMs) || advanceMs < 0) throw new Error('Invalid fake clock advance')
  offset += advanceMs
  return { now: Date.now() }
})
if (process.env.ARTIUM_TEST_SSO === '1') {
  server.addHook('onRequest', async request => {
    if (request.url.startsWith('/auth/sso/synthetic-entra/callback')) callbackCookies = {
      session: Boolean(request.cookies['artium-session']), preauth: Boolean(request.cookies['artium-sso']), csrf: Boolean(request.cookies._csrf),
    }
  })
  server.post('/test/sso-protocol', async request => {
    const selected = request.body.providerId === 'synthetic-generic' ? genericSso : sso
    selected.token.claims = request.body.claims
    selected.token.tamperSignature = request.body.tamperSignature
    if (request.body.administrator !== undefined) db.prepare("UPDATE users SET administrator = ? WHERE id = 'synthetic-browser-sso'").run(request.body.administrator ? 1 : 0)
    if (request.body.localBreakGlass !== undefined) db.prepare("UPDATE users SET break_glass = ?, must_change = 0 WHERE id = 'synthetic-development-user'").run(request.body.localBreakGlass ? 1 : 0)
    if (request.body.enabled !== undefined) db.prepare('UPDATE sso_providers SET enabled = ? WHERE id = ?')
      .run(Number(request.body.enabled), request.body.providerId ?? 'synthetic-entra')
    return { configured: true }
  })
  server.post('/test/sso-invitation', async request => {
    seedSsoRules(db)
    return seedSsoInvitation(db, request.body)
  })
  server.get('/test/sso-evidence', async () => ({ callbackCookies, authorizations: sso.authorizations,
    sessions: db.prepare('SELECT user_id, reauthenticated_at FROM sessions WHERE revoked_at IS NULL').all(),
    invitations: db.prepare('SELECT id, user_id, claimed_at FROM invitations').all(),
    users: db.prepare('SELECT id, username, source, password_hash FROM users').all(),
    grants: db.prepare('SELECT user_id, role_id, origin FROM user_roles ORDER BY role_id, origin').all(),
    events: db.prepare('SELECT event, action, user_id, target_id, arguments, authentication_method FROM audit ORDER BY id').all(),
    audit: db.prepare("SELECT outcome, authentication_method, provider_id, subject FROM audit WHERE authentication_method = 'sso' ORDER BY id").all() }))
}
server.post('/test/audit', async () => {
  const audit = new Audit(db, () => Date.UTC(2026, 0, 1))
  for (let id = 0; id < 103; id++) audit.record({ event: 'run-start', outcome: 'started',
    userId: 'synthetic-ordinary', tool: 'falcon-axi', requestId: 'synthetic-run-' + id, clientAddress: '192.0.2.1',
    args: ['read', '--password=CANARY-audit-secret'], sensitive: { flags: ['--password'], positions: [] } })
  return { seeded: 103 }
})
server.post('/test/sso', async () => {
  db.exec(`INSERT INTO users (id, username, display_name, source, must_change)
    VALUES ('synthetic-sso', 'synthetic-sso', 'Synthetic SSO', 'sso', 0);
    INSERT INTO sso_providers (id, name, kind, issuer)
      VALUES ('synthetic-provider', 'Synthetic provider', 'entra', 'https://identity.example');
    INSERT INTO role_rules (id, provider_id, claim, value, role_id)
      VALUES ('synthetic-rule', 'synthetic-provider', 'roles', 'Artium.Reader', 'synthetic-role');
    INSERT INTO user_roles (user_id, role_id, origin) VALUES ('synthetic-sso', 'synthetic-role', 'synthetic-rule');`)
  return { seeded: true }
})
server.get('/test/tools/:tool', async request => {
  const reference = store.findCredential(request.params.tool)
  return { stored: reference ? store.readCredential(reference) : null,
    delivered: request.params.tool === 'ldap-axi' && existsSync(deliveryFile) ? JSON.parse(readFileSync(deliveryFile, 'utf8')) : null }
})
const address = new URL(await server.listen({ host: '127.0.0.1', port: 0 }))
const proxy = createServer({ key: readFileSync(join(directory, 'server.key')),
  cert: readFileSync(join(directory, 'server.crt'), 'utf8') + readFileSync(join(directory, 'ca.crt'), 'utf8') }, (request, response) => {
  const providerRequest = genericSso && request.url.startsWith('/test/generic-oidc/') ? genericSso
    : sso && request.url.startsWith('/test/oidc/') ? sso : undefined
  const upstream = httpRequest({ hostname: '127.0.0.1', port: providerRequest ? new URL(providerRequest.url).port : address.port,
    path: providerRequest ? request.url.replace(/^\/test\/(?:generic-)?oidc\//, '/') : request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-proto': 'https' } }, reply => {
    response.writeHead(reply.statusCode, reply.headers)
    reply.pipe(response)
  })
  upstream.on('error', () => { response.writeHead(502); response.end() })
  request.pipe(upstream)
})
proxy.listen(0, '127.0.0.1', async () => {
  if (process.env.ARTIUM_TEST_SSO === '1') sso = await seedBrowserSso(db, new ProviderCredentials(db, key),
    `https://localhost:${proxy.address().port}/auth/sso/synthetic-entra/callback`, {
      authorizationEndpoint: `https://127.0.0.1:${proxy.address().port}/test/oidc/authorize`, browserApproval: true,
      endSessionEndpoint: `https://127.0.0.1:${proxy.address().port}/test/oidc/logout`,
    })
  if (process.env.ARTIUM_TEST_GENERIC_SSO === '1') genericSso = await seedBrowserSso(db, new ProviderCredentials(db, key),
    `https://localhost:${proxy.address().port}/auth/sso/synthetic-generic/callback`, {
      generic: { id: 'synthetic-generic', issuer: 'https://generic.example', clientId: 'synthetic-generic-client' },
      authentication: 'secret', browserApproval: true,
      authorizationEndpoint: `https://127.0.0.1:${proxy.address().port}/test/generic-oidc/authorize`,
      endSessionEndpoint: `https://127.0.0.1:${proxy.address().port}/test/generic-oidc/logout`,
    })
  const local = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
  const sockets = new WeakSet()
  const lookup = dns.lookup.bind(dns)
  const connect = net.connect.bind(net)
  const connectTls = tls.connect.bind(tls)
  const ca = readFileSync(join(directory, 'ca.crt'), 'utf8')
  dns.lookup = (host, options) => local(host) ? lookup(host, options)
    : Promise.resolve([{ address: '127.0.0.1', family: 4 }])
  net.connect = (options, ...args) => {
    if (!options.host || local(options.host)) return connect(options, ...args)
    const socket = connect({ host: '127.0.0.1', port: proxy.address().port })
    sockets.add(socket)
    return socket
  }
  tls.connect = (options, ...args) => connectTls(options.socket && sockets.has(options.socket)
    ? { ...options, servername: 'localhost', ca } : options, ...args)
  syncBuiltinESMExports()
  const cert = new X509Certificate(readFileSync(join(directory, 'server.crt')))
  const spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  console.log(JSON.stringify({ url: `https://localhost:${proxy.address().port}`, spki, clock: `${address.origin}/test/clock`,
    caFile: join(directory, 'ca.crt'), clientHome: join(directory, 'cli-client'),
    ...(sso ? { ssoControl: `${address.origin}/test/sso-protocol`, ssoEvidence: `${address.origin}/test/sso-evidence` } : {}),
    certificatePem: readFileSync(join(directory, 'server.crt'), 'utf8') + readFileSync(join(directory, 'server.key'), 'utf8') }))
})
const connections = new Set()
proxy.on('connection', socket => {
  connections.add(socket)
  socket.once('close', () => connections.delete(socket))
})
async function close() {
  const closed = new Promise(resolve => proxy.close(resolve))
  // Chrome can keep speculative TLS sockets open after the final page assertion.
  for (const socket of connections) socket.destroy()
  await closed
  await server.close()
  await sso?.close()
  await genericSso?.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
