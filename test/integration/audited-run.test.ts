import * as childProcess from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createGhAdapter } from '../../src/server/adapters/gh.js'
import { createMgAdapter } from '../../src/server/adapters/mg.js'
import { loadCredentialProfile } from '../../src/server/adapters/credential-profile.js'
import { decode } from '@toon-format/toon'
import type { Adapter } from '../../src/server/adapters/types.js'
import { Audit } from '../../src/server/audit/audit.js'
import type { AuditRecord } from '../../src/server/audit/audit.js'
import { LocalAuthProvider } from '../../src/server/auth/local.js'
import { issueLoginTokens } from '../../src/server/auth/tokens.js'
import { tokenDefaults } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { runTool } from '../../src/server/runner/run.js'
import { Runner, RunnerError } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { issueTestAccessToken } from '../fixtures/tokens.js'
import { fakeTool } from '../fake-tool/tool.js'

vi.mock('node:fs/promises', { spy: true })
vi.mock('node:child_process', { spy: true })

const actualFilesystem = await vi.importActual<typeof filesystem>('node:fs/promises')

let directory: string
let db: Database.Database
let audit: Audit
let runner: Runner
let token: string
let lines: string[]
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const getCredential = vi.fn(async () => ({ clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }))
const adapter = createFalconAdapter({ getCredential })
const resolver = new SharedIdentityResolver(new FakeCredentialStore([
  { reference: { id: 'synthetic-credential', tool: 'falcon-axi' }, value: {} },
]))
const context = { requestId: 'synthetic-run', clientAddress: '192.0.2.1' }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-audited-run-'))
  db = openStore(join(directory, 'artium.db'), provider)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash)
      VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
    UPDATE tools SET enabled = 1, pinned_version = '0.6.0' WHERE name = 'falcon-axi';
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
    INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'falcon-axi');`)
  token = issueTestAccessToken(db, 'synthetic-user')
  lines = []
  audit = new Audit(db, Date.now, line => { lines.push(line) })
  runner = await Runner.create(join(directory, 'calls'))
  getCredential.mockClear()
  // Substitute only the external executable boundary, retaining real adapter credential preparation.
  const prepare = adapter.prepare.bind(adapter)
  vi.spyOn(adapter, 'prepare').mockImplementation(async (args, reference) => {
    const call = await prepare(args, reference)
    return { ...call, executable: fakeTool.executable, args: [...fakeTool.args, ...args],
      limits: { timeoutMs: 5000 }, environment: { ...call.environment, ARTIUM_TEST_CANARY: 'CANARY-secret' } }
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await runner.shutdown()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('a run persists a start before secret retrieval and a paired terminal before returning', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  getCredential.mockImplementationOnce(async () => {
    expect(db.prepare('SELECT event FROM audit').all()).toEqual([{ event: 'run-start' }])
    return { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }
  })
  const result = await runTool(db, audit, runner, token, { args: ['exit', '7'],
    stdin: 'CANARY-body', files: [{ name: 'synthetic-input', contentBase64: Buffer.from('CANARY-file').toString('base64') }] }, adapter, resolver, context)
  expect(result).toMatchObject({ stdout: '', stderr: '', exitCode: 7 })
  db.close()
  db = openStore(join(directory, 'artium.db'), provider)
  const records = db.prepare('SELECT * FROM audit ORDER BY id').all() as AuditRecord[]
  expect(records).toEqual([
    expect.objectContaining({ event: 'run-start', user_id: 'synthetic-user', tool: 'falcon-axi', request_id: context.requestId, outcome: 'started', client_address: context.clientAddress }),
    expect.objectContaining({ event: 'run-terminal', request_id: context.requestId, action: 'read', outcome: 'completed', exit_code: 7, stdout_bytes: result.outputBytes.stdout, stderr_bytes: result.outputBytes.stderr }),
  ])
  expect(lines.map(line => JSON.parse(line))).toEqual(records)
  expect(lines.join('')).not.toMatch(/CANARY-body|CANARY-file|CANARY-secret|CANARY-client/)
  expect(records[1].arguments).toBeNull()
  expect(stderr.mock.calls).toHaveLength(1)
  expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual({
    ts: expect.any(String), level: 'warn', event: 'run', requestId: context.requestId,
    tool: 'falcon-axi', outcome: 'completed', exitCode: 7, errorCode: null,
    durationMs: result.durationMs, stdoutBytes: 0, stderrBytes: 0, truncated: false,
  })
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('CANARY')
})

test('successful calls emit one correlated operational line without tool output', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await runTool(db, audit, runner, token, { args: ['print', 'CANARY-private-output'] }, adapter, resolver, context)
  expect(stderr.mock.calls).toHaveLength(1)
  expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
    level: 'info', event: 'run', requestId: context.requestId, outcome: 'completed', exitCode: 0,
  })
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('CANARY')
})

test('unexpected preparation failure emits one safe operational line', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  getCredential.mockRejectedValueOnce(new Error('CANARY-private-error'))
  await expect(runTool(db, audit, runner, token, { args: ['print', 'CANARY-argument'] }, adapter, resolver, context))
    .rejects.toThrow('CANARY-private-error')
  expect(stderr.mock.calls).toHaveLength(1)
  expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
    event: 'run', requestId: context.requestId, outcome: 'INTERNAL_ERROR', exitCode: null,
  })
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('CANARY')
})

test('a failed run records only the bounded tool failure code', async () => {
  const result = await runTool(db, audit, runner, token, { args: ['tool-failure', 'PERMISSION_DENIED'] }, adapter, resolver, context)
  expect(result).toMatchObject({ exitCode: 1 })
  expect(db.prepare("SELECT * FROM audit WHERE event = 'run-terminal'").get())
    .toMatchObject({ outcome: 'completed', exit_code: 1, error_code: 'PERMISSION_DENIED' })
  const persisted = JSON.stringify(db.prepare('SELECT * FROM audit').all())
  expect(persisted).not.toContain('CANARY-')
  expect(lines.join('')).not.toContain('CANARY-')
  expect(lines.join('')).toContain('PERMISSION_DENIED')
})

test('a failed run without a recognizable code records no error code but keeps the exit code', async () => {
  const result = await runTool(db, audit, runner, token, { args: ['tool-failure'] }, adapter, resolver, context)
  expect(result).toMatchObject({ exitCode: 1 })
  expect(db.prepare("SELECT * FROM audit WHERE event = 'run-terminal'").get())
    .toMatchObject({ outcome: 'completed', exit_code: 1, error_code: null })
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
  expect(lines.join('')).not.toContain('CANARY-')
})

test('a successful run leaves error_code empty', async () => {
  await runTool(db, audit, runner, token, { args: ['exit', '0'] }, adapter, resolver, context)
  expect(db.prepare("SELECT * FROM audit WHERE event = 'run-terminal'").get())
    .toMatchObject({ exit_code: 0, error_code: null })
})

test.each([
  ['AZ_AXI_WRITE_LOG', 'write', 'write', 'read'],
  ['MG_AXI_WRITE_LOG', 'write', 'write', 'read'],
  ['VECTRA_AXI_WRITE_LOG', 'write', 'write', 'read'],
  ['VECTRA_AXI_WRITE_LOG', 'read', 'read', 'read'],
  ['FALCON_AXI_WRITE_LOG', 'read', 'read', 'read'],
])('run action follows its own %s journal for %s activity', async (variable, activity, action, readAction) => {
  const execution = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
    const prepared = await adapter.prepare(...input)
    return { ...prepared, args: [...fakeTool.args, 'native-journal', input[0][0]],
      environment: { ...prepared.environment, [variable]: join(directory, 'writes.log') } }
  } }
  await Promise.all([
    runTool(db, audit, runner, token, { args: [activity] }, execution, resolver, context),
    runTool(db, audit, runner, token, { args: ['read'] }, execution, resolver, { ...context, requestId: 'concurrent-read' }),
  ])
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' AND request_id = ?").get(context.requestId)).toEqual({ action })
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal' AND request_id = 'concurrent-read'").get())
    .toEqual({ action: readAction })
})

test.each([
  ['UPDATE users SET disabled = 1', 'USER_DISABLED'],
  ['UPDATE tools SET enabled = 0', 'TOOL_DISABLED'],
  ['DELETE FROM role_tools', 'TOOL_NOT_GRANTED'],
  ['UPDATE tokens SET revoked_at = 1', 'TOKEN_INVALID'],
])('a denial is audited before any credential retrieval: %s', async (sql, code) => {
  db.exec(sql)
  await expect(runTool(db, audit, runner, token, { args: ['print', 'unused'] }, adapter, resolver, context)).rejects.toMatchObject({ code })
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare('SELECT event, outcome, request_id FROM audit').all()).toEqual([{ event: 'denial', outcome: code, request_id: context.requestId }])
})

test.each([
  ['valid', (): string => token, 'TOOL_DISABLED', 'synthetic-user'],
  ['invalid', (): string => 'CANARY-invalid-token', 'TOKEN_INVALID', null],
] as const)('an unconfigured supported tool records the denial for a %s token', async (_kind, requestToken, code, userId) => {
  db.exec("DELETE FROM role_tools; DELETE FROM tools WHERE name = 'falcon-axi'")
  db.close()
  db = openStore(join(directory, 'artium.db'), provider)
  audit = new Audit(db, Date.now, line => { lines.push(line) })
  const run = vi.spyOn(runner, 'run')
  await expect(runTool(db, audit, runner, requestToken(),
    { args: ['exit', '0'] }, adapter, resolver, context)).rejects.toMatchObject({ code })
  expect(getCredential).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(db.prepare('SELECT event, outcome, user_id, tool, request_id FROM audit').all()).toEqual([
    { event: 'denial', outcome: code, user_id: userId, tool: 'falcon-axi', request_id: context.requestId },
  ])
  expect(lines.map(line => JSON.parse(line))).toEqual(db.prepare('SELECT * FROM audit').all())
})

test.each([
  [{ args: ['--region=CANARY-override'] }, 'FLAG_BLOCKED'],
  [{ args: ['print'], stdin: 'CANARY-input', extra: true }, 'INVALID_INPUT'],
])('invalid or blocked input has a safe denial without a stored body', async (request, code) => {
  await expect(runTool(db, audit, runner, token, request, adapter, resolver, context)).rejects.toMatchObject({ code })
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare('SELECT event, outcome, arguments FROM audit').all()).toEqual([{ event: 'denial', outcome: code, arguments: null }])
  expect(lines.join('')).not.toContain('CANARY-')
})

test('SQLite disk-full failure prevents admission, secret retrieval and child creation', async () => {
  const run = vi.spyOn(runner, 'run')
  const pages = db.pragma('page_count', { simple: true }) as number
  db.pragma(`max_page_count = ${pages}`)
  expect(() => db.prepare("INSERT INTO audit (occurred_at, event, arguments, outcome) VALUES (1, 'sign-in', ?, 'failure')")
    .run('x'.repeat(100_000))).toThrow(expect.objectContaining({ code: 'SQLITE_FULL' }))
  await expect(runTool(db, audit, runner, token, { args: Array<string>(64).fill('x'.repeat(4096)) }, adapter, resolver, context))
    .rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
  expect(getCredential).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 })
  expect(lines).toEqual([])
})

test('terminal persistence failure withholds completed output and leaves an interrupted start', async () => {
  db.exec("CREATE TRIGGER fail_terminal BEFORE INSERT ON audit WHEN NEW.event = 'run-terminal' BEGIN SELECT RAISE(ABORT, 'synthetic full storage'); END")
  await expect(runTool(db, audit, runner, token, { args: ['print', 'synthetic-output'] }, adapter, resolver, context))
    .rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
  expect(getCredential).toHaveBeenCalledOnce()
  expect(db.prepare('SELECT event FROM audit').all()).toEqual([{ event: 'run-start' }])
  db.exec('DROP TRIGGER fail_terminal')
  expect(audit.recoverInterrupted()).toBe(1)
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: 'interrupted' })
})

test('sensitive flag and positional values are redacted in persisted run arguments', async () => {
  vi.spyOn(adapter, 'sensitiveArguments').mockReturnValue({ flags: ['--password'], positions: [5] })
  await runTool(db, audit, runner, token, { args: ['exit', '0', '--password', 'CANARY-separate', '--password=CANARY-equals', 'CANARY-positional'] }, adapter, resolver, context)
  expect(db.prepare("SELECT arguments FROM audit WHERE event = 'run-start'").get()).toEqual({
    arguments: JSON.stringify(['exit', '0', '--password', '[redacted]', '--password=[redacted]', '[redacted]']),
  })
  expect(lines.join('')).not.toContain('CANARY-')
})

test.each([
  ['move', ['--destination', 'CANARY-private-folder'], ['--destination', '[redacted]']],
  ['move', ['--destination=CANARY-private-folder'], ['--destination=[redacted]']],
  ['copy', ['--destination', 'CANARY-private-folder'], ['--destination', '[redacted]']],
  ['copy', ['--destination=CANARY-private-folder'], ['--destination=[redacted]']],
] as const)('mail message %s redacts destination IDs in persisted and streamed audits: %j', async (command, destination, safeDestination) => {
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'mg-axi'; INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'mg-axi')")
  const graph = createMgAdapter({ getCredential: async () => ({
    mode: 'application', auth: 'client-secret', clientSecret: 'CANARY-graph-secret',
    tenantId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002',
    enabledPacks: ['entra', 'mail'], writes: { allowWrites: true, operations: [`mail.message.${command}`] },
  }) }, join(directory, 'writes.log'), loadCredentialProfile('mg-axi',
    join(process.cwd(), 'tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json'))!)
  const prepare = graph.prepare.bind(graph)
  vi.spyOn(graph, 'prepare').mockImplementation(async (...input) => {
    const call = await prepare(...input)
    return { ...call, executable: process.execPath,
      args: [join(process.cwd(), 'test/fake-tool/mg-adapter-child.mjs'), ...call.args] }
  })
  const identities = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-graph', tool: 'mg-axi', revision: 1 }, value: {} },
  ]))
  const args = ['mail', 'message', command, '--mailbox', 'mailbox@contoso.example',
    '--ids', 'synthetic-message', ...destination, '--execute', '--confirm', 'synthetic-message']
  const result = await runTool(db, audit, runner, token, { args }, graph, identities, context)
  expect(result.exitCode, result.stdout + result.stderr).toBe(0)
  expect(decode(result.stdout)).toMatchObject({ complete: true, fakeSends: 1, results: [{ status: 'success' }] })
  expect(db.prepare("SELECT arguments FROM audit WHERE event = 'run-start'").get()).toEqual({
    arguments: JSON.stringify(['mail', 'message', command, '--mailbox', '[redacted]', '--ids', '[redacted]',
      ...safeDestination, '--execute', '--confirm', '[redacted]']),
  })
  const records = db.prepare('SELECT * FROM audit ORDER BY id').all()
  expect(lines.map(line => JSON.parse(line))).toEqual(records)
  expect(JSON.stringify(records)).not.toContain('CANARY-')
  expect(JSON.stringify(records)).not.toContain('mailbox@contoso.example')
  expect(lines.join('')).not.toContain('CANARY-')
})

test('a role change denies the next run with the same token before credential retrieval', async () => {
  await runTool(db, audit, runner, token, { args: ['exit', '0'] }, adapter, resolver, context)
  db.exec('DELETE FROM role_tools')
  getCredential.mockClear()
  await expect(runTool(db, audit, runner, token, { args: ['exit', '0'] }, adapter, resolver, { ...context, requestId: 'next-run' }))
    .rejects.toMatchObject({ code: 'TOOL_NOT_GRANTED' })
  expect(getCredential).not.toHaveBeenCalled()
  expect(db.prepare("SELECT outcome FROM audit WHERE request_id = 'next-run'").get()).toEqual({ outcome: 'TOOL_NOT_GRANTED' })
})

test('known-secret output produces a safe terminal with observed byte counts', async () => {
  await expect(runTool(db, audit, runner, token, { args: ['leak'] }, adapter, resolver, context))
    .rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
  expect(db.prepare("SELECT * FROM audit WHERE event = 'run-terminal'").get()).toMatchObject({ outcome: 'SECRET_IN_OUTPUT', exit_code: null, stdout_bytes: 13, stderr_bytes: 0 })
  expect(lines.join('')).not.toContain('CANARY-secret')
})

test('a classified write ending on a signal records an unknown outcome', async () => {
  const execution = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
    const prepared = await adapter.prepare(...input)
    return { ...prepared, args: [...fakeTool.args, 'native-journal', 'signal'],
      environment: { ...prepared.environment, VECTRA_AXI_WRITE_LOG: join(directory, 'writes.log') },
      write: { operation: 'synthetic-write', target: 'synthetic-target',
      checkArgs: ['print', 'synthetic-state'] } }
  } }
  await expect(runTool(db, audit, runner, token, { args: ['signal'] }, execution, resolver, context))
    .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', message: 'Unknown outcome for synthetic-write synthetic-target.',
      next: expect.stringContaining('artium-axi falcon-axi print synthetic-state') })
  expect(db.prepare("SELECT outcome, action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: 'UNKNOWN_OUTCOME', action: 'write' })
})

test.each(['TIMEOUT', 'CANCELLED', 'PROCESS_SIGNAL', 'SECRET_IN_OUTPUT', 'OUTPUT_LIMIT', 'UNKNOWN_OUTCOME'] as const)('GitHub preview sends nothing and interrupted %s execution returns read-back guidance', async code => {
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'gh-axi'; INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'gh-axi')")
  const github = createGhAdapter({ getCredential: async () => ({ origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' }),
    getSettings: () => ({ writes: { allowWrites: true, operations: ['issue comment'] } }) })
  const identities = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-github', tool: 'gh-axi', revision: 1 }, value: {} },
  ]))
  const run = vi.spyOn(runner, 'run').mockRejectedValue(Object.assign(new RunnerError(code, 'CANARY-private-error'),
    { processStarted: true, durationMs: 17.25, outputBytes: { stdout: 12, stderr: 34 } }))
  const args = ['issue', 'comment', '42', '-R', 'canary/repo', '--body=CANARY-private-comment']
  const preview = await runTool(db, audit, runner, token, { args }, github, identities, context)
  const document = decode(preview.stdout) as { preview: { confirm: string } }
  expect(run).not.toHaveBeenCalled()
  expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'read' })
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await expect(runTool(db, audit, runner, token, { args: [...args, '--confirm', document.preview.confirm] }, github, identities,
    { ...context, requestId: 'synthetic-execute' })).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME',
    next: expect.stringContaining('artium-axi gh-axi issue view 42 --comments -R canary/repo') })
  expect(run).toHaveBeenCalledOnce()
  expect(stderr.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
    expect.objectContaining({ event: 'run', requestId: 'synthetic-execute', tool: 'gh-axi',
      outcome: 'UNKNOWN_OUTCOME', exitCode: null, durationMs: 17.25, stdoutBytes: 12, stderrBytes: 34 }),
  ])
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('CANARY')
  expect(db.prepare("SELECT action, outcome FROM audit WHERE event = 'run-terminal' AND request_id = 'synthetic-execute'").get())
    .toEqual({ action: 'unknown', outcome: 'UNKNOWN_OUTCOME' })
  expect(lines.join('')).not.toMatch(/CANARY-github-token|CANARY-private-comment/)
  expect(lines.join('')).not.toContain(document.preview.confirm)
})

test.each([
  { interruption: 'secret detection', script: 'process.stdout.write(process.env.GH_TOKEN)' },
  { interruption: 'output flooding', script: "process.stderr.write('x'.repeat(64 * 1024 * 1024))" },
])('a real GitHub write stopped by $interruption suppresses output and returns recovery guidance', async ({ script }) => {
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'gh-axi'; INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'gh-axi')")
  const github = createGhAdapter({ getCredential: async () => ({ origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' }),
    getSettings: () => ({ writes: { allowWrites: true, operations: ['issue comment'] } }) })
  const prepare = github.prepare.bind(github)
  vi.spyOn(github, 'prepare').mockImplementation(async (...input) => {
    const call = await prepare(...input)
    return { ...call, executable: process.execPath, args: ['-e', script] }
  })
  const identities = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-github', tool: 'gh-axi', revision: 1 }, value: {} },
  ]))
  const run = vi.spyOn(runner, 'run')
  const args = ['issue', 'comment', '42', '-R', 'canary/repo', '--body=CANARY-private-comment']
  const preview = await runTool(db, audit, runner, token, { args }, github, identities, context)
  const document = decode(preview.stdout) as { preview: { confirm: string } }
  expect(run).not.toHaveBeenCalled()
  const failure = await runTool(db, audit, runner, token, { args: [...args, '--confirm', document.preview.confirm] }, github, identities,
    { ...context, requestId: 'synthetic-execute' }).catch(error => error)
  expect(failure).toMatchObject({ code: 'UNKNOWN_OUTCOME',
    next: expect.stringContaining('artium-axi gh-axi issue view 42 --comments -R canary/repo') })
  expect(failure).not.toHaveProperty('stdout')
  expect(failure).not.toHaveProperty('stderr')
  expect(JSON.stringify(failure)).not.toMatch(/CANARY-github-token|CANARY-private-comment|xxxxxxxx/)
  expect(run).toHaveBeenCalledOnce()
  expect(db.prepare("SELECT action, outcome FROM audit WHERE event = 'run-terminal' AND request_id = 'synthetic-execute'").get())
    .toEqual({ action: 'unknown', outcome: 'UNKNOWN_OUTCOME' })
  expect(lines.join('')).not.toMatch(/CANARY-github-token|CANARY-private-comment|xxxxxxxx/)
})

test.each([
  { operation: 'issue comment', scenario: 'mutation-response-lost', auth: 'token',
    args: ['issue', 'comment', '42', '-R', 'canary/repo', '--body=CANARY-private-comment'],
    calls: [['issue', 'comment', '42', '--repo=canary/repo', '--body=CANARY-private-comment']],
    recovery: 'artium-axi gh-axi issue view 42 --comments -R canary/repo' },
  { operation: 'pr revert', scenario: 'mutation-response-lost', auth: 'token',
    args: ['pr', 'revert', '42', '-R', 'canary/repo'],
    calls: [['pr', 'revert', '42', '--repo=canary/repo']],
    recovery: 'artium-axi gh-axi pr list --state all --limit 100 -R canary/repo' },
  { operation: 'issue create', scenario: 'followup-read-failed', auth: 'token',
    args: ['issue', 'create', '-R', 'canary/repo', '--title=synthetic', '--body=CANARY-private-comment'],
    calls: [['issue', 'create', '--title', 'synthetic', '--body', 'CANARY-private-comment', '--repo', 'canary/repo'],
      ['issue', 'view', '1', '--json', 'number,title,state,url,id', '--repo', 'canary/repo']],
    recovery: 'artium-axi gh-axi issue list --limit 100 --state all -R canary/repo' },
  { operation: 'issue create', scenario: 'followup-read-failed', auth: 'device',
    args: ['issue', 'create', '-R', 'canary/repo', '--title=synthetic', '--body=CANARY-private-comment'],
    calls: [['issue', 'create', '--title', 'synthetic', '--body', 'CANARY-private-comment', '--repo', 'canary/repo'],
      ['issue', 'view', '1', '--json', 'number,title,state,url,id', '--repo', 'canary/repo']],
    recovery: 'artium-axi gh-axi issue list --limit 100 --state all -R canary/repo' },
])('a nonzero $operation result after $scenario with $auth auth returns recovery without retry', async ({ operation, scenario, auth, args, calls, recovery }) => {
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'gh-axi'; INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'gh-axi')")
  const fake = join(directory, 'gh.mjs')
  const log = join(directory, 'gh-calls.jsonl')
  copyFileSync('test/fixtures/fake-gh.mjs', fake)
  chmodSync(fake, 0o755)
  const github = createGhAdapter({ getCredential: async () => auth === 'device'
    ? { origin: 'https://github.com', auth: 'device', accessToken: 'CANARY-github-token', login: 'synthetic' }
    : { origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' },
  getSettings: () => ({ writes: { allowWrites: true, operations: [operation] } }) })
  const prepare = github.prepare.bind(github)
  vi.spyOn(github, 'prepare').mockImplementation(async (...input) => {
    const call = await prepare(...input)
    return { ...call, executable: process.execPath,
      args: [call.invocation?.nativeGh ? fake : resolve('tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...call.args],
      environment: { ...call.environment, GH_BIN: fake, ARTIUM_TEST_GH_WRITES: '1', ARTIUM_TEST_GH_LOG: log, ARTIUM_TEST_GH_FAILURE: scenario } }
  })
  const identities = new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-github', tool: 'gh-axi', revision: 1 }, value: {} },
  ]))
  const run = vi.spyOn(runner, 'run')
  const preview = await runTool(db, audit, runner, token, { args }, github, identities, context)
  const document = decode(preview.stdout) as { preview: { confirm: string } }
  expect(run).not.toHaveBeenCalled()
  const failure = await runTool(db, audit, runner, token, { args: [...args, '--confirm', document.preview.confirm] }, github, identities,
    { ...context, requestId: 'synthetic-execute' }).catch(error => error)
  expect(failure).toMatchObject({ code: 'UNKNOWN_OUTCOME', next: expect.stringContaining(recovery) })
  expect(run).toHaveBeenCalledOnce()
  expect(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual(calls)
  expect(JSON.stringify(failure)).not.toMatch(/CANARY-github-token|CANARY-private-comment|unexpected EOF|Bad credentials/)
  expect(db.prepare("SELECT action, outcome FROM audit WHERE event = 'run-terminal' AND request_id = 'synthetic-execute'").get())
    .toEqual({ action: 'unknown', outcome: 'UNKNOWN_OUTCOME' })
  expect(lines.join('')).not.toMatch(/CANARY-github-token|CANARY-private-comment/)
})

describe.each(['AZ_AXI_WRITE_LOG', 'MG_AXI_WRITE_LOG', 'VECTRA_AXI_WRITE_LOG'])('%s missing evidence', variable => {
  const execution = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
    const prepared = await adapter.prepare(...input)
    return { ...prepared, args: [...fakeTool.args, 'native-journal', ...input[0]],
      environment: { ...prepared.environment, [variable]: join(directory, 'writes.log') } }
  } }
  test.each([
    { activity: 'missing', flags: ['--execute'], exitCode: 0, action: 'read' },
    { activity: 'empty', flags: ['--execute'], exitCode: 0, action: 'read' },
    { activity: 'missing', flags: ['--execute=false'], exitCode: 0, action: 'read' },
    { activity: 'missing', flags: ['--execute', 'false'], exitCode: 0, action: 'read' },
    { activity: 'failed', flags: [], exitCode: 1, action: 'unknown' },
    { activity: 'read', flags: [], exitCode: 0, action: 'read' },
  ])('$activity with $flags records $action', async ({ activity, flags, exitCode, action }) => {
    await expect(runTool(db, audit, runner, token, { args: [activity, ...flags] }, execution, resolver, context))
      .resolves.toMatchObject({ exitCode })
    expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action })
  })
  test('termination before journal append cannot establish a read', async () => {
    await expect(runTool(db, audit, runner, token, { args: ['signal-before-journal', '--execute'] }, execution, resolver, context))
      .rejects.toMatchObject({ code: 'PROCESS_SIGNAL' })
    expect(db.prepare("SELECT action FROM audit WHERE event = 'run-terminal'").get()).toEqual({ action: 'unknown' })
  })
})

test('a classified write cancelled before execution retains cancellation', async () => {
  const execution = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
    return { ...await adapter.prepare(...input), write: { operation: 'synthetic-write', target: 'synthetic-target',
      checkArgs: ['print', 'synthetic-state'] } }
  } }
  const controller = new AbortController()
  controller.abort()
  await expect(runTool(db, audit, runner, token, { args: ['print'] }, execution, resolver, { ...context, signal: controller.signal }))
    .rejects.toMatchObject({ code: 'CANCELLED' })
})

test('a classified write cancelled after child start records an unknown outcome', async () => {
  const execution = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
    return { ...await adapter.prepare(...input), write: { operation: 'synthetic-write', target: 'synthetic-target',
      checkArgs: ['print', 'synthetic-state'] } }
  } }
  const controller = new AbortController()
  const actual = await vi.importActual<typeof childProcess>('node:child_process')
  vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
    const child = actual.spawn(...args)
    child.once('spawn', () => controller.abort())
    return child
  })
  await expect(runTool(db, audit, runner, token, { args: ['sleep'] }, execution, resolver, { ...context, signal: controller.signal }))
    .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' })
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: 'UNKNOWN_OUTCOME' })
})

test('credential preparation failure completes its start with a safe code', async () => {
  getCredential.mockRejectedValueOnce(new Error('CANARY-private-diagnostic'))
  await expect(runTool(db, audit, runner, token, { args: ['print'] }, adapter, resolver, context)).rejects.toThrow('CANARY-private-diagnostic')
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: 'INTERNAL_ERROR' })
  expect(lines.join('')).not.toContain('CANARY-private-diagnostic')
})

describe.each([
  { tool: 'falcon-axi', create: () => createFalconAdapter({ getCredential }) },
  { tool: 'vectra-axi', create: () => createVectraAdapter({ getCredential: async () => ({
    kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-vectra-token', origin: 'https://synthetic.invalid',
  }) }, join(directory, 'vectra-writes.log')) },
] as const)('$tool authentication at child creation', ({ tool, create }) => {
  let executionAdapter: Adapter<unknown>
  let release: () => void
  let setup: Promise<void>
  let spawn: MockInstance<typeof childProcess.spawn>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-01T00:00:00Z') })
    token = issueTestAccessToken(db, 'synthetic-user')
    db.prepare('UPDATE tools SET enabled = 1 WHERE name = ?').run(tool)
    db.prepare('INSERT OR IGNORE INTO role_tools (role_id, tool) VALUES (?, ?)').run('synthetic-role', tool)
    executionAdapter = create()
    const prepare = executionAdapter.prepare.bind(executionAdapter)
    vi.spyOn(executionAdapter, 'prepare').mockImplementation(async (...args) => {
      const call = await prepare(...args)
      return { ...call, executable: fakeTool.executable, args: [...fakeTool.args, ...call.args],
        limits: { timeoutMs: 5000 } }
    })
    let ready!: () => void
    setup = new Promise<void>(resolve => { ready = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const writeFile = actualFilesystem.writeFile
    vi.spyOn(filesystem, 'writeFile').mockImplementation(async (...args) => {
      await writeFile(...args)
      if (String(args[0]).endsWith('/inputs/synthetic-input')) {
        ready()
        await resume
      }
    })
    spawn = vi.spyOn(childProcess, 'spawn').mockClear()
  })
  afterEach(() => { release() })

  const start = () => runTool(db, audit, runner, token, { args: ['exit', '0'],
    files: [{ name: 'synthetic-input', contentBase64: Buffer.from('CANARY-file').toString('base64') }] },
  executionAdapter, new SharedIdentityResolver(new FakeCredentialStore([
    { reference: { id: 'synthetic-credential', tool }, value: {} },
  ])), context)

  test('a still-valid token executes after filesystem setup and cleans prepared files', async () => {
    const result = start()
    await setup
    release()
    await expect(result).resolves.toMatchObject({ exitCode: 0 })
    expect(spawn).toHaveBeenCalledOnce()
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  })

  test('expiry during filesystem setup prevents child creation and cleans prepared files', async () => {
    const result = start()
    const rejected = expect(result).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' })
    await setup
    const [call] = readdirSync(join(directory, 'calls'))
    expect(readFileSync(join(directory, 'calls', call, 'tmp', 'inputs', 'synthetic-input'), 'utf8')).toBe('CANARY-file')
    vi.setSystemTime(Date.now() + tokenDefaults.accessMs)
    release()
    await rejected
    expect(spawn).not.toHaveBeenCalled()
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
    expect(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: 'TOKEN_EXPIRED' })
  })

  test('password change during filesystem setup prevents child creation and cleans prepared files', async () => {
    db.exec('UPDATE users SET must_change = 1')
    const login = issueLoginTokens(db, 'synthetic-user')
    expect(login.status).toBe('password-change-required')
    const result = start()
    const rejected = expect(result).rejects.toMatchObject({ code: 'TOKEN_INVALID' })
    await setup
    await new LocalAuthProvider(db).changePassword('synthetic-user', undefined, 'CANARY-new-password', audit,
      { ...context, requestId: 'synthetic-password-change' }, Date.now(),
      (login as Extract<typeof login, { status: 'password-change-required' }>).passwordChangeToken)
    release()
    await rejected
    expect(spawn).not.toHaveBeenCalled()
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
    expect(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: 'TOKEN_INVALID' })
  })
})
