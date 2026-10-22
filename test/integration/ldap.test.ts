import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { loginResponseSchema } from '../../src/shared/api.js'
import { decode } from '@toon-format/toon'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
const credential = { url: 'ldaps://directory.test:636', auth: 'simple', bindDn: 'uid=reader',
  bindPassword: 'CANARY-ldap-password', caFile: 'CANARY-ca-pem\nsynthetic-ca-line\n' }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-ldap-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'data', 'artium.db'), provider)
  await seedToolUser(db)
  db.exec('UPDATE users SET administrator = 1')
  const store = createCredentialStore(db, provider)
  const adapter = createLdapAdapter(new EmbeddedSecretSource(store))
  const prepare = adapter.prepare.bind(adapter)
  // Replace only the directory boundary, keeping the published parser and credential resolution.
  adapter.prepare = async (...args) => {
    const call = await prepare(...args)
    return { ...call, executable: process.execPath,
      args: [join(process.cwd(), 'test/fake-tool/ldap-adapter-child.mjs'), ...call.args] }
  }
  const runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter],
    credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
    username: 'synthetic-user', password: 'CANARY-local-password' } })
  const session = loginResponseSchema.parse(login.json())
  if (session.status !== 'authenticated') throw new Error('Expected local login')
  headers = { authorization: `Bearer ${session.accessToken}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
  headers['x-artium-reauth-ticket'] = reauth.json().ticket
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

async function configure() {
  const saved = await app.inject({ method: 'PUT', url: '/v1/admin/tools/ldap-axi/credential', headers,
    payload: { value: credential, expectedRevision: 0, expectedToolRevision: 1 } })
  expect(saved.statusCode, saved.body).toBe(200)
  return saved
}

test('LDAP credentials can be saved, tested, enabled and used for a granted read', async () => {
  const rejected = await app.inject({ method: 'PUT', url: '/v1/admin/tools/ldap-axi/credential', headers,
    payload: { value: { ...credential, startTls: true }, expectedRevision: 0, expectedToolRevision: 1 } })
  expect(rejected.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message: 'startTls must be false for this URL.' } })
  const saved = await configure()
  expect(saved.json()).toMatchObject({ tool: 'ldap-axi', configured: true, revision: 1,
    metadata: { auth: 'simple', bindDn: 'uid=reader' } })
  expect(saved.body).not.toContain(credential.bindPassword)
  const checked = await app.inject({ method: 'POST', url: '/v1/admin/tools/ldap-axi/test', headers, payload: {} })
  expect(checked.statusCode, checked.body).toBe(200)
  expect(checked.json().status).toBe('ok')
  const enabled = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/ldap-axi', headers,
    payload: { enabled: true, expectedRevision: 2 } })
  expect(enabled.statusCode, enabled.body).toBe(200)
  const available = await app.inject({ method: 'GET', url: '/v1/tools', headers })
  expect(available.json().tools).toContainEqual({ name: 'ldap-axi', version: '0.3.0', status: 'ok', readOnly: true })
  const result = await app.inject({ method: 'POST', url: '/v1/tools/ldap-axi/run', headers,
    payload: { args: ['user', 'list', '--limit', '1'] } })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json()).toMatchObject({ source: 'ldap-axi', exitCode: 0, stdout: expect.stringContaining('Synthetic User') })
  expect(db.prepare("SELECT action FROM audit WHERE tool = 'ldap-axi' AND event = 'run-terminal'").all())
    .toEqual([{ action: 'read' }, { action: 'read' }])
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
})

test.each([
  { args: ['computer', 'list', '--limit', '1'], expected: { computers: [{ name: 'Synthetic Computer' }] },
    auditArgs: ['computer', 'list', '--limit', '1'] },
  { args: ['computer', 'show', 'synthetic-computer'], expected: { computer: { name: 'Synthetic Computer' } },
    auditArgs: ['computer', 'show', '[redacted]'] },
  { args: ['server'], expected: { flavor: 'ldapv3', tls_verified: true, root_dse: { namingContexts: ['ou=people'] } },
    auditArgs: ['server'] },
])('LDAP 0.3.0 serves an audited read for $args', async ({ args, expected, auditArgs }) => {
  await configure()
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'ldap-axi'")
  const result = await app.inject({ method: 'POST', url: '/v1/tools/ldap-axi/run', headers, payload: { args } })
  expect(result.statusCode, result.body).toBe(200)
  expect(result.json()).toMatchObject({ source: 'ldap-axi', exitCode: 0 })
  expect(decode(result.json().stdout)).toMatchObject(expected)
  expect(db.prepare("SELECT action FROM audit WHERE tool = 'ldap-axi' AND event = 'run-terminal'").all())
    .toEqual([{ action: 'read' }])
  expect(db.prepare("SELECT arguments FROM audit WHERE tool = 'ldap-axi' AND event = 'run-start'").get())
    .toEqual({ arguments: JSON.stringify(auditArgs) })
  expect(readdirSync(join(directory, 'calls'))).toEqual([])
})

test('an LDAP call requires an enabled tool and an explicit role grant', async () => {
  await configure()
  const request = { method: 'POST' as const, url: '/v1/tools/ldap-axi/run', headers, payload: { args: ['user', 'list'] } }
  expect((await app.inject(request)).json().error.code).toBe('TOOL_DISABLED')
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'ldap-axi'; DELETE FROM role_tools WHERE tool = 'ldap-axi'")
  expect((await app.inject(request)).json().error.code).toBe('TOOL_NOT_GRANTED')
  expect(db.prepare("SELECT event FROM audit WHERE tool = 'ldap-axi' AND event = 'run-start'").all()).toEqual([])
})
