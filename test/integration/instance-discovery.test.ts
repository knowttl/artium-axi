import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { toolSkillPaths } from '../../src/server/config.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let store: ReturnType<typeof createCredentialStore>
let headers: { authorization: string }
const previousSkill = toolSkillPaths['falcon-axi']
const value = { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-instance-discovery-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec("DELETE FROM role_tools WHERE tool != 'falcon-axi'; UPDATE tools SET enabled = 1")
  store = createCredentialStore(db, provider)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), environment: {},
    adapters: [createFalconAdapter({ getCredential: async () => ({}) })], resolver: new SharedIdentityResolver(store, db) })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  Object.assign(toolSkillPaths, { 'falcon-axi': join(process.cwd(), 'tools/node_modules/@knowttl/falcon-axi/skills/falcon-axi/SKILL.md') })
})

afterEach(async () => {
  await app.close()
  db.close()
  Object.assign(toolSkillPaths, { 'falcon-axi': previousSkill })
  rmSync(directory, { recursive: true, force: true })
})

const falcon = async () => (await app.inject({ url: '/v1/tools', headers })).json().tools[0]
const skill = async () => (await app.inject({ url: '/v1/skills', headers })).json().skills[0].content as string

test('discovery lists the usable instances with per-instance health and read-only state, without endpoints', async () => {
  expect((await falcon()).instances).toEqual([])
  const lab = store.createInstance('falcon-axi', { name: 'lab', description: 'Lab tenant. Safe for tests.' }, value, 'synthetic-development-user', 1000)
  const production = store.createInstance('falcon-axi', { name: 'production', description: 'Production tenant.' }, value, 'synthetic-development-user', 1000)
  const retired = store.createInstance('falcon-axi', { name: 'retired', description: 'Old tenant.' }, value, 'synthetic-development-user', 1000)
  store.setInstanceFlags('falcon-axi', 'retired', { enabled: false }, retired.id, retired.revision, 'synthetic-development-user', 2000)
  const writableLab = store.setInstanceFlags('falcon-axi', 'lab', { readOnly: false }, lab.id, lab.revision, 'synthetic-development-user', 2000)
  db.prepare("UPDATE tools SET native_settings = '{\"allowWrites\":true}' WHERE name = 'falcon-axi'").run()
  db.prepare("INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status, error_code) VALUES (?, 'falcon-axi', ?, 1, 'error', 'UPSTREAM_NETWORK_FAILED')")
    .run(production.id, production.revision)
  db.prepare("INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status) VALUES (?, 'falcon-axi', ?, 1, 'ok')")
    .run(writableLab.id, writableLab.revision)
  const response = await app.inject({ url: '/v1/tools', headers })
  expect(response.json().tools[0]).toMatchObject({ status: 'error', errorCode: 'UPSTREAM_NETWORK_FAILED' })
  expect(response.json().tools[0].instances).toEqual([
    { name: 'lab', description: 'Lab tenant. Safe for tests.', status: 'ok', readOnly: false },
    { name: 'production', description: 'Production tenant.', status: 'error', readOnly: true, errorCode: 'UPSTREAM_NETWORK_FAILED' },
  ])
  expect(response.body).not.toContain('CANARY')
  expect(response.body).not.toContain('us-2')
})

test('discovery treats a cached category from an older catalogue as unknown', async () => {
  const lab = store.createInstance('falcon-axi', { name: 'lab', description: 'Lab tenant.' }, value, 'synthetic-development-user', 1000)
  const production = store.createInstance('falcon-axi', { name: 'production', description: 'Production tenant.' }, value, 'synthetic-development-user', 1000)
  db.prepare("INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status, error_code) VALUES (?, 'falcon-axi', ?, 1, 'error', 'OLD_ERROR_CATEGORY')")
    .run(lab.id, lab.revision)
  db.prepare("INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status) VALUES (?, 'falcon-axi', ?, 1, 'ok')")
    .run(production.id, production.revision)
  const response = await app.inject({ url: '/v1/tools', headers })
  expect(response.statusCode).toBe(200)
  expect(response.json().tools[0]).toMatchObject({ status: 'unknown', instances: [
    { name: 'lab', description: 'Lab tenant.', status: 'unknown', readOnly: true },
    { name: 'production', description: 'Production tenant.', status: 'ok', readOnly: true },
  ] })
  expect(response.json().tools[0]).not.toHaveProperty('errorCode')
})

test('the served skill gains the instance paragraph only while several instances are usable', async () => {
  store.createInstance('falcon-axi', { name: 'lab', description: '' }, value, 'synthetic-development-user', 1000)
  expect(await skill()).not.toContain('## Instances')
  store.createInstance('falcon-axi', { name: 'production', description: '' }, value, 'synthetic-development-user', 1000)
  expect(await skill()).toContain('ask the user which one to use')
  expect(await skill()).toContain('artium-axi --instance <name> falcon-axi ...')
})

test.each(['full', 'delegated'] as const)('%s discovery only exposes instances granted to the caller', async session => {
  const lab = store.createInstance('falcon-axi', { name: 'lab', description: 'Lab tenant.' }, value, 'synthetic-development-user', 1000)
  store.createInstance('falcon-axi', { name: 'production', description: 'Production tenant.' }, value, 'synthetic-development-user', 1000)
  db.prepare("UPDATE role_tools SET all_instances = 0 WHERE role_id = 'synthetic-role' AND tool = 'falcon-axi'").run()
  db.prepare("INSERT INTO role_tool_instances (role_id, tool, credential_id) VALUES ('synthetic-role', 'falcon-axi', ?)").run(lab.id)
  const grant = session === 'delegated' ? createDelegation(db, 'synthetic-development-user',
    { label: 'Synthetic', scope: { tools: [{ tool: 'falcon-axi' }] }, readOnly: true, reusable: true, expiresAt: Date.now() + 600000 }, []) : undefined
  const caller = grant ? { authorization: `Bearer ${exchangeDelegation(db, grant.token).accessToken}` } : headers
  const response = await app.inject({ url: '/v1/tools', headers: caller })
  expect(response.statusCode).toBe(200)
  expect(response.json().tools[0].instances).toEqual([
    { name: 'lab', description: 'Lab tenant.', status: 'unknown', readOnly: true },
  ])
  const skills = await app.inject({ url: '/v1/skills', headers: caller })
  expect(skills.statusCode).toBe(200)
  expect(skills.json().skills[0].content).not.toContain('## Instances')
})
