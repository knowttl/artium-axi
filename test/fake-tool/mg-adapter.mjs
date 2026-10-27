import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { decode } from '@toon-format/toon'
import { SessionStore } from '../../dist/src/cli/session.js'
import { errorResponse } from '../../dist/src/shared/errors.js'
import { createMgAdapter } from '../../dist/src/server/adapters/mg.js'
import { loadCredentialProfile } from '../../dist/src/server/adapters/credential-profile.js'
import { Runner } from '../../dist/src/server/runner/runner.js'
import { runTool } from '../../dist/src/server/runner/run.js'
import { Audit } from '../../dist/src/server/audit/audit.js'
import { openStore } from '../../dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../dist/src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../dist/src/server/policy/identity-resolver.js'
import { FakeCredentialStore } from '../../dist/test/fixtures/credential-store.js'
import { issueTestAccessToken } from '../../dist/test/fixtures/tokens.js'

process.env.NODE_ENV = 'test'
const directory = mkdtempSync(join(tmpdir(), 'artium-test-mg-adapter-'))
const reference = { id: 'synthetic-graph', tool: 'mg-axi', revision: 1 }
let credential = { mode: 'application', tenantId: '00000000-0000-0000-0000-000000000001',
  clientId: '00000000-0000-0000-0000-000000000002', auth: 'client-secret', clientSecret: 'CANARY-graph-secret',
  writes: { allowWrites: true, operations: ['mg.entra.group.member.add'] } }
let credentialReads = 0
const log = join(directory, 'writes.log')
const adapter = createMgAdapter({ getCredential: async () => { credentialReads++; return credential } }, log,
  loadCredentialProfile('mg-axi', fileURLToPath(new URL('../../tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json', import.meta.url))))
const prepare = adapter.prepare.bind(adapter)
adapter.prepare = async (...args) => {
  const call = await prepare(...args)
  return { ...call, executable: process.execPath,
    fileArguments: call.fileArguments?.map(index => index + 1),
    args: [fileURLToPath(new URL('mg-adapter-child.mjs', import.meta.url)), ...call.args] }
}
const runner = await Runner.create(join(directory, 'calls'))
const db = openStore(join(directory, 'store.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
const audit = new Audit(db, Date.now, () => {})
db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
  UPDATE tools SET enabled = 1 WHERE name = 'mg-axi';
  INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
  INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
  INSERT INTO role_tools VALUES ('synthetic-role', 'mg-axi');`)
const token = issueTestAccessToken(db, 'synthetic-user')
const resolver = new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]))
let request = 0
const run = (args, input = {}) => runTool(db, audit, runner, token, { args, ...input }, adapter, resolver,
  { requestId: `synthetic-graph-run-${++request}`, clientAddress: '192.0.2.1' })
const group = '00000000-0000-0000-0000-000000000003'
const user = '00000000-0000-0000-0000-000000000004'
const write = ['entra', 'group', 'member', 'add', '--group', group, '--user', user]
const cliRequests = []
const server = createServer(async (request, reply) => {
  assert.equal(request.url, '/v1/tools/mg-axi/run')
  assert.equal(request.headers.authorization, `Bearer ${token}`)
  let body = ''
  for await (const chunk of request) body += chunk
  const input = JSON.parse(body)
  cliRequests.push(input)
  try {
    const { stdout, stderr, exitCode, durationMs, outputBytes, truncated } = await run(input.args, input)
    reply.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ source: 'mg-axi', stdout, stderr, exitCode, durationMs, outputBytes, truncated }))
  } catch (error) {
    reply.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify(errorResponse(error, 'synthetic-cli-run')))
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = `http://127.0.0.1:${server.address().port}`
new SessionStore(url, join(directory, 'artium-axi', 'session.json')).write({
  status: 'authenticated', accessToken: token, refreshToken: 'CANARY-cli-refresh',
  accessExpiresAt: Date.now() + 3600_000, familyExpiresAt: Date.now() + 43200_000,
})
const execute = promisify(execFile)
const cli = async args => {
  try {
    return { ...await execute(process.execPath, [fileURLToPath(new URL('../../dist/cli/artium-axi.mjs', import.meta.url)), 'mg-axi', ...args],
      { cwd: directory, timeout: 10_000, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory,
        ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }), code: 0 }
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
}
try {
  const read = await run(['entra', 'user', 'list'])
  assert.equal(read.exitCode, 0, read.stdout + read.stderr)
  assert.match(read.stdout, /Synthetic User/)
  const hunting = ['security', 'hunting', 'query', '--file', 'query.kql']
  const query = 'DeviceEvents | where ActionType == "CANARY-hunt" | take 1'
  const input = { files: [{ name: 'query.kql', contentBase64: Buffer.from(query).toString('base64') }] }
  await assert.rejects(run(hunting, input), error => error.code === 'FLAG_BLOCKED' && error.message.includes('enabledPacks'))
  credential.enabledPacks = ['entra', 'security']
  const hunted = await run(hunting, input)
  assert.equal(hunted.exitCode, 0, hunted.stdout + hunted.stderr)
  assert.match(hunted.stdout, /Synthetic Device/)
  assert.ok(!JSON.stringify(hunted).includes(query))
  writeFileSync(join(directory, 'query.kql'), query)
  for (const fileArgs of [['--file', 'query.kql'], ['--file=query.kql']]) {
    const result = await cli(['security', 'hunting', 'query', ...fileArgs])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /Synthetic Device/)
    assert.ok(!result.stdout.includes(query))
    assert.deepEqual(cliRequests.at(-1), { args: ['security', 'hunting', 'query', ...fileArgs], ...input })
  }
  writeFileSync(join(directory, 'query.kql'), query.padEnd(65536, ' '))
  const boundary = await cli(hunting)
  assert.equal(boundary.code, 0, boundary.stdout + boundary.stderr)
  assert.match(boundary.stdout, /Synthetic Device/)
  const invalidQuery = 'DeviceEvents | wher ActionType == "CANARY-invalid-hunt"'
  const invalidInput = { files: [{ name: 'query.kql', contentBase64: Buffer.from(invalidQuery).toString('base64') }] }
  const invalid = await run(hunting, invalidInput)
  assert.equal(invalid.exitCode, 2, invalid.stdout + invalid.stderr)
  const diagnostics = [
    { line: 1, column: 16, code: 'KS176', token: 'wher', message: 'Query operator expected.' },
    { line: 1, column: 21, code: 'KS005', token: 'ActionType', message: 'Expected: ;' },
  ]
  assert.deepEqual(decode(invalid.stdout).diagnostics, diagnostics)
  writeFileSync(join(directory, 'query.kql'), invalidQuery)
  const invalidCli = await cli(hunting)
  assert.equal(invalidCli.code, 2, invalidCli.stdout + invalidCli.stderr)
  assert.deepEqual(decode(invalidCli.stdout).diagnostics, diagnostics)
  assert.ok(!JSON.stringify([invalid, invalidCli]).includes(invalidQuery))
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes(invalidQuery))
  writeFileSync(join(directory, 'query.kql'), query.padEnd(65537, ' '))
  for (const fileArgs of [['--file', 'query.kql'], ['--file=query.kql']]) {
    const before = cliRequests.length
    const result = await cli(['security', 'hunting', 'query', ...fileArgs])
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.equal(cliRequests.length, before)
    assert.ok(!result.stdout.includes(query))
  }
  writeFileSync(join(directory, 'query.kql'), query)
  mkdirSync(join(directory, 'nested'))
  for (const fileArgs of [
    ['--file', 'nested/../query.kql'], ['--file=nested/../query.kql'], ['--file=..\\query.kql'],
    ['--file', '-'], ['--file'], ['--file='], ['--file', 'missing.kql'],
    ['--file', 'query.kql', '--file', 'query.kql'],
    ['--file=query.kql', '--file=query.kql'],
    ['--file', 'query.kql', '--file=other.kql'],
  ]) {
    const before = cliRequests.length
    const result = await cli(['security', 'hunting', 'query', ...fileArgs])
    assert.equal(result.code, 2, result.stdout + result.stderr)
    assert.equal(cliRequests.length, before)
  }
  const cliRead = await cli(['entra', 'user', 'list'])
  assert.equal(cliRead.code, 0, cliRead.stdout + cliRead.stderr)
  assert.match(cliRead.stdout, /Synthetic User/)
  for (const args of [
    ['entra', 'user', 'list', '--file', 'query.kql'],
    ['api', 'get', '/users', '--file=query.kql'],
  ]) {
    await cli(args)
    assert.deepEqual(cliRequests.at(-1), { args })
  }
  for (const fileArgs of [[], ['--file', 'query.kql'], ['--file=query.kql'], ['--file', 'missing.kql'], ['--file=missing.kql']]) {
    const args = ['security', 'hunting', 'query', ...fileArgs, '--help']
    const result = await cli(args)
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /--file/)
    assert.match(result.stdout, /--timespan/)
    assert.match(result.stdout, /--limit/)
    assert.deepEqual(cliRequests.at(-1), { args })
  }
  await assert.rejects(run(hunting, { files: [{ ...input.files[0], name: '../query.kql' }] }), error => error.code === 'INVALID_INPUT')
  await assert.rejects(run(hunting, { files: [...input.files, { ...input.files[0], name: 'extra.kql' }] }), error => error.code === 'UNSUPPORTED_INPUT')
  await assert.rejects(run(hunting, { files: [{ ...input.files[0], contentBase64: Buffer.alloc(65537, 65).toString('base64') }] }), error => error.code === 'UNSUPPORTED_INPUT')
  const leak = 'DeviceEvents | where ActionType == "CANARY-query-leak"'
  await assert.rejects(run(hunting, { files: [{ ...input.files[0], contentBase64: Buffer.from(leak).toString('base64') }] }), error => error.code === 'SECRET_IN_OUTPUT')
  const secretLeak = 'DeviceEvents | where ActionType == "CANARY-secret-leak"'
  await assert.rejects(run(hunting, { files: [{ ...input.files[0], contentBase64: Buffer.from(secretLeak).toString('base64') }] }), error => error.code === 'SECRET_IN_OUTPUT')
  const huntingAudit = JSON.stringify(db.prepare('SELECT * FROM audit').all())
  for (const sensitive of [query, leak, secretLeak, credential.clientSecret, input.files[0].contentBase64]) assert.ok(!huntingAudit.includes(sensitive))
  const before = credentialReads
  await assert.rejects(run(['entra', 'user', 'list', '--profile=other']), error => error.code === 'FLAG_BLOCKED')
  assert.equal(credentialReads, before)
  db.exec('DELETE FROM role_tools')
  await assert.rejects(run(hunting, input), error => error.code === 'TOOL_NOT_GRANTED')
  await assert.rejects(run(['entra', 'user', 'list']), error => error.code === 'TOOL_NOT_GRANTED')
  assert.equal(credentialReads, before)
  db.exec("INSERT INTO role_tools VALUES ('synthetic-role', 'mg-axi')")
  const preview = await run(write)
  assert.equal(preview.exitCode, 0, preview.stdout + preview.stderr)
  assert.match(preview.stdout, /status: preview/)
  assert.match(preview.stdout, /fakeSends: 0/)
  const confirmation = await run([...write, '--execute'])
  assert.match(confirmation.stdout, /CONFIRM_REQUIRED/)
  assert.equal(confirmation.exitCode, 1)
  credential.writes.allowWrites = false
  const disabled = await run([...write, '--execute', '--confirm', group])
  assert.match(disabled.stdout, /WRITES_DISABLED/)
  credential.writes.allowWrites = true
  credential.writes.operations = ['mg.entra.user.update']
  const scoped = await run([...write, '--execute', '--confirm', group])
  assert.match(scoped.stdout, /OPERATION_NOT_WRITABLE/)
  credential.writes.operations = ['mg.entra.group.member.add']
  const written = await run([...write, '--execute', '--confirm', group])
  assert.equal(written.exitCode, 0, written.stdout + written.stderr)
  assert.match(written.stdout, /fakeSends: 1/)
  const journal = readdirSync(`${log}.runs`).map(name => join(`${log}.runs`, name, 'writes.log')).filter(existsSync)
    .flatMap(path => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  assert.deepEqual(journal.map(row => row.kind), ['intent', 'outcome'])
  assert.equal(journal[1].outcome, 'SUCCESS')
  await assert.rejects(run(['entra', 'user', 'list', '--filter', 'encoded-canary']), error => error.code === 'SECRET_IN_OUTPUT')
  const records = db.prepare('SELECT event, outcome FROM audit ORDER BY id').all()
  assert.ok(records.some(row => row.event === 'denial' && row.outcome === 'FLAG_BLOCKED'))
  assert.ok(records.some(row => row.event === 'denial' && row.outcome === 'TOOL_NOT_GRANTED'))
  assert.equal(records.at(-1).outcome, 'SECRET_IN_OUTPUT')
  assert.equal(records.filter(row => row.event === 'run-start').length, records.filter(row => row.event === 'run-terminal').length)
  assert.ok(!JSON.stringify(journal).includes('CANARY-'))
  assert.deepEqual(readdirSync(join(directory, 'calls')), [])
  console.log('mg-adapter: fake Graph and hunting reads, opt-in/upload/role refusals, query/secret scanning, native preview/write/gates and audit passed; live consent unverified')
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await runner.shutdown()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
