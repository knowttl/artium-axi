import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
import { Client } from '../../src/cli/http.js'
import { toolInput } from '../../src/cli/input.js'
import { inputLimits, runSuccessSchema } from '../../src/shared/api.js'
import { createApp } from '../../src/server/app.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'

describe.each(['vectra-axi', 'awx-axi'] as const)('%s private file channel', tool => {
let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let runner: Runner
let client: Client
let token: string
let outcome: string
let terminal: Promise<string>
const content = tool === 'awx-axi' ? Buffer.from('{"password":"CANARY-file-secret","key":"é"}\r\n') : Buffer.from([0, 255, 1, 2, 195, 169])
const route = `/v1/tools/${tool}/run`

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-file-input-'))
  db = openStore(join(directory, 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  await seedToolUser(db)
  db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
  token = issueTestAccessToken(db, 'synthetic-development-user')
  runner = await Runner.create(join(directory, 'calls'))
  const adapter = tool === 'awx-axi' ? createAwxAdapter({ getCredential: async () => ({ origin: 'https://synthetic.invalid', token: 'CANARY-awx-token', allowWrites: true }) })
    : createVectraAdapter({ getCredential: async () => ({ kind: 'qux', apiVersion: '2.5', auth: 'token',
    token: 'CANARY-vectra-token', origin: 'https://synthetic.invalid' }) }, join(directory, 'writes.log'))
  const prepare = adapter.prepare.bind(adapter)
  // Replace only the external executable with the existing offline probe.
  const execution = { ...adapter, prepare: async (...args: Parameters<typeof prepare>) => {
    const call = await prepare(...args)
    return { ...call, executable: fakeTool.executable, args: [...fakeTool.args, outcome === 'args' ? 'awx-args' : tool === 'awx-axi' ? 'awx-input' : 'input-file', ...call.args],
      fileArguments: call.fileArguments?.map(index => index + fakeTool.args.length + 1),
      environment: { ...call.environment, ARTIUM_TEST_READY_FILE: join(directory, 'ready.json'), ARTIUM_TEST_INPUT_OUTCOME: outcome } }
  } }
  let completed!: (outcome: string) => void
  terminal = new Promise(resolve => { completed = resolve })
  const audit = new Audit(db, Date.now, line => {
    const record = JSON.parse(line)
    if (record.event === 'run-terminal') completed(record.outcome)
  })
  app = createApp({ db, runner, audit, environment: {}, adapters: [execution],
    resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference: { id: 'synthetic-credential', tool }, value: {} }]).seed(db)) })
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  client = new Client({ ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory })
  writeFileSync(join(directory, 'report.txt'), content)
  outcome = 'success'
})

afterEach(async () => {
  await runner.shutdown()
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const upload = () => toolInput(tool, tool === 'awx-axi'
  ? ['credential', 'edit', '42', '--inputs-file', join(directory, 'report.txt'), '--dry-run']
  : ['detection', 'note', 'add', '--id', '123', '--note-file', join(directory, 'report.txt')])

test.each([{ result: 'success', exitCode: 0 }, { result: 'error', exitCode: 7 }])('TD-066 transports file bytes privately and removes them after $result', async ({ result, exitCode }) => {
  outcome = result
  const request = await upload()
  expect(request.files).toEqual([{ name: 'report.txt', size: content.length, contentBase64: content.toString('base64') }])
  const response = runSuccessSchema.parse(await client.request(route, 'POST', request, token))
  expect(response.exitCode).toBe(exitCode)
  const received = tool === 'awx-axi' ? decode(response.stdout) as Record<string, any> : JSON.parse(response.stdout)
  expect(received).toEqual({ path: expect.stringMatching(/\/artium-call-[^/]+\/tmp\/inputs\/report.txt$/),
    ...(tool === 'awx-axi' ? { argv: expect.any(Array), sha256: createHash('sha256').update(content).digest('hex') }
      : { contentBase64: content.toString('base64') }), mode: 0o600, directoryMode: 0o700 })
  expect(response.stdout).not.toContain('CANARY-')
  expect(existsSync(received.path)).toBe(false)
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
  const record = db.prepare("SELECT user_id, tool, arguments FROM audit WHERE event = 'upload'").get() as { arguments: string }
  expect(record).toEqual({ user_id: 'synthetic-development-user', tool, arguments: expect.any(String) })
  expect(JSON.parse(record.arguments)).toEqual({ command: tool === 'awx-axi' ? ['credential', 'edit', '[redacted]', '[redacted]', '[redacted]', '[redacted]'] : request.args,
    file: { name: 'report.txt', size: content.length, sha256: createHash('sha256').update(content).digest('hex') } })
  expect(record.arguments).not.toContain(content.toString('base64'))
})

test('TD-066 removes an uploaded file after cancellation', async () => {
  outcome = 'cancel'
  const watcher = watch(directory)
  try {
    const ready = new Promise<void>(resolve => {
      watcher.on('change', (_, name) => { if (name === 'ready.json') resolve() })
    })
    const pending = client.request(route, 'POST', await upload(), token)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SERVER_UNAVAILABLE' })
    await ready
    const received = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'))
    expect(readFileSync(received.path)).toEqual(content)
    client.cancel()
    await rejected
    expect(await terminal).toBe('CANCELLED')
    expect(existsSync(received.path)).toBe(false)
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { watcher.close() }
})

test('TD-066 refuses over-cap bytes on the client and server before the tool runs', async () => {
  writeFileSync(join(directory, 'report.txt'), Buffer.alloc(inputLimits.fileBytes + 1))
  await expect(upload()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(client.request(route, 'POST', { args: ['detection', 'note', 'add', '--note-file', 'report.txt'],
    files: [{ name: 'report.txt', contentBase64: Buffer.alloc(inputLimits.fileBytes + 1).toString('base64') }] }, token))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(existsSync(join(directory, 'ready.json'))).toBe(false)
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
})

test('TD-066 refuses a declared size that differs from the uploaded bytes', async () => {
  const request = await upload()
  await expect(client.request(route, 'POST', { ...request,
    files: [{ name: 'report.txt', size: 1, contentBase64: content.toString('base64') }] }, token))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(existsSync(join(directory, 'ready.json'))).toBe(false)
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
})

test.each([
  ['detection', 'list'],
  ['detection', 'note', 'add', '--note-file', 'different.txt'],
])('TD-066 refuses uploads to a command without a matching declaration: %j', async (...args) => {
  const request = await upload()
  await expect(client.request(route, 'POST', { ...request, args }, token)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  expect(existsSync(join(directory, 'ready.json'))).toBe(false)
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
})

if (tool === 'awx-axi') test('scanner rejects an individual credential field leaked by the child', async () => {
  outcome = 'leak'
  await expect(client.request(route, 'POST', await upload(), token)).rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-file-secret')
})

if (tool === 'awx-axi') test('structured values stay out of the child process arguments', async () => {
  outcome = 'args'
  const result = runSuccessSchema.parse(await client.request(route, 'POST', {
    args: ['inventory', 'host-create', 'synthetic-host', '--variables', '{"password":"CANARY-inline-secret"}', '--dry-run'],
  }, token))
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('--variables=private-input')
  expect(result.stdout).not.toContain('CANARY-inline-secret')
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-inline-secret')
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
})
})
