import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { loginResponseSchema } from '../../src/shared/api.js'
import { createApp } from '../../src/server/app.js'
import { createAdoAdapter } from '../../src/server/adapters/ado.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { withFakeService } from '../fake-service/fixture.js'
import { seedToolUser } from '../fixtures/tokens.js'

test('a managed PAT can be saved, tested and used with write gating through the pinned binary', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    const store = createCredentialStore(db, provider)
    const adapter = createAdoAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', fileURLToPath(new URL('../fake-service/ado-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@jeffreyhaen/ado-axi/dist/bin/ado-axi.js', import.meta.url)), ...call.args],
        environment: { ...call.environment, ARTIUM_TEST_ADO_ORIGIN: `https://localhost:${port}` } }
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
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ado-axi/credential', headers,
        payload: { value: { org: 'https://dev.azure.com/synthetic-org/', project: 'Synthetic Project', auth: 'pat', token: 'CANARY-ado-pat' },
          expectedRevision: 0, expectedToolRevision: 1 } })
      expect(saved.statusCode, saved.body).toBe(200)
      expect(saved.json()).toMatchObject({ metadata: { org: 'synthetic-org', auth: 'pat' }, normalizations: [{ field: 'org' }] })
      expect(saved.body).not.toContain('CANARY-ado-pat')
      const checked = await app.inject({ method: 'POST', url: '/v1/admin/tools/ado-axi/test', headers, payload: {} })
      expect(checked.statusCode, checked.body).toBe(200)
      expect(checked.json()).toMatchObject({ status: 'ok', readOnly: true })
      expect(JSON.parse(await send('/__evidence')).requests).toContainEqual(expect.objectContaining({
        host: 'dev.azure.com', path: '/synthetic-org/_apis/projects', auth: 'Basic', canaryReceived: true,
      }))
      const enabled = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ado-axi', headers,
        payload: { enabled: true, expectedRevision: 2 } })
      expect(enabled.statusCode, enabled.body).toBe(200)
      const run = (args: string[], input = {}) => app.inject({ method: 'POST', url: '/v1/tools/ado-axi/run', headers, payload: { args, ...input } })
      const result = await run(['projects', 'list', '--limit', '1'])
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json()).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic Project') })
      const query = await run(['wi', 'list', '--limit', '1'])
      expect(query.json()).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Synthetic work item') })
      const write = ['work-item', 'update', '42', '--title', 'Synthetic changed title']
      expect((await run(write)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      const switched = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ado-axi', headers,
        payload: { nativeSettings: { allowWrites: true }, expectedRevision: 3 } })
      expect(switched.statusCode, switched.body).toBe(200)
      const written = await run(write)
      expect(written.statusCode, written.body).toBe(200)
      expect(written.json()).toMatchObject({ exitCode: 0 })
      expect((await run(['api', 'POST', '_apis/projects'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await run(['api', '_apis/projects'], { stdin: '{}' })).json()).toMatchObject({ error: { code: 'UNSUPPORTED_INPUT' } })
      const redacted = await run(['api', '_apis/redaction'])
      expect(redacted.json()).toMatchObject({ error: { code: 'SECRET_IN_OUTPUT' } })
      expect(redacted.body).not.toContain('CANARY-ado-pat')
      expect(redacted.body).not.toContain(Buffer.from(':CANARY-ado-pat').toString('base64'))
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(1)
      expect(evidence.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/synthetic-org/_apis/projects', auth: 'Basic', canaryReceived: true }),
        expect.objectContaining({ method: 'POST', path: '/synthetic-org/Synthetic%20Project/_apis/wit/wiql', auth: 'Basic', canaryReceived: true }),
        expect.objectContaining({ method: 'PATCH', path: '/synthetic-org/_apis/wit/workitems/42', auth: 'Basic', canaryReceived: true,
          body: [{ op: 'add', path: '/fields/System.Title', value: 'Synthetic changed title' }] }),
      ]))
      const audit = db.prepare("SELECT action, arguments FROM audit WHERE tool = 'ado-axi' AND event = 'run-terminal'").all()
      expect(audit).toContainEqual(expect.objectContaining({ action: 'write' }))
      expect(audit).toContainEqual(expect.objectContaining({ action: 'read' }))
      expect(JSON.stringify(audit)).not.toContain('CANARY-ado-pat')
      expect(JSON.stringify(audit)).not.toContain(Buffer.from(':CANARY-ado-pat').toString('base64'))
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
})
