import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter } from '../adapters/types.js'
import type { RunnerInput } from '../runner/input.js'
import type { ToolName } from '../store/credential-store.js'

export function instanceGranted(db: Database.Database, userId: string, tool: ToolName, credentialId: string, rawApiOnly = false): boolean {
  return !!db.prepare(`
    SELECT 1 FROM user_roles
    JOIN role_tools ON role_tools.role_id = user_roles.role_id
    WHERE user_roles.user_id = ? AND role_tools.tool = ? AND (? = 0 OR role_tools.raw_api = 1) AND (role_tools.all_instances = 1 OR EXISTS (
      SELECT 1 FROM role_tool_instances WHERE role_tool_instances.role_id = role_tools.role_id
        AND role_tool_instances.tool = role_tools.tool AND role_tool_instances.credential_id = ?)) LIMIT 1
  `).get(userId, tool, Number(rawApiOnly), credentialId)
}

export function checkToolPolicy(db: Database.Database, userId: string, tool: ToolName, credentialId?: string): void {
  const user = db.prepare('SELECT disabled FROM users WHERE id = ?').get(userId) as { disabled: number } | undefined
  if (!user || user.disabled) throw new ArtiumError('USER_DISABLED')
  const configured = db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number } | undefined
  if (!configured?.enabled) throw new ArtiumError('TOOL_DISABLED')
  const grant = db.prepare(`
    SELECT 1 FROM user_roles
    JOIN role_tools ON role_tools.role_id = user_roles.role_id
    WHERE user_roles.user_id = ? AND role_tools.tool = ? LIMIT 1
  `).get(userId, tool)
  if (!grant) throw new ArtiumError('TOOL_NOT_GRANTED')
  if (credentialId !== undefined && !instanceGranted(db, userId, tool, credentialId)) throw new ArtiumError('INSTANCE_NOT_FOUND')
}

export function checkRawApiPolicy(db: Database.Database, userId: string, adapter: Adapter<unknown>,
  args: readonly string[], input?: RunnerInput, credentialId?: string): void {
  const call = adapter.classify(args, input)
  const raw = adapter.rawApi?.commands.some(command => call.command === command || args.slice(0, command.split(' ').length).join(' ') === command)
  if (!adapter.rawApi || !raw || call.command !== 'unknown' && adapter.rawApi.help(args, input)) return
  const effect = adapter.rawApi.effect?.(args, input) ?? call.effect
  const { raw_api_mode: mode } = db.prepare('SELECT raw_api_mode FROM tools WHERE name = ?').get(adapter.name) as { raw_api_mode: string }
  const modeAllows = mode === 'read-writes' ? effect === 'read' || adapter.rawApi.writes : mode === 'read' && effect === 'read'
  const granted = credentialId === undefined ? db.prepare(`
    SELECT 1 FROM user_roles
    JOIN role_tools ON role_tools.role_id = user_roles.role_id
    WHERE user_roles.user_id = ? AND role_tools.tool = ? AND role_tools.raw_api = 1 LIMIT 1
  `).get(userId, adapter.name) : instanceGranted(db, userId, adapter.name, credentialId, true)
  if (!modeAllows || !granted) throw new ArtiumError('RAW_API_DENIED')
}
