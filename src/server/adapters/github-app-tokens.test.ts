import { generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { GithubAppTokenCache } from './github-app-tokens.js'
import { createGhAdapter, ghCredentialSchema, ghProfile } from './gh.js'
import { withFakeService } from '../../../test/fake-service/fixture.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import type { credentialFetch } from '../credential-tls.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const reference = { id: 'synthetic-app', tool: 'gh-axi' as const, revision: 1 }
const credential = { origin: 'https://github.com', auth: 'github-app', appId: '123', installationId: '456', privateKey: pem }
const token = 'CANARY-installation-token'
const response = (expires = Date.now() + 3_600_000) => new Response(JSON.stringify({ token, expires_at: new Date(expires).toISOString() }), { status: 201 })
afterEach(() => vi.useRealTimers())

test.each([
  ['https://github.com', 'https://api.github.com/app/installations/456/access_tokens', 'GH_TOKEN'],
  ['https://synthetic.ghe.com', 'https://api.synthetic.ghe.com/app/installations/456/access_tokens', 'GH_TOKEN'],
  ['https://github.example:8443', 'https://github.example:8443/api/v3/app/installations/456/access_tokens', 'GH_ENTERPRISE_TOKEN'],
])('signs and privately injects installation tokens for %s', async (origin, endpoint, variable) => {
  const request = vi.fn<typeof credentialFetch>(async () => response())
  const adapter = createGhAdapter({ getCredential: async () => ({ ...credential, origin }) }, new GithubAppTokenCache(request))
  const call = await adapter.prepare(['api', '/rate_limit'], reference)
  expect(request.mock.calls[0][0]).toBe(endpoint)
  const init = request.mock.calls[0][1]
  const jwt = init.headers!.Authorization.slice(7).split('.')
  expect(JSON.parse(Buffer.from(jwt[0], 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
  const claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString())
  expect(claims).toMatchObject({ iss: '123', iat: expect.any(Number), exp: expect.any(Number) })
  expect(claims.exp - claims.iat).toBe(600)
  expect(claims.iat).toBeLessThanOrEqual(Date.now() / 1000 - 59)
  expect(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), publicKey, Buffer.from(jwt[2], 'base64url'))).toBe(true)
  expect(init.body).toBe('{}')
  expect(call.environment[variable]).toBe(token)
  expect(call.secrets).toEqual([token, pem])
  expect(JSON.stringify([call.args, call.files, call.invocation])).not.toContain(token)
  expect(JSON.stringify(call.environment)).not.toContain('PRIVATE KEY')
})

test('shares concurrent acquisition and renews five minutes before expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const request = vi.fn(async () => response())
  const cache = new GithubAppTokenCache(request)
  expect(await Promise.all([cache.acquire(reference, credential), cache.acquire(reference, credential)])).toEqual([token, token])
  vi.setSystemTime(Date.now() + 3_299_999)
  await cache.acquire(reference, credential)
  expect(request).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 1)
  await cache.acquire(reference, credential)
  expect(request).toHaveBeenCalledTimes(2)
})

test('honours shorter provider expiry and caps longer expiry at one hour', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const request = vi.fn().mockImplementationOnce(async () => response(Date.now() + 600_000))
    .mockImplementation(async () => response(Date.now() + 7_200_000))
  const cache = new GithubAppTokenCache(request)
  await cache.acquire(reference, credential)
  vi.setSystemTime(Date.now() + 300_000)
  await cache.acquire(reference, credential)
  vi.setSystemTime(Date.now() + 3_300_000)
  await cache.acquire(reference, credential)
  expect(request).toHaveBeenCalledTimes(3)
})

test('passes only administrator narrowing fields and isolates cache entries', async () => {
  const request = vi.fn<typeof credentialFetch>(async () => response())
  const cache = new GithubAppTokenCache(request)
  await cache.acquire(reference, { ...credential, repositories: ['canary'], permissions: { contents: 'read' } })
  await cache.acquire(reference, { ...credential, repositories: ['other'], permissions: { contents: 'read' } })
  expect(request.mock.calls.map(call => JSON.parse(call[1].body!))).toEqual([
    { repositories: ['canary'], permissions: { contents: 'read' } },
    { repositories: ['other'], permissions: { contents: 'read' } },
  ])
})

test('rotation rejects an in-flight old revision and mints for the new revision', async () => {
  let release!: (value: Response) => void
  let started!: () => void
  const acquisition = new Promise<void>(resolve => { started = resolve })
  const request = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; started() }))
    .mockImplementation(async () => response())
  const cache = new GithubAppTokenCache(request)
  const adapter = createGhAdapter({ getCredential: async () => credential }, cache)
  const pending = adapter.prepare(['api', '/rate_limit'], reference)
  await acquisition
  const next = { ...reference, revision: 2 }
  adapter.invalidateCredential!(next)
  release(response())
  await expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await adapter.prepare(['api', '/rate_limit'], next)
  await expect(cache.acquire(reference, credential)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(request).toHaveBeenCalledTimes(2)
})

test.each([401, 403, 404, 422, 302, 429, 500])('sanitizes provider failure %s and does not cache it', async status => {
  const request = vi.fn(async () => new Response(pem, { status }))
  const cache = new GithubAppTokenCache(request)
  await expect(cache.acquire(reference, credential)).rejects.toMatchObject({ code: [401, 403, 404, 422].includes(status) ? 'UPSTREAM_AUTH_FAILED' : 'UPSTREAM_NETWORK_FAILED' })
  expect(request).toHaveBeenCalledTimes(1)
  request.mockImplementation(async () => response())
  expect(await cache.acquire(reference, credential)).toBe(token)
})

test.each([{}, { token, expires_at: 'invalid' }, { token, expires_at: '2000-01-01T00:00:00Z' },
  { token: '', expires_at: '2099-01-01T00:00:00Z' }])('refuses malformed or expired token response %j', async body => {
  const cache = new GithubAppTokenCache(async () => new Response(JSON.stringify(body)))
  await expect(cache.acquire(reference, credential)).rejects.toMatchObject({ code: 'UPSTREAM_AUTH_FAILED' })
})

test('sanitizes transport errors and rejects invalid keys before sending', async () => {
  const request = vi.fn(async () => { throw new Error(pem) })
  const cache = new GithubAppTokenCache(request)
  await expect(cache.acquire(reference, credential)).rejects.toMatchObject({ code: 'UPSTREAM_NETWORK_FAILED' })
  await expect(cache.acquire({ ...reference, revision: 2 }, { ...credential, privateKey: 'CANARY-invalid-key' }))
    .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
  expect(request).toHaveBeenCalledTimes(1)
})

test('App profile rejects mixed methods and keeps the key out of metadata', () => {
  expect(ghCredentialSchema.safeParse(credential).success).toBe(true)
  expect(ghProfile.metadata(credential)).toEqual({ origin: credential.origin, auth: 'github-app', appId: '123', installationId: '456' })
  expect(ghCredentialSchema.safeParse({ ...credential, token }).success).toBe(false)
  expect(ghCredentialSchema.safeParse({ ...credential, appId: '../app' }).success).toBe(false)
  expect(ghCredentialSchema.safeParse({ ...credential, repositories: [] }).success).toBe(false)
})

test('mints against the loopback TLS fake with credential-scoped CA trust', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const origin = `https://localhost:${port}`
    const trust: CredentialTrust[] = [{ endpoint: origin, pem: readFileSync(join(directory, 'ca.crt'), 'utf8'),
      fingerprint: 'synthetic', leafFingerprint: 'synthetic', mode: 'ca' }]
    const value = { ...credential, origin, privateKey: readFileSync(join(directory, 'server.key'), 'utf8'),
      repositories: ['canary'], permissions: { contents: 'read' } }
    const adapter = createGhAdapter({ getCredential: async () => value, getTrust: () => trust })
    const call = await adapter.prepare(['api', '/rate_limit'], reference)
    expect(call.environment.GH_ENTERPRISE_TOKEN).toBe('CANARY-github-installation')
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.requests).toEqual([{ method: 'POST', path: '/api/v3/app/installations/456/access_tokens', signed: true,
      narrowing: { repositories: ['canary'], permissions: { contents: 'read' } } }])
    await expect(createGhAdapter({ getCredential: async () => value }).prepare(['api', '/rate_limit'], reference))
      .rejects.toMatchObject({ code: 'UPSTREAM_NETWORK_FAILED' })
  })
})
