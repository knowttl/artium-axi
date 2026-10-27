import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { GithubDeviceFlow, githubClientId, githubScopes } from './github-device.js'
import { createGhAdapter, ghProfile } from './gh.js'
import { hostedGhOutput } from './gh-output.js'
import { withFakeService } from '../../../test/fake-service/fixture.js'
import type { credentialFetch } from '../credential-tls.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'

const input = { origin: 'https://github.example', expectedRevision: 0, expectedToolRevision: 1 }
const code = { device_code: 'CANARY-device-code', user_code: 'ABCD-EFGH', verification_uri: input.origin + '/login/device', expires_in: 900, interval: 5 }
const token = 'gho_CANARY-device-token'
const json = (body: unknown) => new Response(JSON.stringify(body))
const device = { origin: input.origin, auth: 'device', accessToken: token, login: 'synthetic-machine' }
const reference = { id: 'synthetic-device', tool: 'gh-axi' as const, revision: 1 }
afterEach(() => vi.useRealTimers())

test('requests full scopes using the fixed public client ID and keeps the device code private', async () => {
  const request = vi.fn<typeof credentialFetch>(async () => json(code))
  const flow = new GithubDeviceFlow(request)
  const result = await flow.start('synthetic-admin', input, [])
  expect(result).toMatchObject({ userCode: code.user_code, verificationUri: code.verification_uri, interval: 5 })
  expect(JSON.stringify(result)).not.toContain(code.device_code)
  expect(request.mock.calls[0][0]).toBe(input.origin + '/login/device/code')
  expect(new URLSearchParams(request.mock.calls[0][1].body)).toEqual(new URLSearchParams({ client_id: githubClientId, scope: githubScopes }))
})

test('enforces interval, slow_down, actor binding and single-flight polls before returning a token', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const request = vi.fn().mockResolvedValueOnce(json(code)).mockResolvedValueOnce(json({ error: 'authorization_pending' }))
    .mockResolvedValueOnce(json({ error: 'slow_down' })).mockResolvedValueOnce(json({ access_token: token, token_type: 'bearer' }))
    .mockResolvedValueOnce(json({ login: device.login }))
  const flow = new GithubDeviceFlow(request)
  const { connectionId } = await flow.start('synthetic-admin', input, [])
  await expect(flow.poll('other-admin', connectionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(await flow.poll('synthetic-admin', connectionId)).toEqual({ status: 'pending', interval: 5 })
  expect(request).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 5000)
  expect(await Promise.all([flow.poll('synthetic-admin', connectionId), flow.poll('synthetic-admin', connectionId)]))
    .toEqual([{ status: 'pending', interval: 5 }, { status: 'pending', interval: 5 }])
  vi.setSystemTime(Date.now() + 5000)
  expect(await flow.poll('synthetic-admin', connectionId)).toEqual({ status: 'pending', interval: 10 })
  vi.setSystemTime(Date.now() + 10_000)
  expect(await flow.poll('synthetic-admin', connectionId)).toEqual({ status: 'connected', value: device })
  expect(request.mock.calls.at(-1)![0]).toBe(input.origin + '/api/v3/user')
  expect(request.mock.calls.at(-1)![1].headers.Authorization).toBe(`Bearer ${token}`)
  await expect(flow.poll('synthetic-admin', connectionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test.each(['access_denied', 'expired_token', 'device_flow_disabled'])('stops on %s without reflecting provider secrets', async error => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const flow = new GithubDeviceFlow(vi.fn().mockResolvedValueOnce(json(code)).mockResolvedValueOnce(json({ error, error_description: token })))
  const { connectionId } = await flow.start('synthetic-admin', input, [])
  vi.setSystemTime(Date.now() + 5000)
  await expect(flow.poll('synthetic-admin', connectionId)).rejects.toMatchObject({ code: error === 'expired_token' ? 'CREDENTIAL_EXPIRED' : 'UPSTREAM_AUTH_FAILED' })
  await expect(flow.poll('synthetic-admin', connectionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('cancellation and expiry discard pending codes without contacting the provider', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const request = vi.fn(async () => json(code))
  const flow = new GithubDeviceFlow(request)
  const first = await flow.start('synthetic-admin', input, [])
  flow.cancel('synthetic-admin', first.connectionId)
  await expect(flow.poll('synthetic-admin', first.connectionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  const second = await flow.start('synthetic-admin', input, [])
  vi.setSystemTime(Date.now() + 900_000)
  await expect(flow.poll('synthetic-admin', second.connectionId)).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' })
  expect(request).toHaveBeenCalledTimes(2)
})

test('an obsolete in-flight poll cannot cancel the replacement connection', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  let release!: (response: Response) => void
  const request = vi.fn().mockResolvedValueOnce(json(code))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve }))
    .mockResolvedValueOnce(json(code))
  const flow = new GithubDeviceFlow(request)
  const first = await flow.start('synthetic-admin', input, [])
  vi.setSystemTime(Date.now() + 5000)
  const pending = flow.poll('synthetic-admin', first.connectionId)
  const second = await flow.start('synthetic-admin', input, [])
  release(json({ error: 'access_denied' }))
  await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(await flow.poll('synthetic-admin', second.connectionId)).toEqual({ status: 'pending', interval: 5 })
})

test.each([{}, { ...code, verification_uri: 'https://other.example/login/device' }, { error: 'device_flow_disabled', error_description: token }])(
  'rejects invalid device responses and foreign verification URLs', async response => {
    await expect(new GithubDeviceFlow(async () => json(response)).start('synthetic-admin', input, []))
      .rejects.toMatchObject({ code: 'UPSTREAM_AUTH_FAILED' })
  })

test.each(['https://github.com', 'https://synthetic.ghe.com', input.origin])('injects the device token privately for %s', async origin => {
  const value = { ...device, origin }
  const prepared = await createGhAdapter({ getCredential: async () => value }).prepare(['api', '/rate_limit'], reference)
  expect(prepared.environment[origin === input.origin ? 'GH_ENTERPRISE_TOKEN' : 'GH_TOKEN']).toBe(token)
  expect(prepared.secrets).toEqual([token])
  expect(JSON.stringify([prepared.args, prepared.files, ghProfile.metadata(value)])).not.toContain(token)
})

test('refuses expired credentials without refreshing or starting a tool', async () => {
  await expect(createGhAdapter({ getCredential: async () => ({ ...device, accessTokenExpiresAt: Date.now() - 1 }) })
    .prepare(['api', '/rate_limit'], reference)).rejects.toMatchObject({ code: 'CREDENTIAL_EXPIRED' })
})

test.each(['code: AUTH_REQUIRED\nerror: Login required', 'code: UNKNOWN\nerror: Bad credentials (HTTP 401)'])(
  'maps revoked device tokens to reconnect errors', stdout => {
    expect(() => hostedGhOutput({ command: 'api', help: false, credentialAuth: 'device' }, { stdout, stderr: '', exitCode: 1,
      timedOut: false, durationMs: 1, outputBytes: { stdout: stdout.length, stderr: 0 }, truncated: { stdout: false, stderr: false } }))
      .toThrow(expect.objectContaining({ code: 'CREDENTIAL_EXPIRED' }))
  })

test('connects through loopback TLS fakes, honours slow_down and records optional expiry without refresh', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  await withFakeService(async ({ directory, port, send }) => {
    await send('/__github/device?scenario=expiring')
    const origin = `https://localhost:${port}`
    const trust: CredentialTrust[] = [{ endpoint: origin, pem: readFileSync(join(directory, 'ca.crt'), 'utf8'),
      fingerprint: 'synthetic', leafFingerprint: 'synthetic', mode: 'ca' }]
    const flow = new GithubDeviceFlow()
    const { connectionId } = await flow.start('synthetic-admin', { ...input, origin }, trust)
    vi.setSystemTime(Date.now() + 5000)
    expect(await flow.poll('synthetic-admin', connectionId)).toEqual({ status: 'pending', interval: 5 })
    vi.setSystemTime(Date.now() + 5000)
    expect(await flow.poll('synthetic-admin', connectionId)).toEqual({ status: 'pending', interval: 10 })
    vi.setSystemTime(Date.now() + 10_000)
    expect(await flow.poll('synthetic-admin', connectionId)).toEqual({ status: 'connected',
      value: { ...device, origin, accessTokenExpiresAt: Date.now() + 3_600_000 } })
    const evidence = JSON.parse(await send('/__evidence'))
    expect(evidence.requests).toEqual([
      { method: 'POST', path: '/login/device/code', validClient: true, scope: githubScopes },
      { method: 'POST', path: '/login/oauth/access_token', validClient: true, validGrant: true },
      { method: 'POST', path: '/login/oauth/access_token', validClient: true, validGrant: true },
      { method: 'POST', path: '/login/oauth/access_token', validClient: true, validGrant: true },
      { method: 'GET', path: '/api/v3/user', canaryReceived: true },
    ])
  })
})
