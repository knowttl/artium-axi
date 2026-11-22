import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminRoleRoutes, adminToolRoutes, adminUserParamsSchema, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { describe, rawApiModeWords, toolProducts, toolState } from './design/status.js'
import { initials } from './chrome.js'
import { adminRead, lastChange } from './forms.js'
import { renderPage } from './render-page.js'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function roleCounts(db: Database.Database, table: 'user_roles' | 'role_rules' | 'invitation_roles', column: string): Map<string, number> {
  const rows = db.prepare(`SELECT role_id AS id, COUNT(DISTINCT ${column}) AS count FROM ${table} GROUP BY role_id`).all() as { id: string, count: number }[]
  return new Map(rows.map(row => [row.id, row.count]))
}

export function registerRolesPages(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/roles', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    // `sheet` is the no-JavaScript view of the New role sheet, rendered open; `dialog` is the link from before the sheet and redirects to it.
    const { dialog, sheet: open, ...filters } = request.query as Record<string, unknown>
    const query = adminRoleRoutes.list.input.safeParse(filters)
    if (!query.success || (dialog !== undefined && dialog !== 'new-role') || (open !== undefined && open !== 'new-role')) throw new ArtiumError('INVALID_INPUT')
    const params = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    if (dialog) return reply.redirect('/admin/roles?' + new URLSearchParams([...params, ['sheet', 'new-role']]))
    const page = await adminRead(app, request, '/v1/admin/roles?' + params, adminRoleRoutes.list.response)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const enabled = new Set(tools.filter(tool => tool.enabled).map(tool => tool.name))
    const members = roleCounts(db, 'user_roles', 'user_id')
    const rules = roleCounts(db, 'role_rules', 'id')
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM roles').get() as { total: number }
    const csrf = reply.generateCsrf()
    return renderPage(reply, 'Roles', 'roles', {
      roles: page.roles.map(role => ({ href: '/admin/roles/' + encodeURIComponent(role.id), name: role.name, members: members.get(role.id) ?? 0, rules: rules.get(role.id) ?? 0,
        tools: role.tools.map(tool => ({ name: toolProducts[tool].name, enabled: enabled.has(tool) })) })),
      pager: { summary: plural(total, 'role'), first: query.data.cursor ? `/admin/roles?limit=${query.data.limit}` : null,
        next: page.nextCursor ? `/admin/roles?cursor=${encodeURIComponent(page.nextCursor)}&limit=${query.data.limit}` : null },
      newRole: { open: open === 'new-role', closeHref: '/admin/roles', csrf } }, current, 'A role is a set of tools. Give roles to people, or map them from SSO groups.',
    [{ label: 'New role', href: '/admin/roles?sheet=new-role', variant: 'primary', icon: 'plus', sheet: 'sheet-new-role' }])
  })

  app.get('/admin/roles/:id', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    // `sheet` is the no-JavaScript view of the Rename role sheet, rendered open.
    const { sheet: open, ...filters } = request.query as Record<string, unknown>
    const params = adminUserParamsSchema.safeParse(request.params)
    const query = adminRoleRoutes.members.input.safeParse(filters)
    if (!params.success || !query.success || (open !== undefined && open !== 'rename-role')) throw new ArtiumError('INVALID_INPUT')
    const path = '/admin/roles/' + encodeURIComponent(params.data.id)
    const api = '/v1' + path
    const role = await adminRead(app, request, api, adminRoleRoutes.get.response)
    const membersQuery = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const members = await adminRead(app, request, api + '/members?' + membersQuery, adminRoleRoutes.members.response)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const { rules } = db.prepare('SELECT COUNT(*) AS rules FROM role_rules WHERE role_id = ?').get(role.id) as { rules: number }
    const { invitations } = db.prepare('SELECT COUNT(*) AS invitations FROM invitation_roles WHERE role_id = ?').get(role.id) as { invitations: number }
    const blockers = [[members.totalCount, 'member'], [rules, 'SSO rule'], [invitations, 'invitation']] as const
    const blocked = blockers.filter(([count]) => count > 0).map(([count, word]) => plural(count, word))
    const advice = [members.totalCount ? 'Remove the role from each member.' : '', rules ? 'Remove or retarget its rules in Sign-in & SSO.' : '',
      invitations ? 'Invitation history keeps the role.' : ''].filter(Boolean).join(' ')
    const csrf = reply.generateCsrf()
    return renderPage(reply, 'Roles', 'role', {
      csrf, path: api, name: role.name, changed: lastChange(db, role),
      tools: toolSchema.options.map(name => {
        const tool = tools.find(candidate => candidate.name === name)!
        const granted = role.tools.includes(name)
        return { name, product: toolProducts[name].name, mark: toolProducts[name].mark, granted, state: toolState(tool), note: granted && !tool.enabled ? 'members can’t use it yet' : null }
      }),
      rawApi: tools.filter(tool => tool.rawApi.modes.length > 0 && role.tools.includes(tool.name)).map(tool =>
        ({ name: tool.name, product: toolProducts[tool.name].name, mode: rawApiModeWords[tool.rawApi.mode].label, off: tool.rawApi.mode === 'off', allowed: role.rawApiTools.includes(tool.name) })),
      members: {
        people: members.users.map(user => ({ href: '/admin/users/' + encodeURIComponent(user.id), name: user.displayName, initials: initials(user.displayName), username: user.username,
          grants: [...new Set(user.roleGrants.filter(grant => grant.roleId === role.id).map(grant => grant.origin === 'direct' ? 'direct' as const : 'rule' as const))].map(origin => describe('grant', origin)),
          state: describe('person', user.archivedAt !== null ? 'archived' : user.enabled ? 'enabled' : 'disabled') })),
        pager: { summary: `Showing ${members.users.length} of ${members.totalCount}`, first: query.data.cursor ? `${path}?limit=${query.data.limit}` : null,
          next: members.nextCursor ? `${path}?cursor=${encodeURIComponent(members.nextCursor)}&limit=${query.data.limit}` : null } },
      blocked: blocked.length ? `Only an unused role can be deleted. Blocked by: ${blocked.join(', ')}. ${advice}` : null,
      rename: { open: open === 'rename-role', closeHref: `${path}?${membersQuery}` } }, current,
    `${plural(members.totalCount, 'member')} · ${plural(role.tools.length, 'tool')}`,
    [{ label: 'Rename role', href: `${path}?${new URLSearchParams([...membersQuery, ['sheet', 'rename-role']])}`, variant: 'secondary', icon: 'pen', sheet: 'sheet-rename-role' }], role.name)
  })
}
