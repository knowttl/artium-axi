import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
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

type Element = DefaultTreeAdapterMap['element']
const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const ownText = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child && !['input', 'select', 'textarea', 'option', 'button', 'svg'].includes(child.tagName) ? ownText(child) : '').join(' ').replace(/\s+/g, ' ').trim()
const ignored = new Set(['class', 'id', 'style', 'aria-describedby', 'aria-labelledby', 'aria-invalid', 'aria-required', 'data-confirm'])
const attributes = (element: Element) => Object.fromEntries(element.attrs.filter(item => !ignored.has(item.name)).map(item => [item.name, item.value]))
const tokenCard = (html: string) => {
  const all = nodes(parse(html))
  const form = all.find(element => element.tagName === 'form' && attribute(element, 'data-create-token') !== undefined)!
  const dialog = all.find(element => element.tagName === 'dialog' && attribute(element, 'id') === 'created-token')!
  const table = all.find(element => element.tagName === 'table' && nodes(element).some(cell => cell.tagName === 'th' && ownText(cell) === 'Label'))
  const inner = (root: Element) => nodes(root).filter(element => element !== root)
  const rows = table ? nodes(table).filter(element => element.tagName === 'tr').slice(1) : []
  return {
    form: { ...attributes(form), confirm: attribute(form, 'data-confirm') ?? '' },
    controls: inner(form).filter(element => ['input', 'select', 'textarea'].includes(element.tagName) && attribute(element, 'name') !== '_csrf').map(control => ({ tag: control.tagName, ...attributes(control), type: attribute(control, 'type') ?? 'text', value: attribute(control, 'value') ?? '' })),
    texts: inner(form).filter(element => ['label', 'p', 'legend', 'summary'].includes(element.tagName)).map(ownText).filter(Boolean),
    submit: inner(form).filter(element => element.tagName === 'button').map(ownText),
    dialog: { ...attributes(dialog), parts: inner(dialog).filter(element => ['h2', 'p', 'label', 'button'].includes(element.tagName)).map(element => [element.tagName, ownText(element), attribute(element, 'id'), attribute(element, 'type')]),
      field: inner(dialog).filter(element => element.tagName === 'input').map(attributes) },
    headings: table ? nodes(table).filter(element => element.tagName === 'th').slice(0, 5).map(ownText) : [],
    rows: rows.map(row => ({ cells: row.childNodes.filter((child): child is Element => 'tagName' in child).map(ownText),
      revoke: nodes(row).filter(element => element.tagName === 'form').map(revoke => ({ ...attributes(revoke), confirm: attribute(revoke, 'data-confirm'), button: nodes(revoke).filter(element => element.tagName === 'button').map(ownText) })) })),
  }
}

test('the rebuilt token card keeps the recorded legacy create form, one-time dialog and token list: URLs, fields, values, texts and confirmations', async () => {
  mint('token-account', 'Synthetic account')
  const recorded = tokenCard(readFileSync(join(process.cwd(), 'test/fixtures/account-tokens-card.html'), 'utf8'))
  const rebuilt = tokenCard((await app.inject({ url: '/account', headers })).body)
  expect(recorded.rows).toHaveLength(1)
  expect(rebuilt).toEqual(recorded)
})

test('the rebuilt Account header keeps the recorded legacy title, description and Change password action', async () => {
  const header = (html: string) => {
    const all = nodes(parse(html))
    const h1 = all.find(element => element.tagName === 'h1')!
    const link = all.find(element => element.tagName === 'a' && ownText(element) === 'Change password')!
    return { title: ownText(h1), description: all.filter(element => element.tagName === 'p').map(ownText).find(text => text.startsWith('Synthetic User')), action: [attribute(link, 'href'), ownText(link)] }
  }
  const recorded = header(readFileSync(join(process.cwd(), 'test/fixtures/account-header.html'), 'utf8'))
  expect(recorded.action).toEqual(['/password', 'Change password'])
  expect(header((await app.inject({ url: '/account', headers })).body)).toEqual(recorded)
})

test('the one-time token value is returned only by the create response and appears on no later page, in no hydration data and in no audit row', async () => {
  const csrf = (await app.inject({ url: '/account', headers })).body.match(/data-create-token[^>]*><input type="hidden" name="_csrf" value="([^"]+)"/)![1]!
  const created = await app.inject({ method: 'POST', url: '/v1/account/tokens', headers,
    payload: { _csrf: csrf, label: 'Synthetic one-time', scope: { tools: [{ tool: 'falcon-axi' }] }, readOnly: true, reusable: false, expiresAt: now + 3600000 } })
  expect(created.statusCode).toBe(200)
  const token = created.json().token as string
  expect(token.length).toBeGreaterThan(20)
  for (const url of ['/account', '/admin/tokens', '/v1/account/tokens']) {
    const later = await app.inject({ url, headers })
    expect(later.body).not.toContain(token)
    expect(JSON.stringify(later.headers)).not.toContain(token)
  }
  expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain(token)
  expect(JSON.stringify(db.prepare('SELECT * FROM delegations').all())).not.toContain(token)
})
