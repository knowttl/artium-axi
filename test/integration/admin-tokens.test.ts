import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createDelegation, revokeDelegation } from '../../src/server/auth/delegations.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { seedToolUser } from '../fixtures/tokens.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
const now = Date.UTC(2026, 0, 1)
const owner = 'synthetic-development-user'
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  directory = mkdtempSync(join(tmpdir(), 'artium-admin-tokens-'))
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'; UPDATE delegation_settings SET minting_enabled = 1")
  const store = createCredentialStore(db, key)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [], credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), environment: {} })
  headers = { host: 'localhost', origin: 'http://localhost', cookie: `${browserCookie}=${createBrowserSession(db, owner, 'CANARY-csrf').id}; _csrf=CANARY-csrf` }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

type TokenId = NonNullable<Parameters<typeof createDelegation>[4]>
const mint = (id: string, label: string, expiresAt = now + 3600000, createdAt = now) => createDelegation(db, owner,
  { label, scope: { tools: [{ tool: 'falcon-axi' }] }, readOnly: true, reusable: true, expiresAt }, [], id as TokenId, createdAt)
const tokensPage = () => app.inject({ url: '/admin/tokens', headers })
const hydrationProps = (body: string) => JSON.parse(body.match(/<script type="application\/json" data-astryx-props>(.*?)<\/script>/)![1]!)

function pageForm(body: string, action: string) {
  const [, tag, content] = body.match(new RegExp(`<form([^>]*action="${action}"[^>]*)>(.*?)</form>`, 's')) ?? []
  const attributes = (markup: string) => Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, match[2]!]))
  const inputs = Object.fromEntries([...(content ?? '').matchAll(/<input([^>]*)>/g)].map(match => attributes(match[1]!)).filter(input => input.name).map(input => [input.name!, input]))
  return { attributes: tag ? attributes(tag) : undefined, inputs }
}

test('the settings form posts what the old form did, with its saved values', async () => {
  const form = pageForm((await tokensPage()).body, '/v1/admin/token-settings')
  expect(form.attributes).toMatchObject({ 'data-api': '', 'data-method': 'PATCH', 'data-confirm': 'Save these token settings?', 'data-token-settings': '', method: 'post' })
  expect(Object.keys(form.inputs)).toEqual(['_csrf', 'mintingEnabled', 'maxLifetimeHours', 'ssoWindowDays'])
  expect(form.inputs.mintingEnabled).toMatchObject({ type: 'checkbox', 'data-type': 'boolean', checked: '' })
  expect(form.inputs.maxLifetimeHours).toMatchObject({ type: 'number', min: '0.01', step: 'any', value: '720', required: '' })
  expect(form.inputs.ssoWindowDays).toMatchObject({ type: 'number', min: '1', max: '30', step: 'any', value: '7', required: '' })
  expect(form.inputs._csrf!.value).toBeTruthy()
})

test('the settings form shows changed settings, a fractional lifetime and an unchecked box', async () => {
  db.exec('UPDATE delegation_settings SET minting_enabled = 0, max_lifetime_ms = 5400000, sso_window_ms = 172800000')
  const form = pageForm((await tokensPage()).body, '/v1/admin/token-settings')
  expect(form.inputs.mintingEnabled).not.toHaveProperty('checked')
  expect(form.inputs.maxLifetimeHours).toMatchObject({ value: '1.5' })
  expect(form.inputs.ssoWindowDays).toMatchObject({ value: '2' })
})

test('each token that is not revoked has a Revoke form for its own URL, and Revoke all stays', async () => {
  mint('token-live', 'Synthetic live')
  mint('token-gone', 'Synthetic gone')
  revokeDelegation(db, 'token-gone', owner, true)
  const { body } = await tokensPage()
  expect(pageForm(body, '/v1/admin/tokens/token-live/revoke').attributes).toMatchObject({ 'data-api': '', 'data-method': 'POST', 'data-confirm': 'Revoke this token and its sessions?', method: 'post' })
  expect(pageForm(body, '/v1/admin/tokens/token-gone/revoke').attributes).toBeUndefined()
  const all = pageForm(body, '/v1/admin/tokens/revoke-all')
  expect(all.attributes).toMatchObject({ 'data-method': 'POST', 'data-confirm': 'Revoke all tokens and their sessions?' })
  expect(Object.keys(all.inputs)).toEqual(['_csrf'])
})

test('submitting the rendered Revoke form revokes that token and the page then shows it Revoked without a form', async () => {
  mint('token-live', 'Synthetic live')
  mint('token-other', 'Synthetic other')
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now)
  const page = await tokensPage()
  const form = pageForm(page.body, '/v1/admin/tokens/token-live/revoke')
  const revoked = await app.inject({ method: 'POST', url: '/v1/admin/tokens/token-live/revoke', headers, payload: { _csrf: form.inputs._csrf!.value } })
  expect(revoked.statusCode).toBe(204)
  expect(db.prepare('SELECT id, revoked_at AS revokedAt FROM delegations ORDER BY id').all()).toEqual([{ id: 'token-live', revokedAt: now }, { id: 'token-other', revokedAt: null }])
  const { body } = await tokensPage()
  expect(Object.fromEntries(hydrationProps(body).props.tokens.map((token: { id: string, status: { word: string } }) => [token.id, token.status.word])))
    .toEqual({ 'token-live': 'Revoked', 'token-other': 'Active' })
  expect(pageForm(body, '/v1/admin/tokens/token-live/revoke').attributes).toBeUndefined()
})

test('each token says Revoked, Expired, Paused, Used or Active in that order of precedence', async () => {
  db.prepare("INSERT INTO users (id, username, display_name, source, must_change, last_sso_sign_in_at) VALUES ('synthetic-sso', 'synthetic-sso', 'SSO', 'sso', 0, NULL)").run()
  for (const id of ['active', 'used', 'paused', 'paused-used', 'expired', 'expired-paused', 'revoked-expired']) mint(id, `Synthetic ${id}`)
  db.exec(`UPDATE delegations SET single_use = 1, consumed_at = ${now} WHERE id IN ('used', 'paused-used');
    UPDATE delegations SET creator_id = 'synthetic-sso' WHERE id IN ('paused', 'paused-used', 'expired-paused');
    UPDATE delegations SET expires_at = ${now} WHERE id IN ('expired', 'expired-paused', 'revoked-expired')`)
  revokeDelegation(db, 'revoked-expired', owner, true)
  const { body } = await tokensPage()
  expect(Object.fromEntries(hydrationProps(body).props.tokens.map((token: { id: string, status: { word: string } }) => [token.id, token.status.word]))).toEqual({
    active: 'Active', used: 'Used', paused: 'Paused until creator signs in via SSO', 'paused-used': 'Paused until creator signs in via SSO',
    expired: 'Expired', 'expired-paused': 'Expired', 'revoked-expired': 'Revoked' })
  expect(body).toContain('Paused until creator signs in via SSO')
})

test('every token is listed newest first with its label, id, creator, access, scope and expiry', async () => {
  mint('token-first', 'Synthetic first')
  db.prepare("UPDATE delegations SET created_at = created_at + 1, read_only = 0, single_use = 1, scope_json = ? WHERE id = 'token-first'")
    .run(JSON.stringify({ tools: [{ tool: 'falcon-axi', commands: ['detection list'] }] }))
  mint('token-second', 'Synthetic second', now + 7200000, now + 2)
  const { tokens } = hydrationProps((await tokensPage()).body).props
  expect(tokens).toEqual([
    { id: 'token-second', label: 'Synthetic second', creator: owner, writable: false, singleUse: false, scope: [{ tool: 'falcon-axi' }],
      expiresAt: new Date(now + 7200000).toISOString(), status: { word: 'Active', tone: 'ok' }, revocable: true },
    { id: 'token-first', label: 'Synthetic first', creator: owner, writable: true, singleUse: true, scope: [{ tool: 'falcon-axi', commands: ['detection list'] }],
      expiresAt: new Date(now + 3600000).toISOString(), status: { word: 'Active', tone: 'ok' }, revocable: true },
  ])
})

test('the page, its hydration data, headers and audit carry no token value, hash or prefix', async () => {
  const { token } = mint('token-secret', 'Synthetic secret')
  const { token_hash: hash } = db.prepare('SELECT token_hash FROM delegations WHERE id = ?').get('token-secret') as { token_hash: string }
  const page = await tokensPage()
  expect(page.statusCode).toBe(200)
  const exposure = JSON.stringify([page.body, page.headers, db.prepare('SELECT * FROM audit').all()])
  for (const secret of [token, hash, 'artd_']) expect(exposure).not.toContain(secret)
})

test('with no tokens the list says so and Settings and Revoke all remain', async () => {
  const { body } = await tokensPage()
  expect(body).toContain('No tokens')
  expect(body).not.toContain('<table')
  expect(pageForm(body, '/v1/admin/token-settings').attributes).toBeDefined()
  expect(pageForm(body, '/v1/admin/tokens/revoke-all').attributes).toBeDefined()
})

test('a person who is not an administrator sees no tokens', async () => {
  mint('token-live', 'Synthetic live')
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
    SELECT 'synthetic-second', 'synthetic-second', 'Second', password_hash, 1, 0 FROM users LIMIT 1`)
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(owner)
  const page = await tokensPage()
  expect(page.statusCode).toBe(403)
  expect(page.body).not.toContain('Synthetic live')
})

test('Account still renders its token card in the legacy markup, with the create form and the one-time dialog', async () => {
  mint('token-account', 'Synthetic account')
  const page = await app.inject({ url: '/account', headers })
  expect(page.statusCode).toBe(200)
  const card = page.body.match(/<section class="card"><div class="card-head"><div><h2>Temporary access tokens<\/h2>.*?<\/section>/s)![0].replace(/(name="_csrf" value=")[^"]*/g, '$1CSRF')
  await expect(card).toMatchFileSnapshot('../fixtures/account-tokens-card.html')
})
