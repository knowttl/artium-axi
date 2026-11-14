import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
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
  expect(response.body.length).toBeGreaterThan(100_000)
})

test.each(assets)('%s revalidates by entity tag', async url => {
  const first = await app.inject({ url })
  expect(first.headers['cache-control']).toBe('no-cache')
  const revalidated = await app.inject({ url, headers: { 'if-none-match': first.headers.etag as string } })
  expect(revalidated.statusCode).toBe(304)
  expect(revalidated.body).toBe('')
  const changed = await app.inject({ url, headers: { 'if-none-match': '"stale"' } })
  expect(changed.statusCode).toBe(200)
})

test('the hydration bundle needs no unsafe-eval', async () => {
  const { body } = await app.inject({ url: '/admin/assets/hydrate.js' })
  expect(body).not.toMatch(/\beval\s*\(|new\s+Function\b/)
})

test('the Astryx stylesheet is self-contained under default-src none', async () => {
  const { body } = await app.inject({ url: '/admin/assets/astryx.css' })
  expect(body).not.toMatch(/@import|url\(/)
})
