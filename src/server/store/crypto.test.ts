import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptCredential, encryptCredential } from './crypto.js'
import { EnvironmentKeyProvider } from './key-provider.js'

const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }).getKey()
const plaintext = Buffer.from('CANARY-synthetic-credential')

describe('credential encryption', () => {
  it('round trips with fresh nonces', () => {
    const first = encryptCredential('synthetic-id', 'falcon-axi', plaintext, key)
    const second = encryptCredential('synthetic-id', 'falcon-axi', plaintext, key)
    expect(decryptCredential(first, key)).toEqual(plaintext)
    expect(first.nonce).not.toEqual(second.nonce)
    expect(first.ciphertext.includes(plaintext)).toBe(false)
  })

  it.each(['ciphertext', 'authentication_tag', 'nonce'] as const)('rejects changed %s', field => {
    const row = encryptCredential('synthetic-id', 'falcon-axi', plaintext, key)
    row[field][0] ^= 1
    expect(() => decryptCredential(row, key)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  })

  it.each([
    ['id', 'other-id'], ['tool', 'vectra-axi'], ['schema_version', 2], ['key_id', 'other-key'],
  ])('binds the credential to %s', (field, value) => {
    const row = encryptCredential('synthetic-id', 'falcon-axi', plaintext, key)
    expect(() => decryptCredential({ ...row, [field]: value }, key)).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  })

  it('rejects a wrong key even with the original key ID', () => {
    const row = encryptCredential('synthetic-id', 'falcon-axi', plaintext, key)
    expect(() => decryptCredential(row, { id: key.id, bytes: randomBytes(32) })).toThrow(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  })
})
