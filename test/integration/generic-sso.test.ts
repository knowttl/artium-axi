import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { readBrowserSession } from '../../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { ProviderCredentials } from '../../src/server/store/provider-credentials.js'
import { FakeCredentialStore } from '../fixtures/credential-store.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { seedBrowserSso, seedSsoInvitation } from '../fixtures/sso.js'

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let fakes: Awaited<ReturnType<typeof seedBrowserSso>>[]
let discoveryFailure: 'redirect' | 'issuer' | undefined
const headers = { host: 'localhost', 'x-forwarded-proto': 'https' }
const providers = [
  { id: 'synthetic-first', issuer: 'https://first.example', clientId: 'synthetic-first-client' },
  { id: 'synthetic-second', issuer: 'https://second.example', clientId: 'synthetic-second-client' },
]

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'artium-generic-sso-'))
  const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  const credentials = new ProviderCredentials(db, key)
  fakes = []
  for (const [index, provider] of providers.entries()) fakes.push(await seedBrowserSso(db, credentials,
    `https://localhost/auth/sso/${provider.id}/callback`, { generic: provider, authentication: index ? 'certificate' : 'secret',
      secretMethod: 'client_secret_basic', clientSecret: 'CANARY-basic+/:= secret' }))
  discoveryFailure = undefined
  app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'calls')), adapters: [],
    environment: { ARTIUM_AXI_TRUSTED_PROXIES: '127.0.0.1' }, resolver: new SharedIdentityResolver(new FakeCredentialStore([])),
    providerCredentials: credentials, ssoFetch: async (url, options) => {
      const index = providers.findIndex(provider => url.startsWith(provider.issuer + '/'))
      if (index < 0) throw new Error('Unexpected fake destination')
      expect(options.redirect).toBe('manual')
      if (url.endsWith('/.well-known/openid-configuration')) {
        if (discoveryFailure === 'redirect') return new Response(null, { status: 302, headers: { location: providers[1].issuer } })
        if (discoveryFailure === 'issuer') {
          const metadata = await (await fakes[index].fetch(url, options)).json()
          return Response.json({ ...metadata, issuer: providers[1].issuer })
        }
      }
      return fakes[index].fetch(url, options)
    } })
})

afterEach(async () => {
  await app.close()
  for (const fake of fakes) await fake.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

async function start(index: number, path = `/auth/sso/${providers[index].id}/start`, sessionToken?: string) {
  const response = await app.inject({ url: path, headers: { ...headers,
    ...(sessionToken ? { cookie: `${browserCookie}=${sessionToken}` } : {}) } })
  expect(response.statusCode).toBe(302)
  const authorization = new URL(response.headers.location!)
  const issued = await fetch(fakes[index].url + '/authorize' + authorization.search, { redirect: 'manual' })
  expect(issued.status).toBe(302)
  const cookie = response.cookies.find(cookie => cookie.name === 'artium-sso')!
  return { url: new URL(issued.headers.get('location')!), cookie: `${cookie.name}=${cookie.value}` }
}

async function finish(transaction: Awaited<ReturnType<typeof start>>) {
  return app.inject({ url: transaction.url.pathname + transaction.url.search, headers: { ...headers, cookie: transaction.cookie } })
}

test('two generic providers with the same subject sign in to separate accounts using secret and certificate credentials', async () => {
  const login = await app.inject({ url: '/login', headers })
  for (const provider of providers) expect(login.body).toContain(`/auth/sso/${provider.id}/start`)
  for (const [index, provider] of providers.entries()) {
    const response = await finish(await start(index))
    expect(response.statusCode).toBe(200)
    const session = response.cookies.find(cookie => cookie.name === browserCookie)!.value
    expect(readBrowserSession(db, session).user_id).toBe(provider.id + '-user')
  }
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE event = 'sign-in' AND outcome = 'success'").get()).toEqual({ count: 2 })
})

test('generic invitation claim binds sub and refuses username mismatch without consuming the invitation', async () => {
  const invitation = seedSsoInvitation(db, { providerId: providers[0].id })
  fakes[0].token.claims = { sub: 'synthetic-invited-subject', preferred_username: 'different-user' }
  expect((await finish(await start(0, invitation.claimPath))).body).toContain('SSO_INVITE_INVALID')
  fakes[0].token.claims = { sub: 'synthetic-invited-subject', preferred_username: 'synthetic-invited' }
  expect((await finish(await start(0, invitation.claimPath))).statusCode).toBe(200)
  expect(db.prepare('SELECT subject FROM identities WHERE subject = ?').get('synthetic-invited-subject'))
    .toEqual({ subject: 'synthetic-invited-subject' })
  expect((await app.inject({ url: invitation.claimPath, headers })).body).toContain('SSO_INVITE_INVALID')
})

test('named claims synchronize each provider independently while preserving direct grants', async () => {
  db.exec(`INSERT INTO roles (id, name) VALUES ('rule-role', 'Rule role');
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-first-user', 'synthetic-role');
    INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES
      ('first-rule', 'synthetic-first', 'groups', 'Readers', 'rule-role'),
      ('second-rule', 'synthetic-second', 'custom.claim', 'Readers', 'rule-role');`)
  fakes[0].token.claims = { groups: ['Readers'], 'custom.claim': 'Readers' }
  fakes[1].token.claims = { groups: ['Readers'], 'custom.claim': 'Readers' }
  expect((await finish(await start(0))).statusCode).toBe(200)
  expect((await finish(await start(1))).statusCode).toBe(200)
  expect(db.prepare("SELECT user_id, origin FROM user_roles WHERE role_id = 'rule-role' ORDER BY user_id").all()).toEqual([
    { user_id: 'synthetic-first-user', origin: 'first-rule' },
    { user_id: 'synthetic-second-user', origin: 'second-rule' },
  ])
  fakes[0].token.claims = { groups: ['readers'] }
  expect((await finish(await start(0))).statusCode).toBe(200)
  expect(db.prepare('SELECT role_id, origin FROM user_roles WHERE user_id = ?').all('synthetic-first-user'))
    .toEqual([{ role_id: 'synthetic-role', origin: 'direct' }])
  expect(db.prepare("SELECT origin FROM user_roles WHERE user_id = 'synthetic-second-user'").all()).toEqual([{ origin: 'second-rule' }])
  expect(db.prepare("SELECT count(*) AS count FROM audit WHERE event = 'role-sync'").get()).toEqual({ count: 3 })
})

test.each([null, 7, true, { Readers: true }, ['Other', 7, { value: 'Readers' }]])('nonmatching claim %j does not grant a role', async groups => {
  db.exec(`INSERT INTO role_rules (id, provider_id, claim, value, role_id)
    VALUES ('group-rule', 'synthetic-first', 'groups', 'Readers', 'synthetic-role')`)
  fakes[0].token.claims = { groups }
  expect((await finish(await start(0))).statusCode).toBe(200)
  expect(db.prepare("SELECT * FROM user_roles WHERE user_id = 'synthetic-first-user'").all()).toEqual([])
})

test.each([0, 1])('generic provider %s confirms its bound browser identity with fresh authentication', async index => {
  const signedIn = await finish(await start(index))
  const session = signedIn.cookies.find(cookie => cookie.name === browserCookie)!.value
  const confirmation = await finish(await start(index, `/auth/sso/${providers[index].id}/start?reauth=1`, session))
  expect(confirmation.statusCode).toBe(200)
  expect(fakes[index].authorizations.at(-1)).toMatchObject({ prompt: 'login', max_age: '0' })
  expect(readBrowserSession(db, session).reauthenticated_at).not.toBeNull()
})

test('a callback routed to another provider consumes state without exchanging the code', async () => {
  const transaction = await start(0)
  transaction.url.pathname = `/auth/sso/${providers[1].id}/callback`
  expect((await finish(transaction)).body).toContain('SSO_STATE_INVALID')
  transaction.url.pathname = `/auth/sso/${providers[0].id}/callback`
  expect((await finish(transaction)).body).toContain('SSO_STATE_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('an authorization response naming the other issuer is refused', async () => {
  const transaction = await start(0)
  transaction.url.searchParams.set('iss', providers[1].issuer)
  expect((await finish(transaction)).body).toContain('SSO_TOKEN_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test('an ID token naming the other issuer is refused even with a valid signature', async () => {
  fakes[0].token.claims = { iss: providers[1].issuer }
  expect((await finish(await start(0))).body).toContain('SSO_TOKEN_INVALID')
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 0 })
})

test.each(['redirect', 'issuer'] as const)('discovery rejects %s away from the configured issuer', async failure => {
  discoveryFailure = failure
  const response = await app.inject({ url: `/auth/sso/${providers[0].id}/start`, headers })
  expect(response.body).toContain('SSO_PROVIDER_ERROR')
  expect(response.cookies.some(cookie => cookie.name === 'artium-sso')).toBe(false)
})
