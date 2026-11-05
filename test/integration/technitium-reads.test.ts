import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decode } from '@toon-format/toon'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createTechnitiumAdapter } from '../../src/server/adapters/technitium.js'
import { Audit } from '../../src/server/audit/audit.js'
import { toolPaths, toolSkillPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { preflight } from '../../src/server/health/preflight.js'
import { inspectCertificate } from '../../src/server/certificate-inspection.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SessionStore } from '../../src/cli/session.js'
import { copyClientInput } from '../fixtures/client-inputs.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'

const actor = 'synthetic-development-user'
vi.mock('node:fs/promises', { spy: true })
const actualFilesystem = await vi.importActual<typeof filesystem>('node:fs/promises')
// Background health reads must not race request evidence or runner cleanup assertions.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(filesystem.open).mockImplementation(actualFilesystem.open)
})
async function withTechnitium(check: (fixture: {
  app: ReturnType<typeof createApp>, db: ReturnType<typeof openStore>, store: ReturnType<typeof createCredentialStore>,
  headers: { authorization: string }, directory: string,
  cli: (args: string[]) => Promise<{ stdout: string, stderr: string }>,
  evidence: () => Promise<{ requests: { method: string, path: string, canaryReceived: boolean, fields: Record<string, string> }[] }>,
  failures: Error[], journalCloseFailure?: Error,
}) => Promise<void>, nativeResultFailure?: string) {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('technitium-axi', { origin: `https://127.0.0.1:${port}`, auth: 'token', tokenKind: 'api',
      token: 'CANARY-technitium-token', caFile: readFileSync(join(directory, 'ca.crt'), 'utf8'), tlsServerName: 'localhost' }, 0, actor, Date.now())
    db.prepare("UPDATE tools SET enabled = 1 WHERE name = 'technitium-axi'").run()
    const runner = await Runner.create(join(directory, 'calls'))
    const previousPath = toolPaths['technitium-axi']
    const previousSkill = toolSkillPaths['technitium-axi']
    Object.assign(toolPaths, { 'technitium-axi': join(process.cwd(), 'tools/node_modules/@knowttl/technitium-axi/bin/technitium-axi.js') })
    Object.assign(toolSkillPaths, { 'technitium-axi': join(process.cwd(), 'tools/node_modules/@knowttl/technitium-axi/README.md') })
    const adapter = createTechnitiumAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
    const journalCloseFailure = nativeResultFailure === 'journal-close'
      ? Object.assign(new Error('synthetic journal close failure'), { code: 'EIO' }) : undefined
    if (journalCloseFailure) vi.spyOn(filesystem, 'open').mockImplementation(async (...input) => {
      const handle = await actualFilesystem.open(...input)
      if (String(input[0]).startsWith(join(directory, 'writes.log.d') + '/')) {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw journalCloseFailure })
      }
      return handle
    })
    if (nativeResultFailure) {
      const prepare = adapter.prepare.bind(adapter)
      adapter.prepare = async (...input) => {
        const call = await prepare(...input)
        return { ...call, args: [join(process.cwd(), 'test/fake-tool/technitium-publication-fault.mjs'),
          nativeResultFailure === 'journal-close' ? 'rename' : nativeResultFailure, ...call.args],
          fileArguments: call.fileArguments?.map(index => index + 2) }
      }
    }
    const app = createApp({ db, runner, audit: new Audit(db), environment: {}, credentialStore: store,
      resolver: new SharedIdentityResolver(store), adapters: [adapter] })
    const failures: Error[] = []
    app.addHook('onError', async (_request, _reply, error) => { failures.push(error) })
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      const token = issueTestAccessToken(db, actor)
      const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
      new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated',
        accessToken: token, refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000,
        familyExpiresAt: Date.now() + 43_200_000 })
      await check({ app, db, store, directory, failures, journalCloseFailure, headers: { authorization: `Bearer ${token}` },
        cli: args => promisify(execFile)(process.execPath, [bundle, ...args], { timeout: 10_000,
          env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } }),
        evidence: async () => JSON.parse(await send('/__evidence')) })
    } finally {
      await app.close()
      db.close()
      Object.assign(toolPaths, { 'technitium-axi': previousPath })
      Object.assign(toolSkillPaths, { 'technitium-axi': previousSkill })
    }
  })
}

test.each(['destination', 'open', 'writeFile', 'sync', 'close', 'rename', 'parent-open', 'parent-sync', 'parent-close', 'journal-close']
  .flatMap(failure => [{ failure, format: 'JSON', flags: ['--json'], parse: JSON.parse },
    { failure, format: 'TOON', flags: [], parse: decode }] ))(
  'native $failure publication failure retains completed journal recovery ($format, R7)', async item => {
    await withTechnitium(async ({ app, db, directory, headers, evidence, failures, journalCloseFailure }) => {
      const writes = { allowWrites: true, operations: ['OP-080'] }
      db.prepare('UPDATE tools SET native_settings = ? WHERE name = ?')
        .run(JSON.stringify({ writes, hostWrites: writes }), 'technitium-axi')
      const files = [{ name: 'input.json', contentBase64: Buffer.from(JSON.stringify({
        parameters: { enableBlocking: true }, baseline: { enableBlocking: false },
      })).toString('base64') }]
      const args = ['settings', 'set', '--input-file', 'input.json', ...item.flags]
      const previewResponse = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers, payload: { args, files } })
      expect(previewResponse.json()).toMatchObject({ exitCode: 0 })
      const preview = item.parse(previewResponse.json().stdout) as { preview: { digest: string } }
      const response = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers,
        payload: { args: [...args, '--execute', '--confirm', preview.preview.digest], files } })
      expect(response.statusCode).toBe(504)
      const journal = JSON.parse(readFileSync(join(directory, 'writes.log.d', preview.preview.digest + '.json'), 'utf8'))
      expect(journal.state).toBe('completed')
      const failure = response.json().error
      expect(failure).toMatchObject({ code: 'UNKNOWN_OUTCOME', next: expect.stringContaining(journal.auditId), recovery: {
        exitCode: 2, receipt: { auditId: journal.auditId, status: 'ok', operation: 'OP-080',
          journal: { state: 'completed', digest: preview.preview.digest, postconditionHash: journal.postconditionHash } },
      } })
      expect((failures[0] as Error & { cause?: { cause?: unknown } })?.cause?.cause).toBe(journalCloseFailure)
      expect((await evidence()).requests.filter(request => request.path === '/api/settings/set'))
        .toEqual([{ method: 'POST', path: '/api/settings/set', canaryReceived: true, fields: { enableBlocking: 'true' } }])
      const record = db.prepare("SELECT outcome, native_audit_id, native_journal_result FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get() as {
        outcome: string, native_audit_id: string, native_journal_result: string,
      }
      expect(record).toMatchObject({ outcome: 'UNKNOWN_OUTCOME', native_audit_id: journal.auditId })
      expect(JSON.parse(record.native_journal_result)).toEqual(failure.recovery)
      expect(response.body).not.toMatch(/CANARY-|artium-call-|technitium-result\.bin/)
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    }, item.failure)
  },
)

const reads = [
  { kind: 'JSON', args: ['user', 'session', 'get'], operation: 'OP-006', path: '/api/user/session/get', fields: { includeInfo: 'true' },
    bytes: Buffer.from(JSON.stringify({ status: 'ok', username: 'synthetic-reader', tokenName: 'synthetic-api', info: { version: '14.0', permissions: { zones: { canView: true } } } }) + '\n') },
  { kind: 'text', args: ['zone', 'export', '--zone=synthetic.test'], operation: 'OP-024', path: '/api/zones/export', fields: { zone: 'synthetic.test' },
    bytes: Buffer.from('synthetic.test. IN TXT "CANARY-technitium-token"\n') },
  { kind: 'CSV', args: ['log', 'export', '--name', 'synthetic', '--class-path', 'synthetic.reader'], operation: 'OP-139', path: '/api/logs/export', fields: { name: 'synthetic', classPath: 'synthetic.reader' },
    bytes: Buffer.from('name,result\r\nsynthetic.test,CANARY-confidential-result\r\n') },
  { kind: 'ZIP', args: ['admin', 'cluster', 'primary', 'transfer-config', '--include-zones', ''], operation: 'OP-125', path: '/api/admin/cluster/primary/transferConfig', fields: { includeZones: '' },
    bytes: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') },
]

async function delegationHeaders(app: ReturnType<typeof createApp>, headers: { authorization: string }, commands: string[] | undefined, readOnly: boolean) {
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
    headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket },
    payload: { label: 'Synthetic', scope: { tools: [{ tool: 'technitium-axi', commands }] }, readOnly, reusable: false, expiresAt: Date.now() + 600_000 } })
  expect(minted.statusCode, minted.body).toBe(200)
  const exchanged = await app.inject({ method: 'POST', url: '/v1/auth/delegated', payload: { token: minted.json().token } })
  expect(exchanged.statusCode, exchanged.body).toBe(200)
  return { authorization: `Bearer ${exchanged.json().accessToken}` }
}

const credentialReads = [
  { command: 'settings backup', args: ['settings', 'backup'], operation: 'OP-084', bytes: reads[3].bytes },
  { command: 'admin cluster primary transfer-config', args: ['admin', 'cluster', 'primary', 'transfer-config'], operation: 'OP-125', bytes: reads[3].bytes },
]

test.each(credentialReads.flatMap(operation => [
  { ...operation, grant: 'tool-wide', commands: undefined, readOnly: false },
  { ...operation, grant: 'read-only exact', commands: [operation.command], readOnly: true },
]))('delegated Technitium $command refuses $grant access before dispatch (R8)', async ({ args, commands, readOnly }) => {
  await withTechnitium(async ({ app, db, headers, evidence }) => {
    db.exec('UPDATE delegation_settings SET minting_enabled = 1')
    const delegated = await delegationHeaders(app, headers, commands, readOnly)
    const response = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers: delegated, payload: { args } })
    expect(response.json()).toMatchObject({ error: { code: 'DELEGATED_SCOPE_DENIED' } })
    expect((await evidence()).requests).toEqual([])
  })
})

test.each(credentialReads)('delegated Technitium $command delivers an exact writable result (R8)', async ({ command, args, operation, bytes }) => {
  await withTechnitium(async ({ app, db, headers }) => {
    db.exec('UPDATE delegation_settings SET minting_enabled = 1')
    const delegated = await delegationHeaders(app, headers, [command], false)
    const response = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers: delegated, payload: { args } })
    expect(response.json()).toMatchObject({ exitCode: 0 })
    const { result } = decode(response.json().stdout) as { result: { path: string, operation: string } }
    expect(result.operation).toBe(operation)
    const downloaded = await app.inject({ url: result.path, headers: delegated })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.rawPayload).toEqual(bytes)
    expect((await app.inject({ url: result.path, headers: delegated })).json().error.code).toBe('NOT_FOUND')
  })
})

test.each([
  { args: ['zone', 'export', '--zone', 'synthetic.test'], bytes: reads[1].bytes },
  { args: ['allowed', 'export'], bytes: Buffer.from('synthetic.test\n') },
  { args: ['blocked', 'export'], bytes: Buffer.from('synthetic.test\n') },
  { args: ['log', 'download', '--file-name', 'synthetic.log'], bytes: Buffer.from('synthetic.test\n') },
  { args: ['log', 'export', '--name', 'synthetic', '--class-path', 'synthetic.reader'], bytes: reads[2].bytes },
])('read-only delegated Technitium data remains retrievable: $args (R8)', async ({ args, bytes }) => {
  await withTechnitium(async ({ app, db, headers }) => {
    db.exec('UPDATE delegation_settings SET minting_enabled = 1')
    const delegated = await delegationHeaders(app, headers, undefined, true)
    const response = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers: delegated, payload: { args } })
    expect(response.json()).toMatchObject({ exitCode: 0 })
    const { result } = decode(response.json().stdout) as { result: { path: string } }
    expect((await app.inject({ url: result.path, headers: delegated })).rawPayload).toEqual(bytes)
  })
})

test.each(reads)('Technitium $kind bytes remain private until one authenticated retrieval', async item => {
  await withTechnitium(async ({ cli, app, headers, directory, db, evidence }) => {
    const output = await cli(['technitium-axi', ...item.args, '--json'])
    const result = JSON.parse(output.stdout).result as { path: string, operation: string, bytes: number, sha256: string }
    expect(result).toMatchObject({ operation: item.operation, bytes: item.bytes.length,
      sha256: createHash('sha256').update(item.bytes).digest('hex') })
    expect(output.stdout).not.toMatch(/CANARY-|artium-call-|\/opt\/tools/)
    expect(output.stderr).toBe('')
    expect((await evidence()).requests).toEqual([{ method: 'POST', path: item.path, canaryReceived: true, fields: item.fields }])
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
    const downloaded = await app.inject({ url: result.path, headers })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.rawPayload).toEqual(item.bytes)
    expect(downloaded.rawPayload.toString()).not.toContain('CANARY-returned-session')
    expect(downloaded.headers['cache-control']).toBe('no-store')
    expect((await app.inject({ url: result.path, headers })).json().error.code).toBe('NOT_FOUND')
    expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toMatch(/CANARY-|synthetic\.test|synthetic\.reader/)
  })
})

test('protected results refuse another user and operation without consuming the owner result', async () => {
  await withTechnitium(async ({ cli, app, headers, db }) => {
    const { result } = JSON.parse((await cli(['technitium-axi', 'user', 'session', 'get', '--json'])).stdout)
    db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
      SELECT 'synthetic-other', 'synthetic-other', 'Synthetic Other', password_hash, 0 FROM users WHERE id = 'synthetic-development-user';
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-other', 'synthetic-role')`)
    const other = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-other')}` }
    expect((await app.inject({ url: result.path, headers: other })).json().error.code).toBe('NOT_FOUND')
    expect((await app.inject({ url: result.path.replace('OP-006', 'OP-024'), headers })).json().error.code).toBe('NOT_FOUND')
    expect((await app.inject({ url: result.path, headers })).rawPayload).toEqual(reads[0].bytes)
  })
})

test('credential rotation invalidates an outstanding protected result', async () => {
  await withTechnitium(async ({ cli, app, headers, store }) => {
    const { result } = JSON.parse((await cli(['technitium-axi', 'user', 'session', 'get', '--json'])).stdout)
    const current = store.findCredential('technitium-axi')!
    store.replaceCredential('technitium-axi', { ...store.readCredential(current) as Record<string, unknown>, token: 'CANARY-rotated' }, 1, actor, Date.now())
    expect((await app.inject({ url: result.path, headers })).json().error.code).toBe('NOT_FOUND')
  })
})

test.each(['true', 'false'])('native boolean parameters retain their explicit %s value', async value => {
  await withTechnitium(async ({ cli, app, headers, evidence }) => {
    const output = await cli(['technitium-axi', 'admin', 'ldap', 'get', '--include-groups', value, '--json'])
    expect(JSON.parse(output.stdout).response).toEqual({ ldapEnabled: false })
    const downloaded = await app.inject({ url: JSON.parse(output.stdout).result.path, headers })
    expect(downloaded.statusCode).toBe(200)
    expect(JSON.parse(downloaded.body).response).toEqual({ ldapEnabled: false })
    expect(downloaded.body).not.toContain('CANARY-ldap-password')
    expect((await evidence()).requests).toEqual([{ method: 'POST', path: '/api/admin/ldap/get', canaryReceived: true, fields: { includeGroups: value } }])
  })
})

test('Technitium TOON session results retain only the redacted projection', async () => {
  await withTechnitium(async ({ app, headers }) => {
    const response = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers,
      payload: { args: ['user', 'session', 'get'] } })
    const { decode } = await import('@toon-format/toon')
    const projection = decode(response.json().stdout) as { result: { path: string } }
    const downloaded = await app.inject({ url: projection.result.path, headers })
    expect(downloaded.statusCode).toBe(200)
    expect(decode(downloaded.body)).toEqual(JSON.parse(reads[0].bytes.toString()))
    expect(downloaded.body).not.toContain('CANARY-returned-session')
  })
})

test('manual preflight and certificate inspection honor the native TLS server name', async () => {
  await withTechnitium(async ({ store, evidence }) => {
    const profile = store.readCredential(store.findCredential('technitium-axi')!) as Record<string, unknown>
    await expect(preflight('technitium-axi', profile)).resolves.toBeUndefined()
    const inspection = await inspectCertificate(new URL(String(profile.origin)), String(profile.caFile), undefined, undefined, 'localhost')
    expect(inspection.chain[0].matchesHostname).toBe(true)
    await expect(preflight('technitium-axi', { ...profile, tlsServerName: 'wrong.synthetic.test' })).rejects.toMatchObject({ code: 'UPSTREAM_TLS_FAILED' })
    expect((await evidence()).requests).toEqual([])
  })
})

test('native authentication failures direct the public client to managed credential recovery', async () => {
  await withTechnitium(async ({ cli, store }) => {
    const current = store.findCredential('technitium-axi')!
    store.replaceCredential('technitium-axi', { ...store.readCredential(current) as Record<string, unknown>, token: 'CANARY-invalid' }, 1, actor, Date.now())
    await expect(cli(['technitium-axi', 'user', 'session', 'get', '--json'])).rejects.toMatchObject({
      stdout: expect.stringContaining('Ask an administrator to update the managed credential and connection settings.'),
    })
  })
})

test('revoked access blocks retrieval until the current grant is restored', async () => {
  await withTechnitium(async ({ cli, app, headers, db }) => {
    const { result } = JSON.parse((await cli(['technitium-axi', 'user', 'session', 'get', '--json'])).stdout)
    db.prepare("DELETE FROM role_tools WHERE tool = 'technitium-axi'").run()
    expect((await app.inject({ url: result.path, headers })).json().error.code).toBe('TOOL_NOT_GRANTED')
    db.prepare("INSERT INTO role_tools VALUES ('synthetic-role', 'technitium-axi')").run()
    db.prepare("UPDATE tools SET enabled = 0 WHERE name = 'technitium-axi'").run()
    expect((await app.inject({ url: result.path, headers })).json().error.code).toBe('TOOL_DISABLED')
    db.prepare("UPDATE tools SET enabled = 1 WHERE name = 'technitium-axi'").run()
    expect((await app.inject({ url: result.path, headers })).rawPayload).toEqual(reads[0].bytes)
  })
})

test.each([
  { args: ['zone', 'export', '--zone', 'synthetic.test', '--result-file', '/tmp/result'], code: 'FLAG_BLOCKED' },
  { args: ['status', '--profile=other'], code: 'FLAG_BLOCKED' },
  { args: ['zone', 'create', '--zone', 'synthetic.test'], code: 'INVALID_INPUT' },
  { args: ['home'], code: 'INVALID_INPUT' },
])('Technitium refuses $args before forwarding', async ({ args, code }) => {
  await withTechnitium(async ({ app, headers, evidence }) => {
    const refused = await app.inject({ method: 'POST', url: '/v1/tools/technitium-axi/run', headers, payload: { args } })
    expect(refused.json().error.code).toBe(code)
    expect((await evidence()).requests).toEqual([])
  })
})

test('Technitium discovery and status describe managed credentials and read-only capability', async () => {
  await withTechnitium(async ({ cli, app, headers, evidence }) => {
    expect((await cli(['technitium-axi', 'status'])).stdout).toContain('Technitium DNS')
    const help = JSON.parse((await cli(['technitium-axi', 'zone', 'export', '--help', '--json'])).stdout)
    expect(help.command).toBe('artium-axi technitium-axi zone export')
    expect(help.flags).toContain('--zone')
    expect(help.flags).not.toContain('--result-file')
    expect((await cli(['tools', 'show', 'technitium-axi'])).stdout).toContain('zone export')
    const status = JSON.parse((await cli(['technitium-axi', 'auth', 'status', '--json'])).stdout)
    expect(status.tokenSource).toBe('env')
    expect(JSON.stringify(status)).not.toContain('ARTIUM_SECRET_')
    expect((await app.inject({ url: '/v1/tools', headers })).json().tools).toMatchObject([{ name: 'technitium-axi', readOnly: true }])
    expect((await evidence()).requests).toEqual([{ method: 'POST', path: '/api/status', canaryReceived: false, fields: {} }])
  })
})
