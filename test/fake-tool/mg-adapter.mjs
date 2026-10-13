import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    args: [fileURLToPath(new URL('mg-adapter-child.mjs', import.meta.url)), ...call.args] }
}
const runner = await Runner.create(join(directory, 'calls'))
const db = openStore(join(directory, 'store.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
const audit = new Audit(db, Date.now, () => {})
db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'CANARY-hash');
  UPDATE tools SET enabled = 1 WHERE name = 'mg-axi';
  INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
  INSERT INTO user_roles VALUES ('synthetic-user', 'synthetic-role');
  INSERT INTO role_tools VALUES ('synthetic-role', 'mg-axi');`)
const token = issueTestAccessToken(db, 'synthetic-user')
const resolver = new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]))
let request = 0
const run = args => runTool(db, audit, runner, token, { args }, adapter, resolver,
  { requestId: `synthetic-graph-run-${++request}`, clientAddress: '192.0.2.1' })
const group = '00000000-0000-0000-0000-000000000003'
const user = '00000000-0000-0000-0000-000000000004'
const write = ['entra', 'group', 'member', 'add', '--group', group, '--user', user]
try {
  const read = await run(['entra', 'user', 'list'])
  assert.equal(read.exitCode, 0, read.stdout + read.stderr)
  assert.match(read.stdout, /Synthetic User/)
  const before = credentialReads
  await assert.rejects(run(['entra', 'user', 'list', '--profile=other']), error => error.code === 'FLAG_BLOCKED')
  assert.equal(credentialReads, before)
  db.exec('DELETE FROM role_tools')
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
  console.log('mg-adapter: fake Graph read, permission/override refusal, native preview/write/gates/audit and encoded canary scan passed; live consent unverified')
} finally {
  await runner.shutdown()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
