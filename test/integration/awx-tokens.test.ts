import { readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { parse } from 'yaml'
import { toolView } from '../../src/cli/views.js'
import { meResponseSchema } from '../../src/shared/api.js'
import { expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { withFakeService } from '../fake-service/fixture.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { copyClientInput } from '../fixtures/client-inputs.js'

async function withTokenService(check: (context: {
  app: ReturnType<typeof createApp>, db: ReturnType<typeof openStore>, store: ReturnType<typeof createCredentialStore>,
  headers: { authorization: string }, send: (path: string, method?: string) => Promise<string>,
  run: (args: string[]) => Promise<Awaited<ReturnType<ReturnType<typeof createApp>['inject']>>>, lines: string[], directory: string,
}) => Promise<void>) {
  await withFakeService(async ({ directory, port, send }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec(`UPDATE tools SET enabled = 1 WHERE name = 'awx-axi';
      INSERT INTO users (id, username, display_name, password_hash)
        SELECT 'synthetic-other-user', 'synthetic-other', 'Synthetic Other', password_hash FROM users WHERE id = 'synthetic-development-user';
      INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-other-user', 'synthetic-role')`)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('awx-axi', { origin: `https://localhost:${port}`, token: 'CANARY-awx-token' },
      0, 'synthetic-development-user', Date.now())
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      if (call.executable === process.execPath) call.args[3] = join(process.cwd(), 'tools/node_modules/.bin/awx-axi')
      else return { ...call, executable: process.execPath, args: [join(process.cwd(), 'tools/node_modules/awx-axi/dist/bin/awx-axi.js'), ...call.args] }
      return call
    }
    const runner = await Runner.create(join(directory, 'calls'), { pem: readFileSync(join(directory, 'ca.crt'), 'utf8'), certificates: [] })
    const lines: string[] = []
    const app = createApp({ db, runner, audit: new Audit(db, Date.now, line => lines.push(line)), adapters: [adapter],
      resolver: new SharedIdentityResolver(store), credentialStore: store, environment: {} })
    const headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
    const run = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers, payload: { args } })
    try { await check({ app, db, store, headers, send, run, lines, directory }) }
    finally { vi.useRealTimers(); await app.close(); db.close() }
  })
}

test('delegated AWX credential creation requires an exact writable pick', async () => {
  await withTokenService(async ({ app, db, headers, directory }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
    const url = await app.listen({ host: '127.0.0.1', port: 0 })
    const bundle = copyClientInput('bundle', join(directory, 'delegated-client.mjs'))
    const cli = async (config: string, args: string[], input = '') => {
      const child = spawn(process.execPath, [bundle, ...args], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: join(directory, config),
        ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdin.end(input)
      const [code] = await once(child, 'close')
      return { code, stdout, stderr, argv: child.spawnargs }
    }
    const create = async (commands: string[] | undefined, readOnly: boolean) => app.inject({ method: 'POST', url: '/v1/account/tokens', headers: proof,
      payload: { label: 'Synthetic', scope: { tools: [{ tool: 'awx-axi', ...(commands ? { commands } : {}) }] },
        readOnly, reusable: false, expiresAt: Date.now() + 600_000 } })
    const wildcard = await create(['user *'], false)
    expect(wildcard.statusCode).toBe(400)
    expect(wildcard.json().error.message).toBe('Wildcards are not supported yet.')
    for (const [config, commands, readOnly, allowed] of [
      ['wide', undefined, false, false], ['readonly', ['user token-create'], true, false], ['exact', ['user token-create'], false, true],
    ] as const) {
      const minted = await create(commands ? [...commands] : undefined, readOnly)
      expect(minted.statusCode).toBe(200)
      const token = minted.json().token as string
      const login = await cli(config, ['login', '--token-stdin'], `${token}\n`)
      expect(login.code).toBe(0)
      expect((login.stdout + login.stderr + login.argv.join(' ')).includes(token)).toBe(false)
      if (allowed) {
        const discovery = await cli(config, ['tools', 'show', 'awx-axi'])
        expect(discovery.stdout).toContain('user token-create')
        expect(discovery.stdout).not.toContain('job list')
        const rootHelp = await cli(config, ['awx-axi', '--help'])
        expect(rootHelp.stdout).toContain('user token-create')
        expect(rootHelp.stdout).not.toContain('job list')
        expect((await cli(config, ['session-context'])).stdout).toContain('awx-axi')
        expect((await cli(config, ['awx-axi', 'user', 'token-create', '42', '--help'])).code).toBe(0)
        expect((await cli(config, ['awx-axi', 'user', 'token-create', '42', '--dry-run'])).code).toBe(0)
        expect(db.prepare("SELECT outcome FROM audit WHERE event = 'credential-issue' ORDER BY id").all())
          .toEqual([{ outcome: 'attempt' }, { outcome: 'preview' }, { outcome: 'attempt' }, { outcome: 'preview' }])
      }
      const result = await cli(config, ['awx-axi', 'user', 'token-create', '42', '--confirm'])
      expect((result.stdout + result.stderr + result.argv.join(' ')).includes(token)).toBe(false)
      expect(result.code).toBe(allowed ? 0 : 1)
      if (!allowed) expect(result.stdout).toContain('DELEGATED_SCOPE_DENIED')
      else expect(result.stdout).toContain('token-create')
    }
    expect(db.prepare("SELECT target_id, outcome FROM audit WHERE event = 'credential-issue' AND outcome = 'success'").all())
      .toEqual([{ target_id: 'user token-create', outcome: 'success' }])
  })
})

test('read-only delegated AWX stdout remains retrievable as data (R8)', async () => {
  await withTokenService(async ({ app, db, headers, send }) => {
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { label: 'Synthetic',
        scope: { tools: [{ tool: 'awx-axi' }] }, readOnly: true, reusable: false, expiresAt: Date.now() + 600_000 } })
    expect(minted.statusCode).toBe(200)
    const exchanged = await app.inject({ method: 'POST', url: '/v1/auth/delegated', payload: { token: minted.json().token } })
    const delegated = { authorization: `Bearer ${exchanged.json().accessToken}` }
    await send('/__awx/stdout-response?status=200&text=synthetic%20log%0A', 'POST')
    const response = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated,
      payload: { args: ['job', 'stdout', '42', '--type', 'project-update', '--download', '42.log'] } })
    expect(response.json()).toMatchObject({ exitCode: 0 })
    const { result } = decode(response.json().stdout) as { result: { path: string } }
    const downloaded = await app.inject({ url: result.path, headers: delegated })
    expect(downloaded.statusCode).toBe(200)
    expect(downloaded.body).toBe('synthetic log\n')
  })
})

test('command-scoped discovery and enforcement follow the delegated grant', async () => {
  await withTokenService(async ({ app, db, headers }) => {
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { label: 'Synthetic',
        scope: { tools: [{ tool: 'awx-axi', commands: ['job list'] }] }, readOnly: true, reusable: false, expiresAt: Date.now() + 600_000 } })
    const exchanged = await app.inject({ method: 'POST', url: '/v1/auth/delegated', payload: { token: minted.json().token } })
    const delegated = { authorization: `Bearer ${exchanged.json().accessToken}` }
    const tools = await app.inject({ url: '/v1/tools', headers: delegated })
    expect(tools.json().tools[0].commands).toEqual(['job list'])
    const skills = await app.inject({ url: '/v1/skills', headers: delegated })
    const content = skills.json().skills[0].content as string
    const [, frontmatter, body] = content.split('---\n')
    expect(parse(frontmatter)).toEqual({ name: 'awx-axi', description: 'Use permitted awx-axi commands through Artium.' })
    expect(body).toContain('`artium-axi awx-axi job list`')
    expect(body).not.toContain('user token-create')
    const me = await app.inject({ url: '/v1/me', headers: delegated })
    expect(me.json()).toMatchObject({ delegation: { label: 'Synthetic' } })
    expect(me.json()).not.toHaveProperty('roles')
    const help = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated, payload: { args: ['--help'] } })
    expect(help.body).toContain('job list')
    expect(help.body).not.toContain('user token-create')
    db.exec("UPDATE tools SET enabled = 0 WHERE name = 'awx-axi'")
    expect((await app.inject({ url: '/v1/skills', headers: delegated })).json().skills).toEqual([])
    expect((await app.inject({ url: '/v1/tools', headers: delegated })).json().tools).toEqual([])
    expect((await app.inject({ url: '/v1/me', headers: delegated })).json().delegation.scope.tools).toEqual([])
    db.exec("UPDATE tools SET enabled = 1 WHERE name = 'awx-axi'")
    db.exec("DELETE FROM credentials WHERE tool = 'awx-axi'")
    const denied = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated, payload: { args: ['user', 'list'] } })
    expect(denied.json()).toMatchObject({ error: { code: 'DELEGATED_SCOPE_DENIED' } })
    db.exec("DELETE FROM role_tools WHERE tool = 'awx-axi'")
    expect((await app.inject({ url: '/v1/me', headers: delegated })).json().delegation.scope.tools).toEqual([])
    expect((await app.inject({ url: '/v1/tools', headers: delegated })).json().tools).toEqual([])
    expect((await app.inject({ url: '/v1/skills', headers: delegated })).json().skills).toEqual([])
  })
})

test.each([{ commands: undefined }, { commands: ['job list', 'job cancel', 'user token-create'] }])('read-only AWX discovery filters every command surface (R10): $commands', async ({ commands }) => {
  await withTokenService(async ({ app, db, headers }) => {
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { label: 'Synthetic',
        scope: { tools: [{ tool: 'awx-axi', commands }] }, readOnly: true, reusable: false, expiresAt: Date.now() + 600_000 } })
    const exchanged = await app.inject({ method: 'POST', url: '/v1/auth/delegated', payload: { token: minted.json().token } })
    const delegated = { authorization: `Bearer ${exchanged.json().accessToken}` }
    const tools = await app.inject({ url: '/v1/tools', headers: delegated })
    const tool = tools.json().tools[0]
    expect(tool.commands).toContain('job list')
    expect(tool.commands).not.toContain('job cancel')
    expect(tool.commands).not.toContain('user token-create')
    const manifest = toolView(tool)
    expect(manifest).toContain('job list')
    expect(manifest).not.toContain('job cancel')
    expect(manifest).not.toContain('user token-create')
    const skills = await app.inject({ url: '/v1/skills', headers: delegated })
    expect(skills.json().skills[0].content).toContain('`artium-axi awx-axi job list`')
    expect(skills.json().skills[0].content).not.toContain('job cancel')
    expect(skills.json().skills[0].content).not.toContain('user token-create')
    const help = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated, payload: { args: ['--help'] } })
    expect((decode(help.json().stdout) as { commands: string[] }).commands).toEqual(tool.commands)
  })
})

test.each([
  { commands: ['job list', 'job cancel', 'job stdout'] },
  { commands: ['job list', 'job cancel'] },
  { commands: undefined },
])('delegated AWX discovery follows current write and tool policy (R11, R13): $commands', async ({ commands }) => {
  await withTokenService(async ({ app, db, headers }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const minted = await app.inject({ method: 'POST', url: '/v1/account/tokens',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { label: 'Synthetic',
        scope: { tools: [{ tool: 'awx-axi', commands }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 600_000 } })
    const exchanged = await app.inject({ method: 'POST', url: '/v1/auth/delegated', payload: { token: minted.json().token } })
    const delegated = { authorization: `Bearer ${exchanged.json().accessToken}` }
    const writable = await app.inject({ url: '/v1/tools', headers: delegated })
    expect(writable.json().tools[0]).toMatchObject({ readOnly: false, commands: expect.arrayContaining(['job list', 'job cancel']) })
    const writableSkills = await app.inject({ url: '/v1/skills', headers: delegated })
    expect(writableSkills.json().skills[0].content).toContain('`artium-axi awx-axi job cancel`')
    const writableHelp = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated, payload: { args: ['--help'] } })
    expect((decode(writableHelp.json().stdout) as { commands: string[] }).commands).toContain('job cancel')

    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":false}' WHERE name = 'awx-axi'`)
    const tools = await app.inject({ url: '/v1/tools', headers: delegated })
    const tool = tools.json().tools[0]
    expect(tool.readOnly).toBe(true)
    expect(tool.commands).toContain('job list')
    expect(tool.commands).not.toContain('job cancel')
    const identity = await app.inject({ url: '/v1/me', headers: delegated })
    expect(meResponseSchema.parse(identity.json())).toMatchObject({ delegation: { scope: { tools: [{ tool: 'awx-axi', commands: tool.commands }] } } })
    expect(toolView(tool)).not.toContain('job cancel')
    const skills = await app.inject({ url: '/v1/skills', headers: delegated })
    expect(skills.json().skills[0].content).toContain('`artium-axi awx-axi job list`')
    expect(skills.json().skills[0].content).not.toContain('job cancel')
    const help = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated, payload: { args: ['--help'] } })
    expect((decode(help.json().stdout) as { commands: string[] }).commands).toEqual(tool.commands)

    db.exec("UPDATE tools SET enabled = 0 WHERE name = 'awx-axi'")
    expect((await app.inject({ url: '/v1/tools', headers: delegated })).json().tools).toEqual([])
    expect((await app.inject({ url: '/v1/skills', headers: delegated })).json().skills).toEqual([])
    expect((await app.inject({ url: '/v1/me', headers: delegated })).json().delegation.scope.tools).toEqual([])
    const disabledHelp = await app.inject({ method: 'POST', url: '/v1/tools/awx-axi/run', headers: delegated, payload: { args: ['--help'] } })
    expect(disabledHelp.json()).toMatchObject({ error: { code: 'TOOL_DISABLED' } })
  })
})

test.each(['read', 'write'])('AWX %s PAT creation delivers bytes once to the authorized caller (S10)', async scope => {
  await withTokenService(async ({ app, db, store, headers, send, run, lines, directory }) => {
    const args = ['user', 'token-create', '42', '--scope', scope]
    expect((await run([...args, '--confirm'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    expect((await run([...args, '--dry-run'])).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    expect((await run(args)).json()).toMatchObject({ error: { code: 'FLAG_BLOCKED' } })
    const preview = await run([...args, '--dry-run'])
    expect(decode(preview.json().stdout)).toMatchObject({ dry_run: { would_send: 'POST users/42/personal_tokens/', payload: { scope } } })
    expect(decode(preview.json().stdout)).not.toHaveProperty('result')
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(0)
    const response = await run([...args, '--confirm'])
    expect(response.json(), response.body).toMatchObject({ exitCode: 0 })
    const result = decode(response.json().stdout) as { result: { path: string } }
    expect(result).toMatchObject({ token: { id: 8, user: 42, scope, status: 'created' }, result: { operation: 'token-create' } })
    expect(response.body + preview.body).not.toContain('CANARY-')
    const other = await app.inject({ method: 'GET', url: result.result.path,
      headers: { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-other-user')}` } })
    expect(other.statusCode).toBe(404)
    db.exec("DELETE FROM role_tools WHERE tool = 'awx-axi'")
    expect((await app.inject({ method: 'GET', url: result.result.path, headers })).statusCode).toBe(403)
    db.exec("INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'awx-axi')")
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":false}' WHERE name = 'awx-axi'`)
    const downloaded = await app.inject({ method: 'GET', url: result.result.path, headers })
    expect(downloaded.statusCode, downloaded.body).toBe(200)
    expect(downloaded.body).toBe('CANARY-awx-created-token-8')
    expect(downloaded.headers['cache-control']).toBe('no-store')
    expect((await app.inject({ method: 'GET', url: result.result.path, headers })).statusCode).toBe(404)
    const logout = await run(['auth', 'logout'])
    expect(logout.json()).toMatchObject({ error: { code: 'INVALID_INPUT', next: expect.stringContaining('user token-revoke') } })
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    const revokePreview = await run(['user', 'token-revoke', '8', '--dry-run'])
    expect(decode(revokePreview.json().stdout)).toMatchObject({ dry_run: { would_send: 'DELETE tokens/8/' } })
    const revoked = await run(['user', 'token-revoke', '8', '--confirm'])
    expect(decode(revoked.json().stdout)).toMatchObject({ token: { id: 8, status: 'revoked' } })
    expect(revoked.body).not.toContain('CANARY-')
    expect(store.findCredential('awx-axi')).toMatchObject({ revision: 1 })
    expect(store.readCredential(store.findCredential('awx-axi')!)).toMatchObject({ token: 'CANARY-awx-token' })
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.mutations).toBe(2)
    expect(evidence.requests).toContainEqual({ method: 'POST', path: '/api/v2/users/42/personal_tokens/',
      auth: 'Bearer', canaryReceived: true, body: { scope } })
    const audit = db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all()
    expect(audit).toContainEqual(expect.objectContaining({ event: 'protected-result', outcome: 'success' }))
    expect(lines.join('\n') + JSON.stringify(audit)).not.toContain('CANARY-')
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  })
}, 60_000)

test.each([
  { mode: 'missing-id', setup: '/__awx/token-response?mode=missing-id', expected: { exitCode: 1, stdout: expect.stringContaining('INVALID_RESPONSE') }, mutations: 1 },
  { mode: 'missing-token', setup: '/__awx/token-response?mode=missing-token', expected: { exitCode: 1, stdout: expect.stringContaining('INVALID_RESPONSE') }, mutations: 1 },
  { mode: 'denied', setup: '/__awx/configuration-permission?enabled=false', expected: { exitCode: 1, stdout: expect.stringContaining('FORBIDDEN') }, mutations: 0 },
  { mode: 'uncertain', setup: '/__awx/write-outcome?drop=true', expected: { error: { code: 'UNKNOWN_OUTCOME' } }, mutations: 1 },
])('AWX $mode token creation returns no secret reference (S10)', async ({ setup, expected, mutations }) => {
  await withTokenService(async ({ db, send, run, lines, directory }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    await send(setup, 'POST')
    const response = await run(['user', 'token-create', '42', '--confirm'])
    expect(response.json(), response.body).toMatchObject(expected)
    expect(response.body).not.toContain('CANARY-')
    expect(response.json()).not.toHaveProperty('result')
    expect(decode(response.json().stdout ?? 'status: failed')).not.toHaveProperty('result')
    expect(JSON.parse(await send('/__evidence')).mutations).toBe(mutations)
    const audit = db.prepare("SELECT * FROM audit WHERE tool = 'awx-axi'").all()
    expect(audit).not.toContainEqual(expect.objectContaining({ event: 'protected-result' }))
    expect(lines.join('\n') + JSON.stringify(audit)).not.toContain('CANARY-')
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  })
}, 60_000)

test('AWX token references expire and cannot follow a replaced credential revision (S10)', async () => {
  await withTokenService(async ({ app, db, store, run, headers }) => {
    db.exec(`UPDATE tools SET native_settings = '{"allowWrites":true}' WHERE name = 'awx-axi'`)
    const first = await run(['user', 'token-create', '42', '--confirm'])
    const firstResult = decode(first.json().stdout) as { result: { path: string } }
    const reference = store.findCredential('awx-axi')!
    store.replaceCredential('awx-axi', store.readCredential(reference), reference.revision!, 'synthetic-development-user', Date.now())
    expect((await app.inject({ method: 'GET', url: firstResult.result.path, headers })).statusCode).toBe(404)
    const second = await run(['user', 'token-create', '42', '--confirm'])
    const secondResult = decode(second.json().stdout) as { result: { path: string } }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
    expect((await app.inject({ method: 'GET', url: secondResult.result.path, headers })).statusCode).toBe(404)
  })
}, 60_000)
