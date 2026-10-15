import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminRoleRoutes, adminUserParamsSchema, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { adminRead, apiForm, changed, revision } from './forms.js'

export function registerRolesPages(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/roles', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const query = adminRoleRoutes.list.input.safeParse(request.query)
    if (!query.success) throw new ArtiumError('INVALID_INPUT')
    const params = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const page = await adminRead(app, request, '/v1/admin/roles?' + params, adminRoleRoutes.list.response)
    const content = `<section><h2>Create role</h2>${apiForm(reply.generateCsrf(), '/v1/admin/roles', 'POST', 'Create role',
      '<label>Role name <input name="name" required></label><p>Use a unique name that describes who needs the tools, such as Read-only analysts.</p>')}</section>
      <section><h2>Roles</h2>${page.roles.length ? `<div class="table-scroll"><table><caption>Roles and tool grants</caption><thead><tr><th>Role</th><th>Granted tools</th></tr></thead><tbody>${page.roles.map(role =>
        `<tr><th scope="row"><a href="/admin/roles/${escape(encodeURIComponent(role.id))}">${escape(role.name)}</a></th><td>${role.tools.map(escape).join(', ') || 'No tools granted'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No roles yet. Create one above, grant tools, then assign it on a user detail page.</p>'}
      <p><a href="/admin/roles?limit=${query.data.limit}">First page</a>${page.nextCursor ? ` | <a href="/admin/roles?cursor=${escape(encodeURIComponent(page.nextCursor))}&amp;limit=${query.data.limit}">Next page</a>` : ''}</p></section>`
    return browserPage(reply, 'Roles', content, current)
  })

  app.get('/admin/roles/:id', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const params = adminUserParamsSchema.safeParse(request.params)
    const query = adminRoleRoutes.members.input.safeParse(request.query)
    if (!params.success || !query.success) throw new ArtiumError('INVALID_INPUT')
    const api = '/v1/admin/roles/' + encodeURIComponent(params.data.id)
    const role = await adminRead(app, request, api, adminRoleRoutes.get.response)
    const membersQuery = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const members = await adminRead(app, request, api + '/members?' + membersQuery, adminRoleRoutes.members.response)
    const csrf = reply.generateCsrf()
    const content = `<p><a href="/admin/roles">Back to roles</a></p><section><h2>${escape(role.name)}</h2>${changed(db, role)}
      ${apiForm(csrf, api, 'PATCH', 'Rename role', revision(role.revision) + `<label>Role name <input name="name" value="${escape(role.name)}" required></label>`, `Rename ${role.name}? Members and tool grants stay unchanged.`)}
      ${apiForm(csrf, api + '/tools', 'PUT', 'Save tool grants', revision(role.revision) + '<fieldset><legend>Granted tools</legend><input name="tools" type="hidden" disabled data-type="array">' +
        toolSchema.options.map(tool => `<label><input type="checkbox" name="tools" value="${tool}"${role.tools.includes(tool) ? ' checked' : ''}> ${tool}</label>`).join('') + '</fieldset><p>Saving replaces all grants. Tools must also be enabled before members can run them.</p>', `Replace ${role.name}’s tool grants? Changes apply to every member on the next call.`)}</section>
      <section><h2>Members</h2><p>${members.users.length} shown of ${members.totalCount} members. Direct means an administrator assigned this role.</p>
      ${members.users.length ? `<div class="table-scroll"><table><caption>Members of ${escape(role.name)}</caption><thead><tr><th>Username</th><th>Display name</th><th>Status</th><th>Assignment</th></tr></thead><tbody>${members.users.map(user =>
        `<tr><th scope="row"><a href="/admin/users/${escape(encodeURIComponent(user.id))}">${escape(user.username)}</a></th><td>${escape(user.displayName)}</td><td>${user.archivedAt !== null ? 'Archived' : user.enabled ? 'Enabled' : 'Disabled'}</td><td>${db.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND origin != 'direct'").get(user.id, role.id) ? 'Rule' : 'Direct'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No members. Assign this role on a user detail page to grant its tools.</p>'}
      <p><a href="/admin/roles/${escape(encodeURIComponent(role.id))}?limit=${query.data.limit}">First page</a>${members.nextCursor ? ` | <a href="/admin/roles/${escape(encodeURIComponent(role.id))}?cursor=${escape(encodeURIComponent(members.nextCursor))}&amp;limit=${query.data.limit}">Next page</a>` : ''}</p></section>
      <section><h2>Delete role</h2>${members.totalCount ? '<p>Remove this role from every member before deleting it. Open each member above to edit their roles.</p>' :
        apiForm(csrf, api, 'DELETE', 'Delete empty role', revision(role.revision), `Delete ${role.name}? Its tool grants will be removed. This cannot be undone.`, 'data-success-url="/admin/roles"')}</section>`
    return browserPage(reply, 'Roles', content, current)
  })
}
