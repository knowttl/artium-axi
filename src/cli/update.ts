import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ArtiumError } from '../shared/errors.js'
import { Client } from './http.js'

export async function update(): Promise<string> {
  const executable = realpathSync(process.argv[1])
  const metadata = join(dirname(executable), '..', 'package.json')
  if (existsSync(metadata) && JSON.parse(readFileSync(metadata, 'utf8')).name === '@knowttl/artium-axi') {
    throw new ArtiumError('INVALID_INPUT', 'This client was installed from npm.', 'Run npm install -g @knowttl/artium-axi@latest.')
  }
  const client = new Client()
  const bundle = await client.request('/cli/artium-axi.mjs', 'GET', undefined, undefined, true)
  const checksum = await client.request('/cli/artium-axi.mjs.sha256', 'GET', undefined, undefined, true)
  const digest = checksum.toString('utf8').trim().split(/\s+/)[0]
  if (!/^[a-fA-F0-9]{64}$/.test(digest) || createHash('sha256').update(bundle).digest('hex') !== digest.toLowerCase()) {
    throw new ArtiumError('INVALID_RESPONSE', 'The downloaded client failed SHA-256 verification.', 'Run artium-axi update again after checking the server bundle and checksum.')
  }
  const temporary = `${executable}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bundle, { flag: 'wx', mode: statSync(executable).mode & 0o777 })
    copyFileSync(executable, `${executable}.bak`)
    renameSync(temporary, executable)
  } catch {
    throw new ArtiumError('INTERNAL_ERROR', 'The client could not be replaced.', 'Check write permissions for the client file and its directory, then run artium-axi update.')
  } finally { rmSync(temporary, { force: true }) }
  return 'status: updated\nnext: artium-axi --version\n'
}
