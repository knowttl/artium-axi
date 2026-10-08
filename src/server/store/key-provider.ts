import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ArtiumError } from '../../shared/errors.js'

export interface MasterKey {
  bytes: Buffer
  id: string
}

export interface KeyProvider {
  getKey(): MasterKey
}

export class EnvironmentKeyProvider implements KeyProvider {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  getKey(): MasterKey {
    try {
      const file = this.environment.ARTIUM_AXI_MASTER_KEY_FILE
      const encoded = this.environment.ARTIUM_AXI_MASTER_KEY
      const bytes = file ? readFileSync(file) : Buffer.from(encoded ?? '', 'base64')
      if (bytes.length !== 32 || (!file && bytes.toString('base64') !== encoded)) {
        throw new Error('invalid key')
      }
      return { bytes, id: createHash('sha256').update(bytes).digest('hex') }
    } catch {
      throw new ArtiumError('MASTER_KEY_INVALID')
    }
  }
}
