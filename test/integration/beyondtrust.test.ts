import { readFileSync, watch } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { request } from 'node:https'
import { decode } from '@toon-format/toon'
import { expect, test, vi } from 'vitest'
import { copyClientInput } from '../fixtures/client-inputs.js'
import * as credentialTls from '../../src/server/credential-tls.js'
import * as healthPreflight from '../../src/server/health/preflight.js'
import { createApp } from '../../src/server/app.js'
import { createBeyondtrustAdapter } from '../../src/server/adapters/beyondtrust.js'
import { toolFailure } from '../../src/server/health/diagnostic.js'
import type { PreparedCall } from '../../src/server/adapters/types.js'
import { SessionStore } from '../../src/cli/session.js'
import { ArtifactStore, artifactDefaults } from '../../src/server/artifacts.js'
import { Audit } from '../../src/server/audit/audit.js'
import { issueRecentAuthTicket } from '../../src/server/auth/tokens.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { runTool } from '../../src/server/runner/run.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { transferLimits } from '../../src/shared/api.js'
import type { TransferScope } from '../../src/shared/api.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

async function withBeyondtrust(check: (fixture: {
  app: ReturnType<typeof createApp>, db: ReturnType<typeof openStore>, directory: string,
  post: (path: string, body?: unknown) => Promise<Response>,
  get: (path: string) => Promise<Response>,
  cli: (args: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }>,
  enable: (operations: string[], allowDeletes?: boolean) => Promise<void>, run: (args: string[], input?: object) => Promise<{ stdout: string, exitCode: number }>,
  evidence: () => Promise<{ requests: { path: string, canaryReceived: boolean, scope?: string }[], mutations: number }>,
}) => Promise<void>, options: { interruption?: string, signal?: AbortSignal, invalidResponse?: boolean } = {}) {
  await withFakeService(async ({ directory, port, send }) => {
    const bundle = copyClientInput('bundle', join(directory, 'artium-axi.mjs'))
    const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), key)
    const credentials = createCredentialStore(db, key)
    await seedToolUser(db)
    db.exec('UPDATE users SET administrator = 1')
    const adapter = createBeyondtrustAdapter(new EmbeddedSecretSource(credentials), join(directory, 'journal', 'writes.log'))
    const wrap = (call: PreparedCall): PreparedCall => ({ ...call, executable: process.execPath,
          args: ['--import', join(process.cwd(), 'test/fake-service/beyondtrust-transport.mjs'),
            join(process.cwd(), 'tools/node_modules/@knowttl/beyondtrust-axi/bin/beyondtrust-axi.js'), ...call.args],
          limits: call.write && ['native-deadline', 'timeout'].includes(options.interruption ?? '')
            ? { ...call.limits, timeoutMs: options.interruption === 'native-deadline' ? 5000 : 2000 } : call.limits,
          environment: { ...call.environment, ARTIUM_TEST_BEYONDTRUST_ORIGIN: `https://localhost:${port}`,
            ...(options.invalidResponse ? { ARTIUM_TEST_BEYONDTRUST_INVALID_RESPONSE: '1' } : {}),
            ...(options.interruption && call.write ? { ARTIUM_TEST_BEYONDTRUST_INTERRUPTION: options.interruption,
              ARTIUM_TEST_BEYONDTRUST_COMMITTED: join(directory, 'committed') } : {}) } })
    const prepare = adapter.prepare.bind(adapter)
    const prepareArtifact = adapter.prepareArtifact!.bind(adapter)
    adapter.prepare = async (...input) => wrap(await prepare(...input))
    adapter.prepareArtifact = async (...input) => wrap(await prepareArtifact(...input))
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const audit = new Audit(db)
    const root = join(directory, 'artifacts')
    await mkdir(root, { mode: 0o700 })
    const artifactStore = await ArtifactStore.create(audit, root, { inspect: async () => ({
      mountinfo: `1 2 0:1 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw`, filesystemType: 0x01021994,
      capacityBytes: transferLimits.reservedBytes, freeBytes: transferLimits.reservedBytes,
      memoryMax: artifactDefaults.containerBytes, memoryCurrent: 0, swapMax: 0, swapCurrent: 0 }) })
    const rejectNetwork = vi.spyOn(credentialTls, 'credentialFetch').mockRejectedValue(new Error('Unexpected synthetic network request'))
    const preflight = options.invalidResponse ? vi.spyOn(healthPreflight, 'preflight').mockResolvedValue() : undefined
    const app = createApp({ db, audit, runner, adapters: [adapter], credentialStore: credentials,
      resolver: new SharedIdentityResolver(credentials), artifactStore, environment: {} })
    const url = await app.listen({ host: '127.0.0.1', port: 0 })
    const token = issueTestAccessToken(db, 'synthetic-development-user')
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: token,
      refreshToken: 'CANARY-unused-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 43200000 })
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-encoding': 'identity',
      'x-artium-reauth-ticket': issueRecentAuthTicket(db, token).ticket }
    const post = (path: string, body: unknown = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) })
    const settings = async () => (await fetch(url + '/v1/admin/tools/beyondtrust-axi', { headers })).json()
    const cli = async (args: string[]) => {
      const child = spawn(process.execPath, [bundle, 'download', ...args, '--password-stdin'],
        { env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdin.end('CANARY-local-password\n')
      const [code] = await once(child, 'close')
      expect(stdout + stderr).not.toContain('CANARY-')
      return { code, stdout, stderr }
    }
    try {
      const saved = await fetch(url + '/v1/admin/tools/beyondtrust-axi/credential', { method: 'PATCH', headers,
        body: JSON.stringify({ value: { host: 'example.pm.beyondtrustcloud.com', clientId: 'synthetic-client', clientSecret: 'CANARY-beyondtrust-secret' },
          expectedRevision: 0, expectedToolRevision: 1 }) })
      expect(saved.status, await saved.clone().text()).toBe(200)
      expect(await saved.text()).not.toContain('CANARY-')
      const activated = await fetch(url + '/v1/admin/tools/beyondtrust-axi', { method: 'PATCH', headers,
        body: JSON.stringify({ enabled: true, expectedRevision: (await settings()).revision }) })
      expect(activated.status).toBe(200)
      const enable = async (operations: string[], allowDeletes = false) => {
        const response = await fetch(url + '/v1/admin/tools/beyondtrust-axi/write-access', { method: 'PATCH', headers,
          body: JSON.stringify({ enabled: true, operations, allowDeletes, expectedRevision: (await settings()).revision }) })
        expect(response.status, await response.clone().text()).toBe(200)
      }
      const run = async (args: string[], input = {}) => {
        if (options.interruption) return runTool(db, audit, runner, token, { args, ...input }, adapter,
          new SharedIdentityResolver(credentials), { requestId: crypto.randomUUID(), clientAddress: '127.0.0.1', signal: options.signal })
        const response = await post('/v1/tools/beyondtrust-axi/run', { args, ...input })
        expect(response.status, await response.clone().text()).toBe(200)
        const result = await response.json()
        expect(JSON.stringify(result)).not.toMatch(/CANARY-beyondtrust-(secret|token)/)
        return result
      }
      await check({ app, db, directory, post, get: path => fetch(url + path, { headers }), cli, enable, run,
        evidence: async () => JSON.parse(await send('/__evidence')) })
      expect(await readdir(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close(); rejectNetwork.mockRestore(); preflight?.mockRestore() }
  })
}

const id = '11111111-1111-4111-8111-111111111111'
test.each([undefined, 'wrong-scope'])('the fake token endpoint refuses scope %s', async scope => {
  await withFakeService(async ({ directory, port }) => {
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: 'synthetic-client',
      client_secret: 'CANARY-beyondtrust-secret', ...(scope === undefined ? {} : { scope }) })
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({ hostname: 'localhost', servername: 'localhost', port, path: '/oauth/connect/token', method: 'POST',
        ca: readFileSync(join(directory, 'ca.crt')), headers: { host: 'example.pm.beyondtrustcloud.com', 'content-type': 'application/x-www-form-urlencoded' } }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end(form.toString())
    })
    expect(status).toBe(401)
  })
})
test('a crash before native intent creation retains the durable host intent identity', async () => {
  await withBeyondtrust(async ({ run, enable, evidence, directory, db }) => {
    await enable(['computer.authorise'])
    const args = ['computer', 'authorise', id]
    const { confirmation } = decode((await run(args)).stdout) as { confirmation: string }
    const result = await run([...args, '--execute', '--confirm', confirmation])
    expect(result.exitCode, result.stdout).toBe(1)
    const { error } = decode(result.stdout) as { error: { code: string, auditId: string } }
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    const root = join(directory, 'journal', 'writes.log.runs')
    const [call] = await readdir(root)
    const path = join(root, call, 'intent.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ auditId: error.auditId, state: 'intent', operation: 'computer authorise' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await evidence()).mutations).toBe(0)
    expect(db.prepare("SELECT action, native_audit_id FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ action: 'unknown', native_audit_id: error.auditId })
  }, { interruption: 'before-intent-crash' })
})
test('cancellation before child launch remains a cancellation without a mutation', async () => {
  const controller = new AbortController()
  await withBeyondtrust(async ({ run, enable, evidence }) => {
    await enable(['computer.authorise'])
    const args = ['computer', 'authorise', id]
    const { confirmation } = decode((await run(args)).stdout) as { confirmation: string }
    controller.abort()
    await expect(run([...args, '--execute', '--confirm', confirmation])).rejects.toMatchObject({ code: 'CANCELLED' })
    expect((await evidence()).mutations).toBe(0)
  }, { interruption: 'cancel', signal: controller.signal })
})
test.each(['native-deadline', 'timeout', 'cancel', 'crash', 'exit'])('a committed mutation interrupted by %s retains its native audit identity', async interruption => {
  const controller = new AbortController()
  await withBeyondtrust(async ({ run, enable, evidence, directory, db }) => {
    await enable(['computer.authorise'])
    const args = ['computer', 'authorise', id]
    const preview = await run(args)
    expect(preview.exitCode, preview.stdout).toBe(0)
    const { confirmation } = decode(preview.stdout) as { confirmation: string }
    const watcher = watch(directory, (_event, name) => {
      if (interruption === 'cancel' && name === 'committed') controller.abort()
    })
    try {
      const result = await run([...args, '--execute', '--confirm', confirmation])
      expect(result.exitCode, result.stdout).toBe(1)
      const { error } = decode(result.stdout) as { error: { code: string, auditId: string } }
      expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', auditId: expect.any(String) })
      expect((await evidence()).mutations).toBe(1)
      const root = join(directory, 'journal', 'writes.log.runs')
      const [call] = await readdir(root)
      const intent = JSON.parse(readFileSync(join(root, call, 'beyondtrust-axi', 'writes', error.auditId + '.json'), 'utf8'))
      expect(intent).toMatchObject({ auditId: error.auditId, state: 'intent', operation: 'computer.authorise' })
      expect(db.prepare("SELECT action, outcome, native_audit_id, error_code FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ action: 'write', outcome: 'UNKNOWN_OUTCOME', native_audit_id: error.auditId, error_code: 'OUTCOME_UNKNOWN' })
      expect(JSON.stringify(result)).not.toMatch(/CANARY-beyondtrust-(secret|token)/)
    } finally { watcher.close() }
  }, { interruption, signal: controller.signal })
})
test('managed cursor resumes across isolated calls', async () => {
  await withBeyondtrust(async ({ run }) => {
    const args = ['computer', 'list', '--host', 'fleet', '--limit', '1']
    const first = await run(args)
    expect(first.exitCode, first.stdout).toBe(0)
    const { cursor } = decode(first.stdout) as { cursor: string }
    expect(cursor).toEqual(expect.any(String))
    const next = await run([...args, '--cursor', cursor])
    expect(next.exitCode, next.stdout).toBe(0)
    expect(decode(next.stdout)).toMatchObject({ count: 1, total: 1001 })
  })
})
test('managed doctor and about accept the fake version records', async () => {
  await withBeyondtrust(async ({ run, evidence }) => {
    const doctor = await run(['doctor'])
    expect(doctor.exitCode, doctor.stdout).toBe(0)
    expect(decode(doctor.stdout)).toMatchObject({ authentication: 'verified for this run' })
    const about = await run(['about'])
    expect(about.exitCode, about.stdout).toBe(0)
    expect(decode(about.stdout)).toMatchObject({ versions: [{ consoleVersion: '3', reportingDatabaseVersion: '3', policyEditorVersion: '3' }] })
    expect(new Set((await evidence()).requests.filter(record => record.path === '/oauth/connect/token').map(record => record.scope)))
      .toEqual(new Set(['urn:management:api']))
  })
})
test('malformed fake responses retain redacted shape diagnostics in client and health output with code-only audit evidence', async () => {
  await withBeyondtrust(async ({ run, post, get }) => {
    const result = await run(['about'])
    expect(result.exitCode, result.stdout).toBe(1)
    expect(decode(result.stdout)).toMatchObject({ error: { code: 'API_RESPONSE_INVALID',
      status: 200, contentType: 'application/json', shapeTruncated: false,
      issuePaths: ['$'], issuePathsTruncated: false,
      issues: [{ path: '$', received: 'object', expected: 'unknown', code: 'custom' }],
      shape: [{ path: '$', type: 'object' }, { path: '$["data"]', type: 'array' },
        { path: '$["data"][*]', type: 'object' }, { path: '$["data"][*]["host"]', type: 'string' },
        { path: '$["data"][*]["clientSecret"]', type: 'string' }, { path: '$["data"][*]["token"]', type: 'string' },
        { path: '$["data"][*]["<key>"]', type: 'string' }, { path: '$["data"][*]["<key>"]', type: 'string' },
        { path: '$["totalRecordCount"]', type: 'string' }] } })
    expect(result.stdout).not.toContain('CANARY-')
    expect(result.stdout).not.toContain(id)

    const tested = await post('/v1/admin/tools/beyondtrust-axi/test')
    const failure = await tested.json()
    expect(failure).toMatchObject({ error: { diagnostic: { toolCode: 'API_RESPONSE_INVALID', message: result.stdout.trim() } } })
    const settings = await (await get('/v1/admin/tools/beyondtrust-axi')).json()
    expect(settings.health.diagnostic.message).toBe(result.stdout.trim())
    expect(JSON.stringify(failure) + JSON.stringify(settings)).not.toContain('CANARY-')

    const audit = await (await get('/v1/admin/audit?tool=beyondtrust-axi')).json()
    expect(audit.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'run-terminal', error_code: 'API_RESPONSE_INVALID' }),
    ]))
    expect(JSON.stringify(audit)).not.toContain('CANARY-')
    expect(JSON.stringify(audit)).not.toContain('shape')
  }, { invalidResponse: true })
})
test('malformed event lists return a normal tool failure with a classified response diagnostic', async () => {
  await withBeyondtrust(async ({ run, db }) => {
    const result = await run(['event', 'list'])
    expect(result.exitCode, result.stdout).toBe(1)
    expect(decode(result.stdout)).toMatchObject({ error: { code: 'API_RESPONSE_INVALID',
      issues: [{ path: '$', received: 'object', expected: 'unknown', code: 'unrecognized_keys' }] } })
    expect(toolFailure(result.stdout, '', result.exitCode, 'beyondtrust-axi')).toMatchObject({
      code: 'UPSTREAM_RESPONSE_INVALID', diagnostic: { stage: 'response', toolCode: 'API_RESPONSE_INVALID' } })
    expect(db.prepare("SELECT outcome, error_code FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get())
      .toEqual({ outcome: 'completed', error_code: 'API_RESPONSE_INVALID' })
  }, { invalidResponse: true })
})
test('managed all reads span pages and resume the final partial page', async () => {
  await withBeyondtrust(async ({ run }) => {
    const args = ['computer', 'list', '--host', 'fleet']
    const first = await run([...args, '--all'])
    expect(first.exitCode, first.stdout).toBe(0)
    const value = decode(first.stdout) as { count: number, total: number, cursor: string }
    expect(value).toMatchObject({ count: 1000, total: 1001 })
    const last = await run([...args, '--all', '--cursor', value.cursor])
    expect(last.exitCode, last.stdout).toBe(0)
    expect(decode(last.stdout)).toMatchObject({ count: 1, total: 1001, cursor: null })
  })
})
test('managed published CLI reads, previews, confirms and journals a single mutation', async () => {
  await withBeyondtrust(async ({ run, enable, evidence, db }) => {
    expect((await run(['computer', 'list', '--limit=1'])).stdout).toContain('example')
    const args = ['computer', 'authorise', id]
    expect((await run(args)).stdout).toContain('WRITES_DISABLED')
    await enable(['computer.authorise'])
    const preview = await run(args)
    expect(preview.exitCode, preview.stdout).toBe(0)
    const { confirmation } = decode(preview.stdout) as { confirmation: string }
    expect((await run([...args, '--execute', '--confirm', 'wrong'])).exitCode).toBe(1)
    expect((await evidence()).mutations).toBe(0)
    expect((await run([...args, '--execute', '--confirm', confirmation])).exitCode).toBe(0)
    expect((await evidence()).mutations).toBe(1)
    expect(db.prepare("SELECT action FROM audit WHERE tool = 'beyondtrust-axi' AND event = 'run-terminal' ORDER BY id DESC LIMIT 1").get()).toEqual({ action: 'write' })
    expect((await evidence()).requests.every(record => record.canaryReceived)).toBe(true)
    expect(new Set((await evidence()).requests.filter(record => record.path === '/oauth/connect/token').map(record => record.scope)))
      .toEqual(new Set(['urn:management:api']))
  })
})
test('administrator delete toggle and both exact confirmations gate deletes', async () => {
  await withBeyondtrust(async ({ run, enable, evidence }) => {
    const args = ['computer', 'delete', id]
    await enable(['computer.delete'])
    expect((await run(args)).stdout).toContain('DELETES_DISABLED')
    await enable(['computer.delete'], true)
    const preview = await run(args)
    expect(preview.exitCode, preview.stdout).toBe(0)
    const { confirmation, deleteConfirmation } = decode(preview.stdout) as { confirmation: string, deleteConfirmation: string }
    expect((await run([...args, '--execute', '--confirm', confirmation])).stdout).toContain('DELETE_CONFIRM_REQUIRED')
    expect((await evidence()).mutations).toBe(0)
    expect((await run([...args, '--execute', '--confirm', confirmation, '--confirm-delete', deleteConfirmation])).exitCode).toBe(0)
    expect((await evidence()).mutations).toBe(1)
  })
})
test('uploaded CSV uses a stable private leaf for native digest confirmation', async () => {
  await withBeyondtrust(async ({ run, enable, evidence }) => {
    await enable(['group.import-computers'])
    const input = { files: [{ name: 'computers.csv', contentBase64: Buffer.from('HostName\nexample\n').toString('base64') }] }
    const args = ['group', 'import-computers', id, '--file', 'computers.csv']
    const preview = await run(args, input)
    expect(preview.exitCode, preview.stdout).toBe(0)
    const { confirmation } = decode(preview.stdout) as { confirmation: string }
    expect((await run([...args, '--execute', '--confirm', confirmation], input)).exitCode).toBe(0)
    expect((await evidence()).mutations).toBe(1)
  })
})
test.each([
  { operation: 'computer.log.download', selector: id, type: 'content' },
  { operation: 'policy.download', selector: id, type: 'content' },
  { operation: 'policy.revision.download', selector: id, type: 'content' },
  { operation: 'api-definition.download', selector: 'api', type: 'yaml' },
])('host-confirmed $operation saves verified bytes through the bundled CLI', async selection => {
  await withBeyondtrust(async ({ cli, enable, directory, evidence }) => {
    await enable([selection.operation])
    await mkdir(join(directory, 'downloads'), { mode: 0o700 })
    const destination = join(directory, 'downloads', 'content')
    const args = ['--operation', selection.operation, '--selector', selection.selector, '--type', selection.type, '--destination', destination]
    const preview = await cli(args)
    expect(preview.code, preview.stdout).toBe(0)
    const { transferId, confirm } = decode(preview.stdout) as { transferId: string, confirm: string }
    const result = await cli([...args, '--transfer', transferId, '--execute', '--confirm', confirm])
    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toContain('saveOutcome: verified-save')
    expect(readFileSync(destination, 'utf8')).toBe('Synthetic inert BeyondTrust artifact\n')
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect(new Set((await evidence()).requests.filter(record => record.path === '/oauth/connect/token').map(record => record.scope)))
      .toEqual(new Set(['urn:management:api']))
  })
})

test('bulk filter confirmation binds a count above the normal read cap', async () => {
  await withBeyondtrust(async ({ run, enable, evidence }) => {
    await enable(['computer.authorise'])
    const args = ['computer', 'authorise', '--host', 'fleet']
    const preview = await run(args)
    expect(preview.exitCode, preview.stdout).toBe(0)
    const value = decode(preview.stdout) as { confirmation: string, preview: { count: number, hosts: unknown[] } }
    expect(value.preview.count).toBe(1001)
    expect(value.preview.hosts).toHaveLength(20)
    expect(value.confirmation).toContain('1001')
    expect((await run([...args, '--execute', '--confirm', value.confirmation])).exitCode).toBe(0)
    expect((await evidence()).mutations).toBe(1)
  })
})
test.each([
  { change: 'selector', expected: 400 }, { change: 'destination', expected: 400 },
  { change: 'credential', expected: 409 }, { change: 'policy', expected: 400 },
])('download execution rechecks $change without sending a native download', async ({ change, expected }) => {
  await withBeyondtrust(async ({ post, enable, db, evidence, directory }) => {
    await enable(['policy.download'])
    const input = { selection: { operation: 'policy.download', selector: id, type: 'content' }, targetDigest: 'a'.repeat(64) }
    const preview = await (await post('/v1/transfers/beyondtrust/prepare', input)).json()
    if (change === 'credential') db.exec("UPDATE credentials SET revision = revision + 1 WHERE tool = 'beyondtrust-axi'")
    if (change === 'policy') db.exec("UPDATE tools SET native_settings = '{}' WHERE name = 'beyondtrust-axi'")
    const result = await post('/v1/transfers/beyondtrust/execute', { ...input,
      ...(change === 'selector' ? { selection: { ...input.selection, selector: '22222222-2222-4222-8222-222222222222' } } : {}),
      ...(change === 'destination' ? { targetDigest: 'b'.repeat(64) } : {}),
      transferId: preview.transferId, execute: true, confirm: preview.confirm })
    expect(result.status).toBe(expected)
    expect((await evidence()).requests.filter(record => record.path.endsWith('/Content'))).toEqual([])
    expect(await readdir(join(directory, 'artifacts'))).toEqual([])
  })
})

