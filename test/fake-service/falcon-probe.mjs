import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareFalcon, falconManifest } from '../../dist/src/server/adapters/falcon.js'
import { Runner } from '../../dist/src/server/runner/runner.js'

const directory = await mkdtemp(join(tmpdir(), 'artium-falcon-probe-'))
const runner = await Runner.create(join(directory, 'calls'))
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
    assert.deepEqual(Object.keys(prepared.environment).sort(), ['FALCON_CLIENT_ID', 'FALCON_CLIENT_SECRET'])
    return runner.run('synthetic-user', prepared.executable, prepared.args,
      { ...prepared.environment, REQUESTS_CA_BUNDLE: '/certs/ca.crt' }, prepared.secrets, prepared.limits)
  }
  const result = await run(['detection', 'list'])
  assert.equal(result.exitCode, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /0 detections/)
  const member = await run(['detection', 'list'], { ...configuration, memberCid: 'synthetic-member' })
  assert.equal(member.exitCode, 0, member.stdout + member.stderr)
  const redirected = await run(['detection', 'list'], { ...configuration, region: 'https://redirect.crowdstrike.com' })
  assert.notEqual(redirected.exitCode, 0)
  assert.match(redirected.stdout, /ORIGIN_NOT_ALLOWED/)
  const apiRedirected = await run(['detection', 'list'], { ...configuration, region: 'https://api-redirect.crowdstrike.com' })
  assert.notEqual(apiRedirected.exitCode, 0)
  assert.match(apiRedirected.stdout, /ORIGIN_NOT_ALLOWED/)
  for (const name of falconManifest.unsafeOverrides) {
    for (const args of [[`--${name}`, 'synthetic'], [`--${name}=synthetic`], ['--', `--${name}=synthetic`]]) {
      await assert.rejects(run(['detection', 'list', ...args], { ...configuration, clientIdFile: '/missing' }), { code: 'FLAG_BLOCKED' })
    }
  }
  const evidence = await (await fetch('https://api.crowdstrike.com/__evidence')).json()
  assert.deepEqual(evidence.requests, [
    { method: 'POST', host: 'api.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'GET', host: 'api.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true },
    { method: 'POST', host: 'api.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'GET', host: 'api.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true },
    { method: 'POST', host: 'redirect.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'POST', host: 'api-redirect.crowdstrike.com', path: '/oauth2/token', canaryReceived: true },
    { method: 'GET', host: 'api-redirect.crowdstrike.com', path: '/alerts/queries/alerts/v2', canaryReceived: true },
  ])
  assert.equal(evidence.mutations, 0)
  console.log(JSON.stringify({ parser: 'matched', reads: 2, tokenRedirect: 'refused', apiRedirect: 'refused', outbound: 'denied', unsafeOverrides: 'refused before secrets', requests: evidence.requests }))
} finally {
  await runner.shutdown()
  await rm(directory, { recursive: true, force: true })
}
