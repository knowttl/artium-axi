import type { CredentialInstance, CredentialReference, CredentialStore, ToolName } from '../../src/server/store/credential-store.js'
import type Database from 'better-sqlite3'
import { encryptCredential } from '../../src/server/store/crypto.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'

export class FakeCredentialStore implements CredentialStore {
  constructor(readonly credentials: { reference: CredentialReference, value: unknown, name?: string, enabled?: boolean, readOnly?: boolean }[] = []) {}

  seed(db: Database.Database) {
    const insert = db.prepare(`INSERT INTO credentials (id, tool, name, enabled, read_only, schema_version, key_id, nonce, ciphertext, authentication_tag, revision)
      VALUES (@id, @tool, @name, @enabled, @readOnly, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, @revision)
      ON CONFLICT(id) DO UPDATE SET tool = excluded.tool, name = excluded.name, enabled = excluded.enabled,
      read_only = excluded.read_only, revision = excluded.revision, schema_version = excluded.schema_version,
      key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext, authentication_tag = excluded.authentication_tag`)
    const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }).getKey()
    for (const { reference, value, name, enabled, readOnly } of this.credentials) insert.run({
      ...encryptCredential(reference.id, reference.tool, Buffer.from(JSON.stringify(value)), key), name: name ?? 'default',
      enabled: Number(enabled ?? true), readOnly: Number(readOnly ?? false), revision: reference.revision ?? 1 })
    return this
  }

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
