import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminRoleRoutes, adminToolRoutes, adminUserParamsSchema, adminUserRoutes, type toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { registerAdminClientAssets } from './client-assets.js'
import { adminRead, lastChange } from './forms.js'
import { sessionsProps } from './session-card.js'
import { components } from './design/components.js'
import { describe, statusWord, toolProducts } from './design/status.js'
import { tokens } from './design/tokens.js'
import { initials } from './design/ui.js'
import { renderPage } from './render-page.js'
import type { PersonProps } from '../../views/person.js'
import type { Status } from '../../views/status.js'

type Role = { id: string, name: string, tools: z.infer<typeof toolSchema>[] }

const frame = readFileSync(new URL('./design/frame.css', import.meta.url), 'utf8')
const forms = readFileSync(new URL('./design/forms.css', import.meta.url), 'utf8')

export const roleTools = (role: Role) => role.tools.map(tool => toolProducts[tool].name).join(', ') || 'No tools yet'

// A role chip naming where the person's grant comes from: Direct, SSO rule, or both.
function roleLabel(user: { roleGrants: { roleId: string, origin: string }[] }, id: string, name: string, alwaysOrigin: boolean): string {
  const origins = new Set(user.roleGrants.filter(grant => grant.roleId === id).map(grant => grant.origin === 'direct' ? statusWord('grant', 'direct') : statusWord('grant', 'rule')))
  const show = alwaysOrigin || origins.has(statusWord('grant', 'rule'))
  return `${name}${show ? ` · ${[...origins].sort().join(', ')}` : ''}`
}

const roleLink = (user: { roleGrants: { roleId: string, origin: string }[] }, id: string, name: string, alwaysOrigin: boolean) =>
  ({ href: '/admin/roles/' + encodeURIComponent(id), label: roleLabel(user, id, name, alwaysOrigin) })

const signInState = (user: { source: string, breakGlass: boolean }) => user.source === 'sso' ? 'sso' : user.breakGlass ? 'break-glass' : 'password'

export function registerUsersPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/assets/style.css', async (_request, reply) => reply.type('text/css').send(tokens + components + frame + forms))
  registerAdminClientAssets(app)

  async function allRoles(request: FastifyRequest) {
    const roles: ReturnType<typeof adminRoleRoutes.list.response.parse>['roles'] = []
    let cursor: string | null = null
    do {
      const page: ReturnType<typeof adminRoleRoutes.list.response.parse> = await adminRead(app, request, '/v1/admin/roles?limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), adminRoleRoutes.list.response)
      roles.push(...page.roles)
      cursor = page.nextCursor
    } while (cursor)
    return roles
  }
  const locked = (user: { lockedUntil: number | null }) => user.lockedUntil !== null && user.lockedUntil > Date.now()

  app.get('/admin/users', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    // Empty filter fields mean no filter, so the GET form works without JavaScript.
    const { sheet: open, ...filters } = Object.fromEntries(Object.entries(request.query as Record<string, unknown>).filter(([, value]) => value !== ''))
    const query = adminUserRoutes.list.input.safeParse(filters)
    if (!query.success || !z.enum(['add-user']).optional().safeParse(open).success) throw new ArtiumError('INVALID_INPUT')
    const params = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const users = await adminRead(app, request, '/v1/admin/users?' + params, adminUserRoutes.list.response)
    const roles = await allRoles(request)
    const csrf = reply.generateCsrf()
    const roleName = (id: string) => roles.find(role => role.id === id)?.name ?? id
    const link = (cursor?: string) => {
      const next = new URLSearchParams(params)
      next.delete('cursor')
      if (cursor) next.set('cursor', cursor)
      return '/admin/users?' + next.toString()
    }
    const filtered = Boolean(query.data.q || query.data.source || query.data.status || query.data.role)
    const filterSelects: [name: 'source' | 'status' | 'role', label: string, options: [string, string][]][] = [
      ['source', 'Sign-in', [['local', 'Password'], ['sso', 'SSO']]], ['status', 'Status', [['enabled', 'Enabled'], ['disabled', 'Disabled']]],
      ['role', 'Role', roles.map(role => [role.id, role.name])]]
    return renderPage(reply, 'People', 'people', {
      filters: { q: query.data.q ?? '', limit: query.data.limit, clear: filtered, count: `${users.totalCount} ${users.totalCount === 1 ? 'person' : 'people'}`,
        selects: filterSelects.map(([name, label, options]) => ({ name, label, options, value: query.data[name] ?? '' })) },
      people: users.users.map(user => ({ href: '/admin/users/' + encodeURIComponent(user.id), name: user.displayName, initials: initials(user.displayName), username: user.username, you: user.id === current.user_id,
        signIn: describe('signIn', signInState(user)), administrator: user.administrator, status: describe('person', user.enabled ? locked(user) ? 'locked' : 'enabled' : 'disabled'),
        enabled: user.enabled, roles: user.roleIds.map(id => ({ href: '/admin/roles/' + encodeURIComponent(id), label: roleLabel(user, id, roleName(id), false) })) })),
      empty: filtered ? 'Nobody matches these filters. Clear the filters or add a user.' : 'Add a local user, or invite someone to sign in with SSO.',
      pager: { summary: `Showing ${users.users.length} of ${users.totalCount}`, first: query.data.cursor ? link() : null, next: users.nextCursor ? link(users.nextCursor) : null },
      addUser: { open: open === 'add-user', closeHref: link(query.data.cursor), csrf, roles: roles.map(role => ({ id: role.id, name: role.name, detail: roleTools(role) })) } }, current, 'Everyone who can sign in. Tool access comes from their roles.',
    [{ label: 'Invite with SSO', href: '/admin/invitations?sheet=new-invitation', variant: 'secondary', icon: 'mail' },
      { label: 'Add user', href: link(query.data.cursor).replace('?', '?sheet=add-user&'), variant: 'primary', icon: 'plus', sheet: 'sheet-add-user' }])
  })

  app.get('/admin/users/:id', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const params = adminUserParamsSchema.safeParse(request.params)
    const open = z.strictObject({ sheet: z.enum(['reset-password']).optional() }).safeParse(request.query)
    if (!params.success || !open.success) throw new ArtiumError('INVALID_INPUT')
    const page = '/admin/users/' + encodeURIComponent(params.data.id)
    const path = '/v1/admin/users/' + encodeURIComponent(params.data.id)
    const user = await adminRead(app, request, path, adminUserRoutes.get.response)
    const roles = await allRoles(request)
    const csrf = reply.generateCsrf()
    const roleName = (id: string) => roles.find(role => role.id === id)?.name ?? id
    const ruleGrants = user.roleGrants.filter(grant => grant.origin !== 'direct').map(grant => {
      const provider = db.prepare('SELECT kind FROM sso_providers JOIN role_rules ON role_rules.provider_id = sso_providers.id WHERE role_rules.id = ?')
        .get(grant.origin) as { kind: string }
      return { role: roleName(grant.roleId), provider: provider.kind === 'entra' ? 'Entra ID' : 'OpenID Connect', rule: grant.origin }
    })
    const identity = (state: Status) => ({ initials: initials(user.displayName), username: user.username, signIn: describe('signIn', signInState(user)), state, administrator: user.administrator })
    const respond = (props: PersonProps) => renderPage(reply, 'People', 'person', props, current, undefined, undefined, user.displayName)
    const changed = lastChange(db, user)

    if (user.archivedAt !== null) {
      return respond({ identity: identity(describe('person', 'archived')), changed, ruleGrants, active: null,
        archived: { at: new Date(user.archivedAt).toISOString(), roles: user.roleIds.map(id => roleLink(user, id, roleName(id), true)) } })
    }

    const sessions = await adminRead(app, request, path + '/sessions', adminUserRoutes.sessions.response)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const isLocked = locked(user)
    const menu = { auditHref: '/admin/audit?user=' + encodeURIComponent(user.id), breakGlass: user.source === 'local' && user.administrator ? { designated: user.breakGlass } : null }
    return respond({ identity: identity(describe('person', user.enabled ? isLocked ? 'locked' : 'enabled' : 'disabled')), changed, ruleGrants, archived: null,
      active: { csrf, path, revision: user.revision, displayName: user.displayName, administrator: user.administrator, enabled: user.enabled, menu,
        linkToSso: user.source === 'local' && user.enabled ? `/admin/invitations?userId=${encodeURIComponent(user.id)}&sheet=new-invitation` : null,
        roles: roles.map(role => ({ id: role.id, name: role.name, detail: roleTools(role) + (user.directRoleIds.includes(role.id) ? ' · Direct' : '') })), directRoleIds: user.directRoleIds,
        tools: user.effectiveTools.map(tool => ({ name: tool.name, product: toolProducts[tool.name].name, mark: toolProducts[tool.name].mark,
          access: describe('access', tool.enabled ? 'yes' : user.enabled ? 'tool-disabled' : 'person-disabled'),
          failing: tool.enabled && tools.find(item => item.name === tool.name)?.health.status === 'error', grantedBy: tool.roleIds.map(id => roleLink(user, id, roleName(id), true)) })),
        sessions: sessionsProps(csrf, path + '/sessions', sessions.sessions),
        facts: { method: user.source === 'sso' ? 'SSO' : user.breakGlass ? 'Break-glass password' : 'Local password', failedAttempts: user.failedAttempts,
          lockedUntil: isLocked ? new Date(user.lockedUntil!).toISOString() : null, password: user.source === 'local' ? user.mustChange ? 'Password change required' : 'Set by them' : null },
        reset: user.source === 'local' ? { open: open.data.sheet === 'reset-password', closeHref: page } : null } })
  })
}
