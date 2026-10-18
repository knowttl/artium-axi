import { ArtiumError } from '../../shared/errors.js'
import type { CredentialReference, CredentialStore } from './credential-store.js'
import type { CredentialTrust } from './trusted-certificates.js'

export interface SecretSource {
  getCredential(reference: CredentialReference): Promise<unknown>
  getSettings?(reference: CredentialReference): Record<string, unknown>
  getTrust?(reference: CredentialReference): readonly CredentialTrust[]
}

export class EmbeddedSecretSource implements SecretSource {
  constructor(private readonly store: Pick<CredentialStore, 'readCredential' | 'readToolSettings' | 'readCredentialTrust'>) {}

  getTrust(reference: CredentialReference): readonly CredentialTrust[] {
    return this.store.readCredentialTrust?.(reference) ?? []
  }

  getSettings(reference: CredentialReference): Record<string, unknown> {
    return this.store.readToolSettings?.(reference.tool) ?? {}
  }

  async getCredential(reference: CredentialReference): Promise<unknown> {
    const credential = this.store.readCredential(reference)
    if (credential === undefined) throw new ArtiumError('REVISION_CONFLICT')
    return credential
  }
}
