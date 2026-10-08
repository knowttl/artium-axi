import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ArtiumError } from '../../shared/errors.js'
import type { MasterKey } from './key-provider.js'

export interface EncryptedCredential {
  id: string
  tool: string
  schema_version: number
  key_id: string
  nonce: Buffer
  ciphertext: Buffer
  authentication_tag: Buffer
}

function associatedData(row: EncryptedCredential): Buffer {
  return Buffer.from(JSON.stringify([row.schema_version, row.tool, row.id, row.key_id]))
}

export function encryptCredential(id: string, tool: string, plaintext: Buffer, key: MasterKey): EncryptedCredential {
  const row: EncryptedCredential = {
    id, tool, schema_version: 1, key_id: key.id, nonce: randomBytes(12),
    ciphertext: Buffer.alloc(0), authentication_tag: Buffer.alloc(0),
  }
  const cipher = createCipheriv('aes-256-gcm', key.bytes, row.nonce)
  cipher.setAAD(associatedData(row))
  row.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  row.authentication_tag = cipher.getAuthTag()
  return row
}

export function decryptCredential(row: EncryptedCredential, key: MasterKey): Buffer {
  try {
    if (row.schema_version !== 1 || row.key_id !== key.id || row.nonce.length !== 12 || row.authentication_tag.length !== 16) {
      throw new Error('invalid credential')
    }
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, row.nonce)
    decipher.setAAD(associatedData(row))
    decipher.setAuthTag(row.authentication_tag)
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()])
  } catch {
    throw new ArtiumError('CREDENTIAL_INVALID')
  }
}
