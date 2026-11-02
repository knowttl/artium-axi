import type Database from 'better-sqlite3'
import type { KeyProvider } from './key-provider.js'
import { decryptCredential, type EncryptedCredential } from './crypto.js'
import { ArtiumError } from '../../shared/errors.js'

export interface SshHost { id: string, address: string, port: number, username: string }
interface Binding extends SshHost { approved_host_keys: string, allowed_addresses: string, credential_id: string }

// SSH credentials and host grants never fall back to generic tenant credentials or sudo bindings.
export class SshHosts {
  constructor(private readonly db: Database.Database, private readonly provider: KeyProvider) {}

  private bindings(userId: string): Binding[] {
    return this.db.prepare(`SELECT h.id, h.address, h.port, h.approved_host_keys, h.allowed_addresses,
      b.username, b.credential_id FROM ssh_hosts h JOIN ssh_bindings b ON b.host_id = h.id
      JOIN ssh_grants g ON g.host_id = h.id WHERE g.user_id = ? AND g.shell = 1 AND h.enabled = 1
      AND b.sudo = 0 ORDER BY h.id`).all(userId) as Binding[]
  }

  list(userId: string): SshHost[] {
    return this.bindings(userId).map(({ id, address, port, username }) => ({ id, address, port, username }))
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
