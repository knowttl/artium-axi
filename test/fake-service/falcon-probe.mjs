import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFalconAdapter, prepareFalcon, falconManifest } from '../../dist/src/server/adapters/falcon.js'
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
    const result = await untrusted.run('synthetic-user', call.executable, call.args, call.environment, call.secrets, call.limits)
    assert.notEqual(result.exitCode, 0, 'Pinned Falcon must refuse the untrusted private CA')
  } finally { await untrusted.shutdown() }
  // Execute the pinned parser, rather than treating source text as behavioral evidence.
  const parserEvidence = execFileSync('/opt/falcon-axi/bin/python', ['-c', `
import json
from falcon_axi.cli import parse
from falcon_axi.core import CliError
assert parse(['detection', 'list', '--region=us-1', '--region', 'us-2']).flags['region'] == 'us-2'
assert parse(['detection', 'list', '--allow-unknown-origin=false']).flags['allow-unknown-origin'] is True
assert parse(['search', 'start', '--query', 'synthetic | head(5)', '--wait', '1']).flags['wait'] == '1'
assert parse(['search', 'status', 'synthetic-search', '--wait', '50']).flags['wait'] == '50'
for wait in ['0', '51', 'forever']:
    try:
        parse(['search', 'status', 'synthetic-search', '--wait', wait])
    except CliError:
        continue
    raise AssertionError('Unbounded search wait accepted')
for args in [['detection', 'list', '--'], ['detection', 'list', '-r', 'us-1'], ['detection', 'list', '--member_cid=synthetic']]:
    try:
        parse(args)
    except CliError:
        continue
    raise AssertionError('Unexpected parser alias or delimiter')
print(json.dumps({'aliases': {}, 'shortFlags': {}, 'repeats': 'last value wins', 'equals': True, 'doubleDash': 'invalid empty flag; not a positional delimiter'}))
`], { encoding: 'utf8' })
  const { path, sha256, ...recordedParser } = falconManifest.parser
  assert.deepEqual(JSON.parse(parserEvidence), recordedParser)
  const run = async (args, settings = configuration) => {
    const prepared = await prepareFalcon(args, settings)
    assert.deepEqual(Object.keys(prepared.environment).sort(), ['FALCON_AXI_CLIENT_ID', 'FALCON_AXI_CLIENT_SECRET', 'FALCON_AXI_READ_ONLY'])
    assert.equal(prepared.environment.FALCON_AXI_READ_ONLY, 'true')
    return runner.run('synthetic-user', prepared.executable, prepared.args,
      prepared.environment, prepared.secrets, prepared.limits)
  }
  const evidence = async () => (await fetch('https://api.crowdstrike.com/__evidence')).json()
  const adapter = createFalconAdapter({ getCredential: async () => ({
    clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-1',
  }) })
  const beforeHelp = (await evidence()).requests.length
  for (const command of ['detection', 'host', 'search']) {
    const help = await run([command, '--help'])
    assert.equal(help.exitCode, 0, help.stdout + help.stderr)
    assert.match(help.stdout, new RegExp(command))
  }
  assert.equal((await evidence()).requests.length, beforeHelp)
  for (const args of [
    ['search', 'start', '--query', 'synthetic | head(1)', '--wait', '30'],
    ['search', 'status', 'synthetic-search', '--wait', '30'],
    ['search', 'stop', 'synthetic-search'],
    ['identity', 'activity', 'synthetic@example.test'],
  ]) {
    for (const prepared of [await prepareFalcon(args, configuration),
      await adapter.prepare(args, { id: 'synthetic', tool: 'falcon-axi' })]) {
      execFileSync('/opt/falcon-axi/bin/python', ['-c', `
import json, sys
from falcon_axi.cli import run
from falcon_axi.core import CliError
class RejectedAuthentication:
    called = False
    def request_oauth_token(self, args):
        assert args.client_id == 'CANARY-falcon-id'
        assert args.client_secret == 'CANARY-falcon-secret'
        self.called = True
        raise CliError('AUTH_FAILED', 'Synthetic rejection')
call = json.load(sys.stdin)
transport = RejectedAuthentication()
env = call['environment']
env['HOME'] = ${JSON.stringify(directory)}
for file in call.get('files', []):
    if file['name'] == 'falcon-axi/config.json':
        env['FALCON_AXI_CONFIG'] = ${JSON.stringify(join(directory, 'config.json'))}
        with open(env['FALCON_AXI_CONFIG'], 'w') as output:
            output.write(file['content'])
stdout, code = run(call['args'], transport=transport, env=env)
assert transport.called == (call['args'][:2] == ['search', 'status']), stdout
assert code != 0 and ('AUTH_FAILED' in stdout or 'READ_ONLY_VIOLATION' in stdout), stdout
`], { input: JSON.stringify(prepared), encoding: 'utf8' })
    }
  }
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
  const redirected = await run(['detection', 'list'], { ...configuration, region: 'https://redirect.crowdstrike.com' })
  assert.notEqual(redirected.exitCode, 0)
  assert.match(redirected.stdout, /ORIGIN_NOT_ALLOWED/)
  const apiRedirected = await run(['detection', 'list', '--limit', '1'], { ...configuration, region: 'https://api-redirect.crowdstrike.com' })
  assert.notEqual(apiRedirected.exitCode, 0)
  assert.match(apiRedirected.stdout, /ORIGIN_NOT_ALLOWED/)
  for (const name of falconManifest.unsafeOverrides) {
    for (const args of [[`--${name}`, 'synthetic'], [`--${name}=synthetic`], ['--', `--${name}=synthetic`]]) {
      await assert.rejects(run(['detection', 'list', ...args], { ...configuration, clientIdFile: '/missing' }), { code: 'FLAG_BLOCKED' })
    }
  }
  const recorded = await evidence()
  assert.deepEqual(recorded.requests.slice(beforeRedirects), [
    { method: 'POST', host: 'redirect.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'POST', host: 'api-redirect.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'GET', host: 'api-redirect.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true, offset: '0', limit: '1' },
  ])
  assert.equal(recorded.mutations, 0)
  // Exercise the shipped CLI through the authenticated API and audited administrator switch.
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'rtr.db'), provider)
  const store = createCredentialStore(db, provider)
  const rtrAdapter = createFalconAdapter(new EmbeddedSecretSource(store), join(directory, 'rtr-writes.log'))
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [rtrAdapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  try {
    await seedToolUser(db)
    db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
    store.replaceCredential('falcon-axi', { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret',
      region: 'us-1' }, 0, 'synthetic-development-user', Date.now())
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
      username: 'synthetic-user', password: 'CANARY-local-password' } })
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const run = async args => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/falcon-axi/run', headers, payload: { args } })
      assert.equal(response.statusCode, 200, response.body)
      return response.json()
    }
    const command = ['rtr', 'run', 'a'.repeat(32), '--command', 'ps']
    const execute = [...command, '--execute', '--confirm', `${'a'.repeat(32)}:ps`]
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const confirmedHeaders = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
    const configured = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/falcon-axi', headers: confirmedHeaders,
      payload: { nativeSettings: { rtr: { enabled: true, commands: ['ps'] } }, expectedRevision: 1 } })
    assert.equal(configured.statusCode, 200, configured.body)
    const detail = await app.inject({ url: '/v1/admin/tools/falcon-axi', headers: confirmedHeaders })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json().writeAccess.enabled, false)
    assert.equal(detail.json().writeAccess.unlocks, 'RTR read-only command execution')
    const start = (await evidence()).requests.length
    assert.equal((await run(command)).exitCode, 0)
    assert.match((await run(execute)).stdout, /READ_ONLY_VIOLATION/)
    assert.equal((await evidence()).requests.length, start)
    for (const args of [['rtr', 'session', 'list'], ['rtr', 'session', 'show', 'synthetic-rtr-session'], ['rtr', 'audit', 'list']]) {
      const history = await run(args)
      assert.equal(history.exitCode, 0, history.stdout)
      assert.match(history.stdout, /synthetic-rtr-session/)
    }
    const switchInput = { enabled: true, expectedRevision: detail.json().revision }
    const unconfirmed = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/falcon-axi/write-access', headers, payload: switchInput })
    assert.equal(unconfirmed.json().error.code, 'REAUTH_REQUIRED')
    const on = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/falcon-axi/write-access',
      headers: confirmedHeaders, payload: switchInput })
    assert.equal(on.statusCode, 200, on.body)
    assert.equal(on.json().writeAccess.enabled, true)
    assert.deepEqual(on.json().nativeSettings.rtr, { enabled: true, commands: ['ps'] })
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'tool-write-access' AND tool = 'falcon-axi'").get().count, 1)
    const beforeRun = (await evidence()).requests.length
    const forced = await rtrAdapter.prepare(execute, store.findCredential('falcon-axi'))
    const forcedResult = await runner.run('synthetic-user', forced.executable, forced.args,
      { ...forced.environment, FALCON_AXI_READ_ONLY: 'true' }, forced.secrets, forced.limits, undefined, forced.files)
    assert.match(forcedResult.stdout, /READ_ONLY_VIOLATION/)
    assert.match((await run([...command, '--execute', '--confirm', 'wrong'])).stdout, /VALIDATION_ERROR/)
    assert.match((await run(['rtr', 'run', 'a'.repeat(32), '--command', 'ls', '--execute', '--confirm', `${'a'.repeat(32)}:ls`])).stdout, /READ_ONLY_VIOLATION/)
    assert.equal((await evidence()).requests.length, beforeRun)
    const result = await run(execute)
    assert.equal(result.exitCode, 0, result.stdout)
    assert.match(result.stdout, /synthetic process list/)
    assert.match(result.stdout, /cleanup: deleted/)
    assert.deepEqual((await evidence()).requests.slice(beforeRun).map(({ method, path }) => ({ method, path })), [
      { method: 'POST', path: '/oauth2/token' },
      { method: 'POST', path: '/real-time-response/entities/sessions/v1' },
      { method: 'POST', path: '/real-time-response/entities/command/v1' },
      { method: 'GET', path: '/real-time-response/entities/command/v1' },
      { method: 'DELETE', path: '/real-time-response/entities/sessions/v1' },
    ])
    const actions = db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' AND tool = 'falcon-axi'").all().map(row => row.action)
    assert.ok(actions.includes('write') && actions.includes('read'))
    const journalRoot = join(directory, 'rtr-writes.log.runs')
    const journals = await Promise.all((await readdir(journalRoot)).map(async name =>
      readFile(join(journalRoot, name, 'writes.log'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''
        throw error
      })))
    assert.match(journals.join(''), /"cleanup": "deleted"/)
    assert.doesNotMatch(journals.join(''), /CANARY-|synthetic process list/)
    const optOut = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/falcon-axi', headers: confirmedHeaders,
      payload: { nativeSettings: { allowWrites: true, rtr: { enabled: false } }, expectedRevision: on.json().revision } })
    assert.equal(optOut.statusCode, 200, optOut.body)
    assert.match((await run(execute)).stdout, /explicit profile opt-in/)
    console.log('falcon-rtr: default off, history reads, recent confirmation, audited switch, native confirmation, command narrowing, execute and delete passed')
  } finally { await app.close(); db.close() }
  console.log(JSON.stringify({ parser: 'matched', reads: 4, pagination: 'advanced with and without member CID', cursorOriginReplay: 'refused before detection request', tokenRedirect: 'refused', apiRedirect: 'refused', outbound: 'denied', unsafeOverrides: 'refused before secrets', requests: recorded.requests }))
} finally {
  await runner.shutdown()
  await rm(directory, { recursive: true, force: true })
}
