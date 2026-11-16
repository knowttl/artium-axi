import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { Adapter } from '../adapters/types.js'
import type { BrowserSession } from '../auth/sessions.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { browserCookie } from '../auth/browser.js'
import { delegatedCommands, delegationScopeWithInstanceNames, resolveDelegatedCommand } from '../auth/delegations.js'
import { instanceGranted } from '../policy/policy.js'
import { delegationPaused } from '../auth/tokens.js'
import { apiForm, apiFormTag, timestamp } from './forms.js'
import { describe, statusWord } from './design/status.js'
import { card } from './design/ui.js'
import { escape } from './escape.js'
import { renderPage } from './render-page.js'
import { delegationScopeSchema } from '../../shared/api.js'

type Token = { id: string, creator_id: string, label: string, scope_json: string, read_only: number, expires_at: number, revoked_at: number | null, consumed_at: number | null, single_use: number }

function tokenState(db: Database.Database, row: Token) {
  return row.revoked_at ? 'revoked' as const : row.expires_at <= Date.now() ? 'expired' as const : delegationPaused(db, row.creator_id) ? 'paused' as const
    : row.single_use && row.consumed_at ? 'used' as const : 'active' as const
}

function tokenRows(db: Database.Database, userId?: string): Token[] {
  return (userId ? db.prepare('SELECT * FROM delegations WHERE creator_id = ? ORDER BY created_at DESC').all(userId)
    : db.prepare('SELECT * FROM delegations ORDER BY created_at DESC').all()) as Token[]
}

function tokenTable(db: Database.Database, csrf: string, userId: string): string {
  const rows = tokenRows(db, userId)
  if (!rows.length) return '<p class="empty">No tokens.</p>'
  return `<div class="tbl-scroll"><table class="tbl stack-sm"><thead><tr><th>Label</th><th>Access</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.label)}<p class="mono">${escape(row.id)}</p></td><td>${row.read_only ? 'Read-only' : 'Writes allowed'} · ${row.single_use ? 'Single use' : 'Reusable'}<ul>${delegationScopeWithInstanceNames(db, row.scope_json).tools.map(item => `<li>${escape(item.tool)}${item.instances ? ` (instances: ${item.instances.map(escape).join(', ')})` : ''}: ${item.commands ? item.commands.map(escape).join(', ') : 'Tool-wide'}</li>`).join('')}</ul></td><td>${timestamp(row.expires_at)}</td><td>${statusWord('token', tokenState(db, row))}</td><td>${row.revoked_at ? '' : apiForm(csrf, `/v1/account/tokens/${encodeURIComponent(row.id)}/revoke`, 'POST', 'Revoke', '', 'Revoke this token and its sessions?', '', 'btn btn-danger-outline btn-sm')}</td></tr>`).join('')}</tbody></table></div>`
}

export function accountTokens(db: Database.Database, current: BrowserSession, csrf: string, adapters: readonly Adapter<unknown>[]): string {
  const settings = db.prepare('SELECT minting_enabled, max_lifetime_ms FROM delegation_settings WHERE id = 1').get() as { minting_enabled: number, max_lifetime_ms: number }
  const granted = db.prepare(`SELECT DISTINCT tools.name FROM tools JOIN role_tools ON role_tools.tool = tools.name
    JOIN user_roles ON user_roles.role_id = role_tools.role_id WHERE user_roles.user_id = ? AND tools.enabled = 1 ORDER BY tools.name`).all(current.user_id) as { name: string }[]
  const choices = granted.flatMap(({ name }) => {
    const adapter = adapters.find(item => item.name === name)
    if (!adapter) return []
    const commands = [...new Set(delegatedCommands(JSON.stringify({ tools: [{ tool: name }] }), false, adapter, () => {}).flatMap(command => {
      try { return [resolveDelegatedCommand(command.replace(/^(?:prepare|server-dry-run) -- /, ''), adapter)] }
      catch { return [] }
    }))].sort()
    const instances = (db.prepare('SELECT id, name FROM credentials WHERE tool = ? ORDER BY name').all(name) as { id: string, name: string }[])
      .filter(instance => instanceGranted(db, current.user_id, adapter.name, instance.id))
    const instanceChoices = instances.length ? `<fieldset><legend>Instances (none selected allows every instance you can use)</legend>${instances.map(instance => `<label class="check"><input type="checkbox" data-token-instance="${escape(name)}" value="${escape(instance.name)}"> <code>${escape(instance.name)}</code></label>`).join('')}</fieldset>` : ''
    return [`<details class="ops-group"><summary>${escape(name)}</summary><div class="ops-body">${instanceChoices}<label class="check"><input type="checkbox" data-token-tool="${escape(name)}"> All permitted commands</label>${commands.map(command => `<label class="check"><input type="checkbox" data-token-command="${escape(name)}" value="${escape(command)}"> <code>${escape(command)}</code></label>`).join('')}</div></details>`]
  }).join('')
  const form = settings.minting_enabled ? `${apiFormTag(csrf, '/v1/account/tokens', 'POST', '', 'data-create-token')}
    <div class="card-body column"><label>Label<input name="label" required maxlength="100"></label>
    <label>Expiry type<select name="expiryType"><option value="duration">Duration</option><option value="date">Date and time</option></select></label>
    <label>Duration in hours<input name="duration" type="number" min="0.01" step="any" value="1"></label>
    <label>Expiry date and time<input name="expiryDate" type="datetime-local"></label>
    <p>Maximum lifetime: ${escape(settings.max_lifetime_ms / 3600000)} hours. The server refuses longer lifetimes.</p>
    <label class="check"><input name="readOnly" type="checkbox" checked> Read-only</label><label class="check"><input name="reusable" type="checkbox"> Reusable token</label>
    <p>Read-only follows tool inventory labels; some reads send data to external services. Writable SSH access reaches every granted host, including sudo. Credential-issuing commands require an exact selection and can create credentials that token revocation does not end.</p>
    <fieldset><legend>Tool and exact command access</legend>${choices || '<p>No enabled tools granted.</p>'}</fieldset></div>
    <div class="card-foot"><button class="btn btn-primary">Create token</button></div></form>
    <dialog id="created-token" class="modal" aria-labelledby="created-token-title"><div class="modal-body"><h2 id="created-token-title">Copy your token now</h2><p>It will not be shown again.</p><label>Token<input data-created-token readonly autocomplete="off"></label></div><div class="modal-foot"><button type="button" class="btn btn-secondary" data-close-created-token>Done</button></div></dialog>` : '<p class="card-body">Token creation is disabled by an administrator. Existing tokens continue to work.</p>'
  return card('Temporary access tokens', 'Grant a subset of your access to another user or agent.', form + tokenTable(db, csrf, current.user_id))
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
