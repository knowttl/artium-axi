import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { Writable, Readable } from 'node:stream'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { toolInput } from '../../src/cli/input.js'
import { createApp } from '../../src/server/app.js'
import { createHybridAdapter } from '../../src/server/adapters/hybrid.js'
import { Audit } from '../../src/server/audit/audit.js'
import { ArtifactStore, artifactDefaults } from '../../src/server/artifacts.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { loginResponseSchema, transferRoutes, transferLimits } from '../../src/shared/api.js'
import { transferTargetDigest } from '../../src/server/transfer.js'
import { withFakeService } from '../fake-service/fixture.js'
import { seedToolUser } from '../fixtures/tokens.js'

test('managed Hybrid Analysis reads and native guarded writes use the published CLI with synthetic credentials', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const log = join(directory, 'writes.log')
    const adapter = createHybridAdapter(new EmbeddedSecretSource(store), log)
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', join(process.cwd(), 'test/fake-service/hybrid-transport.mjs'),
          join(process.cwd(), 'tools/node_modules/@knowttl/hybrid-axi/bin/hybrid-axi.js'), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 3),
        environment: { ...call.environment, ARTIUM_TEST_HYBRID_ORIGIN: `https://localhost:${port}` } }
    }
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const prepareArtifact = adapter.prepareArtifact!.bind(adapter)
    adapter.prepareArtifact = async (...input) => {
      const call = await prepareArtifact(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', join(process.cwd(), 'test/fake-service/hybrid-transport.mjs'),
          join(process.cwd(), 'tools/node_modules/@knowttl/hybrid-axi/bin/hybrid-axi.js'), ...call.args],
        environment: { ...call.environment, ARTIUM_TEST_HYBRID_ORIGIN: `https://localhost:${port}` } }
    }
    const audit = new Audit(db, Date.now, () => {})
    const root = join(directory, 'artifacts')
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(join(directory, 'downloads'), { mode: 0o700 })
    const artifactStore = await ArtifactStore.create(audit, root, { inspect: async () => ({
      mountinfo: `1 2 0:1 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1048576k`,
      filesystemType: 0x01021994, capacityBytes: transferLimits.reservedBytes, freeBytes: transferLimits.reservedBytes,
      memoryMax: artifactDefaults.containerBytes, memoryCurrent: 0, swapMax: 0, swapCurrent: 0 }) })
    const app = createApp({ db, audit, runner, adapters: [adapter], artifactStore,
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    try {
      await seedToolUser(db)
      db.exec('UPDATE users SET administrator = 1')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
        username: 'synthetic-user', password: 'CANARY-local-password' } })
      const session = loginResponseSchema.parse(login.json())
      if (session.status !== 'authenticated') throw new Error('Expected local login')
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
      const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      headers['x-artium-reauth-ticket'] = reauth.json().ticket
      const settings = () => app.inject({ method: 'GET', url: '/v1/admin/tools/hybrid-axi', headers })
      const save = async (apiKey: string, expectedRevision: number) => app.inject({ method: 'PATCH', url: '/v1/admin/tools/hybrid-axi/credential', headers,
        payload: { value: { apiKey }, expectedRevision, expectedToolRevision: (await settings()).json().revision } })
      const saved = await save('CANARY-hybrid-key', 0)
      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.body).not.toContain('CANARY-')
      expect((await app.inject({ method: 'PATCH', url: '/v1/admin/tools/hybrid-axi', headers,
        payload: { enabled: true, expectedRevision: (await settings()).json().revision } })).statusCode).toBe(200)
      const run = async (args: string[], input = {}) => {
        const response = await app.inject({ method: 'POST', url: '/v1/tools/hybrid-axi/run', headers, payload: { args, ...input } })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.body).not.toContain('CANARY-hybrid')
        return response.json() as { stdout: string, exitCode: number }
      }
      expect((await run(['quota'])).stdout).toContain('default')
      const home = await run([])
      expect(decode(home.stdout)).toMatchObject({ bin: 'artium-axi hybrid-axi' })
      expect(home.stdout).not.toContain(directory)
      const status = await run(['auth', 'status'])
      expect(decode(status.stdout)).toMatchObject({ apiKey: 'env', source: 'env' })
      expect(status.stdout).not.toMatch(/ARTIUM_SECRET_|config:|hybrid-profile|artium-call-/)
      const unknown = await app.inject({ method: 'POST', url: '/v1/tools/hybrid-axi/run', headers,
        payload: { args: ['quota', '--synthetic-unknown'] } })
      expect(unknown.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'Unknown flag --synthetic-unknown for hybrid-axi quota.' } })
      const incomplete = await app.inject({ method: 'POST', url: '/v1/tools/hybrid-axi/run', headers,
        payload: { args: ['hash', '--help'] } })
      expect(incomplete.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'Incomplete command "hash" for hybrid-axi.' } })
      const checked = await app.inject({ method: 'POST', url: '/v1/admin/tools/hybrid-axi/test', headers, payload: {} })
      expect(checked.json()).toMatchObject({ status: 'ok' })
      const submit = ['submit', 'url', '--url', 'https://example.com/synthetic', '--environment-id', '160']
      expect((await run(submit)).stdout).toContain('WRITES_DISABLED')
      expect((await run(['hunting', 'matches'])).stdout).toContain('WRITES_DISABLED')
      expect((await run(['hunting', 'yara', 'delete', 'synthetic-rule'])).stdout).toContain('WRITES_DISABLED')
      const operations = ['submitUrl', 'submitFile', 'yaraCreate', 'yaraUpdate', 'yaraDelete', 'huntingMatches']
      const writes = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/hybrid-axi/write-access', headers,
        payload: { enabled: true, operations, expectedRevision: (await settings()).json().revision } })
      expect(writes.statusCode, writes.body).toBe(200)
      const preview = await run(submit)
      expect(preview.stdout).toContain('community')
      const plan = decode(preview.stdout) as { preview: { confirm: string } }
      expect((await run([...submit, '--execute', '--confirm', 'incorrect'])).stdout).toContain('CONFIRM_MISMATCH')
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      const execute = [...submit, '--execute', '--confirm', plan.preview.confirm, '--intent-id', 'synthetic-submit']
      expect((await run(execute)).exitCode).toBe(0)
      expect((await run(execute)).stdout).toContain('ALREADY_EXECUTED')
      const upload = await toolInput('hybrid-axi', ['quick-scan', 'file', '--file', join(process.cwd(), 'package.json'), '--scan-type', 'all_lookup'])
      expect((await run(upload.args, { files: upload.files })).exitCode).toBe(0)
      const sample = { files: [{ name: 'synthetic sample.json', contentBase64: upload.files![0].contentBase64 }] }
      const fileSubmit = ['submit', 'file', '--file', 'synthetic sample.json', '--environment-id', '160',
        '--custom-cmd-line=--silent', '--document-password=-password', '--comment=-comment', '--submit-name=-name']
      const filePlan = decode((await run(fileSubmit, sample)).stdout) as { preview: { confirm: string } }
      expect((await run([...fileSubmit, '--execute', '--confirm', filePlan.preview.confirm], sample)).exitCode).toBe(0)
      const rule = JSON.stringify({ identifier: 'Synthetic rule', threat_categories: [], active: false, rule: 'rule synthetic { condition: false }' })
      const create = ['hunting', 'yara', 'create', '--body-file', '-']
      const yara = decode((await run(create, { stdin: rule })).stdout) as { preview: { confirm: string } }
      expect((await run([...create, '--execute', '--confirm', yara.preview.confirm], { stdin: rule })).exitCode).toBe(0)
      const update = ['hunting', 'yara', 'update', 'synthetic-rule', '--body-file', '-']
      const updatedBody = '{"active":true}'
      const updatePlan = decode((await run(update, { stdin: updatedBody })).stdout) as { preview: { confirm: string } }
      expect((await run([...update, '--execute', '--confirm', updatePlan.preview.confirm], { stdin: updatedBody })).exitCode).toBe(0)
      const remove = ['hunting', 'yara', 'delete', 'synthetic-rule']
      const deletePlan = decode((await run(remove)).stdout) as { preview: { confirm: string } }
      expect((await run([...remove, '--execute', '--confirm', deletePlan.preview.confirm])).exitCode).toBe(0)
      const matches = decode((await run(['hunting', 'matches'])).stdout) as { preview: { confirm: string } }
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(5)
      expect((await run(['hunting', 'matches', '--execute', '--confirm', matches.preview.confirm])).exitCode).toBe(0)
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(6)
      const download = await app.inject({ method: 'POST', url: '/v1/tools/hybrid-axi/run', headers,
        payload: { args: ['hash', 'file', 'a'.repeat(64), '--output', 'sample.bin', '--execute'] } })
      expect(download.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED', message: 'Use artium-axi download for authenticated archive saving.' } })
      const reportDownload = await app.inject({ method: 'POST', url: '/v1/tools/hybrid-axi/run', headers,
        payload: { args: ['report', 'file', 'synthetic-job', '--type', 'memory', '--output', '/synthetic/private/memory.gz', '--execute'] } })
      expect(reportDownload.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.stringify(db.prepare("SELECT * FROM audit WHERE event = 'denial'").all())).not.toContain('/synthetic/private')
      const transfer = { selection: { operation: 'hash-download-bin', selector: 'a'.repeat(64), type: 'bin' }, targetDigest: 'b'.repeat(64) }
      const unavailable = await app.inject({ method: 'POST', url: transferRoutes.prepare.path, headers, payload: transfer })
      expect(unavailable.statusCode).toBe(400)
      expect(unavailable.json().error.code).toBe('FLAG_BLOCKED')
      expect((await app.inject({ method: 'POST', url: transferRoutes.execute.path, headers, payload: {
        ...transfer, transferId: '77066c24-bcb0-4a39-9304-551a617ac080', execute: true, confirm: 'synthetic-confirm',
      } })).statusCode).toBe(401)
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      const cli = async (args: string[]) => {
        const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli/artium-axi.mjs'), '--managed-session', 'download', ...args, '--password-stdin'],
          { env: { PATH: process.env.PATH, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout!.on('data', chunk => { stdout += chunk })
        child.stderr!.on('data', chunk => { stderr += chunk })
        ;(child.stdio[3] as Writable).end(JSON.stringify({ serverUrl: url, accessToken: session.accessToken }))
        ;(child.stdio[4] as Readable).resume()
        child.stdin!.end('CANARY-local-password\n')
        const [code] = await once(child, 'close')
        expect({ code, stderr, stdout }).toMatchObject({ code: 0, stderr: '' })
        expect(stdout).not.toContain('CANARY-')
        return stdout
      }
      const selections = [
        { operation: 'hash-download-bin', selector: 'a'.repeat(64), type: 'bin' },
        { operation: 'report-download-bin', selector: 'synthetic-job', type: 'bin' },
        { operation: 'report-download-dropped-files', selector: 'synthetic-job', type: 'dropped-files' },
        { operation: 'report-download-memory', selector: 'synthetic-job', type: 'memory' },
      ]
      for (const selection of selections) {
        headers['x-artium-reauth-ticket'] = (await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers,
          payload: { password: 'CANARY-local-password' } })).json().ticket
        const selected = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/hybrid-axi/write-access', headers,
          payload: { enabled: true, operations: [selection.operation], expectedRevision: (await settings()).json().revision } })
        expect(selected.statusCode, selected.body).toBe(200)
        expect(selected.json().writeAccess.allowedOperations).toEqual([selection.operation])
        const destination = join(directory, 'downloads', selection.operation)
        const args = ['--operation', selection.operation, '--selector', selection.selector, '--type', selection.type, '--destination', destination]
        const before = JSON.parse(await send('/__evidence')).mutations
        const plan = decode(await cli(args)) as { transferId: string, confirm: string }
        expect(JSON.parse(await send('/__evidence')).mutations).toBe(before)
        expect(await cli([...args, '--transfer', plan.transferId, '--execute', '--confirm', plan.confirm])).toContain('saveOutcome: verified-save')
        expect(JSON.parse(await send('/__evidence')).mutations).toBe(before + 1)
        expect(readFileSync(destination)).toEqual(Buffer.alloc(257, 0xa5))
        expect(readdirSync(root)).toEqual([])
      }
      headers['x-artium-reauth-ticket'] = (await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers,
        payload: { password: 'CANARY-local-password' } })).json().ticket
      expect((await save('CANARY-hybrid-restricted', store.findCredential('hybrid-axi')!.revision!)).statusCode).toBe(200)
      const denied = await run(['hash', 'show', 'a'.repeat(64)])
      expect(denied.exitCode).toBe(1)
      expect(denied.stdout).toContain('403')
      expect(denied.stdout).toContain('PERMISSION_DENIED')
      const restrictedInput = { selection: selections[3], targetDigest: transferTargetDigest(join(directory, 'downloads', 'restricted')) }
      const restrictedPlan = await app.inject({ method: 'POST', url: transferRoutes.prepare.path, headers, payload: restrictedInput })
      expect(restrictedPlan.statusCode, restrictedPlan.body).toBe(200)
      const restricted = await app.inject({ method: 'POST', url: transferRoutes.execute.path, headers, payload: {
        ...restrictedInput, transferId: restrictedPlan.json().transferId, confirm: restrictedPlan.json().confirm, execute: true } })
      expect(restricted.statusCode, restricted.body).toBe(403)
      expect(restricted.json().error.code).toBe('KEY_LEVEL_RESTRICTED')
      expect(readdirSync(root)).toEqual([])
      expect(JSON.parse(await send('/__evidence')).requests.every((request: { canaryReceived: boolean }) => request.canaryReceived)).toBe(true)
      const journals = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(journals.filter(record => record.kind === 'intent')).toHaveLength(11)
      expect(journals.filter(record => record.kind === 'outcome')).toHaveLength(11)
      const transferAudit = db.prepare("SELECT * FROM audit WHERE event = 'transfer'").all()
      expect(JSON.stringify(transferAudit)).not.toMatch(/CANARY-|untrusted-synthetic-name|downloads\/|paWl/)
      expect(transferAudit).toContainEqual(expect.objectContaining({ outcome: 'delivery-completed', client_save_outcome: 'verified-save', archive_bytes: 257 }))
      expect(db.prepare("SELECT count(*) AS count FROM audit WHERE tool = 'hybrid-axi' AND action = 'write' AND exit_code = 0").get()).toMatchObject({ count: 6 })
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
})
