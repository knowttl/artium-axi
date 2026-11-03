import type Database from 'better-sqlite3'
import type { KeyProvider } from './key-provider.js'
import { decryptCredential, encryptCredential, type EncryptedCredential } from './crypto.js'
import { ArtiumError } from '../../shared/errors.js'

export interface SshHost { id: string, address: string, port: number, username: string }
interface Binding extends SshHost { approved_host_keys: string, allowed_addresses: string, credential_id: string,
  host_revision: number, binding_revision: number, credential_revision: number }

// Reusing a deleted handle must not make an old administrative draft current again.
export function nextSshRevision(db: Database.Database, table: 'ssh_hosts' | 'ssh_credentials', id: string, revision: number, create = false): number {
  const row = db.prepare(`SELECT revision FROM ${table} WHERE id = ?`).get(id) as { revision: number } | undefined
  if (!row && !create) throw new ArtiumError('NOT_FOUND')
  if ((row?.revision ?? 0) !== revision) throw new ArtiumError('REVISION_CONFLICT')
  const retired = !row ? db.prepare('SELECT revision FROM ssh_retired_revisions WHERE kind=? AND id=?').get(table, id) as { revision: number } | undefined : undefined
  return (row?.revision ?? retired?.revision ?? 0) + 1
}

export function hasSshConfiguration(db: Database.Database, userId: string | null = null): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ssh_hosts h JOIN ssh_bindings b ON b.host_id = h.id
    WHERE h.enabled = 1 AND b.sudo = 0 AND (? IS NULL OR EXISTS (
      SELECT 1 FROM ssh_grants g WHERE g.host_id = h.id AND g.user_id = ? AND g.shell = 1)) LIMIT 1`).get(userId, userId))
}

// SSH credentials and host grants never fall back to generic tenant credentials or sudo bindings.
export class SshHosts {
  constructor(private readonly db: Database.Database, private readonly provider: KeyProvider) {}

  // The caller commits this replacement and its audit event in one transaction.
  replaceCredential(id: string, value: { privateKey: string, passphrase?: string }, expectedRevision: number, actor: string): number {
    const revision = nextSshRevision(this.db, 'ssh_credentials', id, expectedRevision, true)
    const plaintext = Buffer.from(JSON.stringify(value))
    try {
      const encrypted = encryptCredential(id, 'ssh-axi', plaintext, this.provider.getKey())
      this.db.prepare(`INSERT INTO ssh_credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, revision, updated_at, updated_by)
        VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, @revision, @now, @actor)
        ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, key_id=excluded.key_id, nonce=excluded.nonce,
        ciphertext=excluded.ciphertext, authentication_tag=excluded.authentication_tag, revision=excluded.revision,
        updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run({ ...encrypted, revision, now: Date.now(), actor })
    } finally { plaintext.fill(0) }
    return revision
  }

  private bindings(userId: string): Binding[] {
    return this.db.prepare(`SELECT h.id, h.address, h.port, h.approved_host_keys, h.allowed_addresses,
      b.username, b.credential_id, h.revision AS host_revision, b.revision AS binding_revision, c.revision AS credential_revision
      FROM ssh_hosts h JOIN ssh_bindings b ON b.host_id = h.id JOIN ssh_credentials c ON c.id = b.credential_id
      JOIN ssh_grants g ON g.host_id = h.id WHERE g.user_id = ? AND g.shell = 1 AND h.enabled = 1
      AND b.sudo = 0 ORDER BY h.id`).all(userId) as Binding[]
  }

  list(userId: string): SshHost[] {
    return this.bindings(userId).map(({ id, address, port, username }) => ({ id, address, port, username }))
  }

  dispatchGuard(userId: string, hostId?: string): () => void {
    const read = () => JSON.stringify(this.bindings(userId).filter(host => !hostId || host.id === hostId))
    const snapshot = read()
    return () => { if (read() !== snapshot) throw new ArtiumError('CREDENTIAL_INVALID') }
  }

  profile(userId: string, hostId: string): Record<string, unknown> {
    const binding = this.bindings(userId).find(host => host.id === hostId)
    if (!binding) throw new ArtiumError('NOT_FOUND')
    const row = this.db.prepare("SELECT * FROM ssh_credentials WHERE id = ? AND tool = 'ssh-axi'").get(binding.credential_id) as EncryptedCredential | undefined
    if (!row) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const plaintext = decryptCredential(row, this.provider.getKey())
    try {
      const secret = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>
      if (!secret || typeof secret.privateKey !== 'string' || Object.keys(secret).some(key => !['privateKey', 'passphrase'].includes(key))) throw new ArtiumError('CREDENTIAL_INVALID')
      return { address: binding.address, port: binding.port, username: binding.username,
        approvedHostKeys: JSON.parse(binding.approved_host_keys), allowedAddresses: JSON.parse(binding.allowed_addresses), ...secret }
    } finally { plaintext.fill(0) }
  }
}
