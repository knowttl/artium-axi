import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { withFakeService } from '../../../test/fake-service/fixture.js'
import { Runner } from '../runner/runner.js'
import { falconManifest, prepareFalcon } from './falcon.js'

let directory: string
let configuration: { clientIdFile: string, clientSecretFile: string, region: string, memberCid?: string }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artium-falcon-test-'))
  configuration = { clientIdFile: join(directory, 'client-id'), clientSecretFile: join(directory, 'client-secret'), region: 'us-2' }
  await writeFile(configuration.clientIdFile, 'CANARY-falcon-id\n', { mode: 0o600 })
  await writeFile(configuration.clientSecretFile, 'CANARY-falcon-secret\n', { mode: 0o600 })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

const blocked = [
  ['--region', 'https://appliance.test'], ['--region=https://appliance.test'],
  ['--member-cid', 'synthetic-child'], ['--member-cid=synthetic-child'],
  ['--allow-unknown-origin'], ['--allow-unknown-origin=false'],
  ['--no-member-cid'], ['--no-member-cid=false'],
  ['--profile', 'synthetic'], ['--profile=synthetic'],
  ['--config', 'synthetic.json'], ['--config=synthetic.json'],
  ['--region=us-1', '--region=us-2'], ['--member-cid=one', '--member-cid=two'],
  ['--'], ['--', '--region=us-1'], ['--', '--member-cid=synthetic'],
]
test.each(blocked)('security refuses %j before reading credentials or calling the runner', async (...override) => {
  const run = vi.fn()
  const unavailable = { ...configuration, clientIdFile: join(directory, 'missing-id'), clientSecretFile: join(directory, 'missing-secret') }
  await expect(prepareFalcon(['detection', 'list', ...override], unavailable).then(run))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED', source: 'artium-axi' })
  expect(run).not.toHaveBeenCalled()
})

test.each(['setup', 'config', 'profile', 'credentials', 'export', 'auth login', 'auth logout'])
  ('security refuses local operation %s before credential access', async command => {
    await expect(prepareFalcon(command.split(' '), { ...configuration, clientIdFile: '/missing' }))
      .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  })

test.each([undefined, 'synthetic-member'])('preparation adds the managed region and optional member %s', async memberCid => {
  const args = ['search', 'start', '--query', 'synthetic | text --region=literal', '--repository=synthetic', '--since', '24h']
  const result = await prepareFalcon(args, { ...configuration, memberCid })
  expect(result).toEqual({
    executable: '/opt/falcon-axi/bin/falcon-axi',
    args: [...args, '--region', 'us-2', ...(memberCid ? ['--member-cid', memberCid] : [])],
    environment: { FALCON_AXI_CLIENT_ID: 'CANARY-falcon-id', FALCON_AXI_CLIENT_SECRET: 'CANARY-falcon-secret', FALCON_AXI_READ_ONLY: 'true' },
    secrets: ['CANARY-falcon-id', 'CANARY-falcon-secret'], limits: { runtime: 'python', timeoutMs: 60_000 },
  })
})

test.each(['', '\n', '   '])('empty secret file %j is unavailable', async value => {
  await writeFile(configuration.clientSecretFile, value)
  await expect(prepareFalcon([], configuration)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})

test('unreadable secret file produces safe credential diagnostics', async () => {
  const failure = await prepareFalcon([], { ...configuration, clientSecretFile: join(directory, 'missing') }).catch(error => error)
  expect(failure).toMatchObject({ code: 'CREDENTIAL_INVALID' })
  expect(String(failure)).not.toContain(directory)
})

test('native help and unknown ordinary options remain upstream-owned', async () => {
  expect((await prepareFalcon(['host', 'list', '--help'], configuration)).args)
    .toEqual(['host', 'list', '--help', '--region', 'us-2'])
  expect((await prepareFalcon(['detection', 'list', '-r', 'us-1', '--synthetic'], configuration)).args)
    .toEqual(['detection', 'list', '-r', 'us-1', '--synthetic', '--region', 'us-2'])
  expect(falconManifest.parser.aliases).toEqual({})
  expect(falconManifest.parser.shortFlags).toEqual({})
})

test.each(['login list', 'account list', 'cloud-asset list', 'identity rule list'])
  ('new read command %s keeps managed credentials and read-only execution', async command => {
    const prepared = await prepareFalcon(command.split(' '), configuration)
    expect(prepared.args).toEqual([...command.split(' '), '--region', 'us-2'])
    expect(prepared.environment.FALCON_AXI_READ_ONLY).toBe('true')
  })

test('security prepared canaries reach only the trusted TLS fake through the real runner', async () => {
  await withFakeService(async ({ directory: certificates, port, send }) => {
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const prepared = await prepareFalcon(['detection', 'list'], configuration)
      const program = `
        const https = require('node:https'), fs = require('node:fs');
        const body = new URLSearchParams({ client_id: process.env.FALCON_AXI_CLIENT_ID, client_secret: process.env.FALCON_AXI_CLIENT_SECRET }).toString();
        const request = https.request({ hostname: 'localhost', port: ${port}, path: '/oauth2/token', method: 'POST',
          ca: fs.readFileSync(${JSON.stringify(join(certificates, 'ca.crt'))}), headers: { 'content-type': 'application/x-www-form-urlencoded' } }, response => {
          response.on('data', chunk => process.stdout.write(chunk));
        });
        request.on('error', () => process.exit(1)); request.end(body);
      `
      const result = await runner.run('synthetic-user', process.execPath, ['-e', program], prepared.environment, prepared.secrets)
      expect(result.exitCode).toBe(0)
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.requests).toEqual([{ method: 'POST', host: `localhost:${port}`, path: '/oauth2/token', canaryReceived: true }])
    } finally { await runner.shutdown() }
  })
})

test.each(['FALCON_AXI_CLIENT_ID', 'FALCON_AXI_CLIENT_SECRET'])('security the runner suppresses injected %s', async name => {
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const prepared = await prepareFalcon([], configuration)
    await expect(runner.run('synthetic-user', process.execPath, ['-e', `console.log(process.env.${name})`], prepared.environment, prepared.secrets))
      .rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
  } finally { await runner.shutdown() }
})
