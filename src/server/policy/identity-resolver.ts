import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import { delegatedInstanceIds } from '../auth/delegations.js'
import { isAwxOriginOnly, type CredentialInstance, type CredentialReference, type CredentialStore, type ToolName } from '../store/credential-store.js'
import { instanceGranted } from './policy.js'

type Delegation = { scopeJson: string } | null

export interface IdentityResolver {
  hasInstances(tool: ToolName): boolean
  usableInstances(userId: string, tool: ToolName, delegation?: Delegation, command?: string): CredentialInstance[]
  resolve(userId: string, tool: ToolName, instance?: string, delegation?: Delegation, command?: string): Promise<CredentialReference>
  resolveForRun(userId: string, tool: ToolName, instance?: string, delegation?: Delegation, command?: string): Promise<{ reference: CredentialReference, readOnly: boolean }>
}

export class SharedIdentityResolver implements IdentityResolver {
  constructor(private readonly store: Pick<CredentialStore, 'listInstances' | 'readCredential'>, private readonly grants: Database.Database) {}

  hasInstances(tool: ToolName): boolean { return this.store.listInstances(tool).length > 0 }

  async resolve(userId: string, tool: ToolName, instance?: string, delegation?: Delegation, command?: string): Promise<CredentialReference> {
    return (await this.resolveForRun(userId, tool, instance, delegation, command)).reference
  }

  private reachable(userId: string, tool: ToolName, delegation?: Delegation, command?: string): CredentialInstance[] {
    const scoped = delegatedInstanceIds(delegation, tool, command)
    return this.store.listInstances(tool).filter(candidate => (!scoped || scoped.has(candidate.id)) &&
      instanceGranted(this.grants, userId, tool, candidate.id))
  }

  usableInstances(userId: string, tool: ToolName, delegation?: Delegation, command?: string): CredentialInstance[] {
    return this.reachable(userId, tool, delegation, command).filter(candidate => candidate.enabled &&
      !(tool === 'awx-axi' && isAwxOriginOnly(tool, this.store.readCredential(candidate))))
  }

  async resolveForRun(userId: string, tool: ToolName, instance?: string, delegation?: Delegation, command?: string): Promise<{ reference: CredentialReference, readOnly: boolean }> {
    const instances = this.reachable(userId, tool, delegation, command)
    const selected = instance === undefined ? undefined : instances.find(candidate => candidate.name === instance)
    if (instance !== undefined && !selected) throw new ArtiumError('INSTANCE_NOT_FOUND')
    if (instances.length === 0) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const usable = selected ? [selected] : this.usableInstances(userId, tool, delegation, command)
    if (usable.length > 1) throw new ArtiumError('INSTANCE_REQUIRED', undefined,
      `Ask the user which instance to use, then run artium-axi --instance <${usable.map(candidate => candidate.name).sort().join('|')}> ${tool} ...`)
    if (!usable.length && instances.some(candidate => candidate.enabled)) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    if (!usable[0]?.enabled) throw new ArtiumError('INSTANCE_DISABLED')
    if (tool === 'awx-axi' && isAwxOriginOnly(tool, this.store.readCredential(usable[0]))) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return { reference: { id: usable[0].id, tool, revision: usable[0].revision }, readOnly: usable[0].readOnly }
  }
}
