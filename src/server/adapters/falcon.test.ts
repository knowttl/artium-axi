import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { withFakeService } from '../../../test/fake-service/fixture.js'
import { Runner } from '../runner/runner.js'
import { createFalconAdapter, falconManifest, falconWritePolicy, prepareFalcon } from './falcon.js'
import { CredentialProfile } from './credential-profile.js'
import { prepareRunJournal } from './run-journal.js'

let directory: string
let configuration: { clientIdFile: string, clientSecretFile: string, region: string, memberCid?: string }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artium-falcon-test-'))
  configuration = { clientIdFile: join(directory, 'client-id'), clientSecretFile: join(directory, 'client-secret'), region: 'us-2' }
  await writeFile(configuration.clientIdFile, 'CANARY-falcon-id\n', { mode: 0o600 })
  await writeFile(configuration.clientSecretFile, 'CANARY-falcon-secret\n', { mode: 0o600 })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

test.each([false, true].flatMap(managed => [
  { managed, settings: {}, malquery: 'true', rtr: 'true' },
  { managed, settings: { allowWrites: true }, malquery: 'true', rtr: 'false' },
  { managed, settings: { writes: { allowWrites: true, operations: ['malquery search'] } }, malquery: 'false', rtr: 'true' },
  { managed, settings: { writes: { allowWrites: true, operations: ['rtr run', 'malquery search'] } }, malquery: 'false', rtr: 'false' },
  { managed, settings: { writes: { allowWrites: false, operations: ['malquery search'] } }, malquery: 'true', rtr: 'true' },
]))('MalQuery capability stays independent of RTR with managed=$managed and settings=$settings', async ({ managed, settings, malquery, rtr }) => {
  const value = { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2', ...settings }
  const profile = managed ? new CredentialProfile({ type: 'object', additionalProperties: false,
    properties: { clientId: { type: 'string' }, clientSecret: { type: 'object', 'x-secret': true,
      properties: { env: { type: 'string' } }, required: ['env'] }, region: { type: 'string' } } }, 'falcon-axi') : undefined
  const adapter = createFalconAdapter({ getCredential: async () => value }, join(directory, 'writes.log'), profile)
  const reference = { id: 'synthetic', tool: 'falcon-axi' as const }
  const search = await adapter.prepare(['malquery', 'search', '--hex', '4d 5a', '--fuzzy'], reference)
  expect(search.environment.FALCON_AXI_READ_ONLY).toBe(malquery)
  expect(search.effect).toBe('write')
  expect((await adapter.prepare(['rtr', 'run'], reference)).environment.FALCON_AXI_READ_ONLY).toBe(rtr)
  expect((await adapter.prepare(['malquery', 'quota'], reference)).effect).toBe('read')
  if (managed) expect(JSON.parse(search.files[0].content as string).profiles.artium).not.toHaveProperty('writes')
})

test('Falcon write switch keeps MalQuery off for legacy RTR opt-ins and retains choices while disabled', () => {
  expect(falconWritePolicy.read({})).toMatchObject({ enabled: false, allowedOperations: [] })
  expect(falconWritePolicy.read({ allowWrites: true })).toMatchObject({ enabled: true,
    supportedOperations: ['rtr run', 'malquery search'], allowedOperations: ['rtr run'] })
  const enabled = falconWritePolicy.update({ rtr: { enabled: true } }, { enabled: true, operations: ['malquery search'], expectedRevision: 1 })
  expect(enabled).toEqual({ rtr: { enabled: true }, writes: { allowWrites: true, operations: ['malquery search'] } })
  const disabled = falconWritePolicy.update(enabled, { enabled: false, expectedRevision: 2 })
  expect(falconWritePolicy.read(disabled)).toMatchObject({ enabled: false, allowedOperations: ['malquery search'] })
  expect(falconWritePolicy.read(falconWritePolicy.update(disabled, { enabled: true, expectedRevision: 3 })))
    .toMatchObject({ enabled: true, allowedOperations: ['malquery search'] })
  expect(() => falconWritePolicy.update({}, { enabled: true, operations: ['hunt'], expectedRevision: 1 })).toThrow()
  expect(falconWritePolicy.read(falconWritePolicy.update(disabled, { enabled: false, operations: [], expectedRevision: 3 })))
    .toMatchObject({ enabled: false, allowedOperations: [] })
})

test('MalQuery submissions without native journal evidence are never reported as reads', async () => {
  const journal = await prepareRunJournal({ FALCON_AXI_WRITE_LOG: join(directory, 'writes.log') }, 'falcon-axi', 'write')
  expect(await journal.action(true)).toBe('unknown')
})

test.each([false, true])('RTR profile opt-in and command narrowing remain independent of execute permission %s', async allowWrites => {
  const credential = { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-2',
    allowWrites, rtr: { enabled: true, commands: ['ps'] } }
  const args = ['rtr', 'run', 'a'.repeat(32), '--command', 'ps', '--execute', '--confirm', `${'a'.repeat(32)}:ps`]
  const prepared = await createFalconAdapter({ getCredential: async () => credential }, join(directory, 'writes.log'))
    .prepare(args, { id: 'synthetic', tool: 'falcon-axi' })
  expect(prepared.environment.FALCON_AXI_READ_ONLY).toBe(String(!allowWrites))
  expect(prepared.environment.FALCON_AXI_CLIENT_ID).toBeUndefined()
  expect(prepared.environment.FALCON_AXI_CLIENT_SECRET).toBeUndefined()
  expect(prepared.environment.ARTIUM_SECRET_0).toBe(credential.clientSecret)
  expect(prepared.args).toEqual([...args, '--region', 'us-2'])
  expect(JSON.parse(prepared.files[0].content as string).profiles.artium).toEqual({ clientId: credential.clientId,
    clientSecret: { env: 'ARTIUM_SECRET_0' }, region: 'us-2', rtr: credential.rtr })
  expect(prepared.effect).toBe('write')
})

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
  const args = ['search', 'start', '--query', 'synthetic | text --region=literal', '--repository=synthetic', '--since', '24h', '--wait', '30']
  const result = await prepareFalcon(args, { ...configuration, memberCid })
  expect(result).toEqual({
    executable: '/opt/falcon-axi/bin/falcon-axi',
    invocation: { command: 'search start', help: false },
    args: [...args, '--region', 'us-2', ...(memberCid ? ['--member-cid', memberCid] : [])],
    environment: { FALCON_AXI_CLIENT_ID: 'CANARY-falcon-id', FALCON_AXI_CLIENT_SECRET: 'CANARY-falcon-secret', FALCON_AXI_READ_ONLY: 'true' },
    secrets: ['CANARY-falcon-id', 'CANARY-falcon-secret'], limits: { runtime: 'python', timeoutMs: 65_000, terminationGraceMs: 12_000 },
  })
})

test('managed Falcon profiles preserve the session cleanup grace period', async () => {
  const profile = new CredentialProfile({ type: 'object', properties: { region: { type: 'string' } } }, 'falcon-axi')
  const prepared = await createFalconAdapter({ getCredential: async () => ({ region: 'us-2' }) }, join(directory, 'writes.log'), profile)
    .prepare(['rtr', 'run'], { id: 'synthetic', tool: 'falcon-axi' })
  expect(prepared.limits).toEqual({ runtime: 'python', timeoutMs: 65_000, terminationGraceMs: 12_000 })
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

test.each(['login list', 'account list', 'cloud-asset list', 'identity rule list', 'detection process',
  'process show', 'process tree', 'sandbox list', 'sandbox show', 'file-change list', 'file-change show', 'policy show', 'malquery show', 'malquery quota', 'malquery status'])
  ('new read command %s keeps managed credentials and investigation operations enabled', async command => {
    const prepared = await prepareFalcon(command.split(' '), configuration)
    expect(prepared.args).toEqual([...command.split(' '), '--region', 'us-2'])
    expect(prepared.environment.FALCON_AXI_READ_ONLY).toBe('true')
  })

test.each(['detection', 'host', 'search', 'identity rule'])('%s group help stays terminal for the pinned parser', async group => {
  const args = [...group.split(' '), '--help']
  expect((await prepareFalcon(args, { ...configuration, memberCid: 'synthetic-member' })).args).toEqual(args)
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
