import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { confirmationRoutes } from '../../src/shared/confirmation-routes.js'
import { mintConfirmation } from '../../src/server/admin/confirmation-token.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { createBrowserSession, readBrowserSession } from '../../src/server/auth/sessions.js'
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

test.each([
  ['/admin/ssh/credentials', 'credential-delete', 'ssh_credentials'],
  ['/admin/ssh', 'host-delete', 'ssh_hosts'],
] as const)('each form on %s confirms only its own target', async (page, action, table) => {
  db.exec(`INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses) VALUES
      ('first', '127.0.0.1', 22, '[]', '[]'), ('second', '127.0.0.1', 22, '[]', '[]');
    INSERT INTO ssh_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, updated_at) VALUES
      ('first', 'ssh-axi', 1, 'synthetic', X'00', X'00', X'00', 0), ('second', 'ssh-axi', 1, 'synthetic', X'00', X'00', X'00', 0)`)
  const url = `/v1/admin/ssh/${action}`
  const html = (await app.inject({ url: page, headers })).body
  const forms = [...html.matchAll(new RegExp(`<form[^>]*action="${url}"[^>]*>.*?</form>`, 'gs'))].map(match => pageForm(match[0], url))
  expect(forms.map(item => item.inputs.id)).toEqual(['first', 'second'])
  const confirmations = forms.map(item => item.attributes['data-confirm-token']!)
  for (const [index, id] of ['first', 'second'].entries()) {
    const payload = { id, expectedRevision: 1, confirm: true, _confirmName: id }
    const refused = await post(url, { ...payload, _confirm: confirmations[1 - index] })
    expect([refused.statusCode, refused.json().error.code]).toEqual([428, 'CONFIRMATION_REQUIRED'])
    expect(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)).toEqual({ id })
    expect((await post(url, { ...payload, _confirm: confirmations[index] })).statusCode).toBe(200)
    expect(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)).toBeUndefined()
  }
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

test('a native confirmation heading matching an inherited property gets general help', async () => {
  const step = await postForm(revokeAll, { ...pageForm(await tokenPage(), revokeAll).inputs, _confirmTitle: 'constructor' })
  expect(step.statusCode).toBe(200)
  const elements = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [
    ...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(elements) : []),
  ]
  const text = (element: DefaultTreeAdapterMap['element']): string =>
    element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
  const help = elements(parse(step.body)).find(element => element.tagName === 'details' &&
    element.childNodes.some(child => 'tagName' in child && child.tagName === 'summary' && text(child) === 'Need help?'))
  expect(help && elements(help).filter(element => element.tagName === 'p').map(text))
    .toEqual(['Use the navigation to return to your account or an administration screen.'])
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
  expect([response.statusCode, response.body]).toEqual([204, ''])
  expect(revoked()).toEqual(['token-live'])
})

const archive = (id: string) => `/v1/admin/users/${id}/archive`
const roleRules = '/v1/admin/sso/role-rules'
const ruleFields = { providerId: 'synthetic-provider', claim: 'groups', value: 'Synthetic.Readers', roleId: 'synthetic-role' }
const addProvider = () => db.prepare("INSERT INTO sso_providers (id, name, kind, issuer) VALUES ('synthetic-provider', 'Synthetic provider', 'oidc', 'https://identity.example')").run()
const ruleCount = () => (db.prepare('SELECT COUNT(*) AS count FROM role_rules').get() as { count: number }).count
const later = (minutes: number) => {
  vi.spyOn(Date, 'now').mockReturnValue(now + minutes * 60000)
  db.prepare('UPDATE sessions SET reauthenticated_at = ?').run(now + minutes * 60000)
}
const archived = (id: string) => (db.prepare('SELECT archived_at AS at FROM users WHERE id = ?').get(id) as { at: number | null }).at !== null
function addUser(id: string) {
  db.prepare("INSERT INTO users (id, username, display_name, password_hash, must_change) SELECT ?, ?, 'Second', password_hash, 0 FROM users LIMIT 1").run(id, id)
}
async function archiveConfirmation(id: string) {
  const page = pageForm((await app.inject({ url: `/admin/users/${id}`, headers })).body, archive(id))
  return { confirmation: page.attributes['data-confirm-token']!, expectedRevision: Number(page.inputs.expectedRevision) }
}
async function roleConfirmation(id: string) {
  const body = (await app.inject({ url: `/admin/roles/${id}`, headers })).body
  const [, tag] = body.match(new RegExp(`<form([^>]*data-method="DELETE"[^>]*action="/v1/admin/roles/${id}"[^>]*)>`)) ?? []
  return /data-confirm-token="([^"]+)"/.exec(tag ?? '')![1]!
}
const deleteRole = (id: string, payload: Record<string, unknown>) => app.inject({ method: 'DELETE', url: `/v1/admin/roles/${id}`, headers, payload: { _csrf: csrf, expectedRevision: 1, ...payload } })
const roles = () => db.prepare('SELECT name FROM roles WHERE id = ?')

test.each([
  ['no typed name', undefined],
  ['a different name', 'synthetic-other'],
  ['the right name in another case', 'Synthetic-Second'],
  ['the right name and a trailing space', 'synthetic-second '],
  ['an empty name', ''],
])('archiving a person with %s is refused and changes nothing', async (_case, typed) => {
  addUser('synthetic-second')
  const { confirmation, expectedRevision } = await archiveConfirmation('synthetic-second')
  const response = await post(archive('synthetic-second'), { _confirm: confirmation, expectedRevision, ...typed === undefined ? {} : { _confirmName: typed } })
  expect([response.statusCode, response.json().error.code]).toEqual([428, 'CONFIRMATION_REQUIRED'])
  expect(response.headers['x-artium-confirmation']).toBeUndefined()
  expect(archived('synthetic-second')).toBe(false)
})

test('archiving a person with the exact typed name and the page confirmation completes once', async () => {
  addUser('synthetic-second')
  const { confirmation, expectedRevision } = await archiveConfirmation('synthetic-second')
  expect((await post(archive('synthetic-second'), { _confirm: confirmation, expectedRevision, _confirmName: 'synthetic-second' })).statusCode).toBe(200)
  expect(archived('synthetic-second')).toBe(true)
})

test('a role is deleted only with its exact typed name, and a confirmation is bound to the name the page showed', async () => {
  db.prepare("INSERT INTO roles (id, name) VALUES ('role-doomed', 'Doomed role')").run()
  const confirmation = await roleConfirmation('role-doomed')
  expect((await deleteRole('role-doomed', { _confirm: confirmation, _confirmName: 'doomed role' })).json().error.code).toBe('CONFIRMATION_REQUIRED')
  db.prepare("UPDATE roles SET name = 'Renamed role' WHERE id = 'role-doomed'").run()
  for (const typed of ['Doomed role', 'Renamed role']) {
    expect((await deleteRole('role-doomed', { _confirm: confirmation, _confirmName: typed })).json().error.code).toBe('CONFIRMATION_REQUIRED')
  }
  expect(roles().get('role-doomed')).toEqual({ name: 'Renamed role' })
  const renamed = await roleConfirmation('role-doomed')
  expect((await deleteRole('role-doomed', { _confirm: renamed, _confirmName: 'Renamed role' })).statusCode).toBe(200)
  expect(roles().get('role-doomed')).toBeUndefined()
})

test.each([
  ['POST', '/v1/admin/ssh/credential-delete', 'credential-one', { id: 'credential-one', expectedRevision: 1, confirm: true }, 'ssh_credentials', 'credential-one'],
  ['POST', '/v1/admin/ssh/host-delete', 'host-one', { id: 'host-one', expectedRevision: 1, confirm: true }, 'ssh_hosts', 'host-one'],
  ['DELETE', '/v1/admin/sso/role-rules/rule-one', 'Group.One', { expectedRevision: 1 }, 'role_rules', 'rule-one'],
  ['DELETE', '/v1/admin/tools/falcon-axi/instances/instance-one', 'instance-one', { expectedId: 'instance-id', expectedRevision: 1 }, 'credentials', 'instance-id'],
] as const)('%s %s checks the target name before proceeding', async (method, url, name, payload, table, id) => {
  db.exec(`INSERT INTO sso_providers (id, name, kind, issuer, enabled) VALUES ('provider-one', 'Provider', 'oidc', 'https://example.test', 1);
    INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES ('rule-one', 'provider-one', 'groups', 'Group.One', 'synthetic-role');
    INSERT INTO ssh_hosts (id, address, port, approved_host_keys, allowed_addresses) VALUES ('host-one', '127.0.0.1', 22, '[]', '[]');
    INSERT INTO ssh_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, updated_at)
      VALUES ('credential-one', 'ssh-axi', 1, 'synthetic', X'00', X'00', X'00', 0);
    INSERT INTO credentials (id, tool, name, schema_version, key_id, nonce, ciphertext, authentication_tag)
      VALUES ('instance-id', 'falcon-axi', 'instance-one', 1, 'synthetic', zeroblob(12), X'00', zeroblob(16))`)
  const session = headers.cookie!.split(`${browserCookie}=`)[1]!.split(';')[0]!
  const confirmation = mintConfirmation(readBrowserSession(db, session).id, method, url, name)
  const request = (typed: string) => app.inject({ method, url, headers, payload: { _csrf: csrf, ...payload, _confirm: confirmation, _confirmName: typed } })
  const wrong = await request('wrong-name')
  expect([wrong.statusCode, wrong.json().error.code]).toEqual([428, 'CONFIRMATION_REQUIRED'])
  expect(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)).toEqual({ id })
  const right = await request(name)
  expect(right.statusCode).toBe(200)
  expect(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)).toBeUndefined()
})

test('a value that lapsed but is otherwise valid is answered with a fresh value for the same action, and the fresh value completes it', async () => {
  mint('token-live')
  const issued = pageForm(await tokenPage(), revokeAll).attributes['data-confirm-token']!
  later(20)
  expect((await app.inject({ url: '/admin/tokens', headers })).statusCode).toBe(200)
  later(40)
  const lapsed = await post(revokeAll, { _confirm: issued })
  expect([lapsed.statusCode, lapsed.json().error.code]).toEqual([428, 'CONFIRMATION_REQUIRED'])
  expect(revoked()).toEqual([])
  const fresh = lapsed.headers['x-artium-confirmation'] as string
  expect(fresh).toMatch(/^\d+\.[\w-]+$/)
  expect((await post(revokeAll, { _confirm: fresh })).statusCode).toBe(204)
  expect(revoked()).toEqual(['token-live'])
  expect(revocations()).toBe(1)
})

test('a lapsed value for another action, another session or a wrong typed name gets no fresh value', async () => {
  mint('token-a')
  addUser('synthetic-second')
  const forAll = pageForm(await tokenPage(), revokeAll).attributes['data-confirm-token']!
  const { confirmation, expectedRevision } = await archiveConfirmation('synthetic-second')
  const otherSession = browserHeaders()
  later(20)
  expect((await app.inject({ url: '/admin/tokens', headers })).statusCode).toBe(200)
  expect((await app.inject({ url: '/admin/tokens', headers: otherSession })).statusCode).toBe(200)
  later(40)
  const refused = [
    await post('/v1/admin/tokens/token-a/revoke', { _confirm: forAll }),
    await post(revokeAll, { _confirm: forAll }, otherSession),
    await post(revokeAll, { _confirm: `${forAll.split('.')[0]}.garbage` }),
    await post(archive('synthetic-second'), { _confirm: confirmation, expectedRevision, _confirmName: 'synthetic-other' }),
  ]
  expect(refused.map(response => [response.statusCode, response.headers['x-artium-confirmation']])).toEqual(Array(4).fill([428, undefined]))
  const right = await post(archive('synthetic-second'), { _confirm: confirmation, expectedRevision, _confirmName: 'synthetic-second' })
  expect([right.statusCode, typeof right.headers['x-artium-confirmation']]).toEqual([428, 'string'])
  expect([revoked(), archived('synthetic-second')]).toEqual([[], false])
})

test.each([
  ['no Origin', ({ origin: _origin, ...as }: Record<string, string>) => as, (inputs: Record<string, string>) => inputs],
  ['a foreign Origin', (as: Record<string, string>) => ({ ...as, origin: 'https://elsewhere.example' }), (inputs: Record<string, string>) => inputs],
  ['no CSRF token', (as: Record<string, string>) => as, ({ _csrf: _removed, ...inputs }: Record<string, string>) => inputs],
  ['a wrong CSRF token', (as: Record<string, string>) => as, (inputs: Record<string, string>) => ({ ...inputs, _csrf: 'wrong' })],
])('a native post with %s is refused as CSRF_INVALID and never reaches the confirmation step', async (_case, request, fields) => {
  mint('token-live')
  addUser('synthetic-second')
  addProvider()
  const archivePage = pageForm((await app.inject({ url: '/admin/users/synthetic-second', headers })).body, archive('synthetic-second'))
  for (const [url, inputs] of [[revokeAll, pageForm(await tokenPage(), revokeAll).inputs], [archive('synthetic-second'), archivePage.inputs],
    [roleRules, { _csrf: csrf, ...ruleFields }]] as const) {
    const response = await postForm(url, fields(inputs), request(headers))
    expect([response.statusCode, response.json().error.code]).toEqual([403, 'CSRF_INVALID'])
  }
  expect([revoked(), archived('synthetic-second'), ruleCount()]).toEqual([[], false, 0])
})

test.each([
  ['PATCH', '/v1/admin/tools/falcon-axi', { expectedRevision: '1', enabled: 'false' }],
  ['DELETE', '/v1/admin/roles/role-doomed', { expectedRevision: '1' }],
  ['PUT', '/v1/admin/users/synthetic-second/roles', { expectedRevision: '1' }],
])('a native post to a %s confirmation route changes nothing and answers that the page script is required', async (_method, url, fields) => {
  db.prepare("INSERT INTO roles (id, name) VALUES ('role-doomed', 'Doomed role')").run()
  addUser('synthetic-second')
  const response = await postForm(url, { _csrf: csrf, ...fields })
  expect(response.statusCode).toBe(409)
  expect(response.body).toContain('Page script required')
  expect(response.body).not.toContain('name="_confirm"')
  const crossSite = await postForm(url, { _csrf: csrf, ...fields }, { ...headers, origin: 'https://elsewhere.example' })
  expect([crossSite.statusCode, crossSite.json().error.code]).toEqual([403, 'CSRF_INVALID'])
  expect(db.prepare("SELECT enabled FROM tools WHERE name = 'falcon-axi'").get()).toEqual({ enabled: 1 })
  expect(roles().get('role-doomed')).toEqual({ name: 'Doomed role' })
})

test('a native post to a path that is not a confirmation route is still not found', async () => {
  const response = await postForm('/v1/admin/tools/falcon-axi/unknown', { _csrf: csrf })
  expect([response.statusCode, response.json().error.code]).toEqual([404, 'NOT_FOUND'])
})

test('a native role-rule create carries only its listed plain fields into the step, and confirming creates the rule once', async () => {
  addProvider()
  const step = await postForm(roleRules, { _csrf: csrf, ...ruleFields, temporaryPassword: 'CANARY-typed-secret' })
  expect(step.statusCode).toBe(200)
  expect(step.body).not.toContain('CANARY-typed-secret')
  const confirmation = pageForm(step.body, roleRules).inputs
  expect(Object.keys(confirmation).sort()).toEqual(['_confirm', '_csrf', 'claim', 'providerId', 'roleId', 'value'])
  expect(ruleCount()).toBe(0)
  const created = await postForm(roleRules, confirmation)
  expect([created.statusCode, created.headers.location]).toEqual([303, '/admin'])
  expect(ruleCount()).toBe(1)
  expect(db.prepare('SELECT provider_id AS providerId, claim, value, role_id AS roleId FROM role_rules').get()).toEqual(ruleFields)
})

test('an Authorization header does not replace the confirmation on a route the session cookie authenticates, and is only a token elsewhere', async () => {
  mint('token-live')
  const garbage = { ...headers, authorization: 'Bearer garbage' }
  const admin = await post(revokeAll, {}, garbage)
  expect([admin.statusCode, admin.json().error.code]).toEqual([401, 'TOKEN_INVALID'])
  const account = await post('/v1/account/sessions/revoke', {}, garbage)
  expect([account.statusCode, account.json().error.code]).toEqual([428, 'CONFIRMATION_REQUIRED'])
  expect(revoked()).toEqual([])
  expect((await app.inject({ url: '/admin/tokens', headers })).statusCode).toBe(200)
})
