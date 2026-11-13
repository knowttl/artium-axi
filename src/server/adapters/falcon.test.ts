import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { withFakeService } from '../../../test/fake-service/fixture.js'
import { Runner } from '../runner/runner.js'
import type { RunnerInput } from '../runner/input.js'
import { createFalconAdapter, falconManifest, falconWritePolicy, prepareFalcon } from './falcon.js'
import { CredentialProfile } from './credential-profile.js'
import { prepareRunJournal } from './run-journal.js'
import { toolPaths } from '../config.js'

let directory: string
let configuration: { clientIdFile: string, clientSecretFile: string, region: string, memberCid?: string }
const writeCalls = [
  ['search', 'start', '--query', 'synthetic'], ['search', 'stop', 'synthetic-search'],
  ['host', 'usb', 'a'.repeat(32)], ['identity', 'activity', 'a'.repeat(32)], ['malquery', 'search', '--string', 'synthetic'],
  ['rtr', 'run', 'a'.repeat(32), '--command', 'ps', '--execute', '--confirm', `${'a'.repeat(32)}:ps`],
]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artium-falcon-test-'))
  configuration = { clientIdFile: join(directory, 'client-id'), clientSecretFile: join(directory, 'client-secret'), region: 'us-2' }
  await writeFile(configuration.clientIdFile, 'CANARY-falcon-id\n', { mode: 0o600 })
  await writeFile(configuration.clientSecretFile, 'CANARY-falcon-secret\n', { mode: 0o600 })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

test.each([false, true].flatMap(managed => [
  { managed, settings: {} },
  { managed, settings: { allowWrites: true } },
  { managed, settings: { writes: { allowWrites: true, operations: ['malquery search'] } } },
  { managed, settings: { writes: { allowWrites: true, operations: ['rtr run', 'malquery search'] } } },
  { managed, settings: { writes: { allowWrites: false, operations: ['malquery search'] } } },
]))('passive admission stays read-only with managed=$managed and settings=$settings', async ({ managed, settings }) => {
  const value = { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2', ...settings }
  const profile = managed ? new CredentialProfile({ type: 'object', additionalProperties: false,
    properties: { clientId: { type: 'string' }, clientSecret: { type: 'object', 'x-secret': true,
      properties: { env: { type: 'string' } }, required: ['env'] }, region: { type: 'string' } } }, 'falcon-axi') : undefined
  const adapter = createFalconAdapter({ getCredential: async () => value }, join(directory, 'writes.log'), profile)
  const reference = { id: 'synthetic', tool: 'falcon-axi' as const }
  const quota = await adapter.prepare(['malquery', 'quota'], reference)
  expect(quota.environment.FALCON_AXI_READ_ONLY).toBe('true')
  expect(quota.effect).toBe('read')
  expect(JSON.parse(quota.files[0].content as string).profiles.artium).not.toHaveProperty('writes')
  for (const args of writeCalls) {
    await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  }
})

test.each(writeCalls.map(args => ({ args })))('security refuses an ungranted write $args before retrieving credentials', async ({ args }) => {
  const getCredential = vi.fn()
  await expect(createFalconAdapter({ getCredential }).prepare(args, { id: 'synthetic', tool: 'falcon-axi' }))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(writeCalls.map(args => ({ args })))('the exact Falcon grant enables native execution for $args', async ({ args }) => {
  const operation = args.slice(0, 2).join(' ')
  const adapter = createFalconAdapter({ getSettings: () => ({ writes: { allowWrites: true, operations: [operation] } }),
    getCredential: async () => ({ clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2', rtr: { enabled: true, commands: ['ps'] } }) },
  join(directory, 'writes.log'))
  const call = await adapter.prepare(args, { id: 'synthetic', tool: 'falcon-axi', revision: 1 })
  expect(call.environment.FALCON_AXI_READ_ONLY).toBe('false')
  expect(call.effect).toBe('write')
  expect(call.args.slice(1)).toEqual(args)
})

const rawGrant = { writes: { allowWrites: true, operations: ['raw write'] } }
const rawCredential = { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }
const rawAdapter = (settings: Record<string, unknown> = {}) => createFalconAdapter({ getSettings: () => settings,
  getCredential: async () => rawCredential }, join(directory, 'writes.log'))
const synthetic = { id: 'synthetic', tool: 'falcon-axi' as const, revision: 1 }
const nativeWrites = (call: { files: { content: string | Uint8Array }[] }) => JSON.parse(call.files[0].content as string).profiles.artium.writes

test('raw get is a read that never carries the raw-write profile opt-in', async () => {
  const call = await rawAdapter(rawGrant).prepare(['raw', 'get', '--path', '/synthetic/v1', '--query', 'limit=5'], synthetic)
  expect(call).toMatchObject({ invocation: { command: 'raw get', help: false }, effect: 'read', environment: { FALCON_AXI_READ_ONLY: 'true' } })
  expect(nativeWrites(call)).toBeUndefined()
})

test.each([
  { args: ['--method', 'POST', '--path', '/synthetic/v1'], effect: 'read', readOnly: 'true' },
  { args: ['--method', 'POST', '--path', '/synthetic/v1', '--execute', '--confirm', 'synthetic'], effect: 'write', readOnly: 'false' },
])('raw write $args requires the exact grant and carries the native opt-in', async ({ args, effect, readOnly }) => {
  await expect(rawAdapter().prepare(['raw', 'write', ...args], synthetic)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  await expect(rawAdapter({ writes: { allowWrites: true, operations: ['rtr run'] } }).prepare(['raw', 'write', ...args], synthetic)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  const call = await rawAdapter(rawGrant).prepare(['raw', 'write', ...args], synthetic)
  expect(call).toMatchObject({ effect, environment: { FALCON_AXI_READ_ONLY: readOnly } })
  expect(nativeWrites(call)).toEqual({ allowWrites: true, operations: ['raw-write'] })
})

test('raw files are uploaded leaves or the single explicit stdin and nothing else', async () => {
  const adapter = rawAdapter(rawGrant)
  const file = { name: 'body.json', contentBase64: Buffer.from('{}').toString('base64') }
  const write = ['raw', 'write', '--method', 'POST', '--path', '/synthetic/v1']
  const uploaded = await adapter.prepare([...write, '--body-file=body.json'], synthetic, { files: [file] })
  expect(uploaded.args.slice(1)).toEqual([...write, '--body-file', 'body.json'])
  expect(uploaded.fileArguments?.map(index => uploaded.args[index])).toEqual(['body.json'])
  const stdin = await adapter.prepare([...write, '--body-file', '-'], synthetic, { stdin: '{}' })
  expect(stdin.fileArguments).toEqual([])
  for (const [args, input] of [
    [[...write, '--body-file', '/tmp/body.json'], {}],
    [[...write, '--body-file', '-'], {}],
    [write, { stdin: '{}' }],
    [write, { files: [file] }],
    [[...write, '--body-file', 'body.json'], { files: [file], stdin: '{}' }],
  ] satisfies [string[], RunnerInput][]) await expect(adapter.prepare(args, synthetic, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test('the pinned CLI previews a raw write from an uploaded body through the injected profile opt-in', async () => {
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const input = { files: [{ name: 'body.json', contentBase64: Buffer.from('{"synthetic":true}').toString('base64') }] }
    const call = await rawAdapter(rawGrant).prepare(['raw', 'write', '--method', 'POST', '--path', '/synthetic/v1', '--body-file', 'body.json'], synthetic, input)
    const args = [join(process.cwd(), 'tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/bin.js'), ...call.args.slice(1)]
    const result = await runner.run('synthetic-user', call.executable, args, call.environment, call.secrets, call.limits,
      { ...input, fileArguments: call.fileArguments }, call.files)
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/preview:[\s\S]*method: POST[\s\S]*body_bytes: 18/)
  } finally { await runner.shutdown() }
})

test('falcon binds the credential id and revision for reads and raw writes', async () => {
  for (const args of [['raw', 'get', '--path', '/synthetic/v1'], ['raw', 'write', '--method', 'POST', '--path', '/synthetic/v1']]) {
    const call = await rawAdapter(rawGrant).prepare(args, { ...synthetic, revision: 7 })
    expect(call.environment.FALCON_AXI_CREDENTIAL_REVISION).toBe('synthetic:7')
  }
})

test('the pinned CLI refuses a raw write confirmation previewed under another credential instance', async () => {
  const runner = await Runner.create(join(directory, 'calls'))
  const input = { files: [{ name: 'body.json', contentBase64: Buffer.from('{"synthetic":true}').toString('base64') }] }
  const write = ['raw', 'write', '--method', 'POST', '--path', '/synthetic/v1', '--body-file', 'body.json']
  const cli = join(process.cwd(), 'tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/bin.js')
  const run = async (args: string[], instance: typeof synthetic) => {
    const call = await rawAdapter(rawGrant).prepare(args, instance, input)
    return runner.run('synthetic-user', call.executable, [cli, ...call.args.slice(1)], call.environment, call.secrets, call.limits,
      { ...input, fileArguments: call.fileArguments }, call.files)
  }
  try {
    const preview = await run(write, synthetic)
    const confirm = /confirm: (.+)/.exec(preview.stdout)![1].replace(/^"|"$/g, '')
    const other = await run([...write, '--execute', '--confirm', confirm], { ...synthetic, id: 'other-falcon' })
    expect(other.exitCode).not.toBe(0)
    expect(other.stdout + other.stderr).toContain('CREDENTIAL_CHANGED')
  } finally { await runner.shutdown() }
})

test('Falcon write switch keeps MalQuery off for legacy RTR opt-ins and retains choices while disabled', () => {
  expect(falconWritePolicy.read({})).toMatchObject({ enabled: false, allowedOperations: [] })
  expect(falconWritePolicy.read({ allowWrites: true })).toMatchObject({ capable: true, enabled: true, allowedOperations: ['rtr run'] })
  const settings = { rtr: { enabled: true }, writes: { allowWrites: true, operations: ['malquery search'] } }
  expect(falconWritePolicy.read(settings)).toMatchObject({ capable: true, enabled: true, allowedOperations: ['malquery search'] })
  expect(falconWritePolicy.update(settings, { enabled: false, expectedRevision: 1 })).toEqual({ rtr: { enabled: true },
    writes: { allowWrites: false, operations: ['malquery search'] } })
  expect(settings.writes).toEqual({ allowWrites: true, operations: ['malquery search'] })
})

test('MalQuery submissions without native journal evidence are never reported as reads', async () => {
  const journal = await prepareRunJournal({ FALCON_AXI_WRITE_LOG: join(directory, 'writes.log') }, 'falcon-axi', 'write')
  expect(await journal.action(true)).toBe('unknown')
})

test.each([false, true])('RTR profile opt-in and command narrowing remain independent of execute permission %s', async allowWrites => {
  const credential = { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-2',
    allowWrites, rtr: { enabled: true, commands: ['ps'] } }
  const args = ['rtr', 'run', 'a'.repeat(32), '--command', 'ps', '--execute', '--confirm', `${'a'.repeat(32)}:ps`]
  const getCredential = vi.fn(async () => credential)
  await expect(createFalconAdapter({ getCredential }, join(directory, 'writes.log'))
    .prepare(args, { id: 'synthetic', tool: 'falcon-axi' })).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
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
  const args = ['search', 'status', 'synthetic-search', '--repository=synthetic', '--wait', '30']
  const result = await prepareFalcon(args, { ...configuration, memberCid })
  expect(result).toMatchObject({
    executable: process.execPath, invocation: { command: 'search status', help: false },
    args: [toolPaths['falcon-axi'], ...args], effect: 'read',
    environment: { ARTIUM_SECRET_0: 'CANARY-falcon-secret', FALCON_AXI_READ_ONLY: 'true' },
    limits: { timeoutMs: 65_000, terminationGraceMs: 12_000 },
  })
  expect(result.limits).not.toHaveProperty('runtime')
  expect(JSON.parse(result.files[0].content as string).profiles.artium).toEqual({ clientId: 'CANARY-falcon-id',
    clientSecret: { env: 'ARTIUM_SECRET_0' }, region: 'us-2', ...(memberCid ? { memberCid } : {}) })
})

test('managed Falcon profiles preserve the session cleanup grace period', async () => {
  const prepared = await prepareFalcon(['rtr', 'session', 'list'], configuration)
  expect(prepared.limits).toEqual({ timeoutMs: 65_000, terminationGraceMs: 12_000 })
})

test.each([
  ['--sha256', 'a'.repeat(64)], ['--sha256=' + 'a'.repeat(64)],
])('sandbox SHA-256 selector %j survives both preparation paths (R1)', async (...selector) => {
  const args = ['sandbox', 'list', ...selector]
  const adapter = createFalconAdapter({ getCredential: async () => ({ clientId: 'CANARY-falcon-id',
    clientSecret: 'CANARY-falcon-secret', region: 'us-2' }) })
  expect((await adapter.prepare(args, { id: 'synthetic', tool: 'falcon-axi' })).args)
    .toEqual([toolPaths['falcon-axi'], ...args])
  expect((await prepareFalcon(args, configuration)).args).toEqual([toolPaths['falcon-axi'], ...args])
})

test.each([
  ['--sha256', 'a'.repeat(64)], ['--sha256=' + 'a'.repeat(64)],
])('SHA-256 selector %j remains restricted to declaring commands (R1)', async (...selector) => {
  const getCredential = vi.fn()
  await expect(createFalconAdapter({ getCredential }).prepare(['detection', 'list', ...selector],
    { id: 'synthetic', tool: 'falcon-axi' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
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

test('native help remains available and unknown options are refused before credential access', async () => {
  expect((await prepareFalcon(['host', 'list', '--help'], configuration)).args)
    .toEqual([toolPaths['falcon-axi'], 'host', 'list', '--help'])
  await expect(prepareFalcon(['detection', 'list', '-r', 'us-1', '--synthetic'], configuration))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(falconManifest.parser.aliases).toEqual({})
  expect(falconManifest.parser.shortFlags).toEqual({})
})

test.each(['login list', 'account list', 'cloud-asset list', 'identity rule list', 'detection process synthetic-detection',
  'process show pid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:123', 'process tree pid:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:123',
  'sandbox list', 'sandbox show synthetic-report', 'file-change list', 'file-change show synthetic-change',
  'policy show synthetic-policy', 'malquery show aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'malquery quota', 'malquery status synthetic-search', 'identity list', 'identity show aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'identity timeline aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'identity assessment'])
  ('new read command %s keeps managed credentials and investigation operations enabled', async command => {
    const args = command.split(' ')
    const prepared = await prepareFalcon(args, configuration)
    expect(prepared.args).toEqual([toolPaths['falcon-axi'], ...args])
    expect(prepared.environment.FALCON_AXI_READ_ONLY).toBe('true')
  })

test.each(['detection', 'host', 'search', 'identity rule'])('%s group help stays terminal for the pinned parser', async group => {
  const args = [...group.split(' '), '--help']
  expect((await prepareFalcon(args, { ...configuration, memberCid: 'synthetic-member' })).args).toEqual([toolPaths['falcon-axi'], ...args])
})

test('security prepared canaries reach only the trusted TLS fake through the real runner', async () => {
  await withFakeService(async ({ directory: certificates, port, send }) => {
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const prepared = await prepareFalcon(['detection', 'list'], configuration)
      const program = `
        const https = require('node:https'), fs = require('node:fs');
        const body = new URLSearchParams({ client_id: 'CANARY-falcon-id', client_secret: process.env.ARTIUM_SECRET_0 }).toString();
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

test.each(['ARTIUM_SECRET_0'])('security the runner suppresses injected %s', async name => {
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const prepared = await prepareFalcon([], configuration)
    await expect(runner.run('synthetic-user', process.execPath, ['-e', `console.log(process.env.${name})`], prepared.environment, prepared.secrets))
      .rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
  } finally { await runner.shutdown() }
})
