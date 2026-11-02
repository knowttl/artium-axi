import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFalconAdapter, prepareFalcon, falconManifest } from '../../dist/src/server/adapters/falcon.js'
import { toolPaths } from '../../dist/src/server/config.js'
import { Runner } from '../../dist/src/server/runner/runner.js'
import { loadTrustedCa } from '../../dist/src/server/trusted-ca.js'
import { createApp } from '../../dist/src/server/app.js'
import { Audit } from '../../dist/src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../dist/src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../dist/src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../dist/src/server/policy/identity-resolver.js'
import { seedToolUser } from '../../dist/test/fixtures/tokens.js'

const directory = await mkdtemp(join(tmpdir(), 'artium-falcon-probe-'))
const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: '/test-ca.crt' }))
const configuration = { clientIdFile: join(directory, 'id'), clientSecretFile: join(directory, 'secret'), region: 'us-1' }
try {
  assert.ok(!(await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)
    .some(line => line.split(/\s+/)[1] === '00000000'), 'Isolated client must have no default IPv4 route')
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = createConnection({ host: process.env.ARTIUM_TEST_OUTSIDE_IP, port: 443 })
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('error', reject)
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Synthetic outside TCP connection denied')) })
  }))
  await writeFile(configuration.clientIdFile, 'CANARY-falcon-id\n', { mode: 0o600 })
  await writeFile(configuration.clientSecretFile, 'CANARY-falcon-secret\n', { mode: 0o600 })
  const untrusted = await Runner.create(join(directory, 'untrusted'))
  try {
    const call = await prepareFalcon(['detection', 'list', '--limit', '1'], configuration)
    const result = await untrusted.run('synthetic-user', call.executable, call.args, call.environment, call.secrets, call.limits, undefined, call.files)
    assert.notEqual(result.exitCode, 0, 'Pinned Falcon must refuse the untrusted private CA')
  } finally { await untrusted.shutdown() }
  const { parse } = await import(new URL('./parser.js', 'file://' + toolPaths['falcon-axi']))
  assert.equal(parse(['detection', 'list', '--region=us-1', '--region', 'us-2']).flags.get('--region'), 'us-2')
  assert.equal(parse(['search', 'status', 'synthetic-search', '--wait', '50']).flags.get('--wait'), '50')
  for (const args of [['detection', 'list', '--allow-unknown-origin=false'], ['detection', 'list', '--'],
    ['detection', 'list', '-r', 'us-1'], ['detection', 'list', '--member_cid=synthetic'],
    ['search', 'status', 'synthetic-search', '--wait', '0'], ['search', 'status', 'synthetic-search', '--wait', '51']]) {
    assert.throws(() => parse(args), undefined, `Pinned parser must reject ${JSON.stringify(args)}`)
  }
  const run = async (args, settings = configuration) => {
    const prepared = await prepareFalcon(args, settings)
    assert.equal(prepared.environment.FALCON_AXI_READ_ONLY, 'true')
    assert.equal(prepared.environment.FALCON_AXI_CLIENT_SECRET, undefined)
    return runner.run('synthetic-user', prepared.executable, prepared.args,
      prepared.environment, prepared.secrets, prepared.limits, undefined, prepared.files)
  }
  const evidence = async () => (await fetch('https://api.crowdstrike.com/__evidence')).json()
  const beforeHelp = (await evidence()).requests.length
  for (const command of ['detection', 'host', 'search']) {
    const help = await run([command, '--help'])
    assert.equal(help.exitCode, 0, help.stdout + help.stderr)
    assert.match(help.stdout, new RegExp(command))
  }
  assert.equal((await evidence()).requests.length, beforeHelp)
  for (const settings of [configuration, { ...configuration, memberCid: 'synthetic-member' }]) {
    const before = (await evidence()).requests.length
    const first = await run(['detection', 'list', '--limit', '1'], settings)
    assert.equal(first.exitCode, 0, first.stdout + first.stderr)
    assert.match(first.stdout, /synthetic-detection-1/)
    assert.doesNotMatch(first.stdout, /synthetic-detection-2/)
    const cursor = first.stdout.match(/^continuation_cursor: ([A-Za-z0-9_-]+)$/m)?.[1]
    assert.ok(cursor, first.stdout)
    const second = await run(['detection', 'list', '--limit', '1', '--cursor', cursor], settings)
    assert.equal(second.exitCode, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /synthetic-detection-2/)
    assert.doesNotMatch(second.stdout, /synthetic-detection-1|continuation_cursor:/)
    const replay = await run(['detection', 'list', '--limit', '1', '--cursor', cursor], { ...settings, region: 'us-2' })
    assert.notEqual(replay.exitCode, 0)
    assert.match(replay.stdout, /VALIDATION_ERROR/)
    assert.deepEqual((await evidence()).requests.slice(before), [
      { method: 'POST', host: 'api.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
      { method: 'GET', host: 'api.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true, offset: '0', limit: '1' },
      { method: 'POST', host: 'api.crowdstrike.com', path: '/alerts/entities/alerts/v2', canaryReceived: true },
      { method: 'POST', host: 'api.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
      { method: 'GET', host: 'api.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true, offset: '1', limit: '1' },
      { method: 'POST', host: 'api.crowdstrike.com', path: '/alerts/entities/alerts/v2', canaryReceived: true },
      { method: 'POST', host: 'api.us-2.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    ])
  }
  const beforeRedirects = (await evidence()).requests.length
  for (const [region, code] of [['https://redirect.crowdstrike.com', 'ORIGIN_NOT_ALLOWED'],
    ['https://api-redirect.crowdstrike.com', 'UPSTREAM_ERROR']]) {
    const result = await run(['detection', 'list', '--limit', '1'], { ...configuration, region })
    assert.notEqual(result.exitCode, 0)
    assert.match(result.stdout, new RegExp(code))
  }
  assert.deepEqual((await evidence()).requests.slice(beforeRedirects), [
    { method: 'POST', host: 'redirect.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'POST', host: 'api-redirect.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'GET', host: 'api-redirect.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true, offset: '0', limit: '1' },
  ])
  for (const name of falconManifest.unsafeOverrides) {
    for (const args of [[`--${name}`, 'synthetic'], [`--${name}=synthetic`], ['--', `--${name}=synthetic`]]) {
      await assert.rejects(run(['detection', 'list', ...args], { ...configuration, clientIdFile: '/missing' }), { code: 'FLAG_BLOCKED' })
    }
  }
  // Exercise the shipped binary through the authenticated API with the stored tenant identity.
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'falcon.db'), provider)
  const seedStore = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  seedStore.replaceCredential('falcon-axi', { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret',
    region: 'us-1', writes: { allowWrites: true, operations: ['rtr run', 'malquery search'] },
    rtr: { enabled: true, commands: ['ps'] } }, 0, 'synthetic-development-user', Date.now())
  // Reopening the store migrates encrypted legacy choices into the tenant settings.
  const store = createCredentialStore(db, provider)
  const adapter = createFalconAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
      username: 'synthetic-user', password: 'CANARY-local-password' } })
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const invoke = args => app.inject({ method: 'POST', url: '/v1/tools/falcon-axi/run', headers, payload: { args } })
    for (const args of [[], ['--help'], ['detection', 'list'], ['auth', 'status'], ['scopes'], ['identity', 'list'], ['identity', 'assessment'],
      ['rtr', 'session', 'list'], ['rtr', 'session', 'show', 'synthetic-rtr-session'], ['rtr', 'audit', 'list']]) {
      const response = await invoke(args)
      assert.equal(response.statusCode, 200, response.body)
      const result = response.json()
      assert.equal(result.exitCode, 0, result.stdout + result.stderr)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_0/)
      if (!args.length) assert.match(result.stdout, /bin: artium-axi falcon-axi/)
      if (args[0] === 'detection') assert.match(result.stdout, /synthetic-detection/)
      if (args[0] === 'rtr') assert.match(result.stdout, /synthetic-rtr-session/)
      if (args[0] === 'auth') assert.match(result.stdout, /credential_resolved: true/)
      if (args[0] === 'identity' && args[1] === 'list') assert.match(result.stdout, /Synthetic identity/)
      if (args[0] === 'identity' && args[1] === 'assessment') assert.match(result.stdout, /score: 42/)
    }
    assert.deepEqual((await evidence()).requests.filter(request => request.path === '/identity-protection/combined/graphql/v1')
      .map(request => request.document), ['query', 'query'])
    const beforeDenials = (await evidence()).requests.length
    for (const command of ['search start', 'search stop', 'host usb', 'identity activity', 'malquery search', 'rtr run']) {
      const response = await invoke(command.split(' '))
      assert.equal(response.json().error.code, 'FLAG_BLOCKED', response.body)
    }
    assert.equal((await evidence()).requests.length, beforeDenials)
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const detail = await app.inject({ url: '/v1/admin/tools/falcon-axi',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket } })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json().writeAccess.capable, false)
    assert.equal(detail.json().writeAccess.enabled, false)
    assert.deepEqual(detail.json().writeAccess.allowedOperations, ['rtr run', 'malquery search'])
    const actions = db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' AND tool = 'falcon-axi'").all().map(row => row.action)
    assert.ok(actions.includes('read'))
    assert.ok(!actions.includes('write'))
  } finally { await app.close(); db.close() }
  const recorded = await evidence()
  assert.equal(recorded.mutations, 0)
  console.log(JSON.stringify({ parser: 'TypeScript contract matched', pagination: 'advanced with and without member CID',
    cursorOriginReplay: 'refused', redirects: 'refused', outbound: 'denied', unsafeOverrides: 'refused before secrets',
    api: 'authenticated reads and deferred-operation denials', requests: recorded.requests.length }))
} finally {
  await runner.shutdown()
  await rm(directory, { recursive: true, force: true })
}
