import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminInvitationRoutes, adminInvitationSchema, adminUserParamsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { hashToken } from '../auth/tokens.js'
import { adminRead, apiForm, revision, timestamp } from './forms.js'
import { escape } from './escape.js'

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
    const { userId, ...query } = parse(adminInvitationRoutes.list.input.extend({ userId: z.string().min(1).optional() }), request.query)
    const user = userId ? localUser(userId) : null
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))
    const { invitations, nextCursor } = await adminRead(app, request, adminInvitationRoutes.list.path + '?' + params, adminInvitationRoutes.list.response)
    const providers = db.prepare('SELECT id, name FROM sso_providers ORDER BY name, id').all() as { id: string, name: string }[]
    const roles = db.prepare('SELECT id, name FROM roles ORDER BY name, id').all() as { id: string, name: string }[]
    const csrf = reply.generateCsrf()
    const lifetime = '<label>Expires in days<input name="expiresInDays" data-type="number" type="number" min="1" max="30" value="7" required></label><p>Choose 1 to 30 days. Resend starts a new expiry period and invalidates the old link.</p>'
    const form = (action: string, label: string, fields: string, confirmation: string, link = false) =>
      apiForm(csrf, action, 'POST', label, fields, confirmation, link ? 'data-invitation-link' : '')
    const content = `<p><a href="/admin">Back to users</a> | <a href="/admin/settings/sign-in">Sign-in settings</a></p>
      <p>Invitation links start Entra sign-in when the provider is enabled. Enable the provider in Sign-in settings after completing its setup guide. Nothing is emailed automatically.</p>
      <section><h2>${user ? 'Link local user to SSO' : 'Invite SSO user'}</h2>${user ? `<p>Linking ${escape(user.username)} keeps the existing account and history. No password, roles or sessions change until the invitation is claimed.</p>` : '<p>Create an account invitation. No account or tool access is created until it is claimed. To link an existing local account, open that user and choose Link to SSO.</p>'}
      ${providers.length ? form(adminInvitationRoutes.create.path, 'Create invitation',
        `<label>Provider<select name="providerId" required>${providers.map(provider => `<option value="${escape(provider.id)}">${escape(provider.name)}</option>`).join('')}</select></label>
        ${userId ? `<input type="hidden" name="userId" value="${escape(userId)}">` : ''}
        <label>Display name<input name="displayName" maxlength="256" value="${escape(user?.displayName ?? '')}" required></label>
        <label>Expected username<input name="expectedUsername" maxlength="256" required></label><p>Enter the exact preferred_username claim from the provider (the Entra sign-in username for Microsoft). It must match at claim time; a renamed user needs a new invitation. Accounts are never linked automatically by email.</p>
        <fieldset><legend>Direct roles to add when claimed</legend><input type="hidden" name="roleIds" disabled>${roles.map(role => `<label><input type="checkbox" name="roleIds" value="${escape(role.id)}"> ${escape(role.name)}</label>`).join('') || '<p>No roles yet. Create roles to grant tool access.</p>'}</fieldset>` + lifetime,
        'Create a one-time invitation link? Copy it before leaving the result. You must send it securely yourself.', true) : '<p>Add an Entra provider in Sign-in settings first.</p>'}</section>
      <section><h2>Invitations</h2>${invitations.length ? invitations.map(invitation => {
        const action = adminInvitationRoutes.list.path + '/' + encodeURIComponent(invitation.id)
        const provider = providers.find(provider => provider.id === invitation.providerId)!
        return `<details data-invitation="${escape(invitation.id)}"><summary>${escape(invitation.displayName)} (${escape(invitation.expectedUsername)}) - ${invitation.status}</summary>
          <p>Provider: ${escape(provider.name)}. ${invitation.claimedAt !== null ? 'Account claimed' : invitation.userId ? 'Links an existing account' : 'Creates a new account'}. Expires: ${timestamp(invitation.expiresAt)}. Revision ${invitation.revision}.</p>
          <p>Direct roles: ${invitation.roleIds.map(id => escape(roles.find(role => role.id === id)!.name)).join(', ') || 'None'}.</p>
          ${invitation.status === 'pending' || invitation.status === 'expired' ?
            form(action + '/resend', 'Resend invitation', revision(invitation.revision) + lifetime, 'Replace this invitation link? The old link immediately stops working. Send the new link securely yourself.', true) +
            form(action + '/revoke', 'Revoke invitation', revision(invitation.revision), 'Revoke this invitation? The link can no longer be claimed. Existing accounts and access are unchanged.') : ''}</details>`
      }).join('') : '<p>No invitations yet. Create one above.</p>'}
      <p><a href="/admin/invitations">First page</a>${nextCursor ? ` | <a href="/admin/invitations?cursor=${escape(encodeURIComponent(nextCursor))}">Next page</a>` : ''}</p></section>
      <dialog id="invitation-link" aria-labelledby="invitation-link-title"><h2 id="invitation-link-title">Copy invitation link now</h2><p>This link is shown once. Send it securely to the expected user. The provider must be enabled before it can be claimed.</p><label>Invitation link<textarea data-claim-link readonly rows="4"></textarea></label><form method="dialog"><button>Done</button></form></dialog>`
    return browserPage(reply, 'Invitations', content, current)
  })
}
