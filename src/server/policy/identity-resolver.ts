import { ArtiumError } from '../../shared/errors.js'
import type { CredentialReference, CredentialStore, ToolName } from '../store/credential-store.js'

export interface IdentityResolver {
  resolve(userId: string, tool: ToolName, instance?: string): Promise<CredentialReference>
  resolveForRun(userId: string, tool: ToolName, instance?: string): Promise<{ reference: CredentialReference, readOnly: boolean }>
}

export class SharedIdentityResolver implements IdentityResolver {
  constructor(private readonly store: Pick<CredentialStore, 'listInstances'>) {}

  async resolve(userId: string, tool: ToolName, instance?: string): Promise<CredentialReference> {
    return (await this.resolveForRun(userId, tool, instance)).reference
  }

  async resolveForRun(_userId: string, tool: ToolName, instance?: string): Promise<{ reference: CredentialReference, readOnly: boolean }> {
    const instances = this.store.listInstances(tool)
    if (instances.length === 0) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const selected = instance === undefined ? undefined : instances.find(candidate => candidate.name === instance)
    if (instance !== undefined && !selected) throw new ArtiumError('INSTANCE_NOT_FOUND')
    const usable = selected ? [selected] : instances.filter(candidate => candidate.enabled)
    if (usable.length > 1) throw new ArtiumError('INSTANCE_REQUIRED', undefined,
      `Ask the user which instance to use, then run artium-axi --instance <${usable.map(candidate => candidate.name).sort().join('|')}> ${tool} ...`)
    if (!usable[0]?.enabled) throw new ArtiumError('INSTANCE_DISABLED')
    return { reference: { id: usable[0].id, tool, revision: usable[0].revision }, readOnly: usable[0].readOnly }
  }
}
