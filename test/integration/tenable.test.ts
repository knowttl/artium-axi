import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createTenableAdapter } from '../../src/server/adapters/tenable.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { loginResponseSchema } from '../../src/shared/api.js'
import { withFakeService } from '../fake-service/fixture.js'
import { seedToolUser } from '../fixtures/tokens.js'

test('managed Tenable saves secret keys, reads, tests health and gates business writes and exports through the published CLI', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const log = join(directory, 'writes.log')
    const adapter = createTenableAdapter(new EmbeddedSecretSource(store), log)
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', join(process.cwd(), 'test/fake-service/tenable-transport.mjs'),
          join(process.cwd(), 'tools/node_modules/@knowttl/tenable-axi/bin/tenable-axi.js'), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 3),
        environment: { ...call.environment, ARTIUM_TEST_TENABLE_ORIGIN: `https://localhost:${port}` } }
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
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/tenable-axi/credential', headers,
        payload: { value: { accessKey: 'CANARY-tenable-access', secretKey: 'CANARY-tenable-secret' }, expectedRevision: 0, expectedToolRevision: 1 } })
      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.body).not.toContain('CANARY-')
      const settings = () => app.inject({ method: 'GET', url: '/v1/admin/tools/tenable-axi', headers })
      const enabled = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/tenable-axi', headers,
        payload: { enabled: true, expectedRevision: (await settings()).json().revision } })
      expect(enabled.statusCode, enabled.body).toBe(200)
      const run = async (args: string[], input = {}) => {
        const response = await app.inject({ method: 'POST', url: '/v1/tools/tenable-axi/run', headers, payload: { args, ...input } })
        expect(response.statusCode, response.body).toBe(200)
        expect(response.body).not.toMatch(/CANARY-tenable-(access|secret)/)
        return response.json() as { stdout: string, exitCode: number }
      }
      const read = await run(['card', 'list', '--limit', '1'])
      expect(read.exitCode, read.stdout).toBe(0)
      expect(read.stdout).toContain('Synthetic exposure')
      const checked = await app.inject({ method: 'POST', url: '/v1/admin/tools/tenable-axi/test', headers, payload: {} })
      expect(checked.json()).toMatchObject({ status: 'ok' })
      const create = ['tag', 'category', 'create', '--name', 'Synthetic category']
      expect((await run(create)).stdout).toContain('WRITES_DISABLED')
      expect((await run(['export', 'asset', 'start'])).stdout).toContain('WRITES_DISABLED')
      const operations = ['tags-create-tag-category', 'inventory-export-assets']
      const writes = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/tenable-axi/write-access', headers,
        payload: { enabled: true, operations, expectedRevision: (await settings()).json().revision } })
      expect(writes.statusCode, writes.body).toBe(200)
      expect(writes.json()).toMatchObject({ writeAccess: { enabled: true, allowedOperations: operations } })
      const preview = await run([...create, '--full'])
      expect(preview.exitCode, preview.stdout).toBe(0)
      const plan = decode(preview.stdout) as { preview: { confirm: string } }
      expect((await run([...create, '--execute', '--confirm', 'incorrect'])).stdout).toContain('CONFIRM_MISMATCH')
      expect((await run(['tag', 'category', 'delete', '--id', '11111111-1111-4111-8111-111111111111'])).stdout).toContain('OPERATION_NOT_WRITABLE')
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      const written = await run([...create, '--execute', '--confirm', plan.preview.confirm])
      expect(written.exitCode, written.stdout).toBe(0)
      const exportPreview = await run(['export', 'asset', 'start', '--body-file=body.json', '--full'], {
        files: [{ name: 'body.json', contentBase64: Buffer.from('{}').toString('base64') }],
      })
      expect(exportPreview.exitCode, exportPreview.stdout).toBe(0)
      const exportPlan = decode(exportPreview.stdout) as { preview: { confirm: string } }
      const exported = await run(['export', 'asset', 'start', '--body-file', '-', '--execute', '--confirm', exportPlan.preview.confirm], { stdin: '{}' })
      expect(exported.exitCode, exported.stdout).toBe(0)
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(2)
      expect(evidence.requests.every((request: { canaryReceived: boolean }) => request.canaryReceived)).toBe(true)
      const journals = readdirSync(`${log}.runs`).flatMap(run => {
        try { return readFileSync(join(`${log}.runs`, run, 'writes.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
        catch { return [] }
      })
      expect(journals.map(record => record.kind).sort()).toEqual(['intent', 'intent', 'outcome', 'outcome'])
      const off = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/tenable-axi/write-access', headers,
        payload: { enabled: false, expectedRevision: (await settings()).json().revision } })
      expect(off.statusCode).toBe(200)
      expect((await run([...create, '--execute', '--confirm', plan.preview.confirm])).stdout).toContain('WRITES_DISABLED')
      const audit = db.prepare("SELECT action, arguments FROM audit WHERE tool = 'tenable-axi'").all()
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'write' })]))
      expect(JSON.stringify(audit)).not.toContain('CANARY-tenable')
      const credentialRevision = store.findCredential('tenable-axi')!.revision
      const rotated = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/tenable-axi/credential', headers,
        payload: { value: { secretKey: 'CANARY-tenable-invalid' }, expectedRevision: credentialRevision,
          expectedToolRevision: (await settings()).json().revision } })
      expect(rotated.statusCode, rotated.body).toBe(200)
      expect(store.readCredential(store.findCredential('tenable-axi')!)).toMatchObject({
        accessKey: 'CANARY-tenable-access', secretKey: 'CANARY-tenable-invalid',
      })
      const rejected = await app.inject({ method: 'POST', url: '/v1/admin/tools/tenable-axi/test', headers, payload: {} })
      expect(rejected.json()).toMatchObject({ error: { code: 'UPSTREAM_AUTH_FAILED' } })
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
})
