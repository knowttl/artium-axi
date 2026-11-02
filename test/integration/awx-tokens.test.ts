import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
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
    db.exec("INSERT INTO role_tools VALUES ('synthetic-role', 'awx-axi')")
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
