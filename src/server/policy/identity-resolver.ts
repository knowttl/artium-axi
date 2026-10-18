import { ArtiumError } from '../../shared/errors.js'
import type { CredentialReference, CredentialStore, ToolName } from '../store/credential-store.js'

export interface IdentityResolver {
  resolve(userId: string, tool: ToolName): Promise<CredentialReference>
}

export class SharedIdentityResolver implements IdentityResolver {
  constructor(private readonly store: Pick<CredentialStore, 'findCredential'>) {}

  async resolve(_userId: string, tool: ToolName): Promise<CredentialReference> {
    const reference = this.store.findCredential(tool)
    if (!reference) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return reference
  }
}
