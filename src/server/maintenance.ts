import { resolve } from 'node:path'
import { serverDefaults } from './config.js'
import { EnvironmentKeyProvider } from './store/key-provider.js'
import { rotateKey } from './store/rotate-key.js'
import { ArtiumError, errorResponse } from '../shared/errors.js'
import { recoverAdministrator } from './auth/recover-admin.js'

const args = process.argv.slice(2)
const usage = 'artium-axi-server rotate-key --new-key-file <path>'
const recoveryUsage = 'artium-axi-server recover-admin --username <username> --password-file <path>'
try {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`description: Offline store maintenance\ncommands:\n  rotate-key: Rotate the master key\n  recover-admin: Restore a local administrator and reset its password\nnext: Stop the server and take a backup. Use artium-axi-server <command> --help.\n`)
  } else if (args.length === 2 && args[0] === 'recover-admin' && args[1] === '--help') {
    process.stdout.write(`description: Recover an existing local administrator offline\nusage: ${recoveryUsage}\nflags:\n  --username: Required existing local username\n  --password-file: Required UTF-8 file containing the exact new password\n  --help: Show help\nexample: artium-axi-server recover-admin --username synthetic-admin --password-file /run/secrets/recovery_password\nnext: Stop the server and take a backup. Set the local database and matching master-key environment settings.\n`)
  } else if (args.length === 2 && args[0] === 'rotate-key' && args[1] === '--help') {
    process.stdout.write(`description: Rotate the master key offline\nusage: ${usage}\nflags:\n  --new-key-file: Required raw 32-byte key file\n  --help: Show help\nexample: artium-axi-server rotate-key --new-key-file /run/secrets/new_master_key\nnext: Stop the server and take a backup before rotation.\n`)
  } else if (args[0] === 'recover-admin') {
    if (args.length !== 5 || args[1] !== '--username' || !args[2] ||
      args[3] !== '--password-file' || !args[4]) {
      throw new ArtiumError('INVALID_INPUT', 'Invalid recovery command.', recoveryUsage)
    }
    const userId = await recoverAdministrator(resolve(process.env.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database),
      new EnvironmentKeyProvider(), args[2], args[4])
    process.stdout.write(`recovery:\n  user_id: ${JSON.stringify(userId)}\n  status: password-change-required\nnext: Restart the server, sign in with the recovery password and change it.\n`)
  } else {
    if (args.length !== 3 || args[0] !== 'rotate-key' || args[1] !== '--new-key-file' || !args[2] || args[2].startsWith('-')) {
      throw new ArtiumError('INVALID_INPUT', 'Invalid maintenance command.', `${usage} or ${recoveryUsage}`)
    }
    const receipt = rotateKey(resolve(process.env.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database),
      new EnvironmentKeyProvider(), new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY_FILE: args[2] }))
    process.stdout.write(`rotation:\n  old_key_id: ${JSON.stringify(receipt.old_key_id)}\n  new_key_id: ${JSON.stringify(receipt.new_key_id)}\nnext: Switch the mounted startup key to the new key and restart. Check every adapter before retiring the old key. Keep the old key until its backups expire.\n`)
  }
} catch (error) {
  const safe = error instanceof ArtiumError ? error : new ArtiumError(args[0] === 'recover-admin' ? 'RECOVERY_FAILED' : 'ROTATION_FAILED')
  process.stdout.write(`error:\n${Object.entries(errorResponse(safe, 'maintenance').error).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n`)
  process.exitCode = safe.code === 'INVALID_INPUT' ? 2 : 1
}
