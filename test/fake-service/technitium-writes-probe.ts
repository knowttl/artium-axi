import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createApp } from '../../src/server/app.js'
import { createTechnitiumAdapter } from '../../src/server/adapters/technitium.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SessionStore } from '../../src/cli/session.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from './fixture.js'

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, port, send }) => {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'technitium.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'technitium-axi'")
  store.replaceCredential('technitium-axi', { origin: `https://127.0.0.1:${port}`, auth: 'token', tokenKind: 'api',
    token: 'CANARY-technitium-token', caFile: readFileSync(join(directory, 'ca.crt'), 'utf8'), tlsServerName: 'localhost' }, 0,
  'synthetic-development-user', Date.now())
  const calls = join(directory, 'calls')
  let runner = await Runner.create(calls)
  const adapter = createTechnitiumAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const application = () => createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), environment: {}, credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), adapters: [adapter] })
  let app = application()
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    assert.equal(reauth.statusCode, 200, reauth.body)
    const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
    const settings = async (nativeSettings: Record<string, unknown>) => {
      const current = await app.inject({ url: '/v1/admin/tools/technitium-axi', headers: proof })
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/technitium-axi', headers: proof,
        payload: { nativeSettings, expectedRevision: current.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const policy = async (operations: string[]) => {
      const current = await app.inject({ url: '/v1/admin/tools/technitium-axi', headers: proof })
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/technitium-axi/write-access', headers: proof,
        payload: { enabled: true, operations, expectedRevision: current.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const envelope = (parameters: Record<string, unknown>, extra = {}) => [{ name: 'input.json',
      size: Buffer.byteLength(JSON.stringify({ parameters, ...extra })), contentBase64: Buffer.from(JSON.stringify({ parameters, ...extra })).toString('base64') }]
    const invoke = (args: string[], parameters: Record<string, unknown> = { domain: 'synthetic.test' }, extra = {}) =>
      app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers, payload: { args: [...args, '--input-file', 'input.json', '--json'], files: envelope(parameters, extra) } })
    const success = async (args: string[], parameters?: Record<string, unknown>, extra = {}) => {
      const response = await invoke(args, parameters, extra)
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().exitCode, 0, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|artium-call-|\/opt\/tools/)
      return JSON.parse(response.json().stdout) as { preview: { digest: string, permitted: boolean }, result: { path: string }, auditId: string }
    }
    const operations = ['OP-057', 'OP-099', 'OP-077.import', 'OP-080', 'OP-076', 'OP-023', 'OP-102', 'OP-003']
    const writes = { allowWrites: true, operations }
    assert.equal((await invoke(['allowed', 'add'])).json().error.code, 'FLAG_BLOCKED')
    const resolveInput = { server: 'recursive-resolver', domain: 'synthetic.test', type: 'A' }
    assert.equal((await invoke(['dns-client', 'resolve'], { ...resolveInput, import: true })).json().error.code, 'FLAG_BLOCKED')
    const readPreview = await success(['dns-client', 'resolve'], resolveInput)
    const resolved = await success(['dns-client', 'resolve', '--execute', '--confirm', readPreview.preview.digest], resolveInput)
    assert.equal((await app.inject({ url: resolved.result.path, headers })).json().status, 'ok')
    await settings({ writes })
    assert.equal((await invoke(['allowed', 'add'])).json().error.code, 'FLAG_BLOCKED')
    await policy(operations)
    const preview = await success(['allowed', 'add'])
    assert.equal(preview.preview.permitted, true)
    assert.deepEqual(JSON.parse(await send('/__evidence')).requests.filter((request: { path: string }) => request.path === '/api/allowed/add'), [])
    assert.deepEqual(readdirSync(calls), [])
    const confirmation = preview.preview.digest
    const mismatch = await invoke(['allowed', 'add', '--execute', '--confirm', confirmation], { domain: 'changed.synthetic.test' })
    assert.equal(JSON.parse(mismatch.json().stdout).error.code, 'CONFIRMATION_MISMATCH')
    const executed = await success(['allowed', 'add', '--execute', '--confirm', confirmation])
    const result = await app.inject({ url: executed.result.path, headers })
    assert.equal(result.statusCode, 200, result.body)
    assert.deepEqual(result.json(), { status: 'ok', response: { domain: 'synthetic.test' } })
    assert.equal((await app.inject({ url: executed.result.path, headers })).statusCode, 404)
    assert.equal(JSON.parse((await invoke(['allowed', 'add', '--execute', '--confirm', confirmation])).json().stdout).error.code, 'REPLAY_DENIED')
    assert.equal(JSON.parse(await send('/__evidence')).requests.filter((request: { path: string }) => request.path === '/api/allowed/add').length, 1)
    await app.close()
    runner = await Runner.create(calls)
    app = application()
    assert.equal(JSON.parse((await invoke(['allowed', 'add', '--execute', '--confirm', confirmation])).json().stdout).error.code, 'REPLAY_DENIED')
    const tokenInput = { user: 'synthetic-user', tokenName: 'synthetic-token' }
    const tokenPreview = await success(['admin', 'session', 'create-token'], tokenInput)
    const minted = await success(['admin', 'session', 'create-token', '--execute', '--confirm', tokenPreview.preview.digest], tokenInput)
    const tokenBytes = await app.inject({ url: minted.result.path, headers })
    assert.equal(tokenBytes.json().response.token, 'CANARY-technitium-minted')
    const nativeJournal = readFileSync(join(directory, 'writes.log.d', tokenPreview.preview.digest + '.json'), 'utf8')
    assert.doesNotMatch(nativeJournal, /CANARY-|synthetic-user|synthetic-token/)
    const selected = { enableBlocking: true }
    const baseline = { baseline: { enableBlocking: false } }
    const setterPreview = await success(['settings', 'set'], selected, baseline)
    const setter = await success(['settings', 'set', '--execute', '--confirm', setterPreview.preview.digest], selected, baseline)
    assert.equal((await app.inject({ url: setter.result.path, headers })).json().response.enableBlocking, true)
    const importPreview = await success(['dns-client', 'resolve'], { ...resolveInput, import: true })
    const imported = await success(['dns-client', 'resolve', '--execute', '--confirm', importPreview.preview.digest], { ...resolveInput, import: true })
    assert.equal((await app.inject({ url: imported.result.path, headers })).json().status, 'ok')
    const uncertainPreview = await success(['allowed', 'add'])
    await send('/__technitium/drop-write')
    const uncertain = await invoke(['allowed', 'add', '--execute', '--confirm', uncertainPreview.preview.digest])
    assert.equal(JSON.parse(uncertain.json().stdout).error.code, 'OUTCOME_UNKNOWN')
    const intent = JSON.parse(readFileSync(join(directory, 'writes.log.d', uncertainPreview.preview.digest + '.json'), 'utf8'))
    const reconciled = await invoke(['allowed', 'add', '--reconcile', intent.auditId, '--confirm', uncertainPreview.preview.digest])
    assert.equal(JSON.parse(reconciled.json().stdout).error.code, 'OUTCOME_UNKNOWN')
    assert.equal(JSON.parse((await invoke(['allowed', 'add', '--execute', '--confirm', uncertainPreview.preview.digest])).json().stdout).error.code, 'REPLAY_DENIED')
    assert.deepEqual(readdirSync(calls), [])
    const url = await app.listen({ host: '127.0.0.1', port: 0 })
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated',
      accessToken: login.json().accessToken, refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000,
      familyExpiresAt: Date.now() + 43_200_000 })
    const localInput = join(directory, 'private-input.json')
    writeFileSync(localInput, JSON.stringify({ parameters: { domain: 'synthetic.test' } }), { mode: 0o600 })
    const cli = (extra: string[], command = ['allowed', 'add'], file = localInput) => promisify(execFile)(process.execPath,
      ['/work/dist/cli/artium-axi.mjs', 'technitium-axi', ...command, '--input-file', file, '--json', ...extra],
      { timeout: 10_000, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })
    const cliPreview = JSON.parse((await cli([])).stdout)
    const cliExecuted = JSON.parse((await cli(['--execute', '--confirm', cliPreview.preview.digest])).stdout)
    assert.equal((await app.inject({ url: cliExecuted.result.path, headers })).json().status, 'ok')
    const config = join(directory, 'private.config')
    const configInput = join(directory, 'config-input.json')
    const configBytes = ' { "opaque": "CANARY-private-config" }\r\n'
    writeFileSync(config, configBytes, { mode: 0o600 })
    writeFileSync(configInput, JSON.stringify({ parameters: { name: 'synthetic-app', config: { file: config } } }), { mode: 0o600 })
    const configPreview = JSON.parse((await cli([], ['app', 'config', 'set'], configInput)).stdout)
    const configResult = JSON.parse((await cli(['--execute', '--confirm', configPreview.preview.digest], ['app', 'config', 'set'], configInput)).stdout)
    assert.equal((await app.inject({ url: configResult.result.path, headers })).json().status, 'ok')
    assert.equal(JSON.parse(await send('/__evidence')).requests.find((request: { path: string }) => request.path === '/api/apps/config/set').fields.config, configBytes)
    const upload = join(directory, 'zone.txt')
    const uploadInput = join(directory, 'zone-input.json')
    const zoneBytes = 'synthetic.test. IN TXT "synthetic opaque record"\r\n'
    writeFileSync(upload, zoneBytes, { mode: 0o600 })
    writeFileSync(uploadInput, JSON.stringify({ parameters: { zone: 'synthetic.test' }, upload: { file: upload, format: 'text' } }), { mode: 0o600 })
    const uploadPreview = JSON.parse((await cli([], ['zone', 'import'], uploadInput)).stdout)
    const uploadResult = JSON.parse((await cli(['--execute', '--confirm', uploadPreview.preview.digest], ['zone', 'import'], uploadInput)).stdout)
    assert.equal((await app.inject({ url: uploadResult.result.path, headers })).json().status, 'ok')
    assert.equal(JSON.parse(await send('/__evidence')).requests.find((request: { path: string }) => request.path === '/api/zones/import').uploadedText, zoneBytes)
    const current = store.findCredential('technitium-axi')!
    store.replaceCredential('technitium-axi', { ...store.readCredential(current) as Record<string, unknown>, tokenKind: 'session', username: 'synthetic-user' },
      current.revision!, 'synthetic-development-user', Date.now())
    const bearerPreview = await success(['user', 'create-token'], { tokenName: 'synthetic-token' })
    const bearerResult = await success(['user', 'create-token', '--execute', '--confirm', bearerPreview.preview.digest], { tokenName: 'synthetic-token' })
    assert.equal((await app.inject({ url: bearerResult.result.path, headers })).json().token, 'CANARY-technitium-selected-session-minted')
    const audit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
    assert.doesNotMatch(audit, /CANARY-|private-input|synthetic-token/)
    assert.deepEqual(readdirSync(calls), [])
    console.log('technitium-writes: independent grants, conditional DNS import, CA-bound confirmation, baseline verification, durable replay denial across restart, unknown-outcome reconciliation, private token results, opaque local inputs and bundled CLI passed')
  } finally { await app.close(); db.close() }
})
