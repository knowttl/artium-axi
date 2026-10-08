import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import type { ToolName } from '../store/credential-store.js'

export function checkToolPolicy(db: Database.Database, userId: string, tool: ToolName): void {
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
}
