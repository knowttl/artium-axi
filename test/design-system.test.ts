import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createApp } from '../src/server/app.js'
import { Audit } from '../src/server/audit/audit.js'
import { browserCookie } from '../src/server/auth/browser.js'
import { createBrowserSession } from '../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../src/server/policy/identity-resolver.js'
import { Runner } from '../src/server/runner/runner.js'
import { openStore } from '../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../src/server/store/key-provider.js'
import { FakeCredentialStore } from './fixtures/credential-store.js'
import { seedToolUser } from './fixtures/tokens.js'

// Rules from docs/design-system.md: colours live only in tokens, pages never style themselves, icons come from the sprite.
const colour = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i
const uiSources = ['src/server/admin', 'src/server/admin/design', 'src/server/auth']
  .flatMap(directory => readdirSync(directory).filter(file => file.endsWith('.ts')).map(file => join(directory, file)))
  .concat('src/server/app.ts')

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let admin: string
let ordinary: string

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-design-'))
  db = openStore(join(directory, 'artium.db'), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  await seedToolUser(db)
  db.exec(`UPDATE users SET administrator = 1;
    INSERT INTO users (id, username, display_name, password_hash, must_change)
    SELECT 'synthetic-ordinary', 'synthetic-ordinary', 'Ordinary', password_hash, 0 FROM users LIMIT 1`)
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: {},
    adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([])) })
  admin = createBrowserSession(db, 'synthetic-development-user', 'CANARY-csrf').id
  ordinary = createBrowserSession(db, 'synthetic-ordinary', 'CANARY-csrf').id
})

afterAll(async () => {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

test('only the tokens module defines colours', () => {
  const offenders = uiSources.filter(file => !file.endsWith('design/tokens.ts') && colour.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

test.each([
  ['/admin', 'admin'], ['/admin/users', 'admin'], ['/admin/users/synthetic-ordinary', 'admin'], ['/admin/roles', 'admin'],
  ['/admin/roles/synthetic-role', 'admin'], ['/admin/invitations', 'admin'], ['/admin/tools', 'admin'], ['/admin/audit', 'admin'],
  ['/admin/settings/sign-in', 'admin'], ['/account', 'admin'], ['/account', 'ordinary'], ['/login', 'signed out'],
])('%s for a %s viewer has no inline styles, colour literals or ad hoc icons', async (url, viewer) => {
  const session = viewer === 'admin' ? admin : viewer === 'ordinary' ? ordinary : undefined
  const response = await app.inject({ url, headers: session ? { cookie: `${browserCookie}=${session}` } : {} })
  expect(response.statusCode).toBe(200)
  const [page, sprite = ''] = response.body.split('<svg class="sprite"')
  expect(page).not.toMatch(/\sstyle=/)
  expect(page).not.toMatch(colour)
  expect(page).not.toMatch(/<(?:path|circle|rect|symbol)\b/)
  for (const [, name] of page!.matchAll(/<use href="#(i-[a-z]+)"/g)) expect(sprite).toContain(`<symbol id="${name}"`)
  expect(page!.match(/<h1>/g)).toHaveLength(1)
})

test('the admin navigation marks the section of the current page', async () => {
  const response = await app.inject({ url: '/admin/users/synthetic-ordinary', headers: { cookie: `${browserCookie}=${admin}` } })
  expect(response.body.match(/<a class="nav-item" href="([^"]+)" aria-current="page">/g)).toEqual(['<a class="nav-item" href="/admin/users" aria-current="page">'])
})
