import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { accountSessionRoutes, toolSchema } from '../../src/shared/api.js'
import { hashToken, issueLoginTokens, verifyAccessToken } from '../../src/server/auth/tokens.js'
import { browserDefaults, authDefaults, tokenDefaults } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let cookies: Record<string, string>
let now: number
const password = 'CANARY-local-password'
const newPassword = 'CANARY-changed-password'
const userId = 'synthetic-development-user'
const keyProvider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-browser-'))
  db = openStore(join(directory, 'artium.db'), keyProvider)
  await seedToolUser(db)
  db.prepare('UPDATE users SET administrator = 1').run()
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, administrator, must_change)
    SELECT 'synthetic-second', 'synthetic-second', 'Second', password_hash, 1, 0 FROM users LIMIT 1`)
  now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: {},
    adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([]), db), credentialStore: createCredentialStore(db, keyProvider) })
  cookies = {}
})

afterEach(async () => {
  await app.close()
  db.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, input?: Record<string, string>, extra: Record<string, string> = {}) {
  const response = await app.inject({ method, url, headers: { host: 'localhost', origin: 'http://localhost',
    cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
    ...(input ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...extra },
  payload: input ? new URLSearchParams(input).toString() : undefined })
  for (const cookie of response.cookies) cookies[cookie.name] = cookie.value
  return response
}

async function token(path: string) {
  const response = await request('GET', path)
  expect(response.statusCode).toBe(200)
  return /name="_csrf" value="([^"]+)"/.exec(response.body)![1]!
}

async function signIn(secret = password) {
  const response = await request('POST', '/login', { _csrf: await token('/login'), username: 'synthetic-user', password: secret })
  expect(response.statusCode).toBe(303)
  return response
}

test('token settings require a recently authenticated administrator and are audited', async () => {
  await signIn()
  const csrf = await token('/admin/tokens')
  const change = async (mintingEnabled = false, ssoWindowMs = 2 * 86400000) => app.inject({ method: 'PATCH', url: '/v1/admin/token-settings', headers: {
    host: 'localhost', origin: 'http://localhost', accept: 'application/json', cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
  }, payload: { _csrf: csrf, mintingEnabled, maxLifetimeMs: 3600000, ssoWindowMs } })
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await change()).statusCode).toBe(403)
  db.prepare('UPDATE users SET administrator = 1 WHERE id = ?').run(userId)
  now += authDefaults.recentAuthMs + 1
  expect((await change()).statusCode).toBe(401)
  now -= authDefaults.recentAuthMs + 1
  expect(db.prepare('SELECT minting_enabled, max_lifetime_ms FROM delegation_settings').get()).toEqual({ minting_enabled: 1, max_lifetime_ms: 30 * 86400000 })
  expect((await change(false, 86399999)).statusCode).toBe(400)
  expect((await change(false, 30 * 86400000 + 1)).statusCode).toBe(400)
  expect((await change()).statusCode).toBe(200)
  expect(db.prepare('SELECT minting_enabled, max_lifetime_ms, sso_window_ms FROM delegation_settings').get())
    .toEqual({ minting_enabled: 0, max_lifetime_ms: 3600000, sso_window_ms: 2 * 86400000 })
  expect((await change(true)).statusCode).toBe(200)
  expect(db.prepare('SELECT minting_enabled FROM delegation_settings').get()).toEqual({ minting_enabled: 1 })
  expect(db.prepare("SELECT action, user_id FROM audit WHERE event = 'admin-change' AND action = 'token-settings'").get())
    .toEqual({ action: 'token-settings', user_id: userId })
})

test('browser token creation and revocation use the signed-in account', async () => {
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  await signIn()
  const csrf = await token('/account')
  const send = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: {
    host: 'localhost', origin: 'http://localhost', cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
  }, payload })
  const input = { _csrf: csrf, label: 'Synthetic', scope: { tools: [{ tool: 'falcon-axi' }] }, readOnly: true, reusable: false, expiresAt: now + 60000 }
  const overCap = await send('/v1/account/tokens', { ...input, expiresAt: now + 31 * 86400000 })
  expect(overCap.statusCode).toBe(400)
  const created = await send('/v1/account/tokens', input)
  expect(created.statusCode).toBe(200)
  const { id, token: secret } = created.json()
  const page = await request('GET', '/account')
  expect(page.body).toContain('Synthetic')
  expect(page.body).not.toContain(secret)
  const other = createBrowserSession(db, 'synthetic-second', 'synthetic-csrf')
  const otherList = await app.inject({ url: '/v1/account/tokens', headers: { cookie: `artium-session=${other.id}` } })
  expect(otherList.json().tokens).toEqual([])
  expect((await request('GET', '/admin/tokens')).body).toContain('Synthetic')
  db.prepare("UPDATE users SET source = 'sso', password_hash = NULL, last_sso_sign_in_at = ? WHERE id = ?").run(now - 7 * 86400000, userId)
  expect((await request('GET', '/account')).body).toContain('Paused until creator signs in via SSO')
  expect((await request('GET', '/admin/tokens')).body).toContain('Paused until creator signs in via SSO')
  expect((await send(`/v1/account/tokens/${id}/revoke`, { _csrf: csrf })).statusCode).toBe(204)
  expect(db.prepare('SELECT revoked_at FROM delegations WHERE id = ?').get(id)).toEqual({ revoked_at: now })
})

test.each([
  { grants: "('synthetic-development-user', 'synthetic-role', 'synthetic-rule')", members: '1 person' },
  { grants: "('synthetic-development-user', 'synthetic-role', 'synthetic-rule'), ('synthetic-second', 'synthetic-role', 'direct')", members: '2 people' },
])('R2: tool Access counts distinct people across grant origins: $members', async ({ grants, members }) => {
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example');
    INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES ('synthetic-rule', 'synthetic-provider', 'groups', 'synthetic-group', 'synthetic-role');
    INSERT INTO user_roles (user_id, role_id, origin) VALUES ${grants}`)
  await signIn()
  const row = accessRow(await accessPage('falcon-axi'), 'Synthetic Role')
  expect(nodesOf(row).filter(element => element.tagName === 'a').map(link => attributeOf(link, 'href'))).toContain('/admin/roles/synthetic-role')
  expect(textOf(row)).toContain(`${members} · All instances`)
})

test('tool Access offers an instance access sheet per role, open from its query view', async () => {
  new FakeCredentialStore([
    { reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {} },
    { reference: { id: 'synthetic-production', tool: 'falcon-axi' }, name: 'production', value: {} },
  ]).seed(db)
  await signIn()
  const closed = await accessPage('falcon-axi')
  expect(textOf(accessRow(closed, 'Synthetic Role'))).toContain('1 person · All instances')
  expect([attributeOf(accessSheet(closed, 'instances-synthetic-role'), 'class'), attributeOf(accessSheet(closed, 'instances-synthetic-role'), 'open')]).toEqual(['sheet', undefined])
  db.exec("UPDATE role_tools SET all_instances = 0; INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab')")
  const open = await accessPage('falcon-axi', 'instances-synthetic-role')
  expect(textOf(accessRow(open, 'Synthetic Role'))).toContain('Selected instances: lab')
  expect([attributeOf(accessSheet(open, 'instances-synthetic-role'), 'aria-labelledby'), attributeOf(accessSheet(open, 'instances-synthetic-role'), 'open')])
    .toEqual(['sheet-instances-synthetic-role-title', ''])
  const form = accessForm(open, 'instances-synthetic-role')
  expect(accessSummary(form).slice(0, 2)).toEqual(['/v1/admin/roles/synthetic-role/tools/falcon-axi/instances', 'PUT'])
  expect(accessFields(form).filter(([name]) => name !== '_csrf')).toEqual([['scope', 'radio', 'all', false], ['scope', 'radio', 'selected', true],
    ['instances', 'hidden', undefined, false], ['instances', 'checkbox', 'lab', true], ['instances', 'checkbox', 'production', false], ['expectedRevision', 'hidden', '1', false]])
})

test.each([
  ['instances', 'action="/v1/admin/tools/falcon-axi/instances/lab/test"'], ['access', 'id="sheet-instances-synthetic-role"'],
  ['writes', 'action="/v1/admin/tools/falcon-axi/write-access"'], ['advanced', 'name="nativeSettings"'],
  ['instances', 'id="sheet-add-instance"', '&sheet=add-instance'], ['instances', 'id="sheet-edit-lab"', '&sheet=edit-lab'],
])('the %s tab of a tool page carries no credential value and shows its content once, outside its hydration data', async (tab, marker, sheet = '') => {
  new FakeCredentialStore([{ reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: { clientId: 'CANARY-client', clientSecret: 'CANARY-secret' } }]).seed(db)
  await signIn()
  const body = (await request('GET', `/admin/tools/falcon-axi?tab=${tab}${sheet}`)).body
  expect(body).not.toContain('CANARY-')
  const data = JSON.parse(/<script type="application\/json" data-astryx-props>(.*?)<\/script>/s.exec(body)![1]!) as { props: { panel: { tab: string, legacyHtml?: string } } }
  expect(data.props.panel.tab).toBe(tab)
  expect(data.props.panel.legacyHtml ?? '').toBe('')
  expect(body.split(marker)).toHaveLength(2)
})

test('tool Access can restore all instances after the last selected instance is deleted', async () => {
  new FakeCredentialStore([{ reference: { id: 'synthetic-lab', tool: 'falcon-axi' }, name: 'lab', value: {} }]).seed(db)
  db.exec("UPDATE role_tools SET all_instances = 0; INSERT INTO role_tool_instances VALUES ('synthetic-role', 'falcon-axi', 'synthetic-lab'); DELETE FROM credentials WHERE id = 'synthetic-lab'")
  await signIn()
  const page = await accessPage('falcon-axi', 'instances-synthetic-role')
  const row = accessRow(page, 'Synthetic Role')
  expect(textOf(row)).toContain('Selected instances: None')
  expect(attributeOf(accessSheet(page, 'instances-synthetic-role'), 'open')).toBe('')
  expect(nodesOf(row).filter(element => attributeOf(element, 'data-sheet') === 'sheet-instances-synthetic-role').map(link => attributeOf(link, 'href')))
    .toEqual(['/admin/tools/falcon-axi?tab=access&sheet=instances-synthetic-role'])
  expect(accessFields(accessForm(page, 'instances-synthetic-role')).filter(([name]) => name === 'scope').map(([, , value]) => value)).toEqual(['all', 'selected'])
  const csrf = await token('/admin/tools/falcon-axi?tab=access')
  const response = await app.inject({ method: 'PUT', url: '/v1/admin/roles/synthetic-role/tools/falcon-axi/instances', headers: {
    host: 'localhost', origin: 'http://localhost', cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
  }, payload: { _csrf: csrf, scope: 'all', expectedRevision: 1 } })
  expect(response.statusCode, response.body).toBe(200)
  expect(db.prepare("SELECT all_instances FROM role_tools WHERE role_id = 'synthetic-role' AND tool = 'falcon-axi'").get()).toEqual({ all_instances: 1 })
})

test('tool Access lists per-person grants and offers a picker of people without grants', async () => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'kubernetes-axi'")
    .run(JSON.stringify({ sessions: { grants: { 'synthetic-second': ['exec', 'logs'], 'departed-user': ['watch'] } } }))
  await signIn()
  const page = await accessPage('kubernetes-axi', 'grants-sessions-add')
  expect(page.filter(element => element.tagName === 'h2' && textOf(element) === 'Interactive sessions by person')).toHaveLength(1)
  expect(textOf(accessRow(page, 'synthetic-second'))).toContain('exec, logs')
  expect(textOf(accessRow(page, 'synthetic-second'))).not.toContain('Not an active person')
  expect(textOf(accessRow(page, 'departed-user'))).toContain('Not an active person')
  expect(textOf(accessRow(page, 'departed-user'))).toContain('watch')
  expect(pickerPeople(page, 'grants-sessions-add')).toContain(userId)
  expect(pickerPeople(page, 'grants-sessions-add')).not.toContain('synthetic-second')
  expect(attributeOf(accessSheet(page, 'grants-sessions-add'), 'open')).toBe('')
  expect(attributeOf(accessSheet(page, 'grants-sessions-add'), 'aria-labelledby')).toBe('sheet-grants-sessions-add-title')
  expect(accessSummary(accessForm(page, 'grants-sessions-add')).slice(0, 2)).toEqual(['/v1/admin/tools/kubernetes-axi/user-grants', 'PUT'])
  expect(accessFields(accessForm(page, 'grants-sessions-add'))).toContainEqual(['policy', 'hidden', 'sessions', false])
  const edit = await accessPage('kubernetes-axi', 'grants-sessions-synthetic-second')
  const fields = accessFields(accessForm(edit, 'grants-sessions-synthetic-second'))
  expect(fields).toContainEqual(['userId', 'hidden', 'synthetic-second', false])
  expect(fields).toContainEqual(['operations', 'checkbox', 'exec', true])
  expect(fields).toContainEqual(['operations', 'checkbox', 'watch', false])
})

test('tool Access holds back Shodan grants until the policy ceilings are saved', async () => {
  await signIn()
  const addLinks = (page: Element[]) => page.filter(element => element.tagName === 'a' && textOf(element) === 'Grant a person').map(link => attributeOf(link, 'data-sheet'))
  const before = await accessPage('shodan-axi')
  expect(before.filter(element => element.tagName === 'p' && textOf(element) === 'Set the ceilings for this policy in Advanced native settings before granting people here.')).toHaveLength(4)
  expect(addLinks(before)).toEqual([])
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'shodan-axi'")
    .run(JSON.stringify({ scans: { grants: {}, maxScanCredits: 10, maxRequests: 10 } }))
  const after = await accessPage('shodan-axi')
  expect(addLinks(after)).toEqual(['sheet-grants-scans-add'])
  expect(accessSheet(after, 'grants-scans-add')).toBeDefined()
  expect(accessSheet(after, 'grants-sessions-add')).toBeUndefined()
})

test('tool Access retains outside operations and identifies Shodan grants', async () => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'shodan-axi'").run(JSON.stringify({
    scans: { grants: { 'synthetic-second': ['OP-009', 'OP-010'] }, maxScanCredits: 10, maxRequests: 10 },
    sessions: { grants: { 'synthetic-second': ['OP-047', 'OP-048'] }, perUser: 1, perCredential: 1, total: 1,
      sessionEvents: 1, totalEvents: 1, sessionBytes: 1, totalBytes: 1, retentionSeconds: 1, leaseSeconds: 1 },
    writes: { grants: { 'synthetic-second': ['OP-021', 'OP-070'] }, maxQueryCredits: 1, maxRequests: 1 },
  }))
  await signIn()
  const page = await accessPage('shodan-axi', 'grants-scans-synthetic-second')
  expect(accessFields(accessForm(page, 'grants-scans-synthetic-second'))).toContainEqual(['operations', 'checkbox', 'OP-010', true])
  const rows = page.filter(element => element.tagName === 'li').map(textOf)
  expect(rows.some(row => row.includes('stream (OP-047), stream (OP-048)'))).toBe(true)
  expect(rows.some(row => row.includes('alert ignore (OP-021), alert ignore (OP-070)'))).toBe(true)
})

test('tool Access shows each saved outside operation once', async () => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'shodan-axi'").run(JSON.stringify({
    scans: { grants: { 'synthetic-second': [...Array(31).fill('OP-010'), 'OP-009'] }, maxScanCredits: 10, maxRequests: 10 },
  }))
  await signIn()
  const response = await request('GET', '/admin/tools/shodan-axi?tab=access&sheet=grants-scans-synthetic-second')
  expect(response.statusCode).toBe(200)
  const nodes = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [
    ...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(nodes) : []),
  ]
  const sheet = nodes(parse(response.body)).find(node => node.attrs.some(attr =>
    attr.name === 'id' && attr.value === 'sheet-grants-scans-synthetic-second'))!
  const inputs = nodes(sheet).filter(node => node.tagName === 'input' &&
    node.attrs.some(attr => attr.name === 'name' && attr.value === 'operations') &&
    node.attrs.some(attr => attr.name === 'type' && attr.value === 'checkbox'))
  expect(inputs.filter(node => node.attrs.some(attr => attr.name === 'value' && attr.value === 'OP-010')))
    .toMatchObject([{ attrs: expect.arrayContaining([{ name: 'checked', value: '' }]) }])
  expect(inputs.filter(node => node.attrs.some(attr => attr.name === 'value' && attr.value === 'OP-009')))
    .toHaveLength(1)
})

test('Advanced hides per-person grants and preserves policy settings', async () => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'kubernetes-axi'")
    .run(JSON.stringify({ sessions: { grants: { 'synthetic-second': ['exec'] } } }))
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'shodan-axi'")
    .run(JSON.stringify({ scans: { grants: { 'synthetic-second': ['OP-009'] }, maxScanCredits: 10, maxRequests: 5 } }))
  await signIn()
  const kubernetes = (await request('GET', '/admin/tools/kubernetes-axi?tab=advanced')).body
  const shodan = (await request('GET', '/admin/tools/shodan-axi?tab=advanced')).body
  const settings = (page: string) => {
    const textarea = nodesOf(parse(page)).find(node => node.tagName === 'textarea' && node.attrs.some(attr => attr.name === 'name' && attr.value === 'nativeSettings'))!
    return textarea.childNodes.map(child => 'value' in child ? child.value : '').join('')
  }
  for (const page of [kubernetes, shodan]) {
    expect(settings(page)).not.toContain('grants')
    expect(page).toContain('Per-person grants are managed with the picker on the Access tab.')
    expect(page).toContain('Omitting a policy turns it off and removes its grants.')
  }
  expect(kubernetes).toContain('&quot;sessions&quot;: {}')
  expect(shodan).toContain('&quot;maxScanCredits&quot;: 10')
})

test('tool Access excludes disabled people from the add picker', async () => {
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run('synthetic-second')
  await signIn()
  const picker = pickerPeople(await accessPage('kubernetes-axi', 'grants-sessions-add'), 'grants-sessions-add')
  expect(picker).toContain(userId)
  expect(picker).not.toContain('synthetic-second')
})

test('a person grant saved from the Access sheet reaches the tool settings', async () => {
  await signIn()
  const csrf = await token('/admin/tools/kubernetes-axi?tab=access')
  const response = await app.inject({ method: 'PUT', url: '/v1/admin/tools/kubernetes-axi/user-grants', headers: {
    host: 'localhost', origin: 'http://localhost', accept: 'application/json', cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
  }, payload: { _csrf: csrf, policy: 'sessions', userId: 'synthetic-second', operations: ['exec'], expectedRevision: 1 } })
  expect(response.statusCode, response.body).toBe(200)
  expect(JSON.parse((db.prepare("SELECT native_settings FROM tools WHERE name = 'kubernetes-axi'").get() as { native_settings: string }).native_settings))
    .toEqual({ sessions: { grants: { 'synthetic-second': ['exec'] } } })
  expect(nodesOf(accessRow(await accessPage('kubernetes-axi'), 'synthetic-second')).some(element => textOf(element) === 'exec')).toBe(true)
})

test('removing an empty grant returns the person to the Access picker', async () => {
  db.prepare("UPDATE tools SET native_settings = ? WHERE name = 'kubernetes-axi'")
    .run(JSON.stringify({ sessions: { grants: { 'synthetic-second': [] } } }))
  await signIn()
  const before = await accessPage('kubernetes-axi', 'grants-sessions-add')
  expect(nodesOf(accessRow(before, 'synthetic-second')).some(element => textOf(element) === 'None')).toBe(true)
  expect(pickerPeople(before, 'grants-sessions-add')).not.toContain('synthetic-second')
  const csrf = await token('/admin/tools/kubernetes-axi?tab=access')
  const response = await app.inject({ method: 'PUT', url: '/v1/admin/tools/kubernetes-axi/user-grants', headers: {
    host: 'localhost', origin: 'http://localhost', accept: 'application/json', cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '),
  }, payload: { _csrf: csrf, policy: 'sessions', userId: 'synthetic-second', operations: [], expectedRevision: 1 } })
  expect(response.statusCode, response.body).toBe(200)
  const after = await accessPage('kubernetes-axi', 'grants-sessions-add')
  expect(accessRow(after, 'synthetic-second')).toBeUndefined()
  expect(pickerPeople(after, 'grants-sessions-add')).toContain('synthetic-second')
})

test('administrators can inspect the loaded trusted CA metadata on Tools', async () => {
  await withFakeService(async ({ directory: certs }) => {
    await app.close()
    const bundle = loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(certs, 'ca.crt') })!
    app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls'), bundle), environment: {},
      adapters: [], resolver: new SharedIdentityResolver(new FakeCredentialStore([]), db), credentialStore: createCredentialStore(db, keyProvider) })
    expect((await request('GET', '/admin/tools')).statusCode).toBe(303)
    await signIn()
    const response = await request('GET', '/admin/tools')
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('An operator sets ARTIUM_AXI_EXTRA_CA_FILE and restarts the server')
    expect(response.body).toContain(bundle.certificates[0].subject)
    expect(response.body).toContain(bundle.certificates[0].issuer)
    expect(response.body).toContain(bundle.certificates[0].expiresAt)
    expect(response.body).toContain(bundle.certificates[0].fingerprint)
    expect(response.body).not.toContain('BEGIN CERTIFICATE')
  })
})

test('the Tools list counts, filters and links tools, and enabling one moves it between views', async () => {
  await signIn()
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const page = async (query = '') => nodesOf(parse(withoutProps((await request('GET', '/admin/tools' + query)).body)))
  const listed = async (query = '') => (await page(query)).filter(element => element.tagName === 'th' && attribute(element, 'scope') === 'row')
    .flatMap(row => nodesOf(row).filter(element => element.tagName === 'a').map(link => attribute(link, 'href')))
  const counts = async () => (await page()).filter(element => element.tagName === 'a' && /^(All|Enabled|Needs attention) \d+$/.test(text(element))).map(text)
  const text = (element: DefaultTreeAdapterMap['element']): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
  expect(await listed()).toHaveLength(toolSchema.options.length)
  expect(await counts()).toEqual([`All ${toolSchema.options.length}`, 'Enabled 0', 'Needs attention 0'])
  expect(await listed('?show=enabled')).toEqual([])
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  expect(await counts()).toEqual([`All ${toolSchema.options.length}`, 'Enabled 1', 'Needs attention 1'])
  expect(await listed('?show=enabled')).toEqual(['/admin/tools/falcon-axi'])
  expect(await listed('?show=attention')).toEqual(['/admin/tools/falcon-axi'])
  expect(await listed('?q=azure')).toEqual(['/admin/tools/az-axi', '/admin/tools/ado-axi'])
  expect(await listed('?show=enabled&q=azure')).toEqual([])
  const empty = (await request('GET', '/admin/tools?q=no-such-tool')).body
  expect(withoutProps(empty)).toContain('No tools match these filters')
})

test('audit record details render the settings changes of an admin change', async () => {
  const audit = new Audit(db, () => now, () => {})
  audit.record({ event: 'admin-change', action: 'update-tool', targetId: 'az-axi', userId, tool: 'az-axi', outcome: 'success',
    requestId: 'settings-change', clientAddress: null, settingsChanges: [
      { path: ['managementGroup'], before: null, after: '<synthetic-group>' },
      { path: ['subscriptions'], added: ['synthetic-c'], removed: ['synthetic-a'] },
    ] })
  const { id } = db.prepare("SELECT id FROM audit WHERE request_id = 'settings-change'").get() as { id: number }
  await signIn()
  const page = await request('GET', '/admin/audit?record=' + id)
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('Settings changes')
  expect(page.body).toContain('unset → &quot;&lt;synthetic-group&gt;&quot;')
  expect(page.body).toContain('+ &quot;synthetic-c&quot;\n- &quot;synthetic-a&quot;')
})

test('security: failure diagnostics appear only in administrator row details, never audit exports or streams', async () => {
  const lines: string[] = []
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const audit = new Audit(db, () => now, line => { lines.push(line) })
  const terminal = { userId, tool: 'falcon-axi' as const, clientAddress: null, event: 'run-terminal' as const,
    outcome: 'completed' as const, exitCode: 1, durationMs: 1, outputBytes: { stdout: 0, stderr: 40 } }
  audit.record({ ...terminal, requestId: 'safe-failure', failure: {
    diagnostic: { stage: 'tool run', message: '<script>Synthetic private failure</script>' }, secrets: [password] } })
  audit.record({ ...terminal, requestId: 'secret-failure', failure: {
    diagnostic: { stage: 'tool run', message: password }, secrets: [password] } })
  expect(JSON.stringify(db.prepare('SELECT * FROM run_diagnostics').all())).not.toContain(password)
  db.prepare('UPDATE run_diagnostics SET diagnostic = ? WHERE request_id = ?')
    .run(JSON.stringify({ stage: 'tool run', message: '<script>Synthetic private failure</script>' }), 'safe-failure')
  db.prepare('UPDATE audit SET error_code = ? WHERE request_id = ?').run('UnlabelledLegacyCredential419', 'safe-failure')
  const { id } = db.prepare("SELECT id FROM audit WHERE request_id = 'safe-failure'").get() as { id: number }
  const detail = '/admin/audit?record=' + id
  const anonymous = await request('GET', detail)
  expect(anonymous.statusCode).toBe(303)
  expect(anonymous.body).not.toContain('Synthetic private failure')
  await signIn()
  const page = await request('GET', detail)
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('Failure diagnostic')
  expect(page.body).not.toContain('Synthetic private failure')
  expect(page.body).not.toContain('UnlabelledLegacyCredential419')
  expect(page.body).toContain('Details unavailable.')
  expect(page.body).not.toContain(password)
  for (const path of ['/v1/admin/audit', '/v1/admin/audit/export?format=jsonl', '/v1/admin/audit/export?format=csv']) {
    const response = await request('GET', path)
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('Synthetic private failure')
    expect(response.body).not.toContain(password)
  }
  expect(lines.join('')).not.toContain('Synthetic private failure')
  expect(lines.join('')).not.toContain(password)
  expect(JSON.stringify(stderr.mock.calls)).not.toContain(password)
  now += 14 * 24 * 60 * 60 * 1000
  expect((await request('GET', detail)).body).not.toContain('Synthetic private failure')
})

test('security: an authenticated non-administrator cannot read retained failure diagnostics', async () => {
  new Audit(db).record({ userId, tool: 'falcon-axi', requestId: 'private-failure', clientAddress: null,
    event: 'run-terminal', outcome: 'completed', exitCode: 1, durationMs: 1, outputBytes: { stdout: 0, stderr: 1 },
    failure: { diagnostic: { stage: 'tool run', message: 'Synthetic private failure' }, secrets: [] } })
  await signIn()
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  const response = await request('GET', '/admin/audit')
  expect(response.statusCode).toBe(403)
  expect(response.body).not.toContain('Synthetic private failure')
})

test('browser sign-in creates an opaque secure server session and sign-out revokes it with audit', async () => {
  const response = await signIn()
  expect(response.headers.location).toBe('/admin')
  expect(response.cookies.find(cookie => cookie.name === browserCookie)).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' })
  expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: hashToken(cookies[browserCookie]!) })
  expect(db.prepare('SELECT COUNT(*) AS count FROM tokens').get()).toEqual({ count: 0 })
  expect((await request('GET', '/admin')).body).toContain('Signed in as </span><strong>Synthetic User</strong>')
  const csrf = await token('/admin')
  const signedIn = { ...cookies }
  expect((await request('POST', '/logout', { _csrf: csrf })).headers.location).toBe('/login')
  cookies = signedIn
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
  expect(db.prepare("SELECT event FROM audit WHERE event IN ('sign-in', 'sign-out') ORDER BY id").all())
    .toEqual([{ event: 'sign-in' }, { event: 'sign-out' }])
})

test('browser password sign-in and confirmation are flagged for a designated break-glass administrator', async () => {
  db.exec(`UPDATE users SET break_glass = 1 WHERE id = 'synthetic-development-user';
    INSERT INTO sso_providers (id, name, kind, issuer, enabled)
    VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://identity.example', 1)`)
  await signIn()
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/reauth', { _csrf: await token('/reauth'), password })).statusCode).toBe(303)
  expect(db.prepare("SELECT event, authentication_method FROM audit WHERE event IN ('sign-in', 'reauth') ORDER BY id").all())
    .toEqual([{ event: 'sign-in', authentication_method: 'break-glass' }, { event: 'reauth', authentication_method: 'break-glass' }])
  expect((await request('GET', '/admin/audit')).body).toContain('<span class="mono">sign-in</span> <span class="badge warn">Break-glass</span>')
  const exported = await request('GET', '/v1/admin/audit/export?format=jsonl')
  expect(exported.body.trim().split('\n').map(line => JSON.parse(line).authentication_method)).toEqual(['break-glass', 'break-glass'])
})

test('password confirmation after break-glass designation flags the password change in Audit and exports', async () => {
  await signIn()
  db.prepare('UPDATE users SET break_glass = 1 WHERE id = ?').run(userId)
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/password', { _csrf: await token('/password'), currentPassword: password, newPassword }))
    .headers.location).toBe('/login')
  await signIn(newPassword)
  expect((await request('GET', '/admin/audit')).body).toContain('<span class="mono">password-change</span> <span class="badge warn">Break-glass</span>')
  const exported = await request('GET', '/v1/admin/audit/export?format=jsonl&event=password-change')
  expect(exported.statusCode).toBe(200)
  expect(JSON.parse(exported.body.trim())).toMatchObject({ event: 'password-change', authentication_method: 'break-glass' })
})

test('an existing local browser session cannot confirm its password after SSO is enabled', async () => {
  await signIn()
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer, enabled)
    VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://identity.example', 1)`)
  now += authDefaults.recentAuthMs
  const response = await request('POST', '/v1/auth/reauth', { _csrf: await token('/reauth'), password })
  expect(response.statusCode).toBe(401)
  expect(response.body).toContain('SIGN_IN_FAILED')
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event = 'reauth'").get()).toEqual({ count: 0 })
})

test.each([false, true])('browser local password sign-in with SSO enabled requires designation, administrator=%s', async administrator => {
  db.prepare('UPDATE users SET administrator = ? WHERE id = ?').run(Number(administrator), userId)
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer, enabled)
    VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://identity.example', 1)`)
  const response = await request('POST', '/login', { _csrf: await token('/login'), username: 'synthetic-user', password })
  expect(response.statusCode).toBe(401)
  expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test.each(['/login', '/logout', '/password', '/reauth', '/v1/auth/reauth', '/v1/admin/users', '/v1/admin/tools/falcon-axi/test', '/v1/account/sessions/revoke', '/v1/account/sessions/other/revoke'])
  ('security form mutation %s rejects a missing CSRF token', async path => {
    await signIn()
    const response = await request('POST', path, {})
    expect(response.statusCode).toBe(403)
    expect(response.body).toContain('form token or request origin is invalid')
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event IN ('admin-change', 'password-change', 'sign-out', 'credential-test')").get())
      .toEqual({ count: 0 })
  })

test('ordinary account sessions exclude expired families and refuse revoking another person before self revocation', async () => {
  db.exec('UPDATE users SET administrator = 0 WHERE id = \'synthetic-development-user\'')
  await signIn()
  const csrf = await token('/account')
  const other = issueLoginTokens(db, 'synthetic-second')
  expect(other.status).toBe('authenticated')
  const otherFamily = db.prepare("SELECT id FROM session_families WHERE user_id = 'synthetic-second'").get() as { id: string }
  const refused = await request('POST', '/v1/account/sessions/' + otherFamily.id + '/revoke', { _csrf: csrf })
  expect(refused.statusCode).toBe(404)
  now += browserDefaults.idleMs - 1
  const listed = accountSessionRoutes.list.response.parse((await request('GET', '/v1/account/sessions')).json())
  expect(listed.sessions).toHaveLength(1)
  expect(listed.sessions[0]).toMatchObject({ kind: 'browser', current: true, expiresAt: expect.any(Number) })
  expect((await request('POST', '/v1/account/sessions/' + listed.sessions[0]!.id + '/revoke', { _csrf: csrf })).statusCode).toBe(200)
  expect((await request('GET', '/account')).headers.location).toBe('/login')
  expect(db.prepare("SELECT action, target_id FROM audit WHERE event = 'sign-out'").get())
    .toEqual({ action: 'revoke-session', target_id: listed.sessions[0]!.id })
})

test.each(['/v1/account/sessions', '/v1/admin/users/synthetic-development-user/sessions'])('session listing at %s projects current browser renewal only', async path => {
  await signIn()
  const start = now
  createBrowserSession(db, userId, 'CANARY-other-csrf', now)
  now += browserDefaults.idleMs - 1
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now)
  const response = await request('GET', path)
  expect(response.statusCode).toBe(200)
  const listed = accountSessionRoutes.list.response.parse(response.json())
  expect(listed.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ current: true, lastSeenAt: now, expiresAt: now + browserDefaults.idleMs }),
    expect.objectContaining({ current: false, lastSeenAt: start, expiresAt: start + browserDefaults.idleMs }),
  ]))
})

test.each(['/account', '/admin/users/synthetic-development-user'])('session table at %s displays the renewed idle deadline', async path => {
  await signIn()
  now += browserDefaults.idleMs - 1
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now)
  const response = await request('GET', path)
  expect(response.statusCode).toBe(200)
  expect(response.body).toMatch(new RegExp(`<time datetime="${new Date(now + browserDefaults.idleMs).toISOString()}"`, 'i'))
})

test('the account Sessions card posts to the account routes, emits no style attributes and its sign out everywhere token is accepted', async () => {
  await signIn()
  const { sessions } = accountSessionRoutes.list.response.parse((await request('GET', '/v1/account/sessions')).json())
  const page = (await request('GET', '/account')).body
  const nodes = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const all = nodes(parse(page))
  const forms = all.filter(element => element.tagName === 'form' && attribute(element, 'action')?.startsWith('/v1/account/sessions/'))
  expect(forms.map(form => attribute(form, 'action'))).toEqual(['/v1/account/sessions/revoke', ...sessions.map(session => `/v1/account/sessions/${session.id}/revoke`)])
  expect(forms.map(form => attribute(form, 'data-method'))).toEqual(forms.map(() => 'POST'))
  expect(all.filter(element => attribute(element, 'style') !== undefined)).toEqual([])
  const signOutEverywhere = forms[0]!
  const csrf = attribute(nodes(signOutEverywhere).find(element => attribute(element, 'name') === '_csrf')!, 'value')!
  expect((await request('POST', attribute(signOutEverywhere, 'action')!, { _csrf: csrf })).statusCode).toBe(200)
  expect((await request('GET', '/account')).headers.location).toBe('/login')
})

test.each([
  { bound: 'family', sessionRemaining: 60_000, familyRemaining: 30_000 },
  { bound: 'session', sessionRemaining: 30_000, familyRemaining: 60_000 },
])('current browser renewal keeps the $bound expiry bound', async ({ sessionRemaining, familyRemaining }) => {
  await signIn()
  const deadline = now + browserDefaults.idleMs + 30_000
  const sessionExpiry = now + browserDefaults.idleMs + sessionRemaining
  const familyExpiry = now + browserDefaults.idleMs + familyRemaining
  db.prepare('UPDATE sessions SET expires_at = ?').run(sessionExpiry)
  db.prepare('UPDATE session_families SET expires_at = ?').run(familyExpiry)
  now += browserDefaults.idleMs - 1
  const listed = accountSessionRoutes.list.response.parse((await request('GET', '/v1/account/sessions')).json())
  expect(listed.sessions).toEqual([expect.objectContaining({ current: true, expiresAt: deadline })])
})

test('security sign-in requires a same-origin CSRF-protected form', async () => {
  const csrf = await token('/login')
  expect((await request('POST', '/login', { _csrf: csrf, username: 'synthetic-user', password }, { origin: 'https://other.invalid' })).statusCode).toBe(403)
  expect((await request('POST', '/login', { username: 'synthetic-user', password })).statusCode).toBe(403)
  expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('admin mutation after 15 minutes challenges for the password and succeeds after browser API reauthentication', async () => {
  await signIn()
  const csrf = await token('/admin')
  now += authDefaults.recentAuthMs
  const action = { _csrf: csrf, name: 'Synthetic Browser Role' }
  expect((await request('POST', '/v1/admin/roles', action)).headers.location).toBe('/reauth')
  expect((await request('GET', '/reauth')).body).toContain('Confirm password')
  expect(db.prepare("SELECT COUNT(*) AS count FROM roles WHERE name = 'Synthetic Browser Role'").get()).toEqual({ count: 0 })
  expect((await request('POST', '/v1/auth/reauth', { _csrf: csrf, password })).statusCode).toBe(204)
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'reauth'").all()).toEqual([{ outcome: 'success' }])
  expect((await request('POST', '/v1/admin/roles', action)).statusCode).toBe(201)
})

test('credential testing uses the same recent-auth challenge', async () => {
  await signIn()
  const csrf = await token('/admin')
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/v1/admin/tools/falcon-axi/test', { _csrf: csrf })).headers.location).toBe('/reauth')
})

test('Roles page escapes names and change actors and preserves bounded pagination', async () => {
  await signIn()
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>actor</b>', userId)
  db.prepare('UPDATE roles SET name = ?, updated_by = ?, updated_at = ?').run('<img src=x>', userId, now)
  db.exec("INSERT INTO roles (id, name) VALUES ('a', 'First')")
  const first = await request('GET', '/admin/roles?limit=1')
  expect(first.statusCode).toBe(200)
  expect(first.body).toContain('href="/admin/roles/a"><strong>First</strong></a>')
  expect(first.body).toContain('/admin/roles?cursor=a&amp;limit=1')
  const second = await request('GET', '/admin/roles?cursor=a&limit=1')
  expect(second.body).toContain('<strong>&lt;img src=x&gt;</strong></a>')
  const detail = await request('GET', '/admin/roles/synthetic-role')
  expect(detail.body).toContain('Last changed by &lt;b&gt;actor&lt;/b&gt;')
  expect(detail.body).toContain(new Date(now).toISOString())
  expect(detail.body).toContain('name="tools" checked="" value="falcon-axi"')
  expect((await request('GET', '/admin/roles?limit=101')).statusCode).toBe(400)
  expect((await request('GET', '/admin/roles/synthetic-role?sheet=other')).statusCode).toBe(400)
  expect((await request('GET', '/admin/roles/synthetic-role?limit=101')).statusCode).toBe(400)
  expect((await request('GET', '/admin/roles/synthetic-role?sheet=rename-role')).body).toMatch(/<dialog[^>]*id="sheet-rename-role"[^>]*open=""/)
  expect((await request('GET', '/admin/roles/synthetic-role')).body).not.toMatch(/<dialog[^>]*id="sheet-rename-role"[^>]*open=""/)
})

test.each(['/admin/tools', '/admin/tools/falcon-axi', '/admin/tools/falcon-axi?tab=access', '/admin/tools/falcon-axi?tab=writes', '/admin/tools/falcon-axi?tab=advanced', '/admin/credentials', '/admin/roles', '/admin/roles/synthetic-role', '/admin/users/' + userId, '/admin/invitations', '/admin/audit'])('page %s requires the current administrator capability', async path => {
  expect((await request('GET', path)).headers.location).toBe('/login')
  await signIn()
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await request('GET', path)).statusCode).toBe(403)
})

test('Audit screen escapes stored fields and retains all filters across pages', async () => {
  await signIn()
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>actor</b>', userId)
  const audit = new Audit(db)
  audit.record({ event: 'admin-change', userId, tool: 'falcon-axi', outcome: 'success',
    action: '<b>action</b>', targetId: '<b>target</b>', requestId: '<b>request</b>', clientAddress: '<b>address</b>' })
  audit.record({ event: 'admin-change', userId, tool: 'falcon-axi', outcome: 'success',
    action: 'second', targetId: 'second', requestId: 'second', clientAddress: null })
  const filters = new URLSearchParams({ user: userId, tool: 'falcon-axi', outcome: 'success',
    from: new Date(now).toISOString(), to: new Date(now).toISOString(), limit: '1' })
  const [escaped, latest] = (db.prepare("SELECT id FROM audit WHERE event = 'admin-change' ORDER BY id").all() as { id: number }[]).map(row => String(row.id))
  const first = await request('GET', '/admin/audit?' + filters + '&record=' + latest)
  expect(first.statusCode).toBe(200)
  expect(first.body).toContain('<dt>action</dt><dd>second</dd>')
  expect(first.body).not.toContain('&lt;b&gt;action&lt;/b&gt;')
  const next = /href="([^"]+)">Older/.exec(first.body)![1]!.replaceAll('&amp;', '&')
  const older = new URL('http://localhost' + next)
  expect(Object.fromEntries(older.searchParams)).toMatchObject(Object.fromEntries(filters))
  expect(older.searchParams.has('record')).toBe(false)
  older.searchParams.set('record', escaped!)
  const second = await request('GET', older.pathname + older.search)
  expect(second.statusCode).toBe(200)
  expect(second.body).toContain('<dt>action</dt><dd>&lt;b&gt;action&lt;/b&gt;</dd>')
  expect(second.body).toContain('<dt>target_id</dt><dd>&lt;b&gt;target&lt;/b&gt;</dd>')
  expect(second.body).toContain('<dt>request_id</dt><dd>&lt;b&gt;request&lt;/b&gt;</dd>')
  expect(second.body).toContain('<dt>client_address</dt><dd>&lt;b&gt;address&lt;/b&gt;</dd>')
  expect(second.body).toContain('&lt;b&gt;actor&lt;/b&gt;')
  expect(second.body).not.toContain('<b>')
  expect(second.body).toContain('<span class="btn btn-secondary btn-sm" aria-disabled="true">Older</span>')
  expect(second.headers['cache-control']).toBe('no-store')
})

test('R3: a displayed audit record opens after newer activity pushes it off the page', async () => {
  await signIn()
  const audit = new Audit(db)
  const context = { event: 'admin-change' as const, userId, tool: null, outcome: 'success' as const,
    targetId: 'synthetic-role', clientAddress: null }
  const selected = audit.record({ ...context, action: 'selected-change', requestId: 'selected-change' })
  const first = await request('GET', '/admin/audit?event=admin-change&limit=1')
  const href = '/admin/audit?event=admin-change&limit=1&record=' + selected.id
  expect(first.body).toContain(href.replaceAll('&', '&amp;'))
  audit.record({ ...context, action: 'newer-change', requestId: 'newer-change' })
  const opened = await request('GET', href)
  expect(opened.statusCode).toBe(200)
  expect(opened.body).toContain('<dt>action</dt><dd>selected-change</dd>')
  expect(opened.body).toContain('<h2 id="record-title">admin-change · succeeded</h2>')
  const current = await request('GET', '/admin/audit?event=admin-change&limit=1&record=' + (selected.id + 1))
  expect(current.body).toContain(`<tr class="sel"><th scope="row"><a href="/admin/audit?event=admin-change&amp;limit=1&amp;record=${selected.id + 1}" aria-current="true">`)
})

test('Audit filters handle empty form fields and show a useful empty state', async () => {
  await signIn()
  expect((await request('GET', '/admin/audit?user=&tool=&outcome=&from=&to=&limit=50')).statusCode).toBe(200)
  const empty = await request('GET', '/admin/audit?outcome=missing')
  expect(empty.body).toContain('No audit records match these filters.')
  expect(empty.body).toContain('<option value="missing" selected>missing</option>')
  const byErrorCode = await request('GET', '/admin/audit?errorCode=PERMISSION_DENIED')
  expect(byErrorCode.statusCode).toBe(200)
  expect(byErrorCode.body).toContain('name="errorCode" value="PERMISSION_DENIED"')
  expect((await request('GET', '/admin/audit?from=invalid')).statusCode).toBe(400)
  expect((await request('GET', '/admin/audit?limit=101')).statusCode).toBe(400)
})

test('Audit filtering by instance returns only that instance in the screen, API and exports', async () => {
  await signIn()
  const audit = new Audit(db)
  for (const instance of ['lab', 'production']) {
    audit.record({ event: 'run-start', userId, tool: 'falcon-axi', outcome: 'started', args: [], sensitive: { flags: [], positions: [] },
      requestId: `${instance}-call`, clientAddress: null, credentialId: `${instance}-id`, instance })
  }
  audit.record({ event: 'denial', userId, tool: 'falcon-axi', outcome: 'INSTANCE_REQUIRED', requestId: 'unattributed', clientAddress: null })
  audit.record({ event: 'sign-in', userId, tool: null, outcome: 'success', requestId: 'historic-sign-in', clientAddress: null })
  const screen = await request('GET', '/admin/audit?instance=lab')
  expect(screen.body).toContain('<th scope="col">Instance</th>')
  expect(screen.body).toContain('<td>lab</td>')
  expect(screen.body).not.toContain('<td>production</td>')
  expect(screen.body).not.toContain('default/unknown')
  expect((await request('GET', '/admin/audit')).body).toContain('<td class="faint">default/unknown</td>')
  expect((await request('GET', '/admin/audit?requestId=historic-sign-in')).body).toContain('<td class="faint">default/unknown</td>')
  const api = await request('GET', '/v1/admin/audit?instance=production')
  expect(api.json().records.map((record: { request_id: string }) => record.request_id)).toEqual(['production-call'])
  const jsonl = await request('GET', '/v1/admin/audit/export?format=jsonl&instance=lab')
  expect(jsonl.body.trim().split('\n').map(line => JSON.parse(line))).toEqual([expect.objectContaining({ request_id: 'lab-call', credential_id: 'lab-id', instance: 'lab' })])
  const csv = await request('GET', '/v1/admin/audit/export?format=csv&instance=lab')
  expect(csv.body).toContain('credential_id,instance')
  expect(csv.body).toContain('"lab-id","lab"')
  expect(csv.body).not.toContain('production')
  expect((await request('GET', '/v1/admin/audit?instance=Bad_Name')).statusCode).toBe(400)
})

test('Audit screen applies request ID and failed-run filters to rows and export links', async () => {
  await signIn()
  const audit = new Audit(db)
  const context = { userId, tool: 'falcon-axi' as const, clientAddress: null, durationMs: 1, outputBytes: { stdout: 0, stderr: 0 } }
  audit.record({ ...context, requestId: 'synthetic-failed', event: 'run-terminal', outcome: 'completed', exitCode: 1 })
  audit.record({ ...context, requestId: 'synthetic-success', event: 'run-terminal', outcome: 'completed', exitCode: 0 })
  const { id } = db.prepare("SELECT id FROM audit WHERE request_id = 'synthetic-failed'").get() as { id: number }
  const page = await request('GET', '/admin/audit?requestId=synthetic-failed&failed=1&record=' + id)
  expect(page.statusCode).toBe(200)
  expect(page.body).toContain('<dt>request_id</dt><dd>synthetic-failed</dd>')
  expect(page.body).not.toContain('synthetic-success')
  expect(page.body).toContain('name="requestId" value="synthetic-failed"')
  expect(page.body).toContain('href="/admin/audit?requestId=synthetic-failed" aria-label="Clear filter: Failed runs only"')
  const links = [...page.body.matchAll(/download href="([^"]+)"/g)].map(match => new URL('http://localhost' + match[1].replaceAll('&amp;', '&')))
  expect(links).toHaveLength(2)
  expect(links.map(link => Object.fromEntries(link.searchParams))).toEqual([
    { requestId: 'synthetic-failed', failed: '1', format: 'csv' },
    { requestId: 'synthetic-failed', failed: '1', format: 'jsonl' },
  ])
})

test.each([
  { method: 'PATCH', path: '/v1/admin/users/synthetic-development-user' },
  { method: 'PUT', path: '/v1/admin/users/synthetic-development-user/roles' },
  { method: 'PATCH', path: '/v1/admin/roles/synthetic-role' },
  { method: 'PUT', path: '/v1/admin/roles/synthetic-role/tools' },
  { method: 'PATCH', path: '/v1/admin/tools/falcon-axi' },
  { method: 'PATCH', path: '/v1/admin/tools/falcon-axi/write-access' },
  { method: 'PATCH', path: '/v1/admin/tools/falcon-axi/raw-api' },
  { method: 'PUT', path: '/v1/admin/tools/falcon-axi/raw-api/routes' },
  { method: 'PUT', path: '/v1/admin/tools/falcon-axi/credential' },
  { method: 'PUT', path: '/v1/admin/tools/falcon-axi/user-grants' },
  { method: 'PUT', path: '/v1/admin/roles/synthetic-role/tools/falcon-axi/instances' },
] as const)('security $method $path requires CSRF before editing', async ({ method, path }) => {
  await signIn()
  expect((await request(method, path, {})).statusCode).toBe(403)
})

test('a CSRF token from another browser cannot mutate an existing session', async () => {
  await signIn()
  const first = { ...cookies }
  cookies = {}
  const otherToken = await token('/login')
  const otherSecret = cookies._csrf!
  cookies = first
  expect((await request('POST', '/logout', { _csrf: otherToken })).statusCode).toBe(403)
  cookies._csrf = otherSecret
  expect((await request('POST', '/logout', { _csrf: otherToken })).statusCode).toBe(403)
})

test('an ordinary browser user can change their password and sign out without administrator access', async () => {
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await signIn()).headers.location).toBe('/account')
  expect((await request('GET', '/account')).body).toContain('Change password')
  expect((await request('GET', '/admin')).statusCode).toBe(403)
  expect((await request('POST', '/logout', { _csrf: await token('/account') })).headers.location).toBe('/login')
})

test('browser pages escape the signed-in display name', async () => {
  db.prepare('UPDATE users SET display_name = ?').run('<script>synthetic</script>')
  await signIn()
  const response = await request('GET', '/admin')
  expect(response.body).toContain('&lt;script&gt;synthetic&lt;/script&gt;')
  expect(response.body).not.toContain('<script>')
  expect(response.headers['content-security-policy']).toContain("form-action 'self'")
  expect(response.headers['cache-control']).toBe('no-store')
})

test('Users screen escapes HTML usernames, role names and change actors as text', async () => {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>synthetic</b>', 'synthetic-second')
  db.prepare('UPDATE users SET updated_by = ?, updated_at = ?, revision = 7 WHERE id = ?')
    .run('synthetic-second', now, userId)
  db.prepare('UPDATE roles SET name = ?').run('<img src=x onerror=alert(1)>')
  await signIn()
  const response = await request('GET', '/admin/users')
  expect(response.statusCode).toBe(200)
  expect(response.body).toContain('&lt;b&gt;synthetic&lt;/b&gt;')
  expect(response.body).not.toContain('<b>synthetic</b>')
  expect(response.body).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(response.body).not.toContain('<img')
  const detail = await request('GET', '/admin/users/' + userId)
  expect(detail.body).toMatch(new RegExp(`Last changed by &lt;b&gt;synthetic&lt;/b&gt; at <time datetime="${new Date(now).toISOString()}"`, 'i'))
  expect(detail.body).toContain('Revision 7.')
})

test('Users screen paginates accounts and retains role choices from later API pages', async () => {
  const insert = db.prepare('INSERT INTO roles (id, name) VALUES (?, ?)')
  for (let index = 0; index < 101; index++) insert.run(`role-${index.toString().padStart(3, '0')}`, `Role ${index}`)
  await signIn()
  const response = await request('GET', '/admin/users?limit=1')
  expect(response.body).toContain('Role 100')
  const text = (element: DefaultTreeAdapterMap['element']): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
  const nextHref = (html: string) => nodesOf(parse(withoutProps(html))).find(element => element.tagName === 'a' && text(element) === 'Next')?.attrs.find(item => item.name === 'href')?.value
  const next = nextHref(response.body)!
  expect(next).toMatch(/^\/admin\/users\?.*cursor=/)
  expect(nextHref((await request('GET', next)).body)).toBeUndefined()
  expect((await request('GET', '/admin/users?limit=101')).statusCode).toBe(400)
})

test('users-list bookmarks from before Overview still open the users list with their filters', async () => {
  await signIn()
  const response = await request('GET', '/admin?source=local&limit=1')
  expect(response.statusCode).toBe(301)
  expect(response.headers.location).toBe('/admin/users?source=local&limit=1')
  expect((await request('GET', '/admin')).body).toMatch(/<h1[^>]*>Overview<\/h1>/)
})

test('the overview frame keeps the administration links, landmarks, title and confirmation controls', async () => {
  await signIn()
  const document = nodesOf(parse((await request('GET', '/admin')).body))
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const text = (element: DefaultTreeAdapterMap['element']): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
  const navigation = document.find(element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Administration')!
  const links = nodesOf(navigation).filter(element => element.tagName === 'a' && attribute(element, 'href')?.startsWith('/admin') && !text(element).includes('Artium'))
  expect(links.map(link => attribute(link, 'href'))).toEqual(['/admin', '/admin/users', '/admin/roles', '/admin/invitations', '/admin/tools',
    '/admin/settings/sign-in', '/admin/tokens', '/admin/audit'])
  expect(links.filter(link => attribute(link, 'aria-current') === 'page').map(link => attribute(link, 'href'))).toEqual(['/admin'])
  expect(document.filter(element => element.tagName === 'h1').map(text)).toEqual(['Overview'])
  expect(document.filter(element => element.tagName === 'nav' || attribute(element, 'role') === 'navigation').map(element => attribute(element, 'aria-label')))
    .toEqual(['Administration', 'Administration'])
  expect(document.filter(element => attribute(element, 'role') === 'banner')).toHaveLength(1)
  expect(document.filter(element => attribute(element, 'role') === 'main')).toHaveLength(1)
  const root = document.find(element => element.attrs.some(item => item.name === 'data-astryx-root'))!
  for (const placement of ['frame-controls-header', 'frame-controls-drawer']) {
    const controls = nodesOf(root).filter(element => attribute(element, 'class')?.split(' ').includes(placement))
    expect(controls).toHaveLength(1)
    const switches = nodesOf(controls[0]!).filter(element => element.tagName === 'form' && attribute(element, 'action') === '/theme')
    expect(switches).toHaveLength(1)
    expect(nodesOf(switches[0]!).find(element => attribute(element, 'name') === 'next')?.attrs.find(item => item.name === 'value')?.value).toBe('/admin')
    expect(nodesOf(controls[0]!).filter(element => attribute(element, 'data-reauth-until') !== undefined)).toHaveLength(1)
  }
  expect(nodesOf(root).filter(element => element.tagName === 'form' && attribute(element, 'action') === '/theme')).toHaveLength(2)
  expect(nodesOf(root).filter(element => attribute(element, 'data-reauth-until') !== undefined)).toHaveLength(2)
  const sidebar = document.find(element => attribute(element, 'class')?.split(' ').includes('astryx-app-shell-sidenav'))!
  expect(nodesOf(sidebar).filter(element => element.tagName === 'form' && attribute(element, 'action') === '/logout')).toHaveLength(1)
  const outside = document.filter(element => !nodesOf(root).includes(element))
  expect(outside.filter(element => ['confirmation', 'reauth-dialog', 'toast', 'message'].includes(attribute(element, 'id') ?? '')).map(element => attribute(element, 'id')))
    .toEqual(['toast', 'message', 'confirmation', 'reauth-dialog'])
})

const nodesOf = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [
  ...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(nodesOf) : []),
]

const withoutProps = (body: string) => body.replace(/<script type="application\/json" data-astryx-props>.*?<\/script>/s, '')

type Element = DefaultTreeAdapterMap['element']
const attributeOf = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const textOf = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? textOf(child) : '').join('')
const accessPage = async (tool: string, sheet?: string) => nodesOf(parse(withoutProps((await request('GET', `/admin/tools/${tool}?tab=access${sheet ? '&sheet=' + sheet : ''}`)).body)))
const accessRow = (page: Element[], label: string) => page.find(element => element.tagName === 'li' && nodesOf(element).some(item => ['a', 'strong'].includes(item.tagName) && textOf(item) === label))!
const accessSheet = (page: Element[], name: string) => page.find(element => element.tagName === 'dialog' && attributeOf(element, 'id') === `sheet-${name}`)!
const accessForm = (page: Element[], name: string) => nodesOf(accessSheet(page, name)).find(element => element.tagName === 'form')!
const accessSummary = (form: Element) => ['action', 'data-method', 'data-confirm', 'data-confirm-title', 'data-confirm-action'].map(name => attributeOf(form, name))
const accessFields = (form: Element) => nodesOf(form).filter(element => ['input', 'select'].includes(element.tagName))
  .map(element => [attributeOf(element, 'name'), attributeOf(element, 'type') ?? element.tagName, attributeOf(element, 'value'), attributeOf(element, 'checked') !== undefined])
const pickerPeople = (page: Element[], name: string) => nodesOf(accessSheet(page, name)).filter(element => element.tagName === 'option').map(option => attributeOf(option, 'value'))

test('overview names each broken access link with the action that fixes it', async () => {
  await app.close()
  const store = createCredentialStore(db, new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: {},
    adapters: [createVectraAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))],
    credentialStore: store, resolver: new SharedIdentityResolver(store, db) })
  db.exec(`UPDATE tools SET enabled = 1 WHERE name = 'vectra-axi';
    INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example');
    INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, created_at, created_by, expires_at)
      VALUES ('synthetic-invitation', 'synthetic-hash', 'synthetic-provider', 'synthetic@identity.example', 'Synthetic Invitee', ${now}, '${userId}', ${now + 86_400_000})`)
  await signIn()
  const body = withoutProps((await request('GET', '/admin')).body)
  expect(body).toMatch(/Vectra is enabled without a credential.*?href="\/admin\/tools\/vectra-axi".*?Add credential/s)
  expect(body).toMatch(/Synthetic Invitee can’t claim their invitation yet.*?href="\/admin\/invitations".*?Review/s)
  expect(body).toContain('2 things need you.')
})

test('the overview hands its data to hydration without letting a name end the data block', async () => {
  const hostile = '</script><b id="injected">x</b>'
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example');
    INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, created_at, created_by, expires_at)
      VALUES ('synthetic-invitation', 'synthetic-hash', 'synthetic-provider', 'synthetic@identity.example', '${hostile}', ${now}, '${userId}', ${now + 86_400_000})`)
  await signIn()
  const body = (await request('GET', '/admin')).body
  const document = nodesOf(parse(body))
  const data = document.filter(element => element.tagName === 'script' && element.attrs.some(attribute => attribute.name === 'data-astryx-props'))
  expect(data).toHaveLength(1)
  const { props } = JSON.parse((data[0]!.childNodes[0] as DefaultTreeAdapterMap['textNode']).value) as { props: { attention: { title: string }[] } }
  expect(props.attention.map(item => item.title)).toEqual([`${hostile} can’t claim their invitation yet`])
  expect(document.filter(element => element.attrs.some(attribute => attribute.name === 'id' && attribute.value === 'injected'))).toEqual([])
  expect(document.filter(element => element.tagName === 'script').map(element => element.attrs.find(attribute => attribute.name === 'src')?.value))
    .toEqual(['/admin/assets/confirm.js', '/admin/assets/hydrate.js', undefined])
})

test.each([
  { originOnly: true, cached: 'ok', state: 'Needs credential', passed: false },
  { originOnly: false, cached: null, state: 'Not checked', passed: false },
  { originOnly: false, cached: 'error', state: 'Failing', passed: false },
  { originOnly: false, cached: 'ok', state: 'Healthy', passed: true },
] as const)('overview reports AWX readiness for originOnly=$originOnly, cached=$cached', async ({ originOnly, cached, state, passed }) => {
  await app.close()
  const store = createCredentialStore(db, new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  const credential = store.replaceCredential('awx-axi', originOnly ? { origin: 'https://controller.example' }
    : { origin: 'https://controller.example', token: 'CANARY-awx-token' }, 0, userId, now)
  db.exec("UPDATE tools SET enabled = (name = 'awx-axi')")
  if (cached) db.prepare('INSERT INTO tool_health (tool, credential_id, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, ?, ?, ?)')
    .run('awx-axi', credential.id, credential.revision, now, cached, cached === 'error' ? 'UPSTREAM_NETWORK_FAILED' : null)
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), environment: {},
    adapters: [createAwxAdapter(new EmbeddedSecretSource(store))], credentialStore: store, resolver: new SharedIdentityResolver(store, db) })
  await signIn()
  const response = await request('GET', '/admin')
  expect(response.statusCode).toBe(200)
  const body = withoutProps(response.body)
  expect(body).toMatch(new RegExp(`<td[^>]*>.*?href="/admin/tools/awx-axi".*?<td[^>]*>.*?${state}`, 's'))
  expect(body.includes('AWX is enabled without a credential')).toBe(originOnly)
  expect(body.includes('Every enabled tool has a credential and its last check passed.')).toBe(passed)
  expect(body.includes('1 enabled tool has passed its last check.')).toBe(passed)
  expect(body).toMatch(new RegExp(`<li [^>]*data-progress="${passed ? 'completed' : 'in-progress'}"[^>]*>.*?Connect a tool`, 's'))
})

test('/admin/users renders the add-user sheet open from the sheet query without JavaScript', async () => {
  await signIn()
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const sheet = (body: string) => nodesOf(parse(body)).find(element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-add-user')!
  expect(attribute(sheet((await request('GET', '/admin/users?sheet=add-user')).body), 'open')).toBe('')
  expect(attribute(sheet((await request('GET', '/admin/users')).body), 'open')).toBeUndefined()
  expect(attribute(sheet((await request('GET', '/admin/users')).body), 'aria-labelledby')).toBe('sheet-add-user-title')
})

test('/admin/roles keeps the create-role form contract and opens its sheet from the sheet query without JavaScript', async () => {
  await signIn()
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const page = async (query = '') => nodesOf(parse((await request('GET', '/admin/roles' + query)).body))
  const dialog = (elements: DefaultTreeAdapterMap['element'][]) => elements.find(element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-new-role')!
  expect([attribute(dialog(await page('?sheet=new-role')), 'open'), attribute(dialog(await page()), 'open')]).toEqual(['', undefined])
  const elements = await page()
  const form = elements.find(element => element.tagName === 'form' && attribute(element, 'action') === '/v1/admin/roles')!
  expect(['method', 'data-method', 'data-confirm', 'data-success-url', 'data-success-message'].map(name => attribute(form, name)))
    .toEqual(['post', 'POST', undefined, '/admin/roles/{id}', 'Role created. Choose the tools it grants.'])
  const controls = nodesOf(form).filter(element => element.tagName === 'input')
  expect(controls.map(control => [attribute(control, 'name'), attribute(control, 'required')])).toEqual([['_csrf', undefined], ['name', '']])
  expect(attribute(controls[0]!, 'value')).toMatch(/\S/)
  expect(elements.filter(element => attribute(element, 'data-sheet') === 'sheet-new-role').map(link => attribute(link, 'href'))).toEqual(['/admin/roles?sheet=new-role'])
  expect((await request('GET', '/admin/roles?sheet=other')).statusCode).toBe(400)
  expect((await request('GET', '/admin/roles?dialog=other')).statusCode).toBe(400)
})

test('the earlier /admin/roles?dialog=new-role link redirects to the sheet and keeps the page query', async () => {
  await signIn()
  const response = await request('GET', '/admin/roles?dialog=new-role&limit=10')
  expect([response.statusCode, response.headers.location]).toEqual([302, '/admin/roles?limit=10&sheet=new-role'])
})

test('the person page renders its reset-password sheet open from the sheet query without JavaScript', async () => {
  await signIn()
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const sheet = (body: string) => nodesOf(parse(body)).find(element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-reset-password')!
  const opened = sheet((await request('GET', `/admin/users/${userId}?sheet=reset-password`)).body)
  expect([attribute(opened, 'open'), attribute(opened, 'aria-labelledby')]).toEqual(['', 'sheet-reset-password-title'])
  expect(attribute(sheet((await request('GET', `/admin/users/${userId}`)).body), 'open')).toBeUndefined()
})

const sendJson = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload,
  headers: { host: 'localhost', origin: 'http://localhost', cookie: Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ') } })

const claimToken = (claimPath: string) => new URL(claimPath, 'https://artium.example').searchParams.get('invitation')!

test('a created or resent invitation link appears only in the action response, never on the invitations page', async () => {
  db.exec("INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example')")
  await signIn()
  const _csrf = await token('/admin/invitations')
  const created = await sendJson('/v1/admin/sso/invitations', { _csrf, providerId: 'synthetic-provider', expectedUsername: 'synthetic@identity.example',
    displayName: 'Synthetic Invitee', roleIds: [], expiresInDays: 7 })
  expect(created.statusCode).toBe(201)
  const { invitation } = created.json()
  const resent = await sendJson(`/v1/admin/sso/invitations/${invitation.id}/resend`, { _csrf, expectedRevision: invitation.revision, expiresInDays: 7 })
  expect(resent.statusCode).toBe(200)
  const claims = [claimToken(created.json().claimPath), claimToken(resent.json().claimPath)]
  expect(claims[0]).not.toBe(claims[1])
  for (const url of ['/admin/invitations', `/admin/invitations?sheet=resend-${invitation.id}`, '/admin/invitations?sheet=new-invitation']) {
    const { body } = await request('GET', url)
    for (const secret of [...claims, ...claims.map(hashToken)]) expect(body).not.toContain(secret)
  }
})

test.each(['', '/synthetic-invitation/resend', '/synthetic-invitation/revoke'])('invitation action %j needs the CSRF token and the current administrator capability', async action => {
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example');
    INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, created_at, created_by, expires_at)
      VALUES ('synthetic-invitation', 'synthetic-hash', 'synthetic-provider', 'synthetic@identity.example', 'Synthetic Invitee', ${now}, '${userId}', ${now + 86_400_000})`)
  await signIn()
  const _csrf = await token('/admin/invitations')
  const url = '/v1/admin/sso/invitations' + action
  const payload = action ? { expectedRevision: 1, expiresInDays: 7 } : { providerId: 'synthetic-provider', expectedUsername: 'other@identity.example', displayName: 'Other', roleIds: [], expiresInDays: 7 }
  expect((await sendJson(url, payload)).statusCode).toBe(403)
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await sendJson(url, { ...payload, _csrf })).statusCode).toBe(403)
  expect(db.prepare('SELECT id, token_hash, revision, revoked_at FROM invitations').all()).toEqual([{ id: 'synthetic-invitation', token_hash: 'synthetic-hash', revision: 1, revoked_at: null }])
  expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event LIKE 'invite-%'").get()).toEqual({ count: 0 })
})

test('invitation navigation opens the creation sheet without JavaScript', async () => {
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer) VALUES
    ('synthetic-entra', 'Synthetic Entra', 'entra', 'https://entra.example'),
    ('synthetic-oidc', 'Synthetic OIDC', 'oidc', 'https://oidc.example')`)
  await signIn()
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const elements = async (query = '') => nodesOf(parse((await request('GET', '/admin/invitations' + query)).body))
  const sheet = (page: DefaultTreeAdapterMap['element'][]) => page.find(element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-new-invitation')!
  const closed = await elements()
  expect(closed.filter(element => attribute(element, 'data-sheet') === 'sheet-new-invitation').map(link => attribute(link, 'href'))).toEqual(['/admin/invitations?limit=50&sheet=new-invitation'])
  expect([attribute(sheet(closed), 'open'), attribute(sheet(closed), 'aria-labelledby')]).toEqual([undefined, 'sheet-new-invitation-title'])
  const open = await elements('?sheet=new-invitation')
  expect(attribute(sheet(open), 'open')).toBe('')
  expect(nodesOf(sheet(open)).filter(element => element.tagName === 'option').map(option => option.childNodes.map(child => 'value' in child ? child.value : '').join('')))
    .toEqual(['Synthetic Entra (not enabled yet)', 'Synthetic OIDC (not enabled yet)'])
})

test.each([
  { status: 'Pending', lifetime: 86_400_000, claimed: false, revoked: false, actionable: true },
  { status: 'Expired', lifetime: -86_400_000, claimed: false, revoked: false, actionable: true },
  { status: 'Claimed', lifetime: 86_400_000, claimed: true, revoked: false, actionable: false },
  { status: 'Revoked', lifetime: 86_400_000, claimed: false, revoked: true, actionable: false },
])('invitations display recorded expiry when $status', async ({ status, lifetime, claimed, revoked, actionable }) => {
  const expiry = now + lifetime
  db.exec("INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example')")
  db.prepare(`INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, user_id,
    created_at, created_by, expires_at, claimed_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('synthetic-invitation', 'synthetic-hash', 'synthetic-provider', 'synthetic@identity.example', 'Synthetic Invitee',
      claimed ? 'synthetic-second' : null, now - 2 * 86_400_000, userId, expiry, claimed ? now - 1 : null, revoked ? now - 1 : null)
  await signIn()
  const response = await request('GET', '/admin/invitations')
  expect(response.statusCode).toBe(200)
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const text = (element: DefaultTreeAdapterMap['element']): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
  const row = nodesOf(parse(response.body)).find(element => element.tagName === 'tr' && attribute(element, 'data-invitation') === 'synthetic-invitation')!
  const inRow = nodesOf(row)
  expect(inRow.some(element => attribute(element, 'class')?.includes('badge') && text(element) === status)).toBe(true)
  expect(inRow.filter(element => element.tagName === 'time').map(element => attribute(element, 'datetime'))).toEqual([new Date(expiry).toISOString()])
  expect(inRow.filter(element => element.tagName === 'a' && attribute(element, 'data-sheet') === 'sheet-resend-synthetic-invitation')).toHaveLength(actionable ? 1 : 0)
  expect(inRow.filter(element => element.tagName === 'form' && attribute(element, 'action')?.endsWith('/revoke'))).toHaveLength(actionable ? 1 : 0)
  expect(nodesOf(parse(response.body)).filter(element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-resend-synthetic-invitation')).toHaveLength(actionable ? 1 : 0)
})

test.each([
  { name: 'idle', elapsed: browserDefaults.idleMs, lastSeenAgo: browserDefaults.idleMs },
  { name: 'absolute', elapsed: browserDefaults.absoluteMs, lastSeenAgo: 1 },
])('$name expiry rejects browser requests at the deadline', async ({ elapsed, lastSeenAgo }) => {
  await signIn()
  now += elapsed
  db.prepare('UPDATE sessions SET last_seen_at = ?').run(now - lastSeenAgo)
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
})

test('successful requests extend idle time without extending the absolute deadline', async () => {
  await signIn()
  const start = now
  now += browserDefaults.idleMs - 1
  expect((await request('GET', '/admin')).statusCode).toBe(200)
  expect(db.prepare('SELECT last_seen_at, expires_at FROM sessions').get())
    .toEqual({ last_seen_at: now, expires_at: start + browserDefaults.absoluteMs })
  now += browserDefaults.idleMs - 1
  expect((await request('GET', '/admin')).statusCode).toBe(200)
})

test('forced change redirects admin and reauth, revokes every session and requires a new login', async () => {
  const cli = issueLoginTokens(db, userId)
  await signIn()
  const oldCookies = { ...cookies }
  db.prepare('UPDATE users SET must_change = 1').run()
  cookies = {}
  expect((await signIn()).headers.location).toBe('/password')
  expect((await request('GET', '/admin')).headers.location).toBe('/password')
  expect((await request('GET', '/reauth')).headers.location).toBe('/password')
  expect((await request('POST', '/password', { _csrf: await token('/password'), newPassword })).headers.location).toBe('/login')
  if (cli.status !== 'authenticated') throw new Error('Expected ordinary login')
  expect(() => verifyAccessToken(db, cli.accessToken)).toThrow()
  cookies = oldCookies
  expect((await request('GET', '/admin')).headers.location).toBe('/login')
  expect((await signIn(newPassword)).headers.location).toBe('/admin')
})

test('temporary browser sign-in expires after ten minutes', async () => {
  db.prepare('UPDATE users SET must_change = 1').run()
  await signIn()
  now += tokenDefaults.passwordChangeMs
  expect((await request('GET', '/password')).headers.location).toBe('/login')
})

test('ordinary password change accepts recent browser confirmation and requires current password when stale', async () => {
  await signIn()
  const csrf = await token('/password')
  now += authDefaults.recentAuthMs
  expect((await request('POST', '/password', { _csrf: csrf, newPassword })).statusCode).toBe(401)
  expect((await request('POST', '/password', { _csrf: csrf, currentPassword: 'CANARY-wrong-password', newPassword })).statusCode).toBe(401)
  expect((await request('POST', '/reauth', { _csrf: csrf, password })).headers.location).toBe('/admin')
  expect(db.prepare("SELECT outcome FROM audit WHERE event = 'reauth'").all()).toEqual([{ outcome: 'success' }])
  expect((await request('POST', '/password', { _csrf: csrf, newPassword })).headers.location).toBe('/login')
  expect((await signIn(newPassword)).headers.location).toBe('/admin')
})

test('current administrator capability and enabled state govern every browser request', async () => {
  await signIn()
  const csrf = await token('/admin')
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(userId)
  expect((await request('GET', '/admin')).statusCode).toBe(403)
  expect((await request('POST', '/v1/admin/roles', { _csrf: csrf, name: 'Denied' })).statusCode).toBe(403)
  db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId)
  expect((await request('GET', '/password')).headers.location).toBe('/login')
})

test.each([
  ['light', ' data-theme="light"'], ['dark', ' data-theme="dark"'],
  ['system', ''], ['neon', ''], ['DARK', ''], ['', ''],
])('the sign-in page renders the %j theme cookie as the root theme attribute', async (value, attribute) => {
  cookies['artium-theme'] = value
  expect((await request('GET', '/login')).body).toContain(`<html lang="en"${attribute}>`)
})

test('the theme switch remembers the choice for a year and reloads the page it was used on', async () => {
  const response = await request('POST', '/theme', { theme: 'dark', next: '/login?notice=1' })
  expect(response.statusCode).toBe(303)
  expect(response.headers.location).toBe('/login?notice=1')
  expect(response.cookies).toEqual([expect.objectContaining({ name: 'artium-theme', value: 'dark', path: '/', sameSite: 'Lax', maxAge: 365 * 24 * 60 * 60 })])
  const page = (await request('GET', '/login')).body
  expect(page).toContain('<html lang="en" data-theme="dark">')
  const pressed = (node: DefaultTreeAdapterMap['node']): string[] => [
    ...('tagName' in node && node.tagName === 'button' && node.attrs.some(attr => attr.name === 'aria-pressed' && attr.value === 'true')
      ? [node.attrs.find(attr => attr.name === 'value')!.value] : []),
    ...('childNodes' in node ? node.childNodes.flatMap(pressed) : []),
  ]
  expect(pressed(parse(page))).toEqual(['dark'])
})

test.each([
  ['an unknown theme', { theme: 'neon', next: '/login' }, 400],
  ['a missing theme', { next: '/login' }, 400],
])('the theme switch rejects %s without setting the cookie', async (_name, input, status) => {
  const response = await request('POST', '/theme', input)
  expect(response.statusCode).toBe(status)
  expect(response.cookies.map(cookie => cookie.name)).not.toContain('artium-theme')
})

test.each(['//other.example/a', '/\\other.example/a', 'https://other.example/a', 'admin', '/a\r\nset-cookie: x=y', ''])(
  'the theme switch only returns to a path on this server: %j', async next => {
    const response = await request('POST', '/theme', { theme: 'light', next })
    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/')
  },
)

test.each([
  ['a cross-origin post', { origin: 'http://other.example' }],
  ['a post from a cross-site page without an Origin header', { 'sec-fetch-site': 'cross-site' }],
  ['a post without an Origin header', {}],
])('the theme switch refuses %s', async (_name, headers) => {
  const response = await app.inject({ method: 'POST', url: '/theme', payload: new URLSearchParams({ theme: 'dark', next: '/login' }).toString(),
    headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded', ...headers } })
  expect(response.statusCode).toBe(403)
  expect(response.cookies).toEqual([])
})

test('the theme switch needs no form token and never touches the session or CSRF cookies', async () => {
  await signIn()
  const before = { ...cookies }
  const response = await request('POST', '/theme', { theme: 'light', next: '/admin' })
  expect(response.statusCode).toBe(303)
  expect(response.cookies.map(cookie => cookie.name)).toEqual(['artium-theme'])
  expect(cookies['artium-session']).toBe(before['artium-session'])
  expect(cookies._csrf).toBe(before._csrf)
})
