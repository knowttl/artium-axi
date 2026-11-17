import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { confirmationRoutes } from '../../src/shared/confirmation-routes.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let routes: string[]
let headers: Record<string, string>
let csrf: string
const now = Date.UTC(2026, 0, 1)
const owner = 'synthetic-development-user'
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const revokeAll = '/v1/admin/tokens/revoke-all'
const form = { 'content-type': 'application/x-www-form-urlencoded' }

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  directory = mkdtempSync(join(tmpdir(), 'artium-admin-confirmation-'))
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'; UPDATE delegation_settings SET minting_enabled = 1")
  const store = createCredentialStore(db, key)
  routes = []
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [], credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), environment: {}, onRoute: (method, url) => routes.push(...[method].flat().map(name => `${name} ${url}`)) })
  headers = browserHeaders()
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now)
  csrf = pageForm(await tokenPage(), revokeAll).inputs._csrf!
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const browserHeaders = () => ({ host: 'localhost', origin: 'http://localhost', cookie: `${browserCookie}=${createBrowserSession(db, owner, 'CANARY-csrf').id}; _csrf=CANARY-csrf` })
const mint = (id: string) => createDelegation(db, owner, { label: `Synthetic ${id}`, scope: { tools: [{ tool: 'falcon-axi' }] }, readOnly: true, reusable: true, expiresAt: now + 3600000 }, [], id as never, now)
const revoked = () => db.prepare('SELECT id FROM delegations WHERE revoked_at IS NOT NULL ORDER BY id').all().map(row => (row as { id: string }).id)
const revocations = () => (db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'token-revoke'").get() as { count: number }).count

function pageForm(body: string, action: string) {
  const [, tag, content] = body.match(new RegExp(`<form([^>]*action="${action}"[^>]*)>(.*?)</form>`, 's')) ?? []
  const attributes = (markup: string) => Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, match[2]!]))
  const inputs = Object.fromEntries([...(content ?? '').matchAll(/<input([^>]*)>/g)].map(match => attributes(match[1]!)).filter(input => input.name).map(input => [input.name!, input.value ?? '']))
  return { attributes: attributes(tag ?? ''), inputs }
}
const tokenPage = async () => (await app.inject({ url: '/admin/tokens', headers })).body
const post = (url: string, payload: Record<string, unknown>, as = headers) => app.inject({ method: 'POST', url, headers: as, payload: { _csrf: csrf, ...payload } })
const postForm = (url: string, inputs: Record<string, string>, as: Record<string, string> = headers) =>
  app.inject({ method: 'POST', url, headers: { ...as, ...form }, payload: new URLSearchParams(inputs).toString() })

test('every confirmation route is a route the server registers', () => {
  expect(Object.keys(confirmationRoutes).filter(route => !routes.includes(route))).toEqual([])
})

test('a confirmation-tier form carries its confirmation outside its fields, so a native submit cannot send it', async () => {
  const revoke = pageForm(await tokenPage(), revokeAll)
  expect(revoke.attributes['data-confirm-token']).toMatch(/^\d+\.[\w-]+$/)
  expect(Object.keys(revoke.inputs)).not.toContain('_confirm')
})

test('a native post without confirmation changes nothing and answers with the confirmation step, and confirming completes it once', async () => {
  mint('token-live')
  const page = pageForm(await tokenPage(), revokeAll)
  const step = await postForm(revokeAll, page.inputs, { ...headers, referer: 'http://localhost/admin/tokens' })
  expect(step.statusCode).toBe(200)
  expect(step.body).toContain('Revoke all tokens and their sessions?')
  expect(step.body).toContain('href="/admin/tokens"')
  expect(revoked()).toEqual([])
  const confirmation = pageForm(step.body, revokeAll).inputs
  expect(Object.keys(confirmation).sort()).toEqual(['_confirm', '_csrf'])
  const completed = await postForm(revokeAll, confirmation)
  expect([completed.statusCode, completed.headers.location]).toEqual([303, '/admin'])
  expect(revoked()).toEqual(['token-live'])
  expect(revocations()).toBe(1)
})

test('the confirmation step never shows a field the route does not carry, and a cross-origin referrer is not a way back', async () => {
  const step = await postForm(revokeAll, { ...pageForm(await tokenPage(), revokeAll).inputs, temporaryPassword: 'CANARY-typed-secret' },
    { ...headers, referer: 'https://elsewhere.example/admin/tokens' })
  expect(step.statusCode).toBe(200)
  expect(step.body).not.toContain('CANARY-typed-secret')
  expect(step.body).toContain('href="/admin"')
  expect(step.body).not.toContain('elsewhere.example')
})

test('a scripted request without confirmation is refused with CONFIRMATION_REQUIRED, and with the page confirmation it completes once', async () => {
  mint('token-live')
  const refused = await post(revokeAll, {})
  expect([refused.statusCode, refused.json().error.code]).toEqual([428, 'CONFIRMATION_REQUIRED'])
  expect(revoked()).toEqual([])
  const confirmation = pageForm(await tokenPage(), revokeAll).attributes['data-confirm-token']!
  const completed = await post(revokeAll, { _confirm: confirmation }, { ...headers, accept: 'application/json' })
  expect([completed.statusCode, completed.body]).toEqual([204, ''])
  expect(revoked()).toEqual(['token-live'])
  expect(revocations()).toBe(1)
})

test('a confirmation minted for one action is refused for another action and for another target', async () => {
  mint('token-a')
  mint('token-b')
  const page = await tokenPage()
  const forAll = pageForm(page, revokeAll).attributes['data-confirm-token']!
  const forA = pageForm(page, '/v1/admin/tokens/token-a/revoke').attributes['data-confirm-token']!
  for (const [url, confirmation] of [['/v1/admin/tokens/token-a/revoke', forAll], ['/v1/admin/tokens/token-b/revoke', forA], [revokeAll, forA]] as const) {
    expect((await post(url, { _confirm: confirmation })).json().error.code).toBe('CONFIRMATION_REQUIRED')
  }
  expect(revoked()).toEqual([])
})

test('a confirmation from another session and a malformed one are refused', async () => {
  mint('token-live')
  const issued = pageForm(await tokenPage(), revokeAll).attributes['data-confirm-token']!
  const otherSession = browserHeaders()
  expect((await post(revokeAll, { _confirm: issued }, otherSession)).json().error.code).toBe('CONFIRMATION_REQUIRED')
  for (const malformed of ['', 'garbage', `${now}.`, `${now + 1}.${issued.split('.')[1]}`, `x.${issued.split('.')[1]}`]) {
    expect((await post(revokeAll, { _confirm: malformed })).json().error.code).toBe('CONFIRMATION_REQUIRED')
  }
  expect(revoked()).toEqual([])
})

test('a lapsed confirmation returns the confirmation step without changing anything', async () => {
  mint('token-live')
  const issued = pageForm(await tokenPage(), revokeAll).attributes['data-confirm-token']!
  vi.spyOn(Date, 'now').mockReturnValue(now + 20 * 60000)
  expect((await app.inject({ url: '/admin/tokens', headers })).statusCode).toBe(200)
  vi.spyOn(Date, 'now').mockReturnValue(now + 40 * 60000)
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now + 40 * 60000)
  const response = await postForm(revokeAll, { _csrf: csrf, _confirm: issued })
  expect(response.statusCode).toBe(200)
  expect(pageForm(response.body, revokeAll).inputs._confirm).toBeTruthy()
  expect(revoked()).toEqual([])
})

test('a native post to a route that needs the page script changes nothing and says so', async () => {
  const archive = `/v1/admin/users/${owner}/archive`
  const page = (await app.inject({ url: `/admin/users/${owner}`, headers })).body
  const response = await postForm(archive, pageForm(page, archive).inputs)
  expect(response.statusCode).toBe(409)
  expect(response.body).toContain('Page script required')
  expect(response.body).not.toContain('name="_confirm"')
  expect(db.prepare('SELECT archived_at FROM users WHERE id = ?').get(owner)).toEqual({ archived_at: null })
})

test.each([revokeAll, '/v1/admin/tokens/token-live/revoke'])('a token-authenticated call to %s needs no confirmation, as before', async url => {
  mint('token-live')
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
  const bearer = { authorization: `Bearer ${login.json().accessToken}` }
  const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers: bearer, payload: { password: 'CANARY-local-password' } })
  const response = await app.inject({ method: 'POST', url, headers: { ...bearer, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: {} })
  expect(response.statusCode).toBe(204)
  expect(revoked()).toEqual(['token-live'])
})
