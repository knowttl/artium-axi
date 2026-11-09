import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import type { CredentialInstance, CredentialReference, CredentialStore, ToolName } from '../store/credential-store.js'
import { instanceGranted } from './policy.js'

export interface IdentityResolver {
  hasInstances(tool: ToolName): boolean
  usableInstances(userId: string, tool: ToolName): CredentialInstance[]
  resolve(userId: string, tool: ToolName, instance?: string): Promise<CredentialReference>
  resolveForRun(userId: string, tool: ToolName, instance?: string): Promise<{ reference: CredentialReference, readOnly: boolean }>
}

export class SharedIdentityResolver implements IdentityResolver {
  constructor(private readonly store: Pick<CredentialStore, 'listInstances'>, private readonly grants?: Database.Database) {}

  hasInstances(tool: ToolName): boolean { return this.store.listInstances(tool).length > 0 }

  async resolve(userId: string, tool: ToolName, instance?: string): Promise<CredentialReference> {
    return (await this.resolveForRun(userId, tool, instance)).reference
  }

  usableInstances(userId: string, tool: ToolName): CredentialInstance[] {
    return this.store.listInstances(tool).filter(candidate => candidate.enabled &&
      (!this.grants || instanceGranted(this.grants, userId, tool, candidate.id)))
  }

  async resolveForRun(userId: string, tool: ToolName, instance?: string): Promise<{ reference: CredentialReference, readOnly: boolean }> {
    const instances = this.store.listInstances(tool)
      .filter(candidate => !this.grants || instanceGranted(this.grants, userId, tool, candidate.id))
    const selected = instance === undefined ? undefined : instances.find(candidate => candidate.name === instance)
    if (instance !== undefined && !selected) throw new ArtiumError('INSTANCE_NOT_FOUND')
    if (instances.length === 0) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const usable = selected ? [selected] : this.usableInstances(userId, tool)
    if (usable.length > 1) throw new ArtiumError('INSTANCE_REQUIRED', undefined,
      `Ask the user which instance to use, then run artium-axi --instance <${usable.map(candidate => candidate.name).sort().join('|')}> ${tool} ...`)
    if (!usable[0]?.enabled) throw new ArtiumError('INSTANCE_DISABLED')
    return { reference: { id: usable[0].id, tool, revision: usable[0].revision }, readOnly: usable[0].readOnly }
  }
}
