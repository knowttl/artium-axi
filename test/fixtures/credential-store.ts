import type { CredentialInstance, CredentialReference, CredentialStore, ToolName } from '../../src/server/store/credential-store.js'

export class FakeCredentialStore implements CredentialStore {
  constructor(readonly credentials: { reference: CredentialReference, value: unknown, name?: string, enabled?: boolean, readOnly?: boolean }[] = []) {}

  findCredential(tool: ToolName) {
    return this.credentials.find(entry => entry.reference.tool === tool)?.reference
  }

  listInstances(tool: ToolName): CredentialInstance[] {
    return this.credentials.filter(entry => entry.reference.tool === tool).map(entry => ({
      ...entry.reference, revision: entry.reference.revision ?? 1, name: entry.name ?? 'default', description: '',
      enabled: entry.enabled ?? true, readOnly: entry.readOnly ?? false,
    }))
  }

  readCredential(reference: CredentialReference) {
    return this.credentials.find(entry => entry.reference.id === reference.id && entry.reference.tool === reference.tool)?.value
  }
}
