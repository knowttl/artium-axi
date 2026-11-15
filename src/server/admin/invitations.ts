import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminInvitationRoutes, adminInvitationSchema, adminUserParamsSchema, type toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { hashToken } from '../auth/tokens.js'
import { adminRead } from './forms.js'
import { describe } from './design/status.js'
import { initials } from './design/ui.js'
import { renderPage } from './render-page.js'
import { roleTools } from './users.js'

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
    const page = '/admin/invitations' + (params.size ? '?' + params : '')
    const withSheet = (name: string) => '/admin/invitations?' + new URLSearchParams([...params, ...(userId ? [['userId', userId]] : []), ['sheet', name]])
    const enabled = providers.filter(provider => provider.enabled)
    const only = providers.length === 1 ? providers[0]! : null

    const banner = !providers.length
      ? { status: 'info' as const, title: 'Add an SSO provider first', text: 'Invitations need an Entra ID or OpenID Connect provider. Add one in Sign-in & SSO, then come back to invite people.',
        link: { href: '/admin/settings/sign-in', label: 'Open Sign-in & SSO' } }
      : !enabled.length
        ? { status: 'warning' as const, title: 'Links can’t be claimed yet', text: only
          ? `${only.name} is not enabled. Finish its setup and enable it in Sign-in & SSO; invitation links work once it is enabled.`
          : 'No provider is enabled. Finish setting up a provider and enable it in Sign-in & SSO; invitation links work once their provider is enabled.',
          link: only ? { href: `/admin/settings/sign-in/${encodeURIComponent(only.id)}`, label: 'Open provider' } : { href: '/admin/settings/sign-in', label: 'Open Sign-in & SSO' } }
        : null
    return renderPage(reply, 'Invitations', 'invitations', {
      csrf: reply.generateCsrf(), path: adminInvitationRoutes.list.path, banner,
      invitations: invitations.map(invitation => ({ id: invitation.id, name: invitation.displayName, initials: initials(invitation.displayName),
        detail: invitation.claimedAt !== null ? 'Account claimed' : invitation.userId ? 'Links a local account' : 'New account', username: invitation.expectedUsername,
        provider: providers.find(provider => provider.id === invitation.providerId)!.name,
        roles: invitation.roleIds.map(id => roles.find(role => role.id === id)!.name), status: describe('invitation', invitation.status),
        expiresAt: new Date(invitation.expiresAt).toISOString(),
        actions: invitation.status === 'pending' || invitation.status === 'expired'
          ? { resend: { open: open === 'resend-' + invitation.id, closeHref: page, href: withSheet('resend-' + invitation.id) }, revision: invitation.revision } : null })),
      pager: { summary: `Showing ${invitations.length} invitation${invitations.length === 1 ? '' : 's'}`, first: query.cursor ? '/admin/invitations' : null,
        next: nextCursor ? `/admin/invitations?cursor=${encodeURIComponent(nextCursor)}` : null },
      create: providers.length ? { open: open === 'new-invitation', closeHref: page, providers: providers.map(({ id, name, enabled }) => ({ id, name, enabled: Boolean(enabled) })),
        title: user ? 'Link a local user to SSO' : 'New invitation',
        description: user ? `Linking ${user.username} keeps their account and history. Nothing changes until they claim the link.` : 'No account or tool access exists until the link is claimed.',
        roles: roles.map(role => ({ id: role.id, name: role.name, detail: roleTools(role) })), userId: userId ?? null, displayName: user?.displayName ?? '' } : null,
    }, current, 'One-time links that let a person sign in with SSO (Entra ID or OpenID Connect) for the first time. Nothing is emailed; you send each link yourself.',
    [{ label: 'New invitation', icon: 'plus', variant: 'primary', ...providers.length ? { href: withSheet('new-invitation'), sheet: 'sheet-new-invitation' } : { href: '/admin/settings/sign-in', disabled: true } }])
  })
}
