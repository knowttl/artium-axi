import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import { credentialFetch } from '../credential-tls.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { toolEndpoints } from '../tool-endpoints.js'

export const githubClientId = '178c6fc778ccc68e1d6a'
export const githubScopes = 'repo read:org gist workflow project'
const seconds = z.number().int().positive().max(86400)
const deviceResponse = z.object({ device_code: z.string().min(1), user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.string(), expires_in: seconds, interval: seconds.default(5) })
const tokenResponse = z.object({ access_token: z.string().min(1).regex(/^\S+$/), token_type: z.literal('bearer'),
  expires_in: z.number().int().positive().optional() })
interface Connection {
  id: string, actor: string, origin: string, deviceCode: string, expiresAt: number, interval: number, nextAt: number,
  expectedRevision: number, expectedToolRevision: number, trust: readonly CredentialTrust[], busy: boolean
}

// Pending codes live only in this process. Reconnect after a restart; no refresh token is retained.
export class GithubDeviceFlow {
  private connection?: Connection
  private generation = 0
  constructor(private readonly request: typeof credentialFetch = credentialFetch) {}

  private async json(url: string, init: Parameters<typeof credentialFetch>[1], trust: readonly CredentialTrust[]) {
    try {
      const response = await this.request(url, { ...init, signal: AbortSignal.timeout(10_000) }, trust)
      if (!response.ok) throw new Error('Provider refused request')
      return await response.json() as Record<string, unknown>
    } catch { throw new ArtiumError('UPSTREAM_AUTH_FAILED', 'GitHub connection could not complete.',
      'Try connecting again, or use a personal access token or GitHub App. Check the origin, network and CA trust for Enterprise Server.') }
  }

  private post(origin: string, path: string, fields: Record<string, string>, trust: readonly CredentialTrust[]) {
    return this.json(origin + path, { method: 'POST', headers: { Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: githubClientId, ...fields }).toString() }, trust)
  }

  async start(actor: string, input: { origin: string, expectedRevision: number, expectedToolRevision: number }, trust: readonly CredentialTrust[]) {
    // Starting another connection cancels the previous pending connection for this deployment.
    const generation = ++this.generation
    this.connection = undefined
    const parsed = deviceResponse.safeParse(await this.post(input.origin, '/login/device/code', { scope: githubScopes }, trust))
    if (generation !== this.generation) throw new ArtiumError('REVISION_CONFLICT')
    if (!parsed.success || parsed.data.verification_uri !== input.origin + '/login/device') {
      throw new ArtiumError('UPSTREAM_AUTH_FAILED', 'GitHub device flow is unavailable for this origin.',
        'Use a personal access token or GitHub App, or check that GitHub CLI device flow is enabled on this host.')
    }
    const now = Date.now()
    const data = parsed.data
    const connection: Connection = { ...input, actor, id: randomUUID(), deviceCode: data.device_code,
      expiresAt: now + Math.min(data.expires_in, 900) * 1000, interval: data.interval, nextAt: now + data.interval * 1000, trust, busy: false }
    this.connection = connection
    return { connectionId: connection.id, userCode: data.user_code, verificationUri: data.verification_uri,
      expiresAt: connection.expiresAt, interval: connection.interval }
  }

  cancel(actor: string, id: string): void {
    this.current(actor, id)
    this.connection = undefined
  }

  current(actor: string, id: string): Connection {
    const connection = this.connection
    if (!connection || connection.actor !== actor || connection.id !== id) throw new ArtiumError('NOT_FOUND')
    if (connection.expiresAt <= Date.now()) {
      this.connection = undefined
      throw new ArtiumError('CREDENTIAL_EXPIRED', 'The GitHub connection code expired.', 'Start Connect with GitHub again.')
    }
    return connection
  }

  async poll(actor: string, id: string) {
    const connection = this.current(actor, id)
    const pending = () => ({ status: 'pending' as const, interval: Math.max(1, Math.ceil((connection.nextAt - Date.now()) / 1000)) })
    if (connection.busy || connection.nextAt > Date.now()) return pending()
    connection.busy = true
    connection.nextAt = Date.now() + connection.interval * 1000
    try {
      const body = await this.post(connection.origin, '/login/oauth/access_token', {
        device_code: connection.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, connection.trust)
      if (this.current(actor, id) !== connection) throw new ArtiumError('REVISION_CONFLICT')
      if (body.error === 'authorization_pending') return pending()
      if (body.error === 'slow_down') {
        connection.interval += 5
        connection.nextAt = Date.now() + connection.interval * 1000
        return pending()
      }
      if (body.error) {
        this.connection = undefined
        if (body.error === 'expired_token') throw new ArtiumError('CREDENTIAL_EXPIRED', 'The GitHub connection code expired.', 'Start Connect with GitHub again.')
        throw new ArtiumError('UPSTREAM_AUTH_FAILED', 'GitHub authorization was denied or device flow is unavailable.',
          'Start a new connection, or use a personal access token or GitHub App.')
      }
      const token = tokenResponse.safeParse(body)
      if (!token.success) throw new ArtiumError('UPSTREAM_AUTH_FAILED')
      const acquiredAt = Date.now()
      const api = toolEndpoints('gh-axi', { origin: connection.origin })[1].href.replace(/\/$/, '')
      const identity = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/).max(100) }).safeParse(await this.json(api + '/user', {
        method: 'GET', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.data.access_token}`,
          'User-Agent': 'artium-axi' } }, connection.trust))
      if (!identity.success) throw new ArtiumError('UPSTREAM_AUTH_FAILED')
      if (this.current(actor, id) !== connection) throw new ArtiumError('REVISION_CONFLICT')
      this.connection = undefined
      return { status: 'connected' as const, value: { origin: connection.origin, auth: 'device',
        accessToken: token.data.access_token, login: identity.data.login,
        ...(token.data.expires_in === undefined ? {} : { accessTokenExpiresAt: acquiredAt + token.data.expires_in * 1000 }) } }
    } finally { connection.busy = false }
  }
}
