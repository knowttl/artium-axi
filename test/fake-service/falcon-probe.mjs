import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFalconAdapter, prepareFalcon, falconManifest } from '../../dist/src/server/adapters/falcon.js'
import { Runner } from '../../dist/src/server/runner/runner.js'
import { loadTrustedCa } from '../../dist/src/server/trusted-ca.js'

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
    assert.equal(prepared.environment.FALCON_AXI_READ_ONLY, 'false')
    return runner.run('synthetic-user', prepared.executable, prepared.args,
      prepared.environment, prepared.secrets, prepared.limits)
  }
  const evidence = async () => (await fetch('https://api.crowdstrike.com/__evidence')).json()
  const adapter = createFalconAdapter({ getCredential: async () => ({
    clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-1',
  }) })
  for (const args of [
    ['search', 'start', '--query', 'synthetic | head(1)'],
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
assert transport.called, stdout
assert code != 0 and 'AUTH_FAILED' in stdout, stdout
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
  console.log(JSON.stringify({ parser: 'matched', reads: 4, pagination: 'advanced with and without member CID', cursorOriginReplay: 'refused before detection request', tokenRedirect: 'refused', apiRedirect: 'refused', outbound: 'denied', unsafeOverrides: 'refused before secrets', requests: recorded.requests }))
} finally {
  await runner.shutdown()
  await rm(directory, { recursive: true, force: true })
}
