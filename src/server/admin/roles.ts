import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminRoleRoutes, adminToolRoutes, adminUserParamsSchema, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { grantOrigin, personStatus, status, toolProducts, toolState } from './design/status.js'
import { avatar, icon, pager } from './design/ui.js'
import { escape } from './escape.js'
import { adminRead, apiFormTag, changed, revision } from './forms.js'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const visibleChips = 4

function roleCounts(db: Database.Database, table: 'user_roles' | 'role_rules' | 'invitation_roles', column: string): Map<string, number> {
  const rows = db.prepare(`SELECT role_id AS id, COUNT(DISTINCT ${column}) AS count FROM ${table} GROUP BY role_id`).all() as { id: string, count: number }[]
  return new Map(rows.map(row => [row.id, row.count]))
}

export function registerRolesPages(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/roles', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    // `dialog` is the no-JavaScript view of the New role dialog, rendered open.
    const { dialog, ...filters } = request.query as Record<string, unknown>
    const query = adminRoleRoutes.list.input.safeParse(filters)
    if (!query.success || (dialog !== undefined && dialog !== 'new-role')) throw new ArtiumError('INVALID_INPUT')
    const params = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const page = await adminRead(app, request, '/v1/admin/roles?' + params, adminRoleRoutes.list.response)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const enabled = new Set(tools.filter(tool => tool.enabled).map(tool => tool.name))
    const members = roleCounts(db, 'user_roles', 'user_id')
    const rules = roleCounts(db, 'role_rules', 'id')
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM roles').get() as { total: number }
    const chip = (tool: (typeof toolSchema.options)[number]) => enabled.has(tool)
      ? `<span class="chip">${escape(toolProducts[tool].name)}</span>`
      : `<span class="chip" title="Tool disabled"><span class="dot off" aria-hidden="true"></span>${escape(toolProducts[tool].name)}<span class="sr-only"> (disabled)</span></span>`
    const rows = page.roles.map(role => {
      // A long list keeps one chip slot for the count of the rest.
      const shown = role.tools.length > visibleChips ? visibleChips - 1 : visibleChips
      const rest = role.tools.slice(shown)
      const chips = role.tools.slice(0, shown).map(chip).join('') +
        (rest.length ? `<span class="chip" title="${escape(rest.map(tool => toolProducts[tool].name).join(', '))}">+${rest.length}<span class="sr-only"> more: ${escape(rest.map(tool => toolProducts[tool].name).join(', '))}</span></span>` : '')
      const count = (counts: Map<string, number>) => counts.get(role.id) ?? 0
      return `<tr><th scope="row"><a href="/admin/roles/${escape(encodeURIComponent(role.id))}">${escape(role.name)}</a></th>
        <td>${role.tools.length ? `<div class="chips">${chips}</div>` : '<span class="faint">No tools yet</span>'}</td>
        <td class="num" data-label="Members">${count(members)}</td><td class="num${count(rules) ? '' : ' faint'}" data-label="SSO rules">${count(rules)}</td><td class="num faint">${icon('chev')}</td></tr>`
    }).join('')
    const csrf = reply.generateCsrf()
    const newRole = `<dialog id="new-role" class="modal" aria-labelledby="new-role-title"${dialog ? ' open' : ''}>
      ${apiFormTag(csrf, '/v1/admin/roles', 'POST', '', 'data-success-url="/admin/roles/{id}" data-success-message="Role created. Choose the tools it grants."')}
      <div class="modal-body"><h2 id="new-role-title">New role</h2><p>Name it for the people who need it, such as Read-only analysts. You choose its tools next.</p>
      <label for="new-role-name">Role name</label><input id="new-role-name" name="name" required autocomplete="off"></div>
      <div class="modal-foot"><a class="btn btn-secondary" href="/admin/roles" data-close-dialog>Cancel</a><button class="btn btn-primary">Create role</button></div></form></dialog>`
    const list = page.roles.length ? `<section class="card"><table class="tbl row-links stack"><caption class="sr-only">Roles and tool grants</caption>
      <thead><tr><th scope="col">Role</th><th scope="col">Tools</th><th scope="col" class="num">Members</th><th scope="col" class="num">SSO rules</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
      <tbody>${rows}</tbody></table>
      <p class="card-note"><span class="dot off" aria-hidden="true"></span>Grey dot: the tool is disabled, so members can't use it yet.</p>
      ${pager(plural(total, 'role'), [{ label: 'First', href: query.data.cursor ? `/admin/roles?limit=${query.data.limit}` : null },
        { label: 'Next', href: page.nextCursor ? `/admin/roles?cursor=${encodeURIComponent(page.nextCursor)}&limit=${query.data.limit}` : null }])}</section>`
      : `<section class="card empty"><h2>No roles yet</h2><p>A role is a set of tools. Create one, choose its tools, then give it to people.</p><a class="btn btn-primary" href="/admin/roles?dialog=new-role" data-open-dialog="new-role">${icon('plus')}New role</a></section>`
    return browserPage(reply, 'Roles', newRole + list, current, 'A role is a set of tools. Give roles to people, or map them from SSO groups.', {
      actions: `<div class="actions"><a class="btn btn-primary" href="/admin/roles?dialog=new-role" data-open-dialog="new-role">${icon('plus')}New role</a></div>`,
    })
  })

  app.get('/admin/roles/:id', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const params = adminUserParamsSchema.safeParse(request.params)
    const query = adminRoleRoutes.members.input.safeParse(request.query)
    if (!params.success || !query.success) throw new ArtiumError('INVALID_INPUT')
    const path = '/admin/roles/' + encodeURIComponent(params.data.id)
    const api = '/v1' + path
    const role = await adminRead(app, request, api, adminRoleRoutes.get.response)
    const membersQuery = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const members = await adminRead(app, request, api + '/members?' + membersQuery, adminRoleRoutes.members.response)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const csrf = reply.generateCsrf()
    const rename = `<details class="inline-edit"><summary class="btn btn-ghost btn-icon btn-sm" aria-label="Rename role">${icon('pen')}</summary><div class="popover">
      ${apiFormTag(csrf, api, 'PATCH', '', 'data-success-message="Role renamed."')}${revision(role.revision)}
      <label for="role-name">Role name</label><input id="role-name" name="name" value="${escape(role.name)}" required autocomplete="off">
      <div class="actions"><button class="btn btn-primary btn-sm">Rename</button></div></form></div></details>`
    const tiles = toolSchema.options.map(name => {
      const tool = tools.find(candidate => candidate.name === name)!
      const granted = role.tools.includes(name)
      const state = toolState(tool)
      return `<label class="tile"><input type="checkbox" name="tools" value="${name}"${granted ? ' checked' : ''}><span class="tool-ico" aria-hidden="true">${toolProducts[name].mark}</span>
        <span class="tile-text"><strong>${escape(toolProducts[name].name)}</strong>${status(state.word, state.tone, granted && !tool.enabled ? 'members can’t use it yet' : undefined)}</span></label>`
    }).join('')
    const grants = `<section class="card">${apiFormTag(csrf, api + '/tools', 'PUT', `Replace ${role.name}’s tool grants? Changes apply to every member on the next call.`, 'data-confirm-action="Save tools" data-track-changes')}${revision(role.revision)}
      <div class="card-head"><div><h2>Tools this role grants</h2><p>Changes apply to every member on their next call.</p></div></div>
      <div class="card-body"><fieldset class="tiles"><legend class="sr-only">Granted tools</legend><input name="tools" type="hidden" disabled data-type="array">${tiles}</fieldset></div>
      <div class="card-foot"><span>Saving replaces the whole selection. A tool must also be enabled before members can run it.</span><div class="actions"><button class="btn btn-primary btn-sm">Save tools</button><button type="reset" class="btn btn-ghost btn-sm" data-discard hidden>Discard</button></div></div></form></section>`
    const memberRows = members.users.map(user => `<tr><th scope="row"><a class="cell-main" href="/admin/users/${escape(encodeURIComponent(user.id))}">${avatar(user.displayName)}<span><strong>${escape(user.displayName)}</strong><span>${escape(user.username)}</span></span></a></th>
      <td><div class="chips">${[...new Set(user.roleGrants.filter(grant => grant.roleId === role.id).map(grant => grant.origin === 'direct' ? 'direct' : 'rule'))].map(grantOrigin).join('')}</div></td><td>${personStatus(user)}</td></tr>`).join('')
    const memberList = `<section class="card"><div class="card-head"><div><h2>Members</h2><p>Give or remove this role on a person's page, or map it from SSO groups with a role rule.</p></div></div>
      ${members.users.length ? `<table class="tbl row-links stack"><caption class="sr-only">Members of ${escape(role.name)}</caption><thead><tr><th scope="col">Name</th><th scope="col">How</th><th scope="col">Status</th></tr></thead><tbody>${memberRows}</tbody></table>
      ${pager(`Showing ${members.users.length} of ${members.totalCount}`, [{ label: 'First', href: query.data.cursor ? `${path}?limit=${query.data.limit}` : null },
        { label: 'Next', href: members.nextCursor ? `${path}?cursor=${encodeURIComponent(members.nextCursor)}&limit=${query.data.limit}` : null }])}`
      : '<p class="card-body muted">No members yet. Give this role to people on their page in People.</p>'}</section>`
    const { rules } = db.prepare('SELECT COUNT(*) AS rules FROM role_rules WHERE role_id = ?').get(role.id) as { rules: number }
    const { invitations } = db.prepare('SELECT COUNT(*) AS invitations FROM invitation_roles WHERE role_id = ?').get(role.id) as { invitations: number }
    const blockers = [[members.totalCount, 'member'], [rules, 'SSO rule'], [invitations, 'invitation']] as const
    const blocked = blockers.filter(([count]) => count > 0).map(([count, word]) => plural(count, word))
    const remove = blocked.length
      ? `<p>Only an unused role can be deleted. Blocked by: ${escape(blocked.join(', '))}. ${members.totalCount ? 'Remove the role from each member. ' : ''}${rules ? 'Remove or retarget its rules in Sign-in &amp; SSO. ' : ''}${invitations ? 'Invitation history keeps the role.' : ''}</p></div><button class="btn btn-danger-outline btn-sm" type="button" disabled>Delete…</button>`
      : `<p>Deletes the role and its tool grants. This cannot be undone.</p></div>${apiFormTag(csrf, api, 'DELETE', `Delete ${role.name}? Its tool grants will be removed. This cannot be undone.`,
        `data-confirm-action="Delete role" data-confirm-name="${escape(role.name)}" data-success-url="/admin/roles" data-success-message="Role deleted."`)}${revision(role.revision)}<button class="btn btn-danger-outline btn-sm">Delete…</button></form>`
    const content = `<div class="meta-line">${changed(db, role)}</div>${grants}${memberList}<section class="card danger"><div class="list-row"><div class="grow"><h2>Delete role</h2>${remove}</div></section>`
    return browserPage(reply, 'Roles', content, current, `${plural(members.totalCount, 'member')} · ${plural(role.tools.length, 'tool')}`, { heading: role.name, actions: rename })
  })
}
