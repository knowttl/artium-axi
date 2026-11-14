import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import * as cssTree from 'css-tree'
import postcss from 'postcss'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createApp } from '../src/server/app.js'
import { Audit } from '../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../src/server/policy/identity-resolver.js'
import { Runner } from '../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../src/server/store/key-provider.js'
import { ProviderCredentials } from '../src/server/store/provider-credentials.js'
import { FakeCredentialStore } from './fixtures/credential-store.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-client-assets-'))
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), key)
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: {},
    adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([]), db), providerCredentials: new ProviderCredentials(db, key), credentialStore: createCredentialStore(db, key) })
})

afterAll(async () => {
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const assets = [
  ['/admin/assets/hydrate.js', 'application/javascript'],
  ['/admin/assets/astryx.css', 'text/css'],
]

test.each(assets)('%s is served same-origin without a session under the script and style policy', async (url, type) => {
  const response = await app.inject({ url })
  expect(response.statusCode).toBe(200)
  expect(response.headers['content-type']).toMatch(new RegExp(`^${type}`))
  expect(response.headers['content-security-policy']).toContain("script-src 'self'; style-src 'self';")
  expect(response.headers['content-security-policy']).not.toContain('unsafe-')
})

test('the Astryx stylesheet is self-contained under default-src none', async () => {
  const { body } = await app.inject({ url: '/admin/assets/astryx.css' })
  const resources: string[] = []
  const stylesheet = postcss.parse(body)
  stylesheet.walkAtRules('import', () => { resources.push('@import') })
  stylesheet.walkDecls(declaration => {
    cssTree.walk(cssTree.parse(declaration.value, { context: 'value', onParseError: error => { throw error } }), node => {
      if (node.type === 'Url') resources.push(node.value)
    })
  })
  expect(resources).toEqual([])
})

test('the served Astryx stylesheet declares the documented theme tokens', async () => {
  const { body } = await app.inject({ url: '/admin/assets/astryx.css' })
  const properties = new Set<string>()
  postcss.parse(body).walkDecls(declaration => { properties.add(declaration.prop) })
  for (const token of ['--color-text-primary', '--color-background-surface', '--color-accent', '--radius-container']) {
    expect(properties.has(token), token).toBe(true)
  }
})

test('the build entry point works in a path containing spaces', () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-admin client-'))
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'src'))
    copyFileSync('scripts/build-admin-client.mjs', join(root, 'scripts/build-admin-client.mjs'))
    symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')
    symlinkSync(join(process.cwd(), 'src/client'), join(root, 'src/client'), 'dir')
    execFileSync(process.execPath, [join(root, 'scripts/build-admin-client.mjs')], { cwd: root })
    expect(readFileSync(join(root, 'src/server/admin/client/astryx.css'), 'utf8')).toBe(
      readFileSync('src/server/admin/client/astryx.css', 'utf8'))
    expect(readFileSync(join(root, 'src/server/admin/client/hydrate.js'), 'utf8')).toBe(
      readFileSync('src/server/admin/client/hydrate.js', 'utf8'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
