import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ArtiumError } from '../../shared/errors.js'
import { Audit } from '../audit/audit.js'
import { decryptCredential, encryptCredential } from './crypto.js'
import type { EncryptedCredential } from './crypto.js'
import { openStore } from './db.js'
import type { KeyProvider } from './key-provider.js'
import { acquireMaintenanceLock } from './maintenance-lock.js'

export function rotateKey(file: string, oldProvider: KeyProvider, newProvider: KeyProvider) {
  const release = acquireMaintenanceLock(file)
  try {
    if (!existsSync(file)) throw new ArtiumError('CREDENTIAL_INVALID')
    const oldKey = oldProvider.getKey()
    const newKey = newProvider.getKey()
    if (oldKey.id === newKey.id) throw new ArtiumError('MASTER_KEY_INVALID', 'The new master key must differ from the old key.')
    const db = openStore(file, { getKey: () => oldKey })
    try {
      const receipt = { old_key_id: oldKey.id, new_key_id: newKey.id }
      new Audit(db, Date.now, () => {}).change({ event: 'admin-change', action: 'rotate-key', targetId: newKey.id,
        userId: null, tool: null, requestId: randomUUID(), clientAddress: null, outcome: 'success' }, () => {
        for (const table of ['credentials', 'provider_credentials']) {
          const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as EncryptedCredential[]
          const update = db.prepare(`UPDATE ${table} SET schema_version = @schema_version,
            key_id = @key_id, nonce = @nonce, ciphertext = @ciphertext,
            authentication_tag = @authentication_tag WHERE id = @id AND tool = @tool`)
          for (const row of rows) {
            const plaintext = decryptCredential(row, oldKey)
            try { update.run(encryptCredential(row.id, row.tool, plaintext, newKey)) }
            finally { plaintext.fill(0) }
          }
        }
        db.prepare('UPDATE store_metadata SET master_key_id = ? WHERE id = 1').run(newKey.id)
        db.prepare('INSERT INTO key_rotations (old_key_id, new_key_id) VALUES (@old_key_id, @new_key_id)').run(receipt)
      })
      return receipt
    } finally { db.close() }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('ROTATION_FAILED')
  } finally { release() }
}
