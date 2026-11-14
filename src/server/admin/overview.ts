import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminToolRoutes } from '../../shared/api.js'
import type { OverviewProps } from '../../views/overview.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { credentialCertificates } from '../store/trusted-certificates.js'
import { describe, toolProducts, toolState, toolWrites } from './design/status.js'
import { initials } from './design/ui.js'
import { adminRead } from './forms.js'
import { renderPage } from './render-page.js'

// Plain words for audited administration changes; other actions fall back to their code.
const changeWords: Record<string, string> = {
  'create-user': 'Added a user', 'update-user': 'Updated a person', 'assign-user-roles': 'Changed a person’s roles', 'archive-user': 'Archived a person',
  'unlock-user': 'Unlocked a person', 'reset-user-password': 'Reset a password', 'revoke-user-session': 'Revoked a session', 'revoke-user-sessions': 'Signed a person out everywhere',
  'create-role': 'Created a role', 'rename-role': 'Renamed a role', 'replace-role-tools': 'Changed a role’s tools', 'replace-role-tool-instances': 'Changed a role’s instance access',
  'grant-role-raw-api': 'Allowed Raw API for a role', 'revoke-role-raw-api': 'Removed Raw API from a role',
  'set-tool-raw-api-off': 'Turned Raw API off for a tool', 'set-tool-raw-api-read': 'Set a tool’s Raw API to read', 'set-tool-raw-api-read-writes': 'Set a tool’s Raw API to read and writes',
'delete-role': 'Deleted a role',
  'update-tool': 'Updated a tool', 'replace-credential': 'Saved a tool credential', 'save-awx-origin': 'Saved the AWX address', 'connect-github-device': 'Connected GitHub',
  'trust-certificate': 'Trusted a certificate', 'remove-trusted-certificate': 'Removed a trusted certificate', 'tool-write-access': 'Changed write access', 'update-tool-user-grants': 'Changed a person’s tool grants',
  'create-provider': 'Added an SSO provider', 'update-provider': 'Updated an SSO provider', 'replace-provider-credential': 'Saved an SSO credential',
  'create-role-rule': 'Added an SSO role rule', 'update-role-rule': 'Updated an SSO role rule', 'delete-role-rule': 'Removed an SSO role rule', 'update-local-policy': 'Changed sign-in policy',
  'invite-create': 'Created an invitation', 'invite-resend': 'Resent an invitation', 'invite-revoke': 'Revoked an invitation',
}

export function registerOverviewPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin', async (request, reply) => {
    // The users list lived here before Overview; keep its filtered and paged bookmarks working.
    const query = request.url.indexOf('?')
    if (query !== -1) return reply.redirect('/admin/users' + request.url.slice(query), 301)
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const now = Date.now()
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const credentials = db.prepare('SELECT id, tool FROM credentials').all() as { id: string, tool: string }[]
    const grants = new Map((db.prepare('SELECT tool, COUNT(*) AS roles FROM role_tools GROUP BY tool').all() as { tool: string, roles: number }[]).map(row => [row.tool, row.roles]))
    const count = (sql: string, ...values: unknown[]) => (db.prepare(sql).get(...values) as { n: number }).n
    const people = count('SELECT COUNT(*) AS n FROM users WHERE archived_at IS NULL')
    const withRoles = count('SELECT COUNT(DISTINCT users.id) AS n FROM users JOIN user_roles ON user_roles.user_id = users.id WHERE archived_at IS NULL')
    const withAccess = count(`SELECT COUNT(DISTINCT users.id) AS n FROM users JOIN user_roles ON user_roles.user_id = users.id
      JOIN role_tools ON role_tools.role_id = user_roles.role_id JOIN tools ON tools.name = role_tools.tool WHERE users.disabled = 0 AND users.archived_at IS NULL AND tools.enabled = 1`)
    const disabled = count('SELECT COUNT(*) AS n FROM users WHERE disabled = 1 AND archived_at IS NULL')
    const rolesWithTools = count('SELECT COUNT(DISTINCT role_id) AS n FROM role_tools')
    const breakGlass = count('SELECT COUNT(*) AS n FROM users WHERE break_glass = 1 AND disabled = 0 AND archived_at IS NULL')
    const ssoOn = count('SELECT COUNT(*) AS n FROM sso_providers WHERE enabled = 1')
    const pending = db.prepare(`SELECT invitations.id, display_name AS name, sso_providers.name AS provider, sso_providers.enabled FROM invitations JOIN sso_providers ON sso_providers.id = provider_id
      WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at`).all(now) as { id: string, name: string, provider: string, enabled: number }[]

    const enabled = tools.filter(tool => tool.enabled)
    const failing = enabled.filter(tool => tool.health.status === 'error')
    const missing = enabled.filter(tool => tool.health.status === 'unconfigured')
    const healthy = enabled.filter(tool => tool.health.status === 'ok')
    const writesOn = tools.filter(tool => !tool.readOnly)
    const expiring = credentials.flatMap(credential => credentialCertificates(db, credential.id)
      .filter(pin => Math.min(pin.leaf ? Date.parse(pin.leaf.expiresAt) : Infinity, Date.parse(pin.certificate.expiresAt)) <= now + 30 * 86_400_000)
      .map(pin => ({ tool: credential.tool as keyof typeof toolProducts, pin })))
    const unclaimable = pending.filter(invitation => !invitation.enabled)

    const attention: OverviewProps['attention'] = [
      ...failing.map(tool => ({ mark: toolProducts[tool.name].mark, title: `${toolProducts[tool.name].name} test is failing`, text: `Its last check failed${tool.health.errorCode ? ` with ${tool.health.errorCode}` : ''}. People with this tool get errors until it passes.`, status: describe('health', 'failing'), href: `/admin/tools/${tool.name}`, action: 'Open tool' })),
      ...missing.map(tool => ({ mark: toolProducts[tool.name].mark, title: `${toolProducts[tool.name].name} is enabled without a credential`, text: 'Calls fail until a credential is saved and tested.', status: describe('health', 'needs-credential'), href: `/admin/tools/${tool.name}`, action: 'Add credential' })),
      ...unclaimable.map(invitation => ({ mark: initials(invitation.name), title: `${invitation.name} can’t claim their invitation yet`, text: `${invitation.provider} is not enabled. Invitations work once it is enabled.`, status: describe('invitation', 'pending'), href: '/admin/invitations', action: 'Review' })),
      ...expiring.map(({ tool, pin }) => ({ mark: toolProducts[tool].mark, title: `A trusted certificate for ${toolProducts[tool].name} expires soon`, text: `${pin.endpoint} expires within 30 days. Inspect and trust the renewed certificate.`, href: `/admin/tools/${tool}`, action: 'Open tool' })),
    ]
    const attentionEmpty = healthy.length === enabled.length && enabled.length ? 'Every enabled tool has a credential and its last check passed.' : enabled.length ? 'Enabled tools still need a passing check.' : 'No tools are enabled yet.'

    const toolRows: OverviewProps['tools'] = enabled.map(tool => ({ name: tool.name, product: toolProducts[tool.name].name, state: toolState(tool), writes: toolWrites(tool),
      roles: `${grants.get(tool.name) ?? 0} role${grants.get(tool.name) === 1 ? '' : 's'}`, checkedAt: tool.health.checkedAt === null ? null : new Date(tool.health.checkedAt).toISOString() }))

    const steps = [
      { title: 'Connect a tool', done: healthy.length > 0, detail: healthy.length ? `${healthy.length} enabled tool${healthy.length === 1 ? ' has passed its' : 's have passed their'} last check.` : 'Save a credential, pass its test, then enable the tool. Writes stay off until you turn them on.', href: '/admin/tools', action: 'Open Tools' },
      { title: 'Create a role', done: rolesWithTools > 0, detail: rolesWithTools ? `${rolesWithTools} role${rolesWithTools === 1 ? ' grants' : 's grant'} tools.` : 'Choose which tools a role grants.', href: '/admin/roles', action: 'Open Roles' },
      { title: 'Give people roles', done: withRoles > 0, detail: withRoles ? `${withRoles} of ${people} people have one.` : 'Add people or invite them with SSO, then assign their roles.', href: '/admin/users', action: 'Open People' },
      { title: 'Choose a break-glass admin', done: breakGlass > 0, detail: 'A local admin who can still sign in if SSO breaks. Needed before SSO.', href: '/admin/users?source=local', action: 'Choose admin' },
      { title: 'Turn on single sign-on', done: ssoOn > 0, detail: 'Optional', href: '/admin/settings/sign-in', action: 'Open Sign-in & SSO' },
    ]
    const done = steps.filter(step => step.done).length

    const changes = db.prepare(`SELECT audit.id, occurred_at AS at, event, action, users.display_name AS actor FROM audit LEFT JOIN users ON users.id = audit.user_id
      WHERE event IN ('admin-change', 'tool-write-access', 'invite-create', 'invite-resend', 'invite-revoke') AND outcome = 'success' ORDER BY audit.id DESC LIMIT 5`).all() as { id: number, at: number, event: string, action: string | null, actor: string | null }[]
    const recent: OverviewProps['changes'] = changes.map(change => ({ mark: initials(change.actor ?? 'System'), title: changeWords[change.action ?? change.event] ?? change.action ?? change.event,
      actor: change.actor ?? 'System', at: new Date(change.at).toISOString() }))

    const health = [failing.length && `${failing.length} failing`, missing.length && `${missing.length} need${missing.length === 1 ? 's' : ''} a credential`].filter(Boolean).join(' · ')
    const stats: OverviewProps['stats'] = [
      { label: 'Tools enabled', value: `${enabled.length} / ${tools.length}`, note: enabled.length === tools.length ? 'Every tool is on' : `${tools.length - enabled.length} are off` },
      { label: 'Healthy', value: String(healthy.length), note: health || (enabled.length ? healthy.length === enabled.length ? 'Every check passed' : 'Checks still pending' : 'No tools enabled'), tone: health ? 'err' : undefined },
      { label: 'People with access', value: String(withAccess), note: [disabled && `${disabled} disabled`, pending.length && `${pending.length} invitation${pending.length === 1 ? '' : 's'} pending`].filter(Boolean).join(' · ') || `${people} ${people === 1 ? 'person' : 'people'} in total` },
      { label: 'Tools with writes on', value: String(writesOn.length), note: writesOn.length ? 'Writes are audited per operation' : 'Every tool is read-only', tone: writesOn.length ? 'warn' : 'ok' },
    ]
    const summary = `Artium is serving ${enabled.length} enabled tool${enabled.length === 1 ? '' : 's'} to ${withAccess} ${withAccess === 1 ? 'person' : 'people'}. ${attention.length ? `${attention.length} thing${attention.length === 1 ? ' needs' : 's need'} you.` : 'Nothing needs you right now.'}`
    return renderPage(reply, 'Overview', 'overview', { stats, attention, attentionEmpty, tools: toolRows, setupSummary: `${done} of ${steps.length} done`, steps, changes: recent }, current, summary)
  })
}
