import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminRoleRoutes, adminUserRoutes } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { adminScript, adminStyle } from './assets.js'
import { escape } from './escape.js'
import { adminNav, apiForm, changed, revision } from './forms.js'

export function registerUsersPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/assets/confirm.js', async (_request, reply) => reply.type('application/javascript').send(adminScript))
  app.get('/admin/assets/style.css', async (_request, reply) => reply.type('text/css').send(adminStyle))
  app.get('/admin', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const headers = { cookie: request.headers.cookie ?? '' }
    const query = adminUserRoutes.list.input.safeParse(request.query)
    if (!query.success) throw new ArtiumError('INVALID_INPUT')
    const usersResponse = await app.inject({ method: 'GET', url: '/v1/admin/users?' + new URLSearchParams({
      limit: String(query.data.limit), ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
    }), headers })
    const users = adminUserRoutes.list.response.parse(usersResponse.json())
    const roles = [] as ReturnType<typeof adminRoleRoutes.list.response.parse>['roles']
    let cursor: string | null = null
    do {
      const response = await app.inject({ method: 'GET', url: '/v1/admin/roles?limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), headers })
      const page = adminRoleRoutes.list.response.parse(response.json())
      roles.push(...page.roles)
      cursor = page.nextCursor
    } while (cursor)
    const csrf = reply.generateCsrf()
    const roleFields = (selected: string[]) => `<fieldset><legend>Roles</legend><input type="hidden" name="roleIds" disabled>${roles.length ? roles.map(role =>
      `<label><input type="checkbox" name="roleIds" value="${escape(role.id)}"${selected.includes(role.id) ? ' checked' : ''}> ${escape(role.name)}</label>`).join('') : '<p>No roles created yet.</p>'}</fieldset>`
    const form = (action: string, method: string, label: string, fields: string, confirmation = '') =>
      apiForm(csrf, action, method, label, fields, confirmation)
    const temporaryPassword = '<label>Temporary password <input type="password" name="temporaryPassword" autocomplete="new-password" required></label>'
    const content = `${adminNav('Users')}
      <p>Signed in as ${escape(current.display_name)}.</p><p id="message" role="alert" tabindex="-1"></p>
      <section><h2>Create user</h2>${form('/v1/admin/users', 'POST', 'Create user',
        '<label>Username <input name="username" autocomplete="off" required></label><label>Display name <input name="displayName" required></label>' +
        temporaryPassword + '<label><input type="checkbox" name="administrator" data-type="boolean"> Administrator</label>' + roleFields([]))}</section>
      ${users.users.map(user => {
        const path = '/v1/admin/users/' + encodeURIComponent(user.id)
        return `<section><h2>${escape(user.username)}</h2><p>${escape(user.displayName)} | ${user.enabled ? 'Enabled' : 'Disabled'}${user.administrator ? ' | Administrator' : ''}</p>
          <p>${user.mustChange ? 'Password change required. ' : ''}Failed sign-ins: ${escape(user.failedAttempts)}. Locked until: ${escape(user.lockedUntil === null ? 'Not locked' : new Date(user.lockedUntil).toISOString())}</p>
          ${changed(db, user)}
          ${form(path, 'PATCH', user.enabled ? 'Disable user' : 'Enable user', revision(user.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${escape(!user.enabled)}">`, user.enabled ? 'Disable this user and revoke their sessions?' : 'Enable this user?')}
          ${form(path + '/unlock', 'POST', 'Unlock user', '', 'Clear this user’s sign-in lockout?')}
          <details><summary>Reset password and assign roles</summary>
          ${form(path + '/password-reset', 'POST', 'Reset password', temporaryPassword, 'Reset this password and revoke all user sessions?')}
          ${form(path + '/roles', 'PUT', 'Assign roles', revision(user.revision) + roleFields(user.roleIds), 'Replace this user’s roles?')}</details></section>`
      }).join('')}
      <p><a href="/admin">First page</a>${users.nextCursor ? ` | <a href="/admin?cursor=${escape(encodeURIComponent(users.nextCursor))}&amp;limit=${escape(query.data.limit)}">Next page</a>` : ''}</p>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escape(csrf)}"><button>Sign out</button></form>`
    return browserPage(reply, 'Users', content)
  })
}
