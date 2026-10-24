import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { toolInput } from '../../src/cli/input.js'
import { createApp } from '../../src/server/app.js'
import { createHybridAdapter } from '../../src/server/adapters/hybrid.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { loginResponseSchema, transferRoutes } from '../../src/shared/api.js'
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
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter],
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
      expect(download.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED', message: 'Hosted downloads are not available yet through artium; use hybrid-axi locally.' } })
      const reportDownload = await app.inject({ method: 'POST', url: '/v1/tools/hybrid-axi/run', headers,
        payload: { args: ['report', 'file', 'synthetic-job', '--type', 'memory', '--output', '/synthetic/private/memory.gz', '--execute'] } })
      expect(reportDownload.json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect(JSON.stringify(db.prepare("SELECT * FROM audit WHERE event = 'denial'").all())).not.toContain('/synthetic/private')
      expect((await app.inject({ method: 'POST', url: transferRoutes.prepare.path, headers, payload: {} })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: transferRoutes.execute.path, headers, payload: {} })).statusCode).toBe(404)
      expect((await save('CANARY-hybrid-restricted', store.findCredential('hybrid-axi')!.revision!)).statusCode).toBe(200)
      const denied = await run(['hash', 'show', 'a'.repeat(64)])
      expect(denied.exitCode).toBe(1)
      expect(denied.stdout).toContain('403')
      expect(denied.stdout).toContain('PERMISSION_DENIED')
      expect(JSON.parse(await send('/__evidence')).requests.every((request: { canaryReceived: boolean }) => request.canaryReceived)).toBe(true)
      const journals = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(journals.filter(record => record.kind === 'intent')).toHaveLength(6)
      expect(db.prepare("SELECT count(*) AS count FROM audit WHERE tool = 'hybrid-axi' AND action = 'write' AND exit_code = 0").get()).toMatchObject({ count: 6 })
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
})
