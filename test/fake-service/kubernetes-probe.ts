import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { withFakeService } from './fixture.js'
import { createTestClientCertificate } from './certificates.mjs'
import { createKubernetesAdapter } from '../../src/server/adapters/kubernetes.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { allowRawApi, seedToolUser } from '../fixtures/tokens.js'
import { rewriteSuggestions } from '../../src/cli/rewrite.js'
import { toolPaths } from '../../src/server/config.js'

// The container caller has --network none; all authenticated traffic stays on loopback.
assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
const nativeCodec = await import(pathToFileURL(createRequire(realpathSync(toolPaths['kubernetes-axi'])).resolve('@toon-format/toon')).href) as { decode: (text: string) => unknown }
await withFakeService(async ({ directory, port, send }) => {
  const origin = `https://localhost:${port}`
  const pem = readFileSync(join(directory, 'ca.crt'), 'utf8')
  const leaf = readFileSync(join(directory, 'server.crt'), 'utf8')
  const fingerprint = new X509Certificate(pem).fingerprint256
  const leafFingerprint = new X509Certificate(leaf).fingerprint256
  const runner = await Runner.create(join(directory, 'calls'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'kubernetes.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'kubernetes-axi'")
  allowRawApi(db, 'kubernetes-axi', 'read')
  // The native CA is deliberately unusable: the approved saved CA must reach kubectl.
  store.replaceCredential('kubernetes-axi', { origin, auth: 'token', namespace: 'synthetic', certificateAuthority: 'no native trust',
    token: 'CANARY-kubernetes-token' }, 0, 'synthetic-development-user', Date.now())
  const reference = store.findCredential('kubernetes-axi')!
  db.prepare(`INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
    VALUES ('synthetic-ca', ?, ?, ?, ?, ?, ?, 'ca', ?, 'synthetic-development-user')`).run(reference.id, origin + '/', fingerprint, leafFingerprint, pem, leaf, Date.now())
  const adapter = await createKubernetesAdapter(new EmbeddedSecretSource(store))
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), environment: {} })
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const invoke = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/run', headers, payload: { args } })
    for (const [args, expected] of [
      [[], /synthetic-pod/], [['get', 'pods'], /synthetic-pod/], [['get', 'deployments'], /synthetic-deployment/],
      [['get', 'secrets'], /synthetic-secret/], [['api-versions'], /apps\/v1/],
      [['native', '--', 'get', 'deployments', '-o', 'json'], /synthetic-deployment/],
      [['auth', 'whoami'], /synthetic-reader/],
      [['logs', 'synthetic-pod'], /Synthetic pod log/], [['doctor'], /connectivity: not checked/],
    ] as Array<[string[], RegExp]>) {
      const response = await invoke(args)
      assert.equal(response.statusCode, 200, response.body)
      const result = response.json()
      assert.equal(result.exitCode, 0, result.stdout + result.stderr)
      assert.match(result.stdout, expected)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|\/opt\/tools|\/tmp\/artium/)
    }
    const review = await invoke(['auth', 'can-i', 'get', 'pods'])
    assert.equal(review.statusCode, 200, review.body)
    assert.equal(review.json().exitCode, 0, review.body)
    const authorization = nativeCodec.decode(review.json().stdout) as { reviews: Array<{ status: { allowed: boolean } }> }
    assert.deepEqual(authorization.reviews.map(review => review.status.allowed), [true])
    const help = await invoke(['native', '--', 'get', '--help'])
    assert.equal(help.json().exitCode, 0, help.body)
    const document = decode(rewriteSuggestions(help.json().stdout, 'kubernetes-axi', false, { command: 'native --', help: true })) as { flags: Record<string, unknown>, help: string[] }
    assert.ok(Object.hasOwn(document.flags, 'selector'))
    assert.equal(Object.hasOwn(document.flags, 'server'), false)
    assert.ok(document.help.some(line => line.includes('Static token reads and mutation workflows also support saved strict leaf pins; client certificates and hosted byte sessions require issuing CA trust.')))
    const evidence = async () => JSON.parse(await send('/__evidence')) as { requests: Array<{ path: string, method: string, canaryReceived: boolean }> }
    const before = (await evidence()).requests.length
    for (const args of [['native', '--', 'delete', 'pod', 'synthetic-pod'], ['get', 'pods', '--token=CANARY-forbidden'], ['get', 'pods', '--watch']]) {
      const response = await invoke(args)
      assert.ok(response.statusCode >= 400, response.body)
    }
    assert.equal((await evidence()).requests.length, before)
    execFileSync('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-set_serial', '100', '-days', '3650', '-extfile', 'authority.cnf', '-extensions', 'server',
      '-out', 'other-server.crt'], { cwd: directory, stdio: 'pipe', timeout: 10_000 })
    const otherLeaf = readFileSync(join(directory, 'other-server.crt'), 'utf8')
    db.prepare("UPDATE trusted_certificates SET mode = 'pin', leaf_fingerprint = ?, leaf_pem = ?")
      .run(new X509Certificate(otherLeaf).fingerprint256, otherLeaf)
    const pinned = await invoke(['get', 'pods'])
    assert.equal(pinned.statusCode, 200, pinned.body)
    assert.equal(pinned.json().exitCode, 1, pinned.body)
    assert.match(pinned.json().stderr, /CERTIFICATE_PIN_MISMATCH/)
    assert.equal((await evidence()).requests.length, before)
    db.prepare("UPDATE trusted_certificates SET mode = 'ca', leaf_fingerprint = ?, leaf_pem = ?")
      .run(leafFingerprint, leaf)
    db.prepare("UPDATE trusted_certificates SET endpoint = 'https://other.example/'").run()
    const unrelated = await invoke(['get', 'pods'])
    assert.equal(unrelated.statusCode, 200, unrelated.body)
    assert.notEqual(unrelated.json().exitCode, 0, unrelated.body)
    assert.equal((await evidence()).requests.length, before)
    db.prepare('UPDATE trusted_certificates SET endpoint = ?').run(origin + '/')
    createTestClientCertificate(directory)
    store.replaceCredential('kubernetes-axi', { origin, auth: 'certificate', namespace: 'synthetic', certificateAuthority: pem,
      clientCertificate: readFileSync(join(directory, 'client.crt'), 'utf8'), privateKey: readFileSync(join(directory, 'client.key'), 'utf8') }, reference.revision!, 'synthetic-development-user', Date.now())
    const certificateRead = await invoke(['get', 'deployments'])
    assert.equal(certificateRead.statusCode, 200, certificateRead.body)
    assert.equal(certificateRead.json().exitCode, 0, certificateRead.body)
    assert.match(certificateRead.json().stdout, /synthetic-deployment/)
    db.prepare("DELETE FROM role_tools WHERE tool = 'kubernetes-axi'").run()
    const denied = await invoke(['get', 'pods'])
    assert.equal(denied.statusCode, 403, denied.body)
    assert.equal(denied.json().error.code, 'TOOL_NOT_GRANTED')
    const recorded = (await evidence()).requests.filter(request => request.path === '/version' || request.path.startsWith('/apis/') || request.path.startsWith('/api/v1'))
    assert.ok(recorded.length > 0)
    assert.ok(recorded.every(request => request.canaryReceived))
    assert.ok(recorded.every(request => request.method === 'GET' || /\/selfsubject(?:access)?reviews$/.test(request.path)))
    const writes = db.prepare("SELECT count(*) AS count FROM audit WHERE tool = 'kubernetes-axi' AND action = 'write'").get() as { count: number }
    assert.equal(writes.count, 0)
    assert.deepEqual(readdirSync(join(directory, 'calls')), [])
    console.log(JSON.stringify({ kubernetes: '0.1.3', transport: 'isolated loopback', savedCa: 'projected into kubectl profile',
      leafPins: 'refused before requests', identity: 'token and client certificate', nativeReads: 'verified', authorizationReviews: 'verified', deny: 'verified' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
