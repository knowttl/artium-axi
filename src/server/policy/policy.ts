import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { rawApiRoutesSchema, type rawApiModeSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter } from '../adapters/types.js'
import type { RunnerInput } from '../runner/input.js'
import type { ToolName } from '../store/credential-store.js'
import { matchRawApiRoute, readRawApiCall } from './raw-api.js'

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

export function rawApiModes(adapter: Adapter<unknown> | undefined): z.infer<typeof rawApiModeSchema>[] {
  if (!adapter?.rawApi) return []
  return ['off', 'read', 'read-writes']
}

export function parseRawApiRoutes(stored: string | null) {
  return rawApiRoutesSchema.parse(stored === null ? { get: [], write: [] } : JSON.parse(stored))
}

export function checkRawApiPolicy(db: Database.Database, userId: string, adapter: Adapter<unknown>,
  args: readonly string[], input?: RunnerInput, credentialId?: string): { readWrites: boolean, route: string | null } {
  const none = { readWrites: false, route: null }
  const call = adapter.classify(args, input)
  const raw = adapter.rawApi?.commands.some(command => call.command === command || args.slice(0, command.split(' ').length).join(' ') === command)
  if (!adapter.rawApi || !raw || call.command !== 'unknown' && adapter.rawApi.help(args, input)) return none
  const effect = adapter.rawApi.effect?.(args, input) ?? call.effect
  const { raw_api_mode: mode, raw_api_routes: stored } = db.prepare('SELECT raw_api_mode, raw_api_routes FROM tools WHERE name = ?')
    .get(adapter.name) as { raw_api_mode: string, raw_api_routes: string | null }
  const modeAllows = mode === 'read-writes' ? effect === 'read' || adapter.rawApi.writes : mode === 'read' && effect === 'read'
  const granted = credentialId === undefined ? db.prepare(`
    SELECT 1 FROM user_roles
    JOIN role_tools ON role_tools.role_id = user_roles.role_id
    WHERE user_roles.user_id = ? AND role_tools.tool = ? AND role_tools.raw_api = 1 LIMIT 1
  `).get(userId, adapter.name) : instanceGranted(db, userId, adapter.name, credentialId, true)
  if (!modeAllows || !granted) throw new ArtiumError('RAW_API_DENIED')
  const write = effect === 'write'
  const routes = parseRawApiRoutes(stored)
  const list = write ? routes.write : routes.get
  if (write && !list.length) throw new ArtiumError('RAW_API_DENIED')
  const request = readRawApiCall(adapter, args, input)
  const route = list.length ? request && matchRawApiRoute(list, write, request) : undefined
  if (list.length && !route) throw new ArtiumError('RAW_API_DENIED')
  return { readWrites: mode === 'read-writes', route: route ?? null }
}
