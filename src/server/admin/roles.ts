import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminRoleRoutes, adminToolRoutes, adminUserParamsSchema, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { grantOrigin, personStatus, rawApiModeWords, status, toolProducts, toolState } from './design/status.js'
import { avatar, card, field, icon, pager } from './design/ui.js'
import { escape } from './escape.js'
import { adminRead, apiFormTag, changed, revision } from './forms.js'
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
    const csrf = reply.generateCsrf()
    const newRole = `<dialog id="new-role" class="modal" aria-labelledby="new-role-title"${dialog ? ' open' : ''}>
      ${apiFormTag(csrf, '/v1/admin/roles', 'POST', '', 'data-success-url="/admin/roles/{id}" data-success-message="Role created. Choose the tools it grants."')}
      <div class="modal-body"><h2 id="new-role-title">New role</h2><p>Name it for the people who need it, such as Read-only analysts. You choose its tools next.</p>
      ${field('new-role-name', 'Role name', attributes => `<input class="input" ${attributes} name="name" required autocomplete="off">`)}<p data-form-error role="alert" tabindex="-1"></p></div>
      <div class="modal-foot"><a class="btn btn-secondary" href="/admin/roles" data-close-dialog>Cancel</a><button class="btn btn-primary">Create role</button></div></form></dialog>`
    return renderPage(reply, 'Roles', 'roles', {
      roles: page.roles.map(role => ({ href: '/admin/roles/' + encodeURIComponent(role.id), name: role.name, members: members.get(role.id) ?? 0, rules: rules.get(role.id) ?? 0,
        tools: role.tools.map(tool => ({ name: toolProducts[tool].name, enabled: enabled.has(tool) })) })),
      pager: { summary: plural(total, 'role'), first: query.data.cursor ? `/admin/roles?limit=${query.data.limit}` : null,
        next: page.nextCursor ? `/admin/roles?cursor=${encodeURIComponent(page.nextCursor)}&limit=${query.data.limit}` : null },
      newRole }, current, 'A role is a set of tools. Give roles to people, or map them from SSO groups.',
    [{ label: 'New role', href: '/admin/roles?dialog=new-role', variant: 'primary', icon: 'plus', dialog: 'new-role' }])
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
    const rawRows = tools.filter(tool => tool.rawApi.modes.length > 0 && role.tools.includes(tool.name)).map(tool => {
      const product = toolProducts[tool.name].name
      return `<div class="list-row"><div class="grow"><strong>${escape(product)}</strong><p>Tool mode: ${rawApiModeWords[tool.rawApi.mode].label}.${tool.rawApi.mode === 'off' ? ' Members cannot make raw calls until an administrator changes it.' : ''}</p></div>
        ${apiFormTag(csrf, `${api}/tools/${tool.name}/raw-api`, 'PUT', `Change ${role.name}’s Raw API access to ${product}? Changes apply to every member on the next call.`, 'class="row" data-confirm-action="Save access"')}${revision(role.revision)}
        <label class="switch-row"><input type="checkbox" class="switch" role="switch" name="enabled" data-type="boolean" aria-label="Allow Raw API for ${escape(product)}"${role.rawApiTools.includes(tool.name) ? ' checked' : ''}><span>Allow</span></label>
        <button class="btn btn-secondary btn-sm">Save</button></form></div>`
    }).join('')
    const rawApi = card('Raw API access', 'Lets members make raw API calls through the tools below. The tool’s Raw API mode sets what those calls may do.',
      rawRows || '<p class="card-body muted">Grant a tool with raw API routes to offer this.</p>')
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
    const content = `<div class="meta-line">${changed(db, role)}</div>${grants}${rawApi}${memberList}<section class="card danger"><div class="list-row"><div class="grow"><h2>Delete role</h2>${remove}</div></section>`
    return browserPage(reply, 'Roles', content, current, `${plural(members.totalCount, 'member')} · ${plural(role.tools.length, 'tool')}`, { heading: role.name, actions: rename })
  })
}
