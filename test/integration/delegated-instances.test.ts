import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createDelegationSchema } from '../../src/shared/api.js'
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

test('a token scoped to one instance cannot reach another instance or a re-created instance of the same name', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    allowRawApi(db, 'gitea-axi')
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'gitea-axi'")
    const store = createCredentialStore(db, provider), origin = `https://localhost:${port}`
    const create = (name: string) => store.createInstance('gitea-axi', { name, description: '' },
      { origin, tokenOrigin: origin, token: `CANARY-gitea-${name}` }, 'synthetic-development-user', 1000)
    for (const name of ['lab', 'production']) create(name)
    const previous = toolPaths['gitea-axi']
    Object.assign(toolPaths, { 'gitea-axi': join(process.cwd(), 'tools/node_modules/@knowttl/gitea-axi/dist/cli.js') })
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const adapters = [createGiteaAdapter(new EmbeddedSecretSource(store))]
    const app = createApp({ db, runner, audit: new Audit(db), resolver: new SharedIdentityResolver(store, db), adapters, environment: {} })
    const creator = 'synthetic-development-user'
    const mint = (scope: object, readOnly = true) => createDelegation(db, creator,
      { label: 'Synthetic', scope: { tools: [scope] } as never, readOnly, reusable: true, expiresAt: Date.now() + 600000 }, adapters)
    const call = (token: string, payload: object) => app.inject({ method: 'POST', url: '/v1/tools/gitea-axi/run',
      headers: { authorization: `Bearer ${exchangeDelegation(db, token).accessToken}` }, payload: { args: ['--help'], ...payload } })
    try {
      const lab = store.findInstance('gitea-axi', 'lab')!
      const scoped = mint({ tool: 'gitea-axi', instances: ['lab'] })
      const unscoped = mint({ tool: 'gitea-axi' })
      expect(JSON.parse((db.prepare('SELECT scope_json FROM delegations WHERE id = ?').get(scoped.id) as { scope_json: string }).scope_json))
        .toEqual({ tools: [{ tool: 'gitea-axi', instances: [lab.id] }] })

      expect((await call(unscoped.token, {})).json().error.code).toBe('INSTANCE_REQUIRED')
      expect((await call(scoped.token, {})).json()).toMatchObject({ instance: 'lab', exitCode: 0 })
      expect((await call(scoped.token, { instance: 'lab' })).json()).toMatchObject({ instance: 'lab', exitCode: 0 })
      const other = await call(scoped.token, { instance: 'production' })
      expect([other.statusCode, other.json().error.code]).toEqual([404, 'INSTANCE_NOT_FOUND'])
      expect((await call(unscoped.token, { instance: 'production' })).json()).toMatchObject({ instance: 'production', exitCode: 0 })

      const api = mint({ tool: 'gitea-axi', commands: ['api'], instances: ['lab'] })
      const reachedLab = await call(api.token, { args: ['api', 'version'] })
      expect(reachedLab.json(), reachedLab.body).toMatchObject({ instance: 'lab', exitCode: 0 })
      expect((await call(api.token, { args: ['api', 'version'], instance: 'production' })).json().error.code).toBe('INSTANCE_NOT_FOUND')
      const requests = (JSON.parse(await send('/__evidence')) as { requests: { identity: string }[] }).requests
      expect(requests.map(request => request.identity)).toEqual(['lab'])

      const split = createDelegation(db, creator, { label: 'Split', scope: { tools: [
        { tool: 'gitea-axi', commands: ['api'], instances: ['lab'] },
        { tool: 'gitea-axi', commands: ['repo list'], instances: ['production'] },
      ] }, readOnly: true, reusable: true, expiresAt: Date.now() + 600000 }, adapters)
      for (const [args, allowed, denied] of [
        [['api', '--help'], 'lab', 'production'],
        [['repo', 'list', '--help'], 'production', 'lab'],
      ] as const) {
        expect((await call(split.token, { args, instance: allowed })).json()).toMatchObject({ instance: allowed, exitCode: 0 })
        expect((await call(split.token, { args, instance: denied })).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
      }
      const splitMe = await app.inject({ method: 'GET', url: '/v1/me',
        headers: { authorization: `Bearer ${exchangeDelegation(db, split.token).accessToken}` } })
      expect(splitMe.json().delegation.scope.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ commands: expect.arrayContaining(['api']), instances: ['lab'] }),
        expect.objectContaining({ commands: expect.arrayContaining(['repo list']), instances: ['production'] }),
      ]))

      const tools = await app.inject({ method: 'GET', url: '/v1/tools',
        headers: { authorization: `Bearer ${exchangeDelegation(db, scoped.token).accessToken}` } })
      expect(tools.json().tools[0].instances.map((instance: { name: string }) => instance.name)).toEqual(['lab'])
      const me = (token: string) => app.inject({ method: 'GET', url: '/v1/me',
        headers: { authorization: `Bearer ${exchangeDelegation(db, token).accessToken}` } })
      expect((await me(scoped.token)).json().delegation.scope.tools[0]).toMatchObject({ tool: 'gitea-axi', instances: ['lab'] })
      expect((await me(unscoped.token)).json().delegation.scope.tools[0].instances.sort()).toEqual(['lab', 'production'])

      store.deleteInstance('gitea-axi', 'lab', lab.id, lab.revision)
      const recreated = create('lab')
      expect(recreated.id).not.toBe(lab.id)
      expect((await me(scoped.token)).json().delegation.scope.tools).toEqual([])
      const splitHeaders = { authorization: `Bearer ${exchangeDelegation(db, split.token).accessToken}` }
      const remaining = await app.inject({ url: '/v1/tools', headers: splitHeaders })
      expect(remaining.json().tools[0].commands).toContain('repo list')
      expect(remaining.json().tools[0].commands).not.toContain('api')
      const skills = await app.inject({ url: '/v1/skills', headers: splitHeaders })
      expect(skills.json().skills[0].content).toContain('repo list')
      expect(skills.json().skills[0].content).not.toContain('gitea-axi api')
      for (const payload of [{}, { instance: 'lab' }, { instance: 'production' }]) {
        const reply = await call(scoped.token, payload)
        expect(reply.statusCode, reply.body).toBeGreaterThanOrEqual(400)
        expect(['INSTANCE_NOT_FOUND', 'CREDENTIAL_NOT_CONFIGURED', 'DELEGATED_SCOPE_DENIED']).toContain(reply.json().error.code)
      }
      expect((await call(api.token, { args: ['api', 'version'], instance: 'lab' })).json().error.code).toBe('INSTANCE_NOT_FOUND')
      expect((await call(unscoped.token, { instance: 'lab' })).json()).toMatchObject({ instance: 'lab', exitCode: 0 })
    } finally {
      await app.close(); db.close()
      Object.assign(toolPaths, { 'gitea-axi': previous })
    }
  })
}, 60000)

test('minting names instances once, stores ids, and refuses unknown or ungranted instances', async () => {
  await withFakeService(async ({ directory, port }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'gitea-axi'")
    const store = createCredentialStore(db, provider), origin = `https://localhost:${port}`
    for (const name of ['lab', 'production']) store.createInstance('gitea-axi', { name, description: '' },
      { origin, tokenOrigin: origin, token: `CANARY-gitea-${name}` }, 'synthetic-development-user', 1000)
    const adapters = [createGiteaAdapter(new EmbeddedSecretSource(store))]
    const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db),
      resolver: new SharedIdentityResolver(store, db), adapters, environment: {} })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const mint = (tools: object[]) => createDelegation(db, 'synthetic-development-user',
      { label: 'Synthetic', scope: { tools } as never, readOnly: true, reusable: true, expiresAt: Date.now() + 600000 }, adapters)
    try {
      const production = store.findInstance('gitea-axi', 'production')!
      db.prepare("DELETE FROM role_tools WHERE tool = 'gitea-axi'").run()
      db.prepare("INSERT INTO role_tools (role_id, tool, all_instances) VALUES ('synthetic-role', 'gitea-axi', 0)").run()
      db.prepare("INSERT INTO role_tool_instances (role_id, tool, credential_id) VALUES ('synthetic-role', 'gitea-axi', ?)").run(production.id)
      for (const instances of [['lab'], ['staging']]) {
        expect(() => mint([{ tool: 'gitea-axi', instances }])).toThrowError(expect.objectContaining({ code: 'INSTANCE_NOT_FOUND' }))
      }
      mint([{ tool: 'gitea-axi', instances: ['production'] }, { tool: 'gitea-axi', commands: ['api'] }])
      expect(createDelegationSchema.safeParse({ label: 'Synthetic', scope: { tools: [{ tool: 'gitea-axi', instances: [production.id] }] },
        readOnly: true, reusable: true, expiresAt: Date.now() + 600000 }).success).toBe(false)
      mint([{ tool: 'gitea-axi', instances: ['production', 'production'] }])
      const listed = await app.inject({ method: 'GET', url: '/v1/account/tokens', headers })
      expect(JSON.parse(listed.json().tokens[0].scopeJson)).toEqual({ tools: [{ tool: 'gitea-axi', instances: ['production'] }] })
      const scoped = mint([{ tool: 'gitea-axi', instances: ['production'] }])
      const unscoped = mint([{ tool: 'gitea-axi' }])
      const me = () => app.inject({ method: 'GET', url: '/v1/me',
        headers: { authorization: `Bearer ${exchangeDelegation(db, scoped.token).accessToken}` } })
      const unscopedMe = () => app.inject({ method: 'GET', url: '/v1/me',
        headers: { authorization: `Bearer ${exchangeDelegation(db, unscoped.token).accessToken}` } })
      expect((await me()).json().delegation.scope.tools[0].instances).toEqual(['production'])
      expect((await unscopedMe()).json().delegation.scope.tools[0].instances).toEqual(['production'])
      db.prepare("DELETE FROM role_tool_instances WHERE role_id = 'synthetic-role' AND tool = 'gitea-axi'").run()
      expect((await me()).json().delegation.scope.tools).toEqual([])
      expect((await unscopedMe()).json().delegation.scope.tools).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60000)
