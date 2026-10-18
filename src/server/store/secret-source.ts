import { ArtiumError } from '../../shared/errors.js'
import type { CredentialReference, CredentialStore } from './credential-store.js'

export interface SecretSource {
  getCredential(reference: CredentialReference): Promise<unknown>
  getSettings?(reference: CredentialReference): Record<string, unknown>
}

export class EmbeddedSecretSource implements SecretSource {
  constructor(private readonly store: Pick<CredentialStore, 'readCredential' | 'readToolSettings'>) {}

  getSettings(reference: CredentialReference): Record<string, unknown> {
    return this.store.readToolSettings?.(reference.tool) ?? {}
  }

  async getCredential(reference: CredentialReference): Promise<unknown> {
    const credential = this.store.readCredential(reference)
    if (credential === undefined) throw new ArtiumError('REVISION_CONFLICT')
    return credential
  }
}
