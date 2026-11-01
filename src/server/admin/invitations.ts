import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminInvitationRoutes, adminInvitationSchema, adminUserParamsSchema, type toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { hashToken } from '../auth/tokens.js'
import { actionForm, adminRead, revision, timestamp } from './forms.js'
import { escape } from './escape.js'
import { badge } from './design/status.js'
import { avatar, callout, card, field, icon, sheet, sheetLink } from './design/ui.js'
import { roleOptions } from './users.js'

export function registerInvitationAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string): void {
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  function localUser(id: string) {
    const user = db.prepare("SELECT username, display_name AS displayName FROM users WHERE id = ? AND source = 'local' AND disabled = 0 AND archived_at IS NULL").get(id) as
      { username: string, displayName: string } | undefined
    if (!user) throw new ArtiumError('INVALID_INPUT', 'Choose an enabled local account to link.', 'Open an enabled local user and choose Link to SSO.')
    return user
  }
  function read(id: string, now = Date.now()): z.infer<typeof adminInvitationSchema> {
    const row = db.prepare(`SELECT id, provider_id AS providerId, expected_username AS expectedUsername,
      display_name AS displayName, user_id AS userId, created_at AS createdAt, created_by AS createdBy,
      expires_at AS expiresAt, claimed_at AS claimedAt, revoked_at AS revokedAt, revision FROM invitations WHERE id = ?`).get(id) as
      Omit<z.infer<typeof adminInvitationSchema>, 'status' | 'roleIds'> | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    const roleIds = (db.prepare('SELECT role_id FROM invitation_roles WHERE invitation_id = ? ORDER BY role_id').all(id) as { role_id: string }[]).map(row => row.role_id)
    return adminInvitationSchema.parse({ ...row, roleIds,
      status: row.claimedAt !== null ? 'claimed' : row.revokedAt !== null ? 'revoked' : row.expiresAt <= now ? 'expired' : 'pending' })
  }
  app.get(adminInvitationRoutes.list.path, async (request, reply) => {
    authorize(request)
    reply.header('Cache-Control', 'no-store')
    const { cursor, limit } = parse(adminInvitationRoutes.list.input, request.query)
    const rows = db.prepare('SELECT id FROM invitations WHERE id > ? ORDER BY id LIMIT ?').all(cursor ?? '', limit + 1) as { id: string }[]
    const page = rows.slice(0, limit)
    return adminInvitationRoutes.list.response.parse({ invitations: page.map(row => read(row.id)),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null })
  })
  app.post(adminInvitationRoutes.create.path, async (request, reply) => {
    const actor = authorize(request)
    const input = parse(adminInvitationRoutes.create.input, request.body)
    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    const invitation = audit.change({ event: 'invite-create', targetId: id, userId: actor, tool: null,
      outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      if (!db.prepare('SELECT 1 FROM sso_providers WHERE id = ?').get(input.providerId)) throw new ArtiumError('NOT_FOUND')
      if (input.userId) localUser(input.userId)
      for (const roleId of input.roleIds) {
        if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId)) throw new ArtiumError('NOT_FOUND')
      }
      const now = Date.now()
      db.prepare(`INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, user_id, created_at, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hashToken(token), input.providerId, input.expectedUsername,
          input.displayName, input.userId ?? null, now, actor, now + input.expiresInDays * 86_400_000)
      for (const roleId of input.roleIds) db.prepare('INSERT INTO invitation_roles (invitation_id, role_id) VALUES (?, ?)').run(id, roleId)
      return read(id, now)
    }).value
    return reply.header('Cache-Control', 'no-store').code(201).send({ invitation,
      claimPath: `/auth/sso/${encodeURIComponent(input.providerId)}/start?invitation=${token}` })
  })
  for (const route of [adminInvitationRoutes.resend, adminInvitationRoutes.revoke]) app.post(route.path, async (request, reply) => {
    const actor = authorize(request)
    const input = parse<z.infer<typeof adminInvitationRoutes.resend.input> | z.infer<typeof adminInvitationRoutes.revoke.input>>(route.input, request.body)
    const { id } = parse(adminUserParamsSchema, request.params)
    const token = randomBytes(32).toString('base64url')
    const invitation = audit.change({ event: route.auditEvent, targetId: id, userId: actor, tool: null,
      outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      const now = Date.now()
      const current = read(id, now)
      if (input.expectedRevision !== current.revision) throw new ArtiumError('REVISION_CONFLICT')
      if (current.claimedAt !== null || current.revokedAt !== null) {
        throw new ArtiumError('INVALID_INPUT', 'This invitation is already claimed or revoked.', 'Create a new invitation if access is needed.')
      }
      if ('expiresInDays' in input) {
        if (current.userId) localUser(current.userId)
        db.prepare('UPDATE invitations SET token_hash = ?, expires_at = ?, revision = revision + 1 WHERE id = ?')
          .run(hashToken(token), now + input.expiresInDays * 86_400_000, id)
      } else {
        db.prepare('UPDATE invitations SET revoked_at = ?, revision = revision + 1 WHERE id = ?').run(now, id)
      }
      return read(id, now)
    }).value
    reply.header('Cache-Control', 'no-store')
    return route === adminInvitationRoutes.resend ? { invitation,
      claimPath: `/auth/sso/${encodeURIComponent(invitation.providerId)}/start?invitation=${token}` } : invitation
  })

  app.get('/admin/invitations', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const { userId, sheet: open, ...query } = parse(adminInvitationRoutes.list.input.extend({ userId: z.string().min(1).optional(),
      sheet: z.string().regex(/^(new-invitation|resend-.+)$/).optional() }), request.query)
    const user = userId ? localUser(userId) : null
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))
    const { invitations, nextCursor } = await adminRead(app, request, adminInvitationRoutes.list.path + '?' + params, adminInvitationRoutes.list.response)
    const providers = db.prepare('SELECT id, name, kind, enabled FROM sso_providers ORDER BY name, id').all() as { id: string, name: string, kind: string, enabled: number }[]
    const roles = (db.prepare('SELECT id, name FROM roles ORDER BY name, id').all() as { id: string, name: string }[]).map(role => ({ ...role,
      tools: (db.prepare('SELECT tool FROM role_tools WHERE role_id = ? ORDER BY tool').all(role.id) as { tool: z.infer<typeof toolSchema> }[]).map(row => row.tool) }))
    const csrf = reply.generateCsrf()
    const page = '/admin/invitations' + (params.size ? '?' + params : '')
    const withSheet = (name: string) => '/admin/invitations?' + new URLSearchParams([...params, ...(userId ? [['userId', userId]] : []), ['sheet', name]])
    const lifetime = (id: string) => field(id, 'Expires in', attributes => `<div class="row"><input class="input narrow" ${attributes} name="expiresInDays" data-type="number" type="number" min="1" max="30" value="7" required><span class="none">days</span></div>`,
      'Choose 1 to 30 days.')
    const enabled = providers.filter(provider => provider.enabled)

    const banner = !providers.length
      ? callout('info', 'Add an SSO provider first', 'Invitations need an Entra ID or OpenID Connect provider. Add one in Sign-in &amp; SSO, then come back to invite people.', '<a class="btn btn-secondary btn-sm" href="/admin/settings/sign-in">Open Sign-in &amp; SSO</a>')
      : !enabled.length
        ? callout('warn', 'Links can’t be claimed yet', providers.length === 1
          ? `${escape(providers[0]!.name)} is not enabled. Finish its setup and enable it in Sign-in &amp; SSO; invitation links work once it is enabled.`
          : 'No provider is enabled. Finish setting up a provider and enable it in Sign-in &amp; SSO; invitation links work once their provider is enabled.',
          `<a class="btn btn-secondary btn-sm" href="${providers.length === 1 ? `/admin/settings/sign-in/${escape(encodeURIComponent(providers[0]!.id))}` : '/admin/settings/sign-in'}">Open ${providers.length === 1 ? 'provider' : 'Sign-in &amp; SSO'}</a>`)
        : ''
    const rows = invitations.map(invitation => {
      const action = adminInvitationRoutes.list.path + '/' + encodeURIComponent(invitation.id)
      const provider = providers.find(provider => provider.id === invitation.providerId)!
      const chips = invitation.roleIds.map(id => `<span class="chip">${escape(roles.find(role => role.id === id)!.name)}</span>`).join('')
      const open = invitation.status === 'pending' || invitation.status === 'expired'
      return `<tr data-invitation="${escape(invitation.id)}"><td><div class="cell-main">${avatar(invitation.displayName)}<div><strong>${escape(invitation.displayName)}</strong><span>${invitation.claimedAt !== null ? 'Account claimed' : invitation.userId ? 'Links a local account' : 'New account'}</span></div></div></td>
        <td><code>${escape(invitation.expectedUsername)}</code></td><td class="muted">${escape(provider.name)}</td>
        <td>${chips ? `<div class="chips">${chips}</div>` : '<span class="none">None</span>'}</td><td>${badge('invitation', invitation.status)}</td>
        <td class="muted">${timestamp(invitation.expiresAt)}</td>
        <td class="actions-cell">${open ? sheetLink('resend-' + invitation.id, withSheet('resend-' + invitation.id), 'Resend', 'btn btn-ghost btn-sm') +
          actionForm(csrf, action + '/revoke', 'POST', revision(invitation.revision) + '<button class="btn btn-ghost btn-sm danger">Revoke</button>',
            { consequence: 'Revoke this invitation? The link can no longer be claimed. Existing accounts and access are unchanged.', title: 'Revoke invitation', action: 'Revoke' }) : ''}</td></tr>`
    }).join('')
    const pager = `<span>Showing ${invitations.length} invitation${invitations.length === 1 ? '' : 's'}</span><div class="actions"><a class="btn btn-secondary btn-sm" href="/admin/invitations"${query.cursor ? '' : ' aria-disabled="true"'}>First page</a><a class="btn btn-secondary btn-sm" href="${nextCursor ? `/admin/invitations?cursor=${escape(encodeURIComponent(nextCursor))}` : '/admin/invitations'}"${nextCursor ? '' : ' aria-disabled="true"'}>Next</a></div>`
    const table = invitations.length
      ? `<section class="card"><h2 class="sr-only">Invitations</h2><div class="table-wrap"><table class="tbl stacked"><thead><tr><th scope="col">Person</th><th scope="col">Expected username</th><th scope="col">Provider</th><th scope="col">Roles on claim</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div><div class="card-foot">${pager}</div></section>`
      : card('No invitations yet', '', `<div class="card-body"><p class="note">Create an invitation to let someone sign in with SSO for the first time. To keep a local account’s history, open that person and choose Link to SSO.</p></div>`)

    const create = providers.length ? sheet({ name: 'new-invitation', open: open === 'new-invitation', closeHref: page,
      title: user ? 'Link a local user to SSO' : 'New invitation',
      description: user ? `Linking ${user.username} keeps their account and history. Nothing changes until they claim the link.` : 'No account or tool access exists until the link is claimed.',
      body: field('invite-provider', 'Provider', attributes => `<select class="select" ${attributes} name="providerId" required>${providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}${provider.enabled ? '' : ' (not enabled yet)'}</option>`).join('')}</select>`) +
        (userId ? `<input type="hidden" name="userId" value="${escape(userId)}">` : '') +
        field('invite-display-name', 'Display name', attributes => `<input class="input" ${attributes} name="displayName" maxlength="256" value="${escape(user?.displayName ?? '')}" required>`) +
        field('invite-username', 'Expected username', attributes => `<input class="input mono" ${attributes} name="expectedUsername" maxlength="256" autocomplete="off" spellcheck="false" required>`,
          'The exact preferred_username claim the provider sends: the Entra ID sign-in name, or the OpenID Connect username. It must match when the link is claimed. Accounts are never linked by email.') +
        roleOptions(roles, [], 'Roles to add when claimed', 'No roles yet. Create roles to grant tool access.') + lifetime('invite-expires'),
      submit: '<button class="btn btn-primary">Create invitation</button>',
      wrap: inner => actionForm(csrf, adminInvitationRoutes.create.path, 'POST', inner, { consequence: 'Create a one-time invitation link? It is shown once; copy it before closing the result and send it securely yourself.', title: 'Create invitation', action: 'Create link' }, 'data-invitation-link') }) : ''
    const resends = invitations.filter(invitation => invitation.status === 'pending' || invitation.status === 'expired').map(invitation => sheet({ name: 'resend-' + invitation.id, open: open === 'resend-' + invitation.id, closeHref: page,
      title: 'Resend invitation', description: `A new link for ${invitation.displayName}. The old link stops working immediately.`,
      body: revision(invitation.revision) + lifetime('resend-expires-' + invitation.id),
      submit: '<button class="btn btn-primary">Resend invitation</button>',
      wrap: inner => actionForm(csrf, adminInvitationRoutes.list.path + '/' + encodeURIComponent(invitation.id) + '/resend', 'POST', inner,
        { consequence: 'Replace this invitation link? The old link immediately stops working. Send the new link securely yourself.', title: 'Resend invitation', action: 'Resend' }, 'data-invitation-link') })).join('')
    const linkDialog = `<dialog id="invitation-link" class="modal" aria-labelledby="invitation-link-title"><div class="modal-body"><h2 id="invitation-link-title"><span class="ico-circle ok">${icon('link')}</span>Copy the invitation link now</h2><p>This link is shown once. Send it to the person over a channel you trust. Their provider must be enabled before they can claim it.</p>
      <div class="copy-group"><div class="copyfield"><input class="input" data-claim-link readonly aria-label="Invitation link"><button class="btn btn-primary" type="button" data-copy>${icon('copy')}Copy</button></div><p class="copy-status" data-copy-status role="status"></p></div></div>
      <form method="dialog" class="modal-foot"><button class="btn btn-secondary">Done</button></form></dialog>`
    return browserPage(reply, 'Invitations', `${banner}${table}${create}${resends}${linkDialog}`, current, {
      description: 'One-time links that let a person sign in with SSO (Entra ID or OpenID Connect) for the first time. Nothing is emailed; you send each link yourself.',
      actions: providers.length ? sheetLink('new-invitation', withSheet('new-invitation'), 'New invitation', 'btn btn-primary', 'plus') : `<a class="btn btn-primary" href="/admin/settings/sign-in" aria-disabled="true">${icon('plus')}New invitation</a>` })
  })
}
