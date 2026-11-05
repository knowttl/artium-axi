import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import inventory from '../../../tools/inventories/shodan-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runtimePath, toolPaths } from '../config.js'

export function verifyShodanPackage() {
  try {
    const executable = realpathSync(toolPaths['shodan-axi'])
    const root = resolve(dirname(executable), '..')
    if (executable !== join(root, 'bin', 'shodan-axi.js')) throw new Error('Unexpected executable')
    for (const source of inventory.sources) {
      const digest = createHash('sha256').update(readFileSync(join(root, source.path))).digest('hex')
      if (digest !== source.sha256) throw new Error('Package differs from inventory')
    }
    const version = execFileSync(process.execPath, [executable, '--version'], {
      env: { PATH: runtimePath }, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
    })
    if (version.trim() !== inventory.version) throw new Error('Version differs from inventory')
  } catch { throw new ArtiumError('SPAWN_FAILED') }
}
