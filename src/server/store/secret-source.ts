import { ArtiumError } from '../../shared/errors.js'
import type { CredentialReference, CredentialStore } from './credential-store.js'

export interface SecretSource {
  getCredential(reference: CredentialReference): Promise<unknown>
}

export class EmbeddedSecretSource implements SecretSource {
  constructor(private readonly store: Pick<CredentialStore, 'readCredential'>) {}

  async getCredential(reference: CredentialReference): Promise<unknown> {
    const credential = this.store.readCredential(reference)
    if (credential === undefined) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
    return credential
  }
}
