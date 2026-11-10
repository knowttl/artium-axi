import { configurationTests } from './awx-configuration-cases.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decode } from '@toon-format/toon'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'

test.each([
  { title: 'team user', create: ['user', 'create', 'synthetic-person'],
    add: ['team', 'user-add', '7', '--user', '42'], remove: ['team', 'user-remove', '7', '--user', '42'],
    read: ['team', 'users', '7'], present: { users: [{ id: 42, username: 'synthetic-person' }] }, absent: { users: '0 users found for team', count: '0 total' } },
  { title: 'role user', create: ['user', 'create', 'synthetic-person'],
    add: ['role', 'grant', '7', '--user', '42'], remove: ['role', 'revoke', '7', '--user', '42'],
    read: ['role', 'users', '7'], present: { users: [{ id: 42, username: 'synthetic-person' }] }, absent: { users: '0 users found holding role', count: '0 total' } },
  { title: 'role team', create: ['team', 'create', 'Synthetic team', '--organization', '7'],
    add: ['role', 'grant', '7', '--team', '42'], remove: ['role', 'revoke', '7', '--team', '42'],
    read: ['role', 'teams', '7'], present: { teams: [{ id: 42, name: 'Synthetic team' }] }, absent: { teams: '0 teams found holding role', count: '0 total' } },
])('AWX $title membership changes remain readable with writes disabled (S10)', async ({ create, add, remove, read, present, absent }) => {
  await withFakeService(async ({ directory, port }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = async (args: string[]) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      return decode(response.json().stdout)
    }
    try {
      await run([...create, '--confirm'])
      await run([...add, '--confirm'])
      allowWrites = false
      expect(await run(read)).toMatchObject(present)
      allowWrites = true
      await run([...remove, '--confirm'])
      allowWrites = false
      expect(await run(read)).toMatchObject(absent)
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX user privilege removal and interrupted username changes persist with writes disabled (S10)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = true
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`,
      token: 'CANARY-awx-token', allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    const run = async (args: string[]) => {
      const response = await request(args)
      expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
      return decode(response.json().stdout)
    }
    try {
      await run(['user', 'create', 'synthetic-person', '--is-superuser', '--is-system-auditor', '--confirm'])
      expect(await run(['user', 'show', 'synthetic-person'])).toMatchObject({ user: {
        id: 42, username: 'synthetic-person', is_superuser: true, is_system_auditor: true,
      } })
      await run(['user', 'edit', 'synthetic-person', '--no-superuser', '--no-system-auditor', '--confirm'])
      await send('/__awx/write-outcome?drop=true', 'POST')
      const interrupted = await request(['user', 'edit', '42', '--username', 'synthetic-renamed', '--confirm'])
      expect(interrupted.json(), interrupted.body).toMatchObject({ error: { code: 'UNKNOWN_OUTCOME',
        next: expect.stringContaining('artium-axi awx-axi user list --limit 100') } })
      allowWrites = false
      expect(await run(['user', 'list'])).toMatchObject({ users: [
        { id: 42, username: 'synthetic-renamed', is_superuser: false, is_system_auditor: false },
      ] })
      expect(await run(['user', 'show', 'synthetic-renamed'])).toMatchObject({ user: {
        id: 42, username: 'synthetic-renamed', is_superuser: false, is_system_auditor: false,
      } })
    } finally { await app.close(); db.close() }
  })
}, 60_000)

test('AWX token revocation requires the tenant switch and confirmation and invalidates the PAT (S10)', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    let allowWrites = false
    let token = 'CANARY-awx-minted-token'
    const reference = { id: 'synthetic-credential', tool: 'awx-axi' as const }
    const adapter = createAwxAdapter({ getCredential: async () => ({ origin: `https://localhost:${port}`, token, allowWrites }) })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, executable: process.execPath,
        args: [join(process.cwd(), 'tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter], environment: {},
      resolver: new SharedIdentityResolver(new FakeCredentialStore([{ reference, value: {} }]).seed(db)) })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const request = async (args: string[]) => {
      const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
      expect(response.body).not.toContain('CANARY-')
      return response
    }
    try {
      expect((await request(['user', 'list'])).json()).toMatchObject({ exitCode: 0 })
      token = 'CANARY-awx-token'
      const args = ['user', 'token-revoke', '7']
      expect((await request([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      expect((await request([...args, '--dry-run'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      allowWrites = true
      expect((await request(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
      const preview = await request([...args, '--dry-run'])
      expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { action: 'revoke', would_send: 'DELETE tokens/***/' } })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=false', 'POST')
      const denied = await request([...args, '--confirm'])
      expect(denied.json(), denied.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') })
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
      await send('/__awx/configuration-permission?enabled=true', 'POST')
      const revoked = await request([...args, '--confirm'])
      expect(decode(revoked.json().stdout)).toMatchObject({ token: { id: 7, status: 'revoked' } })
      token = 'CANARY-awx-minted-token'
      allowWrites = false
      const read = await request(['user', 'list'])
      expect(read.json(), read.body).toMatchObject({ exitCode: 1, stdout: expect.stringContaining('AUTH_REQUIRED') })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(1)
      expect(evidence.requests).toContainEqual({ method: 'DELETE', path: '/api/v2/tokens/7/', auth: 'Bearer', canaryReceived: true })
      const audit = db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all()
      expect(audit).toContainEqual(expect.objectContaining({ event: 'run-terminal', action: 'write' }))
      expect(lines.join('\n') + JSON.stringify(audit)).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally { await app.close(); db.close() }
  })
}, 60_000)
configurationTests(['organization', 'team', 'user', 'role'])
