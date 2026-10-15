import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import { decryptCredential, encryptCredential, type EncryptedCredential } from './crypto.js'
import type { KeyProvider } from './key-provider.js'

export class ProviderCredentials {
  private readonly key

  constructor(private readonly db: Database.Database, provider: KeyProvider) {
    this.key = provider.getKey()
  }

  read(id: string): { value: Record<string, unknown>, revision: number, updatedAt: number, updatedBy: string } | undefined {
    const row = this.db.prepare('SELECT * FROM provider_credentials WHERE id = ?').get(id) as
      (EncryptedCredential & { revision: number, updated_at: number, updated_by: string }) | undefined
    if (!row) return
    const plaintext = decryptCredential(row, this.key)
    try {
      return { value: JSON.parse(plaintext.toString('utf8')), revision: row.revision, updatedAt: row.updated_at, updatedBy: row.updated_by }
    } finally { plaintext.fill(0) }
  }

  replace(id: string, value: Record<string, unknown>, expectedRevision: number, actor: string, now: number): void {
    const current = this.db.prepare('SELECT revision FROM provider_credentials WHERE id = ?').get(id) as { revision: number } | undefined
    if ((current?.revision ?? 0) !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
    const plaintext = Buffer.from(JSON.stringify(value))
    try {
      const encrypted = encryptCredential(id, 'sso:' + id, plaintext, this.key)
      this.db.prepare(`INSERT INTO provider_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision, updated_at, updated_by)
        VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, @revision, @now, @actor)
        ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, key_id = excluded.key_id,
        nonce = excluded.nonce, ciphertext = excluded.ciphertext, authentication_tag = excluded.authentication_tag,
        revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run({ ...encrypted, revision: expectedRevision + 1, now, actor })
    } finally { plaintext.fill(0) }
  }
}
