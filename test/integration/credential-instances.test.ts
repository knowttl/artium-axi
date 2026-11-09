import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import type { MutableCredentialStore } from '../../src/server/store/credential-store.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { issueTestAccessToken } from '../fixtures/tokens.js'
import { createRunnerTestAdapter } from '../fake-tool/tool.js'

const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
let directory: string
let db: Database.Database
let store: MutableCredentialStore
let runner: Runner
let app: ReturnType<typeof createApp>
let token: string
let usedClients: unknown[]

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-credential-instances-'))
  db = openStore(join(directory, 'artium.db'), provider)
  store = createCredentialStore(db, provider)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('synthetic-user', 'synthetic-user', 'Synthetic User', 'unusable');
    UPDATE tools SET enabled = 1, pinned_version = '0.6.0' WHERE name = 'falcon-axi';
    INSERT INTO roles (id, name) VALUES ('synthetic-role', 'Synthetic Role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-user', 'synthetic-role');
    INSERT INTO role_tools (role_id, tool) VALUES ('synthetic-role', 'falcon-axi');`)
  for (const name of ['lab', 'production']) {
    store.createInstance('falcon-axi', { name, description: '' }, { clientId: `CANARY-client-${name}`, clientSecret: 'CANARY-secret', region: 'us-2' }, 'synthetic-user', 1000)
  }
  token = issueTestAccessToken(db, 'synthetic-user')
  usedClients = []
  runner = await Runner.create(join(directory, 'calls'))
  const adapter = createRunnerTestAdapter({ getCredential: async reference => {
    const credential = store.readCredential(reference) as { clientId: string }
    usedClients.push(credential.clientId)
    return credential
  } }, true)
  app = createApp({ db, runner, audit: new Audit(db, Date.now, () => {}), resolver: new SharedIdentityResolver(store), adapters: [adapter], environment: {} })
})
afterEach(async () => {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const run = (payload: object) => app.inject({ method: 'POST', url: '/v1/tools/falcon-axi/run',
  headers: { authorization: `Bearer ${token}` }, payload: { args: ['detection', 'list'], ...payload } })

test.each(['lab', 'production'])('run selects the %s instance and reports it', async instance => {
  const reply = await run({ instance })
  expect(reply.statusCode).toBe(200)
  expect(reply.json()).toMatchObject({ source: 'falcon-axi', instance, exitCode: 0 })
  expect(usedClients).toEqual([`CANARY-client-${instance}`])
})

test.each([
  ['unknown', { instance: 'staging' }, 404, 'INSTANCE_NOT_FOUND'],
  ['malformed', { instance: 'Lab' }, 400, 'INVALID_INPUT'],
])('%s instance fails closed before any credential is read', async (_label, payload, status, code) => {
  const reply = await run(payload)
  expect(reply.statusCode).toBe(status)
  expect(reply.json().error.code).toBe(code)
  expect(usedClients).toEqual([])
})

test('omitting an instance returns the sorted usable choices', async () => {
  const reply = await run({})
  expect(reply.statusCode).toBe(409)
  expect(reply.json().error).toMatchObject({ code: 'INSTANCE_REQUIRED',
    next: 'Ask the user which instance to use, then run artium-axi --instance <lab|production> falcon-axi ...' })
  expect(usedClients).toEqual([])
})

test('disabled instance is refused when named and not selected implicitly', async () => {
  const lab = store.findInstance('falcon-axi', 'lab')!
  store.setInstanceFlags('falcon-axi', 'lab', { enabled: false }, lab.id, lab.revision, 'synthetic-user', 2000)
  const named = await run({ instance: 'lab' })
  expect(named.statusCode).toBe(403)
  expect(named.json().error.code).toBe('INSTANCE_DISABLED')
  const implicit = await run({})
  expect(implicit.statusCode).toBe(200)
  expect(implicit.json().instance).toBe('production')
  expect(usedClients).toEqual(['CANARY-client-production'])
})
