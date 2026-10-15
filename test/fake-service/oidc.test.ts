import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ClientSecretBasic } from 'openid-client'
import { createFakeOidcProvider } from './oidc.js'

let provider: Awaited<ReturnType<typeof createFakeOidcProvider>>
let now: number
const client = generateKeyPairSync('rsa', { modulusLength: 2048 })
const clientId = 'synthetic-client'
const redirectUri = 'http://127.0.0.1/callback'
const verifier = 'CANARY-pkce-verifier-for-synthetic-client-00000000'

beforeEach(async () => {
  now = Date.UTC(2026, 0, 1)
  provider = await createFakeOidcProvider({ clientId, redirectUri, now: () => now,
    authentication: { kind: 'certificate', publicKey: client.publicKey },
    claims: { sub: 'synthetic-subject', tid: 'synthetic-tenant', oid: 'synthetic-object',
      preferred_username: 'synthetic-user', roles: ['Artium.Reader'] } })
})
afterEach(() => provider.close())

function assertion() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: clientId, sub: clientId, aud: provider.issuer + '/token',
    exp: now / 1000 + 60, jti: randomUUID() })).toString('base64url')
  const data = header + '.' + payload
  return data + '.' + sign('RSA-SHA256', Buffer.from(data), client.privateKey).toString('base64url')
}

async function authorize(overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid profile', state: 'CANARY-state', nonce: 'CANARY-nonce', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...overrides })
  return fetch(provider.issuer + '/authorize?' + query, { redirect: 'manual' })
}

async function code() {
  const response = await authorize()
  expect(response.status).toBe(302)
  const redirect = new URL(response.headers.get('location')!)
  expect(redirect.origin + redirect.pathname).toBe(redirectUri)
  expect(redirect.searchParams.get('state')).toBe('CANARY-state')
  return redirect.searchParams.get('code')!
}

function exchange(code: string, overrides: Record<string, string> = {}) {
  return fetch(provider.issuer + '/token', { method: 'POST', body: new URLSearchParams({ client_id: clientId,
    redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion(), ...overrides }) })
}

test('local discovery and JWKS verify a certificate-authenticated PKCE ID token', async () => {
  const metadata = await (await fetch(provider.issuer + '/.well-known/openid-configuration')).json()
  expect(metadata).toMatchObject({ issuer: provider.issuer, token_endpoint: provider.issuer + '/token',
    authorization_endpoint: provider.issuer + '/authorize', code_challenge_methods_supported: ['S256'] })
  const response = await exchange(await code())
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const { id_token } = await response.json()
  const [header, payload, signature] = id_token.split('.')
  const { keys } = await (await fetch(metadata.jwks_uri)).json()
  const kid = JSON.parse(Buffer.from(header, 'base64url').toString()).kid
  const key = createPublicKey({ key: keys.find((key: { kid: string }) => key.kid === kid), format: 'jwk' })
  expect(verify('RSA-SHA256', Buffer.from(header + '.' + payload), key, Buffer.from(signature, 'base64url'))).toBe(true)
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: provider.issuer, aud: clientId,
    sub: 'synthetic-subject', tid: 'synthetic-tenant', oid: 'synthetic-object', preferred_username: 'synthetic-user',
    roles: ['Artium.Reader'], nonce: 'CANARY-nonce', iat: now / 1000, exp: now / 1000 + 300 })
})

test('authorization codes are single use', async () => {
  const issued = await code()
  expect((await exchange(issued)).status).toBe(200)
  const response = await exchange(issued)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid_grant' })
})

test('authorization codes expire after one minute', async () => {
  const issued = await code()
  now += 60_000
  const response = await exchange(issued)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid_grant' })
})

test('token exchange requires the original PKCE verifier', async () => {
  const response = await exchange(await code(), { code_verifier: 'CANARY-wrong-verifier' })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'invalid_grant' })
})

test('token exchange refuses an unsigned client assertion', async () => {
  const response = await exchange(await code(), { client_assertion: 'CANARY-invalid-assertion' })
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'invalid_client' })
})

test('certificate client assertions cannot be replayed', async () => {
  const credential = assertion()
  expect((await exchange(await code(), { client_assertion: credential })).status).toBe(200)
  const response = await exchange(await code(), { client_assertion: credential })
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'invalid_client' })
})

test.each([
  ['redirect_uri', 'https://other.example/callback'],
  ['client_id', 'other-client'],
  ['code_challenge_method', 'plain'],
])('authorize rejects invalid %s', async (field, value) => {
  const response = await authorize({ [field]: value })
  expect(response.status).toBe(400)
  expect(response.headers.get('location')).toBeNull()
})

test('a secret-configured provider accepts only its configured secret', async () => {
  await provider.close()
  provider = await createFakeOidcProvider({ clientId, redirectUri, claims: { sub: 'synthetic-subject' },
    authentication: { kind: 'secret', secret: 'CANARY-client-secret' } })
  const issued = await code()
  const rejected = await exchange(issued, { client_secret: 'CANARY-wrong-secret' })
  expect(rejected.status).toBe(401)
  expect((await exchange(issued, { client_secret: 'CANARY-client-secret' })).status).toBe(200)
})

test('Basic authentication decodes form-encoded credentials without requiring body credentials', async () => {
  await provider.close()
  const secret = 'CANARY-basic+/:= secret'
  provider = await createFakeOidcProvider({ clientId, redirectUri, claims: { sub: 'synthetic-subject' },
    authentication: { kind: 'secret', secret, method: 'client_secret_basic' } })
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: await code(),
    redirect_uri: redirectUri, code_verifier: verifier })
  const headers = new Headers()
  ClientSecretBasic(secret)({ issuer: provider.issuer }, { client_id: clientId }, body, headers)
  const response = await fetch(provider.issuer + '/token', { method: 'POST', body, headers })
  expect(response.status).toBe(200)
})
