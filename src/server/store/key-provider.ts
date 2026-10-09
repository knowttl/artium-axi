import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { ArtiumError } from '../../shared/errors.js'
import { serverDefaults } from '../config.js'

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
      const encoded = file ? undefined : this.environment.ARTIUM_AXI_MASTER_KEY ?? parseEnv(readFileSync(
        join(dirname(resolve(this.environment.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database)), '.env'), 'utf8')).ARTIUM_AXI_MASTER_KEY
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

export function saveMasterKey(database: string, key: MasterKey): void {
  const file = join(dirname(database), '.env')
  const temporary = `${file}.${randomUUID()}`
  try {
    let contents = ''
    try { contents = readFileSync(file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const remaining = contents.replace(/^(?:export\s+)?ARTIUM_AXI_MASTER_KEY\s*=.*(?:\r?\n|$)/gm, '')
    writeFileSync(temporary, `${remaining}${remaining && !remaining.endsWith('\n') ? '\n' : ''}ARTIUM_AXI_MASTER_KEY=${key.bytes.toString('base64')}\n`,
      { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch {
    throw new ArtiumError('MASTER_KEY_INVALID')
  } finally { rmSync(temporary, { force: true }) }
}
