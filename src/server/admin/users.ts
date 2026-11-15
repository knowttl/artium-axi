import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminRoleRoutes, adminToolRoutes, adminUserParamsSchema, adminUserRoutes, type toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { adminScript, adminStyle } from './assets.js'
import { registerAdminClientAssets } from './client-assets.js'
import { escape } from './escape.js'
import { actionForm, adminRead, changed, revision, timestamp, type Confirmation } from './forms.js'
import { sessionTable } from './session-table.js'
import { describe, stateBadge, stateStatus, statusWord, toolIcon, toolProducts } from './design/status.js'
import { avatar, callout, card, checkOption, field, icon, initials, sheet, sheetLink } from './design/ui.js'
import { renderPage } from './render-page.js'
import { temporaryPasswordHint } from '../../views/people.js'

type Role = { id: string, name: string, tools: z.infer<typeof toolSchema>[] }

const roleTools = (role: Role) => role.tools.map(tool => toolProducts[tool].name).join(', ') || 'No tools yet'

// Role checkboxes for the roleIds array; the disabled hidden input makes an empty selection send [].
export function roleOptions(roles: Role[], selected: string[], legend: string, empty: string, detail: (role: Role) => string = () => ''): string {
  return `<fieldset class="options"><legend>${escape(legend)}</legend><input type="hidden" name="roleIds" disabled>${roles.length ? roles.map(role =>
    checkOption(`<input type="checkbox" name="roleIds" value="${escape(role.id)}"${selected.includes(role.id) ? ' checked' : ''}>`, role.name,
      roleTools(role) + detail(role))).join('') : `<p class="hint">${escape(empty)}</p>`}</fieldset>`
}

// A role chip naming where the person's grant comes from: Direct, SSO rule, or both.
function roleLabel(user: { roleGrants: { roleId: string, origin: string }[] }, id: string, name: string, alwaysOrigin: boolean): string {
  const origins = new Set(user.roleGrants.filter(grant => grant.roleId === id).map(grant => grant.origin === 'direct' ? statusWord('grant', 'direct') : statusWord('grant', 'rule')))
  const show = alwaysOrigin || origins.has(statusWord('grant', 'rule'))
  return `${name}${show ? ` · ${[...origins].sort().join(', ')}` : ''}`
}

function roleChip(user: { roleGrants: { roleId: string, origin: string }[] }, id: string, name: string, alwaysOrigin: boolean): string {
  return `<a class="chip" href="/admin/roles/${escape(encodeURIComponent(id))}">${escape(roleLabel(user, id, name, alwaysOrigin))}</a>`
}

const signInState = (user: { source: string, breakGlass: boolean }) => user.source === 'sso' ? 'sso' : user.breakGlass ? 'break-glass' : 'password'

export function temporaryPasswordField(id: string): string {
  return field(id, 'Temporary password', attributes => `<input class="input" ${attributes} type="password" name="temporaryPassword" autocomplete="new-password" required>`,
    temporaryPasswordHint)
}

export function registerUsersPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/assets/confirm.js', async (_request, reply) => reply.type('application/javascript').send(adminScript))
  app.get('/admin/assets/style.css', async (_request, reply) => reply.type('text/css').send(adminStyle))
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
  const administratorOption = (selected: boolean, description: string) =>
    checkOption(`<input type="checkbox" name="administrator" data-type="boolean"${selected ? ' checked' : ''}>`, 'Administrator', description)
  const signIn = (user: { source: string, breakGlass: boolean }) => stateBadge('signIn', signInState(user))
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
      return `<li class="list-row">${stateBadge('grant', 'rule')}<div class="grow"><strong>${escape(roleName(grant.roleId))}</strong><p>From ${provider.kind === 'entra' ? 'Entra ID' : 'OpenID Connect'} rule <code>${escape(grant.origin)}</code></p></div></li>`
    }).join('')
    const form = (action: string, method: string, body: string, confirmation: Confirmation, attributes = '') => actionForm(csrf, action, method, body, confirmation, attributes)
    const header = (state: string) => ({ heading: user.displayName, lead: avatar(user.displayName, true),
      meta: `<code>${escape(user.username)}</code>${signIn(user)}${state}${user.administrator ? stateBadge('signIn', 'admin') : ''}` })
    const meta = `<div class="card-meta">${changed(db, user)}</div>`

    if (user.archivedAt !== null) {
      const retained = user.roleIds.map(id => roleChip(user, id, roleName(id), true)).join('')
      const content = callout('info', 'Archived person', `Archived at ${timestamp(user.archivedAt)}. Sign-in is blocked, all sessions are revoked, and history is retained. This page is read-only.`) +
        `<div class="grid2"><div class="stack">${card('Roles', 'Membership is retained. This account stays archived.',
          `<div class="card-body stack">${retained ? `<div class="chips">${retained}</div>` : '<p class="none">No retained roles remain.</p>'}${ruleGrants ? `<ul class="rows">${ruleGrants}</ul>` : ''}</div>`)}</div>
          <div class="stack">${meta}</div></div>`
      return browserPage(reply, 'People', content, current, undefined, header(stateBadge('person', 'archived')))
    }

    const sessions = await adminRead(app, request, path + '/sessions', adminUserRoutes.sessions.response)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const isLocked = locked(user)
    const breakGlass = user.source === 'local' && user.administrator ? form(path, 'PATCH', revision(user.revision) + `<input type="hidden" name="breakGlass" data-type="boolean" value="${!user.breakGlass}"><button class="btn">${icon('shield')}${user.breakGlass ? 'Remove break-glass designation…' : 'Make break-glass admin…'}</button>`,
      user.breakGlass ? { consequence: `Remove ${user.username}’s break-glass designation and revoke all their sessions?`, title: 'Remove break-glass designation', action: 'Remove designation' }
        : { consequence: `Designate ${user.username} for emergency local password access when SSO is enabled? Reserve this for emergency access; every use is flagged in the audit log.`, title: 'Make break-glass admin', action: 'Designate' }) : ''
    const signOut = sessions.sessions.length ? form(path + '/sessions/revoke', 'POST', `<button class="btn">${icon('logout')}Sign out everywhere…</button>`,
      { consequence: `Sign out all ${sessions.sessions.length} active browser and CLI sessions now?${sessions.sessions.some(session => session.current) ? ' This includes this browser.' : ''}`, title: 'Sign out everywhere', action: 'Sign out everywhere' }) : ''
    const menu = `<details class="more-menu"><summary class="btn btn-secondary btn-icon" aria-label="More actions">${icon('more')}</summary><div class="popover">
      ${user.source === 'local' ? sheetLink('reset-password', page + '?sheet=reset-password', 'Reset password…', '', 'key') : ''}${signOut}${breakGlass}<hr><a href="/admin/audit?user=${escape(encodeURIComponent(user.id))}">${icon('list')}View in audit log</a></div></details>`
    const actions = `<div class="actions">${user.source === 'local' && user.enabled ? `<a class="btn btn-secondary" href="/admin/invitations?userId=${escape(encodeURIComponent(user.id))}&amp;sheet=new-invitation">${icon('link')}Link to SSO</a>` : ''}${menu}</div>`

    const rolesCard = form(path + '/roles', 'PUT', card('Roles', 'Direct roles are set here. Roles from SSO rules sync at each sign-in.',
      `<div class="card-body stack">${roleOptions(roles, user.directRoleIds, 'Direct roles', 'No roles yet. Create a role on Roles to grant tool access.', role => user.directRoleIds.includes(role.id) ? ' · Direct' : '')}${ruleGrants ? `<ul class="rows">${ruleGrants}</ul>` : ''}</div>`,
      { foot: `<span>Saving replaces direct roles and keeps rule grants. Changes apply on their next tool call.</span><div class="actions">${revision(user.revision)}<button class="btn btn-primary btn-sm">Save roles</button></div>` }),
      { consequence: `Replace ${user.username}’s direct roles with this selection? Tool access changes on the next call.`, title: 'Save roles', action: 'Save roles' }, 'class="card-form"')
    const grantedBy = (tool: { roleIds: string[] }) => tool.roleIds.map(id => roleChip(user, id, roleName(id), true)).join('')
    const usable = card('What can they use?', 'All tools from all their roles. A disabled person or tool cannot run calls.', user.effectiveTools.length
      ? `<div class="table-wrap"><table class="tbl stacked"><thead><tr><th scope="col">Tool</th><th scope="col">Can run calls</th><th scope="col">Granted by</th></tr></thead><tbody>${user.effectiveTools.map(tool =>
        `<tr><td><div class="cell-main">${toolIcon(tool.name)}<div><strong>${escape(toolProducts[tool.name].name)}</strong><span>${escape(tool.name)}</span></div></div></td><td>${stateStatus('access', tool.enabled ? 'yes' : user.enabled ? 'tool-disabled' : 'person-disabled')}${tool.enabled && tools.find(item => item.name === tool.name)?.health.status === 'error' ? ' <span class="none">(currently failing)</span>' : ''}</td><td><div class="chips">${grantedBy(tool)}</div></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="card-body"><p class="none">No tools granted. Assign a role that grants tools.</p></div>')
    const danger = card('Danger zone', '', `<ul class="rows">
      <li class="list-row"><div class="grow"><strong>${user.enabled ? 'Disable access' : 'Enable access'}</strong><p>${user.enabled ? 'Blocks sign-in and ends all their sessions now. You can enable them again later.' : 'Lets them sign in again. Revoked sessions stay signed out.'}</p></div>${form(path, 'PATCH',
        revision(user.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${!user.enabled}"><button class="btn ${user.enabled ? 'btn-danger-outline' : 'btn-secondary'} btn-sm">${user.enabled ? 'Disable…' : 'Enable…'}</button>`,
        user.enabled ? { consequence: `Disable ${user.username}? Sign-in is blocked and all their browser and CLI sessions are revoked immediately.`, title: 'Disable access', action: 'Disable' }
          : { consequence: `Enable ${user.username}? They can sign in again; revoked sessions stay signed out.`, title: 'Enable access', action: 'Enable' })}</li>
      <li class="list-row"><div class="grow"><strong>Archive person</strong><p>Permanent. Hides them from People, blocks sign-in and revokes all sessions. History and role membership are kept.</p></div>${form(path + '/archive', 'POST',
        revision(user.revision) + '<button class="btn btn-danger-outline btn-sm">Archive…</button>',
        { consequence: `Archive ${user.username}? All browser and CLI sessions are revoked, sign-in is blocked, and history is retained. This cannot be undone here.`, title: 'Archive person', action: 'Archive', typedName: user.username }, 'data-success-url="/admin/users"')}</li></ul>`, { danger: true })
    const profile = form(path, 'PATCH', card('Profile', '', `<div class="card-body stack">${revision(user.revision)}${field('profile-display-name', 'Display name', attributes => `<input class="input" ${attributes} name="displayName" value="${escape(user.displayName)}" required>`)}${administratorOption(user.administrator, 'Manage people, roles, tools and sign-in. Changes immediately.')}<div><button class="btn btn-secondary btn-sm">Save profile</button></div></div>`),
      { consequence: `Update ${user.username}’s profile and administrator capability? Administrator access changes immediately.`, title: 'Save profile', action: 'Save profile' }, 'class="card-form"')
    const facts = card('Sign-in', '', `<div class="card-body stack"><dl class="kv"><dt>Method</dt><dd>${user.source === 'sso' ? 'SSO' : user.breakGlass ? 'Break-glass password' : 'Local password'}</dd><dt>Failed sign-ins</dt><dd>${user.failedAttempts}</dd><dt>Locked</dt><dd>${isLocked ? `Until ${timestamp(user.lockedUntil)}` : 'No'}</dd>${user.source === 'local' ? `<dt>Password</dt><dd>${user.mustChange ? 'Password change required' : 'Set by them'}</dd>` : ''}</dl>
      ${isLocked ? form(path + '/unlock', 'POST', `<button class="btn btn-secondary btn-sm">${icon('unlock')}Unlock</button>`,
        { consequence: `Clear ${user.username}’s failed sign-in attempts and lockout? Their password and sessions stay unchanged.`, title: 'Unlock', action: 'Unlock' }) : ''}</div>`)
    const reset = user.source === 'local' ? sheet({ name: 'reset-password', open: open.data.sheet === 'reset-password', closeHref: page, title: 'Reset password', description: `Set a new temporary password for ${user.username}.`,
      body: temporaryPasswordField('reset-password-input') + callout('warn', 'All their sessions end', 'They are signed out everywhere and must change the temporary password at their next sign-in.'),
      submit: '<button class="btn btn-primary">Reset password</button>',
      wrap: inner => form(path + '/password-reset', 'POST', inner, { consequence: `Reset ${user.username}’s password? All their sessions are revoked and they must change the temporary password on next sign-in.`, title: 'Reset password', action: 'Reset password' }) }) : ''
    const content = `<div class="grid2"><div class="stack">${rolesCard}${usable}${sessionTable(csrf, path + '/sessions', sessions.sessions)}${danger}</div><div class="stack">${profile}${facts}${meta}</div></div>${reset}`
    return browserPage(reply, 'People', content, current, undefined, { ...header(stateBadge('person', user.enabled ? isLocked ? 'locked' : 'enabled' : 'disabled', true)), actions })
  })
}
