import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createLdapAdapter } from '../../src/server/adapters/ldap.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import * as toolSkills from '../../src/server/tool-skills.js'
import { skillsResponseSchema } from '../../src/shared/api.js'
import { ArtiumError } from '../../src/shared/errors.js'
import { SessionStore } from '../../src/cli/session.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: { authorization: string }
const loadToolSkill = toolSkills.loadToolSkill
beforeAll(() => { execFileSync(process.execPath, ['scripts/build-cli.mjs']) })
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-skills-api-'))
  db = openStore(join(directory, 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  await seedToolUser(db)
  db.exec('UPDATE tools SET enabled = 1')
  const runner = await Runner.create(join(directory, 'calls'))
  app = createApp({ db, runner, audit: new Audit(db), environment: {},
    adapters: [createFalconAdapter({ getCredential: async () => ({}) }), createLdapAdapter({ getCredential: async () => ({}) })],
    resolver: new SharedIdentityResolver(new FakeCredentialStore([])) })
  headers = { authorization: `Bearer ${issueTestAccessToken(db, 'synthetic-development-user')}` }
  vi.spyOn(toolSkills, 'loadToolSkill').mockImplementation(tool => loadToolSkill(tool,
    tool === 'falcon-axi' ? 'test/fixtures/falcon-SKILL.md' : `tools/node_modules/@knowttl/${tool}/skills/${tool}/SKILL.md`))
})
afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

test('the authenticated skill snapshot follows current grants, enabled tools and runtime availability', async () => {
  const first = await app.inject({ url: '/v1/skills', headers })
  expect(first.statusCode).toBe(200)
  expect(first.headers['cache-control']).toBe('no-store')
  expect(skillsResponseSchema.parse(first.json()).skills.map(skill => skill.name)).toEqual(['falcon-axi', 'ldap-axi'])
  db.exec("DELETE FROM role_tools WHERE tool = 'ldap-axi'; UPDATE tools SET enabled = 0 WHERE name = 'falcon-axi'")
  expect((await app.inject({ url: '/v1/skills', headers })).json()).toEqual({ skills: [] })
  db.exec("INSERT INTO role_tools VALUES ('synthetic-role', 'ldap-axi')")
  expect((await app.inject({ url: '/v1/skills', headers })).json().skills).toEqual([
    { name: 'ldap-axi', content: expect.stringContaining('artium-axi ldap-axi user list') },
  ])
})

test('skill downloads require an active signed-in account', async () => {
  expect((await app.inject('/v1/skills')).json().error.code).toBe('TOKEN_INVALID')
  db.exec('UPDATE users SET disabled = 1')
  expect((await app.inject({ url: '/v1/skills', headers })).json().error.code).toBe('USER_DISABLED')
})

test('one unavailable granted skill fails the whole snapshot', async () => {
  vi.mocked(toolSkills.loadToolSkill).mockImplementation(tool => {
    if (tool === 'ldap-axi') throw new ArtiumError('INTERNAL_ERROR')
    return loadToolSkill(tool, 'test/fixtures/falcon-SKILL.md')
  })
  const response = await app.inject({ url: '/v1/skills', headers })
  expect(response.statusCode).toBe(500)
  expect(response.json().skills).toBeUndefined()
})

test('the standalone CLI adds a new role grant using the same signed-in session', async () => {
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const bundle = join(directory, 'standalone.mjs')
  copyFileSync('dist/cli/artium-axi.mjs', bundle)
  new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated',
    accessToken: headers.authorization.slice('Bearer '.length), refreshToken: 'CANARY-refresh',
    accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
  const execute = promisify(execFile)
  const options = { env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory,
    ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }, timeout: 10_000 }
  db.exec("DELETE FROM role_tools WHERE tool = 'ldap-axi'")
  const first = await execute(process.execPath, [bundle, 'setup', '--host', 'codex'], options)
  expect(first.stdout).toContain('falcon-axi,installed')
  expect(first.stdout).not.toContain('ldap-axi')
  db.exec("INSERT INTO role_tools VALUES ('synthetic-role', 'ldap-axi')")
  const second = await execute(process.execPath, [bundle, 'setup', '--host', 'codex'], options)
  expect(second.stderr).toBe('')
  expect(second.stdout).toContain('falcon-axi,unchanged')
  expect(second.stdout).toContain('ldap-axi,installed')
  expect(readFileSync(join(directory, '.agents/skills/ldap-axi/SKILL.md'), 'utf8')).toContain('artium-axi ldap-axi user list')
})
