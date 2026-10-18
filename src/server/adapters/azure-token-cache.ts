import type { INetworkModule } from '@azure/msal-node'
import inventory from '../../../tools/inventories/az-axi.json' with { type: 'json' }
import { ArtiumError, errors } from '../../shared/errors.js'
import { safeDiagnostic } from '../health/diagnostic.js'
import { azureAudiences, azureCredentialSchema, mintAzureToken } from './azure-tokens.js'
import type { AzureCredential, AzureResource, AzureToken } from './azure-tokens.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'

export interface AzureTokenIdentity {
  id: string
  revision: number
  credential: AzureCredential
  trust?: readonly CredentialTrust[]
}

export interface AzureResourcePlan {
  required: readonly AzureResource[]
  optional: readonly AzureResource[]
}

// The adapter supplies the manifest route and parsed, canonical flag values.
export function azureCommandResources(command: string, flags: Readonly<Record<string, string>> = {}): AzureResourcePlan {
  const route = inventory.commands.find(route => route.command === command)
  if (!route || route.tokenResources === null) throw new ArtiumError('FLAG_BLOCKED')
  if (flags.help === 'true') return { required: [], optional: [] }
  if (flags['show-query'] === 'true' && ['exposure', 'defender assessments'].includes(route.handlerCommand)) {
    return { required: [], optional: [] }
  }
  if (route.handlerCommand === 'doctor') return { required: ['arm', 'logs'], optional: ['graph'] }
  if (route.handlerCommand === 'api') {
    const resource = flags.resource ?? 'arm'
    if (!['arm', 'logs', 'graph'].includes(resource)) throw new ArtiumError('FLAG_BLOCKED')
    return { required: [resource as AzureResource], optional: [] }
  }
  if (route.handlerCommand === 'rbac list') {
    const principal = flags.principal?.trim()
    const lookup = Boolean(principal && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(principal))
    if (flags['show-query'] === 'true') return { required: lookup ? ['graph'] : [], optional: [] }
    return { required: lookup ? ['arm', 'graph'] : ['arm'], optional: lookup ? [] : ['graph'] }
  }
  return { required: route.tokenResources as AzureResource[], optional: [] }
}

interface CacheEntry {
  token?: AzureToken
  pending?: Promise<AzureToken>
}

export class AzureTokenCache {
  private readonly identities = new Map<string, { revision: number, entries: Map<string, CacheEntry> }>()

  constructor(private readonly networkClient?: INetworkModule) {}

  // Replacement drops tokens and in-flight entries before the new revision can acquire.
  replace(id: string, revision: number): void {
    const current = this.identities.get(id)
    if (!current || revision > current.revision) this.identities.set(id, { revision, entries: new Map() })
  }

  async acquire(identity: AzureTokenIdentity, plan: AzureResourcePlan): Promise<Partial<Record<AzureResource, AzureToken>>> {
    const credential = azureCredentialSchema.safeParse(identity.credential)
    if (!credential.success) throw new ArtiumError('CREDENTIAL_INVALID')
    this.replace(identity.id, identity.revision)
    const current = this.identities.get(identity.id)!
    if (current.revision !== identity.revision) throw new ArtiumError('REVISION_CONFLICT')
    const required = new Set(plan.required)
    const resources = [...new Set([...plan.required, ...plan.optional])]
    if (resources.some(resource => !Object.hasOwn(azureAudiences, resource))) throw new ArtiumError('CREDENTIAL_INVALID')
    const tokens = await Promise.all(resources.map(async resource => {
      const key = JSON.stringify([identity.id, identity.revision, credential.data.tenantId, credential.data.clientId, resource, identity.trust ?? []])
      let entry = current.entries.get(key)
      if (!entry) { entry = {}; current.entries.set(key, entry) }
      try {
        if (!entry.token || entry.token.expiresAt - Date.now() < 300_000) {
          entry.pending ??= this.mint(credential.data, resource, identity.trust).then(token => {
            if (this.identities.get(identity.id) !== current) throw new ArtiumError('REVISION_CONFLICT')
            entry.token = token
            return token
          }).finally(() => { entry.pending = undefined })
          await entry.pending
        }
        return [resource, entry.token!] as const
      } catch (error) {
        if (required.has(resource)) throw error
        return undefined
      }
    }))
    if (this.identities.get(identity.id) !== current) throw new ArtiumError('REVISION_CONFLICT')
    return Object.fromEntries(tokens.filter(token => token !== undefined))
  }

  private async mint(credential: AzureCredential, resource: AzureResource, trust?: readonly CredentialTrust[]): Promise<AzureToken> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ArtiumError('UPSTREAM_NETWORK_FAILED')) }, 10_000)
    })
    const attempts = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.signal.aborted) throw new ArtiumError('UPSTREAM_NETWORK_FAILED')
        try {
          const token = await mintAzureToken(credential, resource, this.networkClient, controller.signal, trust)
          if (token.expiresAt <= Date.now()) throw new ArtiumError('UPSTREAM_AUTH_FAILED')
          return token
        } catch (error) {
          if (attempt === 2 || controller.signal.aborted || error instanceof ArtiumError && error.code !== 'UPSTREAM_NETWORK_FAILED') throw error
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
        }
      }
      throw new ArtiumError('UPSTREAM_NETWORK_FAILED')
    }
    try { return await Promise.race([attempts(), deadline]) }
    catch (error) {
      if (error instanceof ArtiumError) error.diagnostic = safeDiagnostic(error.diagnostic ?? {
        stage: 'token acquisition', host: 'login.microsoftonline.com', message: errors[error.code].message,
      }, [credential.auth === 'secret' ? credential.clientSecret : credential.privateKey])
      throw error
    }
    finally { clearTimeout(timer!) }
  }
}
