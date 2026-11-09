import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createGiteaAdapter } from '../../src/server/adapters/gitea.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'
import { toolPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { withFakeService } from '../fake-service/fixture.js'
import { allowRawApi, issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

test('instance selection reaches the service and invalid selections fail closed', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try { await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    allowRawApi(db, 'gitea-axi')
    db.exec("UPDATE tools SET enabled = 1 WHERE name IN ('gitea-axi', 'falcon-axi')")
    const store = createCredentialStore(db, provider), origin = `https://localhost:${port}`
    for (const name of ['lab', 'production']) store.createInstance('gitea-axi', { name, description: '' },
      { origin, tokenOrigin: origin, token: `CANARY-gitea-${name}` }, 'synthetic-development-user', 1000)
    store.createInstance('falcon-axi', { name: 'lab', description: '' },
      { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }, 'synthetic-development-user', 1000)
    const previous = { gitea: toolPaths['gitea-axi'], falcon: toolPaths['falcon-axi'] }
    Object.assign(toolPaths, { 'gitea-axi': join(process.cwd(), 'tools/node_modules/@knowttl/gitea-axi/dist/cli.js'),
      'falcon-axi': join(process.cwd(), 'tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/bin.js') })
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const source = new EmbeddedSecretSource(store)
    const app = createApp({ db, runner, audit: new Audit(db), resolver: new SharedIdentityResolver(store),
      adapters: [createGiteaAdapter(source), createFalconAdapter(source, join(directory, 'writes.log'))], environment: {} })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (payload: object) => app.inject({ method: 'POST', url: '/v1/tools/gitea-axi/run', headers,
      payload: { args: ['api', 'version'], ...payload } })
    const evidence = async () => (JSON.parse(await send('/__evidence')) as { requests: { identity: string }[] }).requests
    try {
      for (const [payload, status, code] of [[{}, 409, 'INSTANCE_REQUIRED'], [{ instance: 'staging' }, 404, 'INSTANCE_NOT_FOUND'],
        [{ instance: 'Lab' }, 400, 'INVALID_INPUT']] as const) {
        const reply = await run(payload)
        expect(reply.statusCode).toBe(status)
        expect(reply.json().error.code).toBe(code)
        if (code === 'INSTANCE_REQUIRED') expect(reply.json().error.next).toContain('<lab|production> gitea-axi')
      }
      expect(await evidence()).toEqual([])
      for (const instance of ['lab', 'production']) {
        const reply = await run({ instance })
        expect(reply.json(), reply.body).toMatchObject({ source: 'gitea-axi', instance, exitCode: 0 })
      }
      expect((await evidence()).map(request => request.identity)).toEqual(['lab', 'production'])
      for (const name of ['lab', 'production']) {
        const rows = db.prepare('SELECT event, credential_id, instance FROM audit WHERE instance = ? ORDER BY id').all(name)
        const id = store.findInstance('gitea-axi', name)!.id
        expect(rows).toEqual([{ event: 'run-start', credential_id: id, instance: name }, { event: 'run-terminal', credential_id: id, instance: name }])
      }
      expect(db.prepare("SELECT outcome, credential_id, instance FROM audit WHERE event = 'denial' ORDER BY id").all()).toEqual([
        { outcome: 'INVALID_INPUT', credential_id: null, instance: null }])
      const grant = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic', scope: { tools: [{ tool: 'gitea-axi' }] },
        readOnly: true, reusable: true, expiresAt: Date.now() + 600000 }, [])
      const delegated = { authorization: `Bearer ${exchangeDelegation(db, grant.token).accessToken}` }
      const discover = (payload: object) => app.inject({ method: 'POST', url: '/v1/tools/gitea-axi/run', headers: delegated, payload: { args: ['--help'], ...payload } })
      expect((await discover({})).json().error.code).toBe('INSTANCE_REQUIRED')
      const lab = store.findInstance('gitea-axi', 'lab')!
      expect((await run({ args: ['api'] })).statusCode).toBe(400)
      expect(db.prepare("SELECT credential_id, instance FROM audit WHERE event = 'denial' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ credential_id: null, instance: null })
      expect((await run({ instance: 'lab', args: ['api'] })).statusCode).toBe(400)
      store.setInstanceFlags('gitea-axi', 'lab', { enabled: false }, lab.id, lab.revision, 'synthetic-development-user', 2000)
      expect((await run({ instance: 'lab' })).json().error.code).toBe('INSTANCE_DISABLED')
      expect((await run({ args: ['api'] })).statusCode).toBe(400)
      expect(db.prepare("SELECT credential_id, instance FROM audit WHERE event = 'denial' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ credential_id: store.findInstance('gitea-axi', 'production')!.id, instance: 'production' })
      expect((await evidence()).map(request => request.identity)).toEqual(['lab', 'production'])
      expect((await run({})).json()).toMatchObject({ instance: 'production', exitCode: 0 })
      expect((await evidence()).map(request => request.identity)).toEqual(['lab', 'production', 'production'])
      expect((await discover({ instance: 'lab' })).json().error.code).toBe('INSTANCE_DISABLED')
      expect(db.prepare("SELECT outcome, credential_id, instance FROM audit WHERE event = 'denial' AND instance = 'lab' ORDER BY id").all()).toEqual([
        { outcome: 'INVALID_INPUT', credential_id: lab.id, instance: 'lab' },
        { outcome: 'INSTANCE_DISABLED', credential_id: lab.id, instance: 'lab' },
      ])
      expect(db.prepare("SELECT event, outcome, credential_id, instance FROM audit WHERE instance = 'lab' AND outcome = 'INSTANCE_DISABLED' ORDER BY id").all())
        .toEqual([{ event: 'run-terminal', outcome: 'INSTANCE_DISABLED', credential_id: lab.id, instance: 'lab' },
          { event: 'denial', outcome: 'INSTANCE_DISABLED', credential_id: lab.id, instance: 'lab' }])
      expect((await discover({ instance: 'staging' })).json().error.code).toBe('INSTANCE_NOT_FOUND')
      const proxmox = store.createInstance('proxmox-axi', { name: 'lab', description: '' },
        { origin: 'https://synthetic.invalid', auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }, 'synthetic-development-user', 1000)
      const absentAdapter = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/run', headers,
        payload: { instance: 'lab', args: ['version'] } })
      expect(absentAdapter.statusCode).not.toBe(200)
      expect(db.prepare("SELECT credential_id, instance FROM audit WHERE event = 'denial' AND tool = 'proxmox-axi' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ credential_id: proxmox.id, instance: 'lab' })
      expect((await discover({})).statusCode).toBe(200)
      const preview = await app.inject({ method: 'POST', url: '/v1/tools/falcon-axi/run', headers,
        payload: { instance: 'lab', args: ['rtr', 'run', 'a'.repeat(32), '--command', 'ps'] } })
      expect(preview.json(), preview.body).toMatchObject({ instance: 'lab', exitCode: 0 })
      expect(preview.json().stdout).toContain('preview:')
      for (const name of ['lab', 'production']) {
        const instance = store.findInstance('gitea-axi', name)!
        store.deleteInstance('gitea-axi', name, instance.id, instance.revision)
      }
      const unconfigured = await run({})
      expect(unconfigured.json().error.code).toBe('CREDENTIAL_NOT_CONFIGURED')
      expect(db.prepare("SELECT event, outcome, credential_id, instance FROM audit WHERE tool = 'gitea-axi' AND event IN ('run-start', 'run-terminal') ORDER BY id DESC LIMIT 2").all()).toEqual([
        { event: 'run-terminal', outcome: 'CREDENTIAL_NOT_CONFIGURED', credential_id: null, instance: null },
        { event: 'run-start', outcome: 'started', credential_id: null, instance: null },
      ])
      expect((await run({ instance: 'lab' })).json().error.code).toBe('INSTANCE_NOT_FOUND')
      const missing = await discover({ instance: 'lab' })
      expect(missing.statusCode).toBe(404)
      expect(missing.json().error.code).toBe('INSTANCE_NOT_FOUND')
      expect((await discover({})).statusCode).toBe(200)
    } finally {
      await app.close(); db.close()
      Object.assign(toolPaths, { 'gitea-axi': previous.gitea, 'falcon-axi': previous.falcon })
    }
  }) } finally { vi.useRealTimers() }
}, 60000)
