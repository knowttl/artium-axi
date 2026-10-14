import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { adminRoleRoutes, adminUserParamsSchema, adminUserRoutes } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { adminScript, adminStyle } from './assets.js'
import { escape } from './escape.js'
import { adminRead, apiForm, changed, revision, timestamp } from './forms.js'

export function registerUsersPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/assets/confirm.js', async (_request, reply) => reply.type('application/javascript').send(adminScript))
  app.get('/admin/assets/style.css', async (_request, reply) => reply.type('text/css').send(adminStyle))

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
  const roleFields = (roles: Awaited<ReturnType<typeof allRoles>>, selected: string[]) =>
    `<fieldset><legend>Roles</legend><input type="hidden" name="roleIds" disabled>${roles.length ? roles.map(role =>
      `<label><input type="checkbox" name="roleIds" value="${escape(role.id)}"${selected.includes(role.id) ? ' checked' : ''}> ${escape(role.name)} (Direct)</label>`).join('') : '<p>No roles yet. Create a role on Roles to grant tool access.</p>'}</fieldset>`
  const temporaryPassword = '<label>Temporary password <input type="password" name="temporaryPassword" autocomplete="new-password" required></label><p>Use 15 to 128 characters, avoiding common passwords. Share securely; the person must replace it on first sign-in.</p>'
  const administratorField = (selected: boolean) => `<label><input type="checkbox" name="administrator" data-type="boolean"${selected ? ' checked' : ''}> Administrator</label><p>Administrators can manage all users, roles and credentials. Tool access still comes from roles.</p>`

  app.get('/admin', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const query = adminUserRoutes.list.input.safeParse(request.query)
    if (!query.success) throw new ArtiumError('INVALID_INPUT')
    const params = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const users = await adminRead(app, request, '/v1/admin/users?' + params, adminUserRoutes.list.response)
    const roles = await allRoles(request)
    const csrf = reply.generateCsrf()
    const select = (name: 'source' | 'status' | 'role', label: string, options: [string, string][]) => `<label>${label}<select name="${name}"><option value="">All</option>${options.map(([value, text]) =>
      `<option value="${escape(value)}"${query.data[name] === value ? ' selected' : ''}>${escape(text)}</option>`).join('')}</select></label>`
    const link = (cursor?: string) => {
      const next = new URLSearchParams(params)
      next.delete('cursor')
      if (cursor) next.set('cursor', cursor)
      return '/admin?' + escape(next.toString())
    }
    const content = `<section><h2>Find users</h2><form method="get" action="/admin" data-filters>
      <label>Search <input name="q" value="${escape(query.data.q ?? '')}" maxlength="256"></label><p>Matches any part of a username or display name.</p>
      ${select('source', 'Sign-in source', [['local', 'Local password']])}
      ${select('status', 'Status', [['enabled', 'Enabled'], ['disabled', 'Disabled']])}
      ${select('role', 'Role', roles.map(role => [role.id, role.name]))}
      <input type="hidden" name="limit" value="${query.data.limit}"><button>Search users</button> <a href="/admin">Clear filters</a></form>
      <p>${users.users.length} shown of ${users.totalCount} matching users.</p>
      ${users.users.length ? `<div class="table-scroll"><table><caption>Users</caption><thead><tr><th>Username</th><th>Display name</th><th>Source</th><th>Status</th><th>Administrator</th><th>Roles</th></tr></thead><tbody>${users.users.map(user =>
        `<tr><th scope="row"><a href="/admin/users/${escape(encodeURIComponent(user.id))}">${escape(user.username)}</a></th><td>${escape(user.displayName)}</td><td>Local password</td><td>${user.enabled ? 'Enabled' : 'Disabled'}</td><td>${user.administrator ? 'Yes' : 'No'}</td><td>${user.roleIds.map(id => escape(roles.find(role => role.id === id)?.name ?? id)).join(', ') || 'None'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No matching users. Clear the filters or create a local user below.</p>'}
      <p><a href="${link()}">First page</a>${users.nextCursor ? ` | <a href="${link(users.nextCursor)}">Next page</a>` : ''}</p></section>
      <section><h2>New local user</h2>${apiForm(csrf, '/v1/admin/users', 'POST', 'Create user',
        '<label>Username <input name="username" autocomplete="off" required></label><p>Use a unique username without spaces. It cannot be renamed.</p><label>Display name <input name="displayName" required></label>' +
        temporaryPassword + administratorField(false) + roleFields(roles, []))}</section>`
    return browserPage(reply, 'Users', content, current)
  })

  app.get('/admin/users/:id', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const params = adminUserParamsSchema.safeParse(request.params)
    if (!params.success) throw new ArtiumError('INVALID_INPUT')
    const path = '/v1/admin/users/' + encodeURIComponent(params.data.id)
    const user = await adminRead(app, request, path, adminUserRoutes.get.response)
    const roles = await allRoles(request)
    const csrf = reply.generateCsrf()
    const form = (action: string, method: string, label: string, fields: string, confirmation: string) =>
      apiForm(csrf, action, method, label, fields, confirmation)
    const content = `<p><a href="/admin">Back to users</a></p><section><h2>${escape(user.username)}</h2>
      <p>Sign-in source: Local password. ${user.enabled ? 'Enabled' : 'Disabled'}.</p>${changed(db, user)}
      ${form(path, 'PATCH', 'Save profile', revision(user.revision) + `<label>Display name <input name="displayName" value="${escape(user.displayName)}" required></label>` + administratorField(user.administrator), `Update ${user.username}’s profile and administrator capability? Administrator access changes immediately.`)}</section>
      <section><h2>Roles</h2><p>Direct roles were assigned by an administrator. Saving replaces the whole selection.</p>
      ${form(path + '/roles', 'PUT', 'Assign roles', revision(user.revision) + roleFields(roles, user.roleIds), `Replace ${user.username}’s roles with this selection? Tool access changes on the next call.`)}</section>
      <section><h2>Effective tools</h2><p>These grants combine all assigned roles. A disabled user or tool cannot run calls.</p>
      ${user.effectiveTools.length ? `<div class="table-scroll"><table><caption>Effective tools for ${escape(user.username)}</caption><thead><tr><th>Tool</th><th>Access</th><th>Granted by</th></tr></thead><tbody>${user.effectiveTools.map(tool =>
        `<tr><th scope="row">${escape(tool.name)}</th><td>${tool.enabled ? 'Available' : user.enabled ? 'Tool disabled' : 'User disabled'}</td><td>${tool.roleIds.map(id => `<a href="/admin/roles/${escape(encodeURIComponent(id))}">${escape(roles.find(role => role.id === id)?.name ?? id)}</a> (Direct)`).join(', ')}</td></tr>`).join('')}</tbody></table></div>` : '<p>No tools granted. Assign a role that grants tools above.</p>'}</section>
      <section><h2>Sign-in controls</h2><p>${user.mustChange ? 'Password change required. ' : ''}Failed sign-ins: ${user.failedAttempts}. Locked until: ${timestamp(user.lockedUntil, 'Not locked')}</p>
      ${form(path, 'PATCH', user.enabled ? 'Disable user' : 'Enable user', revision(user.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${!user.enabled}">`, user.enabled ? `Disable ${user.username}? Sign-in is blocked and all their browser and CLI sessions are revoked immediately.` : `Enable ${user.username}? They can sign in again; revoked sessions stay signed out.`)}
      ${form(path + '/unlock', 'POST', 'Unlock user', '', `Clear ${user.username}’s failed sign-in attempts and lockout? Their password and sessions stay unchanged.`)}
      <details><summary>Reset password</summary>${form(path + '/password-reset', 'POST', 'Reset password', temporaryPassword, `Reset ${user.username}’s password? All their sessions are revoked and they must change the temporary password on next sign-in.`)}</details></section>`
    return browserPage(reply, 'Users', content, current)
  })
}
