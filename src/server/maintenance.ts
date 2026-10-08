import { resolve } from 'node:path'
import { serverDefaults } from './config.js'
import { EnvironmentKeyProvider } from './store/key-provider.js'
import { rotateKey } from './store/rotate-key.js'
import { ArtiumError, errorResponse } from '../shared/errors.js'

const args = process.argv.slice(2)
const usage = 'artium-axi-server rotate-key --new-key-file <path>'
try {
  if (args.length === 1 && args[0] === '--help' || args.length === 2 && args[0] === 'rotate-key' && args[1] === '--help') {
    process.stdout.write(`description: Rotate the master key offline\nusage: ${usage}\nflags:\n  --new-key-file: Required raw 32-byte key file\n  --help: Show help\nexample: artium-axi-server rotate-key --new-key-file /run/secrets/new_master_key\nnext: Stop the server and take a backup before rotation.\n`)
  } else {
    if (args.length !== 3 || args[0] !== 'rotate-key' || args[1] !== '--new-key-file' || !args[2] || args[2].startsWith('-')) {
      throw new ArtiumError('INVALID_INPUT', 'Invalid maintenance command.', usage)
    }
    const receipt = rotateKey(resolve(process.env.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database),
      new EnvironmentKeyProvider(), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY_FILE: args[2] }))
    process.stdout.write(`rotation:\n  old_key_id: ${JSON.stringify(receipt.old_key_id)}\n  new_key_id: ${JSON.stringify(receipt.new_key_id)}\nnext: Switch the mounted startup key to the new key and restart. Check every adapter before retiring the old key. Keep the old key until its backups expire.\n`)
  }
} catch (error) {
  const safe = error instanceof ArtiumError ? error : new ArtiumError('ROTATION_FAILED')
  process.stdout.write(`error:\n${Object.entries(errorResponse(safe, 'rotation').error).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n`)
  process.exitCode = safe.code === 'INVALID_INPUT' ? 2 : 1
}
