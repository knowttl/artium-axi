import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import postcss, { type AnyNode } from 'postcss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createApp } from '../src/server/app.js'
import { tokens } from '../src/server/admin/design/tokens.js'
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

function colourDeclarations(css: string) {
  const declarations: { property: string; value: string; context: string[] }[] = []
  postcss.parse(css).walkDecls(declaration => {
    if (!colour.test(declaration.value)) return
    const context: string[] = []
    for (let parent: AnyNode | undefined = declaration.parent; parent; parent = parent.parent) {
      if (parent.type === 'rule') context.push(parent.selector)
      if (parent.type === 'atrule') context.push(`@${parent.name} ${parent.params}`)
    }
    declarations.push({ property: declaration.prop, value: declaration.value, context })
  })
  return declarations
}

function elements(node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] {
  return [
    ...('tagName' in node ? [node] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(elements) : []),
  ]
}

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

test('the served stylesheet defines colours only through the token contract', async () => {
  const response = await app.inject({ url: '/admin/assets/style.css' })
  expect(response.statusCode).toBe(200)
  expect(colourDeclarations(response.body)).toEqual(colourDeclarations(tokens))
})

test.each([
  ['/admin', 'admin'], ['/admin/users', 'admin'], ['/admin/users/synthetic-ordinary', 'admin'], ['/admin/roles', 'admin'],
  ['/admin/roles/synthetic-role', 'admin'], ['/admin/invitations', 'admin'], ['/admin/tools', 'admin'], ['/admin/audit', 'admin'],
  ['/admin/settings/sign-in', 'admin'], ['/account', 'admin'], ['/account', 'ordinary'], ['/login', 'signed out'],
])('%s for a %s viewer has no inline styles, colour literals or ad hoc icons', async (url, viewer) => {
  const session = viewer === 'admin' ? admin : viewer === 'ordinary' ? ordinary : undefined
  const response = await app.inject({ url, headers: session ? { cookie: `${browserCookie}=${session}` } : {} })
  expect(response.statusCode).toBe(200)
  const page = elements(parse(response.body))
  const sprites = page.filter(element => element.tagName === 'svg' && element.attrs.some(attribute => attribute.name === 'class' && attribute.value === 'sprite'))
  expect(sprites.length).toBeLessThanOrEqual(1)
  const sprite = sprites[0]
  const symbols = sprite ? elements(sprite).filter(element => element.tagName === 'symbol')
    .map(element => element.attrs.find(attribute => attribute.name === 'id')?.value) : []
  for (const element of page) {
    expect(element.attrs.filter(attribute => attribute.name === 'style')).toEqual([])
    for (const attribute of element.attrs) expect(attribute.value).not.toMatch(colour)
    if (element.tagName !== 'svg' || element === sprite) continue
    const descendants = elements(element).slice(1)
    expect(descendants.map(child => child.tagName)).toEqual(['use'])
    const reference = descendants[0]!.attrs.find(attribute => attribute.name === 'href')?.value
    expect(reference).toMatch(/^#i-[a-z]+$/)
    expect(symbols).toContain(reference!.slice(1))
  }
  expect(page.filter(element => element.tagName === 'h1')).toHaveLength(1)
})

test('the admin navigation marks the section of the current page', async () => {
  const response = await app.inject({ url: '/admin/users/synthetic-ordinary', headers: { cookie: `${browserCookie}=${admin}` } })
  expect(response.body.match(/<a class="nav-item" href="([^"]+)" aria-current="page">/g)).toEqual(['<a class="nav-item" href="/admin/users" aria-current="page">'])
})
