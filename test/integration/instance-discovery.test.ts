import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import * as toolSkills from '../../src/server/tool-skills.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let store: ReturnType<typeof createCredentialStore>
let headers: { authorization: string }
const loadToolSkill = toolSkills.loadToolSkill
const value = { clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-2' }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-instance-discovery-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), provider)
  await seedToolUser(db)
  db.exec("DELETE FROM role_tools WHERE tool != 'falcon-axi'; UPDATE tools SET enabled = 1")
  store = createCredentialStore(db, provider)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), environment: {},
    adapters: [createFalconAdapter({ getCredential: async () => ({}) })], resolver: new SharedIdentityResolver(store) })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  vi.spyOn(toolSkills, 'loadToolSkill').mockImplementation(tool => loadToolSkill(tool,
    `tools/node_modules/@knowttl/${tool}/skills/${tool}/SKILL.md`))
})

afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
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
  store.setInstanceFlags('falcon-axi', 'lab', { readOnly: false }, lab.id, lab.revision, 'synthetic-development-user', 2000)
  db.prepare("UPDATE tools SET native_settings = '{\"allowWrites\":true}' WHERE name = 'falcon-axi'").run()
  db.prepare("INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status, error_code) VALUES (?, 'falcon-axi', ?, 1, 'error', 'UPSTREAM_NETWORK_FAILED')")
    .run(production.id, production.revision)
  const response = await app.inject({ url: '/v1/tools', headers })
  expect(response.json().tools[0].instances).toEqual([
    { name: 'lab', description: 'Lab tenant. Safe for tests.', status: 'unknown', readOnly: false },
    { name: 'production', description: 'Production tenant.', status: 'error', readOnly: true, errorCode: 'UPSTREAM_NETWORK_FAILED' },
  ])
  expect(response.body).not.toContain('CANARY')
  expect(response.body).not.toContain('us-2')
})

test('the served skill gains the instance paragraph only while several instances are usable', async () => {
  store.createInstance('falcon-axi', { name: 'lab', description: '' }, value, 'synthetic-development-user', 1000)
  expect(await skill()).not.toContain('## Instances')
  store.createInstance('falcon-axi', { name: 'production', description: '' }, value, 'synthetic-development-user', 1000)
  expect(await skill()).toContain('ask the user which one to use')
  expect(await skill()).toContain('artium-axi --instance <name> falcon-axi ...')
})
