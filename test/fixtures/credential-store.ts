import type { CredentialReference, CredentialStore, ToolName } from '../../src/server/store/credential-store.js'

export class FakeCredentialStore implements CredentialStore {
  constructor(readonly credentials: { reference: CredentialReference, value: unknown }[] = []) {}

  findCredential(tool: ToolName) {
    return this.credentials.find(entry => entry.reference.tool === tool)?.reference
  }

  readCredential(reference: CredentialReference) {
    return this.credentials.find(entry => entry.reference.id === reference.id && entry.reference.tool === reference.tool)?.value
  }
}
