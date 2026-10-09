import { resolve } from 'node:path'
import { serverDefaults } from './config.js'
import { EnvironmentKeyProvider } from './store/key-provider.js'
import { rotateKey } from './store/rotate-key.js'
import { ArtiumError, errorResponse, errors } from '../shared/errors.js'
import { recoverAdministrator } from './auth/recover-admin.js'
import { backupStore, restoreStore } from './store/backup.js'

const args = process.argv.slice(2)
const usage = 'artium-axi-server rotate-key --new-key-file <path>'
const recoveryUsage = 'artium-axi-server recover-admin --username <username> --password-file <path>'
try {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`description: Store maintenance\ncommands:\n  backup: Take a consistent online backup\n  restore: Restore offline into an empty new volume and invalidate saved sessions\n  rotate-key: Rotate the master key\n  recover-admin: Restore a local administrator and reset its password\nnext: Use artium-axi-server <command> --help.\n`)
  } else if (args[0] === 'backup' || args[0] === 'restore') {
    const command = args[0]
    const flag = command === 'backup' ? '--out' : '--from'
    const commandUsage = `artium-axi-server ${command} ${flag} <path>`
    if (args.length === 2 && args[1] === '--help') {
      process.stdout.write(`description: ${command === 'backup' ? 'Consistent online SQLite backup to a new owner-only sensitive file' : 'Stopped restore into an empty new volume with the matching master key; invalidate every saved login session'}\nusage: ${commandUsage}\nflags:\n  ${flag}: Required ${command === 'backup' ? 'new backup file in an existing protected directory' : 'backup file'}\n  --help: Show help\nexample: artium-axi-server ${command} ${flag} /backups/pre-upgrade.db\nnext: Set ARTIUM_AXI_DATABASE_FILE and the matching master-key setting. Keep the master key separately.\n`)
    } else {
      if (args.length !== 3 || args[1] !== flag || !args[2] || args[2].startsWith('-')) {
        throw new ArtiumError('INVALID_INPUT', 'Invalid maintenance command.', commandUsage)
      }
      const file = resolve(process.env.ARTIUM_AXI_DATABASE_FILE ?? serverDefaults.database)
      const provider = new EnvironmentKeyProvider()
      const receipt = command === 'backup' ? await backupStore(file, args[2], provider) : restoreStore(args[2], file, provider)
      process.stdout.write(`${command}:\n  status: completed\n  key_id: ${JSON.stringify(receipt.key_id)}\nnext: ${command === 'backup' ? 'Record the image digest and key ID; retain the master key separately until this backup expires.' : 'Start the matching image with this new volume and key. Every user must sign in again.'}\n`)
    }
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
  const safe = error instanceof ArtiumError ? error : new ArtiumError(args[0] === 'backup' ? 'BACKUP_FAILED' : args[0] === 'restore' ? 'RESTORE_FAILED' : args[0] === 'recover-admin' ? 'RECOVERY_FAILED' : 'ROTATION_FAILED')
  process.stdout.write(`error:\n${Object.entries(errorResponse(safe, 'maintenance').error).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n`)
  process.exitCode = errors[safe.code].exitCode
}
