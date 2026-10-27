import { createPrivateKey, sign } from 'node:crypto'
import { ArtiumError } from '../../shared/errors.js'
import { credentialFetch } from '../credential-tls.js'
import type { CredentialReference } from '../store/credential-store.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { toolEndpoints } from '../tool-endpoints.js'

interface InstallationToken { token: string, expiresAt: number }
interface Entry { token?: InstallationToken, pending?: Promise<InstallationToken> }

// One shared deployment identity. Nothing is persisted beyond the encrypted App key.
export class GithubAppTokenCache {
  private readonly identities = new Map<string, { revision: number, entries: Map<string, Entry> }>()

  constructor(private readonly request: typeof credentialFetch = credentialFetch) {}

  replace(id: string, revision: number): void {
    const current = this.identities.get(id)
    if (!current || revision > current.revision) this.identities.set(id, { revision, entries: new Map() })
  }

  // Credential shape is validated by the adapter before acquisition.
  async acquire(reference: CredentialReference, credential: Record<string, unknown>, trust: readonly CredentialTrust[] = []): Promise<string> {
    const revision = reference.revision ?? 0
    this.replace(reference.id, revision)
    const current = this.identities.get(reference.id)!
    if (current.revision !== revision) throw new ArtiumError('REVISION_CONFLICT')
    const key = JSON.stringify([credential.origin, credential.appId, credential.installationId,
      credential.repositories, credential.permissions, trust])
    let entry = current.entries.get(key)
    if (!entry) { entry = {}; current.entries.set(key, entry) }
    if (!entry.token || entry.token.expiresAt - Date.now() <= 300_000) {
      entry.pending ??= this.mint(credential, trust).then(token => {
        if (this.identities.get(reference.id) !== current) throw new ArtiumError('REVISION_CONFLICT')
        entry.token = token
        return token
      }).finally(() => { entry.pending = undefined })
      await entry.pending
    }
    if (this.identities.get(reference.id) !== current) throw new ArtiumError('REVISION_CONFLICT')
    return entry.token!.token
  }

  private async mint(credential: Record<string, unknown>, trust: readonly CredentialTrust[]): Promise<InstallationToken> {
    const now = Date.now()
    let jwt: string
    try {
      const key = createPrivateKey(credential.privateKey as string)
      if (key.asymmetricKeyType !== 'rsa') throw new Error('RSA required')
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
      const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
        iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: credential.appId,
      })}`
      jwt = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`
    } catch { throw new ArtiumError('CREDENTIAL_INVALID') }
    try {
      const api = toolEndpoints('gh-axi', credential)[1]
      const response = await this.request(`${api.origin}${api.pathname.replace(/\/$/, '')}/app/installations/${credential.installationId}/access_tokens`, {
        method: 'POST', headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'User-Agent': 'artium-axi', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ ...(credential.repositories ? { repositories: credential.repositories } : {}),
          ...(credential.permissions ? { permissions: credential.permissions } : {}) }),
        signal: AbortSignal.timeout(10_000),
      }, trust)
      if (!response.ok) throw new ArtiumError([401, 403, 404, 422].includes(response.status) ? 'UPSTREAM_AUTH_FAILED' : 'UPSTREAM_NETWORK_FAILED')
      const result = await response.json() as { token?: unknown, expires_at?: unknown }
      const expiresAt = typeof result.expires_at === 'string' ? Date.parse(result.expires_at) : NaN
      if (typeof result.token !== 'string' || !result.token || /\s/.test(result.token) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new ArtiumError('UPSTREAM_AUTH_FAILED')
      }
      return { token: result.token, expiresAt: Math.min(expiresAt, now + 3_600_000) }
    } catch (error) {
      // Neither provider bodies nor transport errors may expose the JWT or key.
      if (error instanceof ArtiumError) throw error
      throw new ArtiumError('UPSTREAM_NETWORK_FAILED')
    }
  }
}
