import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { Adapter } from '../adapters/types.js'
import type { BrowserSession } from '../auth/sessions.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { browserCookie } from '../auth/browser.js'
import { delegatedCommands, delegationScopeWithInstanceNames, resolveDelegatedCommand } from '../auth/delegations.js'
import { instanceGranted } from '../policy/policy.js'
import { delegationPaused } from '../auth/tokens.js'
import { describe } from './design/status.js'
import { renderPage } from './render-page.js'
import type { AccountTokensProps } from '../../views/account-tokens.js'

type Token = { id: string, creator_id: string, label: string, scope_json: string, read_only: number, expires_at: number, revoked_at: number | null, consumed_at: number | null, single_use: number }

function tokenState(db: Database.Database, row: Token) {
  return row.revoked_at ? 'revoked' as const : row.expires_at <= Date.now() ? 'expired' as const : delegationPaused(db, row.creator_id) ? 'paused' as const
    : row.single_use && row.consumed_at ? 'used' as const : 'active' as const
}

function tokenRows(db: Database.Database, userId?: string): Token[] {
  return (userId ? db.prepare('SELECT * FROM delegations WHERE creator_id = ? ORDER BY created_at DESC').all(userId)
    : db.prepare('SELECT * FROM delegations ORDER BY created_at DESC').all()) as Token[]
}

export function accountTokens(db: Database.Database, current: BrowserSession, adapters: readonly Adapter<unknown>[]): AccountTokensProps {
  const settings = db.prepare('SELECT minting_enabled, max_lifetime_ms FROM delegation_settings WHERE id = 1').get() as { minting_enabled: number, max_lifetime_ms: number }
  const granted = db.prepare(`SELECT DISTINCT tools.name FROM tools JOIN role_tools ON role_tools.tool = tools.name
    JOIN user_roles ON user_roles.role_id = role_tools.role_id WHERE user_roles.user_id = ? AND tools.enabled = 1 ORDER BY tools.name`).all(current.user_id) as { name: string }[]
  return {
    mintingEnabled: Boolean(settings.minting_enabled),
    maxLifetimeHours: settings.max_lifetime_ms / 3600000,
    choices: granted.flatMap(({ name }) => {
      const adapter = adapters.find(item => item.name === name)
      if (!adapter) return []
      const commands = [...new Set(delegatedCommands(JSON.stringify({ tools: [{ tool: name }] }), false, adapter, () => {}).flatMap(command => {
        try { return [resolveDelegatedCommand(command.replace(/^(?:prepare|server-dry-run) -- /, ''), adapter)] }
        catch { return [] }
      }))].sort()
      const instances = (db.prepare('SELECT id, name FROM credentials WHERE tool = ? ORDER BY name').all(name) as { id: string, name: string }[])
        .filter(instance => instanceGranted(db, current.user_id, adapter.name, instance.id)).map(instance => instance.name)
      return [{ tool: name, instances, commands }]
    }),
    tokens: tokenRows(db, current.user_id).map(row => ({ id: row.id, label: row.label, writable: !row.read_only, singleUse: Boolean(row.single_use),
      expiresAt: new Date(row.expires_at).toISOString(), status: describe('token', tokenState(db, row)), revocable: !row.revoked_at,
      scope: delegationScopeWithInstanceNames(db, row.scope_json).tools })),
  }
}

export function registerTokenPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/tokens', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const csrf = reply.generateCsrf()
    const settings = db.prepare('SELECT minting_enabled, max_lifetime_ms, sso_window_ms FROM delegation_settings WHERE id = 1').get() as { minting_enabled: number, max_lifetime_ms: number, sso_window_ms: number }
    return renderPage(reply, 'Temporary access tokens', 'tokens', {
      csrf,
      settings: { mintingEnabled: Boolean(settings.minting_enabled), maxLifetimeHours: settings.max_lifetime_ms / 3600000, ssoWindowDays: settings.sso_window_ms / 86400000 },
      tokens: tokenRows(db).map(row => ({ id: row.id, label: row.label, creator: row.creator_id, writable: !row.read_only, singleUse: Boolean(row.single_use),
        scope: delegationScopeWithInstanceNames(db, row.scope_json).tools, expiresAt: new Date(row.expires_at).toISOString(), status: describe('token', tokenState(db, row)),
        revocable: !row.revoked_at })) }, current)
  })
}
