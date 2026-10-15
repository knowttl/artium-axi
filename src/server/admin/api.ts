import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminAuditExportRoute, adminAuditRecordSchema, adminAuditRoute, adminRoleRoutes, adminRoleSchema, adminUserParamsSchema, adminUserRoutes, adminUserSchema, sessionParamsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import type { AuthAttempts } from '../auth/attempts.js'
import { readUsername } from '../auth/bootstrap.js'
import { hashPassword } from '../auth/local.js'
import { requireRecentAuth, revokeUserSessions, verifyAccessToken } from '../auth/tokens.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { registerToolAdmin, type ToolAdminOptions } from './tools.js'
import { registerProviderAdmin } from './providers.js'
import { registerRoleRuleAdmin } from './role-rules.js'
import { registerInvitationAdmin } from './invitations.js'
import type { ProviderCredentials } from '../store/provider-credentials.js'
import { listUserSessions, revokeUserSession } from '../auth/user-sessions.js'

type PublicUser = z.infer<typeof adminUserSchema>

export function registerAdmin(app: FastifyInstance, db: Database.Database, audit: Audit, authAttempts: AuthAttempts, tools: ToolAdminOptions, providerCredentials?: ProviderCredentials): void {
  db.function('unicode_lower', { deterministic: true }, (value: string | null) => value === null ? null : value.toLowerCase())
  function authorize(request: FastifyRequest): string {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    let userId: string | null = null
    try {
      if (!request.headers.authorization && request.cookies[browserCookie]) {
        userId = readBrowserSession(db, request.cookies[browserCookie]!).user_id
        return requireBrowserAdmin(db, request.cookies[browserCookie]!, !['GET', 'HEAD'].includes(request.method))
      }
      userId = verifyAccessToken(db, token)
      const user = db.prepare('SELECT administrator FROM users WHERE id = ?').get(userId) as { administrator: number }
      if (!user.administrator) throw new ArtiumError('ADMIN_REQUIRED')
      const ticket = request.headers['x-artium-reauth-ticket']
      return requireRecentAuth(db, token, typeof ticket === 'string' ? ticket : '')
    } catch (error) {
      if (!db.inTransaction && error instanceof ArtiumError) {
        audit.record({ event: 'denial', userId, tool: null, outcome: error.code, requestId: request.id, clientAddress: request.ip })
      }
      throw error
    }
  }

  function readUser(id: string): PublicUser {
    const row = db.prepare(`SELECT id, username, display_name AS displayName, source, disabled, administrator,
      must_change AS mustChange, failed_attempts AS failedAttempts, locked_until AS lockedUntil,
      revision, updated_at AS updatedAt, updated_by AS updatedBy, archived_at AS archivedAt FROM users WHERE id = ?`).get(id) as
      (Omit<PublicUser, 'enabled' | 'administrator' | 'mustChange' | 'roleIds' | 'roleGrants'> &
        { disabled: number, administrator: number, mustChange: number }) | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    const { disabled, ...fields } = row
    const roleGrants = db.prepare('SELECT role_id AS roleId, origin FROM user_roles WHERE user_id = ? ORDER BY role_id, origin')
      .all(id) as PublicUser['roleGrants']
    const roleIds = [...new Set(roleGrants.map(grant => grant.roleId))]
    return adminUserSchema.parse({ ...fields, enabled: !disabled, administrator: Boolean(row.administrator),
      mustChange: Boolean(row.mustChange), roleIds, roleGrants })
  }

  registerToolAdmin(app, db, audit, authorize, tools)
  registerProviderAdmin(app, db, audit, authorize, providerCredentials)
  registerRoleRuleAdmin(app, db, audit, authorize)
  registerInvitationAdmin(app, db, audit, authorize)

  app.route({ method: adminAuditRoute.method, url: adminAuditRoute.path, handler: async request => {
    authorize(request)
    return adminAuditRoute.response.parse(audit.query(parse(adminAuditRoute.input, request.query)))
  } })
  app.route({ method: adminAuditExportRoute.method, url: adminAuditExportRoute.path, handler: async (request, reply) => {
    authorize(request)
    const { format, ...filters } = parse(adminAuditExportRoute.input, request.query)
    const columns = Object.keys(adminAuditRecordSchema.shape) as (keyof z.infer<typeof adminAuditRecordSchema>)[]
    const csv = (value: unknown) => value === null ? '' : `"${String(value).replaceAll('"', '""')}"`
    // Query the first page now to bind every continuation to the same insertion ceiling.
    const first = audit.query({ ...filters, limit: 100 })
    function* download() {
      if (format === 'csv') yield columns.join(',') + '\r\n'
      let page = first
      while (true) {
        for (const row of page.records) {
          const record = adminAuditRecordSchema.parse(row)
          yield format === 'jsonl' ? JSON.stringify(record) + '\n' : columns.map(key => csv(record[key])).join(',') + '\r\n'
        }
        if (!page.nextCursor) return
        page = audit.query({ ...filters, limit: 100, cursor: page.nextCursor })
      }
    }
    return reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="artium-audit.${format}"`)
      .header('Cache-Control', 'no-store').send(Readable.from(download()))
  } })

  function change<T>(request: FastifyRequest, action: string, id: string, read: (id: string) => T, mutation: (actor: string, now: number) => void): T {
    const actor = authorize(request)
    try {
      return audit.change({ event: 'admin-change', action, targetId: id, userId: actor, tool: null,
        outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
        authorize(request)
        mutation(actor, Date.now())
        return read(id)
      }).value
    } catch (error) {
      if (error instanceof Error && error.message === 'LAST_ADMINISTRATOR') throw new ArtiumError('LAST_ADMINISTRATOR')
      if (error instanceof Error && 'code' in error &&
        ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_FOREIGNKEY'].includes(String(error.code))) throw new ArtiumError('INVALID_INPUT')
      throw error
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }

  app.route({ method: adminUserRoutes.list.method, url: adminUserRoutes.list.path, handler: async request => {
    authorize(request)
    const { cursor, limit, q, source, status, role } = parse(adminUserRoutes.list.input, request.query)
    // instr treats wildcard characters as literal search text.
    const where = `archived_at IS NULL AND (? IS NULL OR instr(unicode_lower(username), unicode_lower(?)) > 0 OR instr(unicode_lower(display_name), unicode_lower(?)) > 0)
      AND (? IS NULL OR source = ?) AND (? IS NULL OR disabled = ?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM user_roles WHERE user_id = users.id AND role_id = ?))`
    const filters = [q ?? null, q ?? null, q ?? null, source ?? null, source ?? null,
      status ?? null, Number(status === 'disabled'), role ?? null, role ?? null]
    const rows = db.prepare(`SELECT id FROM users WHERE ${where} AND id > ? ORDER BY id LIMIT ?`)
      .all(...filters, cursor ?? '', limit + 1) as { id: string }[]
    const { totalCount } = db.prepare(`SELECT COUNT(*) AS totalCount FROM users WHERE ${where}`).get(...filters) as { totalCount: number }
    const page = rows.slice(0, limit)
    return adminUserRoutes.list.response.parse({ users: page.map(row => readUser(row.id)),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null, totalCount })
  } })
  app.route({ method: adminUserRoutes.sessions.method, url: adminUserRoutes.sessions.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    parse(adminUserRoutes.sessions.input, request.query)
    readUser(id)
    const currentFamily = !request.headers.authorization && request.cookies[browserCookie]
      ? readBrowserSession(db, request.cookies[browserCookie]!).family_id : null
    return listUserSessions(db, id, currentFamily)
  } })
  app.route({ method: adminUserRoutes.revokeSession.method, url: adminUserRoutes.revokeSession.path, handler: async request => {
    authorize(request)
    const { id, sessionId } = parse(sessionParamsSchema, request.params)
    parse(adminUserRoutes.revokeSession.input, request.body ?? {})
    return change(request, adminUserRoutes.revokeSession.auditEvent, sessionId, () => ({ revoked: true as const }), (_actor, now) => {
      readUser(id)
      revokeUserSession(db, id, sessionId, now)
    })
  } })
  app.route({ method: adminUserRoutes.revokeSessions.method, url: adminUserRoutes.revokeSessions.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    parse(adminUserRoutes.revokeSessions.input, request.body ?? {})
    return change(request, adminUserRoutes.revokeSessions.auditEvent, id, () => ({ revoked: true as const }), (_actor, now) => {
      readUser(id)
      revokeUserSessions(db, id, now)
    })
  } })
  app.route({ method: adminUserRoutes.archive.method, url: adminUserRoutes.archive.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const { expectedRevision } = parse(adminUserRoutes.archive.input, request.body)
    return change(request, adminUserRoutes.archive.auditEvent, id, readUser, (actor, now) => {
      const user = readUser(id)
      if (user.revision !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      if (user.archivedAt !== null) return
      db.prepare(`UPDATE users SET disabled = 1, archived_at = ?, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE id = ?`).run(now, now, actor, id)
      revokeUserSessions(db, id, now)
    })
  } })
  app.route({ method: adminUserRoutes.get.method, url: adminUserRoutes.get.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const user = readUser(id)
    const grants = db.prepare(`SELECT DISTINCT role_tools.tool AS name, tools.enabled, user_roles.role_id AS roleId
      FROM user_roles JOIN role_tools ON role_tools.role_id = user_roles.role_id
      JOIN tools ON tools.name = role_tools.tool WHERE user_roles.user_id = ? ORDER BY role_tools.tool, user_roles.role_id`)
      .all(id) as { name: string, enabled: number, roleId: string }[]
    const names = [...new Set(grants.map(grant => grant.name))]
    const directRoleIds = user.roleGrants.filter(grant => grant.origin === 'direct').map(grant => grant.roleId)
    return adminUserRoutes.get.response.parse({ ...user, directRoleIds, effectiveTools: names.map(name => ({ name,
      enabled: user.enabled && Boolean(grants.find(grant => grant.name === name)!.enabled),
      roleIds: grants.filter(grant => grant.name === name).map(grant => grant.roleId),
    })) })
  } })
  app.route({ method: adminUserRoutes.create.method, url: adminUserRoutes.create.path, handler: async (request, reply) => {
    authorize(request)
    const input = parse(adminUserRoutes.create.input, request.body)
    const username = readUsername(input.username)
    const hash = await hashPassword(input.temporaryPassword)
    const id = randomUUID()
    const user = change(request, adminUserRoutes.create.auditEvent, id, readUser, (actor, now) => {
      db.prepare(`INSERT INTO users (id, username, display_name, password_hash, administrator, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, username, input.displayName, hash, Number(input.administrator), now, actor)
      const assign = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)')
      for (const roleId of input.roleIds) assign.run(id, roleId)
    })
    return reply.code(201).send(user)
  } })
  app.route({ method: adminUserRoutes.patch.method, url: adminUserRoutes.patch.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const input = parse(adminUserRoutes.patch.input, request.body)
    return change(request, adminUserRoutes.patch.auditEvent, id, readUser, (actor, now) => {
      const current = readUser(id)
      if (current.revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const enabled = input.enabled ?? current.enabled
      if (enabled && current.archivedAt !== null) {
        throw new ArtiumError('INVALID_INPUT', 'Archived users cannot be enabled.', 'Create a new user if access is needed again.')
      }
      db.prepare(`UPDATE users SET display_name = ?, disabled = ?, administrator = ?, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?`).run(input.displayName ?? current.displayName,
        Number(!enabled), Number(input.administrator ?? current.administrator), now, actor, id, input.expectedRevision)
      if (!enabled) revokeUserSessions(db, id, now)
    })
  } })
  app.route({ method: adminUserRoutes.unlock.method, url: adminUserRoutes.unlock.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    parse(adminUserRoutes.unlock.input, request.body ?? {})
    const user = change(request, adminUserRoutes.unlock.auditEvent, id, readUser, (actor, now) => {
      readUser(id)
      db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = NULL, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE id = ?`).run(now, actor, id)
    })
    authAttempts.clearUsername(user.username)
    return user
  } })
  app.route({ method: adminUserRoutes.reset.method, url: adminUserRoutes.reset.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const input = parse(adminUserRoutes.reset.input, request.body)
    if (readUser(id).source !== 'local') throw new ArtiumError('INVALID_INPUT', 'SSO users do not have a local password.', 'Manage this account at its identity provider.')
    const hash = await hashPassword(input.temporaryPassword)
    const user = change(request, adminUserRoutes.reset.auditEvent, id, readUser, (actor, now) => {
      if (readUser(id).source !== 'local') throw new ArtiumError('INVALID_INPUT')
      db.prepare(`UPDATE users SET password_hash = ?, must_change = 1, failed_attempts = 0, locked_until = NULL,
        revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`).run(hash, now, actor, id)
      revokeUserSessions(db, id, now)
    })
    authAttempts.clearUsername(user.username)
    return user
  } })

  app.route({ method: adminUserRoutes.roles.method, url: adminUserRoutes.roles.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const input = parse(adminUserRoutes.roles.input, request.body)
    return change(request, adminUserRoutes.roles.auditEvent, id, readUser, (actor, now) => {
      const current = readUser(id)
      if (current.revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const directRoles = db.prepare("SELECT role_id FROM user_roles WHERE user_id = ? AND origin = 'direct'")
        .all(id) as { role_id: string }[]
      if (current.archivedAt !== null && input.roleIds.some(roleId => !directRoles.some(row => row.role_id === roleId))) {
        throw new ArtiumError('INVALID_INPUT', 'Archived users cannot gain role memberships.', 'Remove retained roles only.')
      }
      db.prepare("DELETE FROM user_roles WHERE user_id = ? AND origin = 'direct'").run(id)
      const assign = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)')
      for (const roleId of input.roleIds) assign.run(id, roleId)
      db.prepare('UPDATE users SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now, actor, id)
    })
  } })

  function readRole(id: string): z.infer<typeof adminRoleSchema> {
    const row = db.prepare('SELECT id, name, revision, updated_at AS updatedAt, updated_by AS updatedBy FROM roles WHERE id = ?').get(id)
    if (!row) throw new ArtiumError('NOT_FOUND')
    const tools = (db.prepare('SELECT tool FROM role_tools WHERE role_id = ? ORDER BY tool').all(id) as { tool: string }[]).map(row => row.tool)
    return adminRoleSchema.parse({ ...row, tools })
  }

  app.route({ method: adminRoleRoutes.get.method, url: adminRoleRoutes.get.path, handler: async request => {
    authorize(request)
    return readRole(parse(adminUserParamsSchema, request.params).id)
  } })
  app.route({ method: adminRoleRoutes.members.method, url: adminRoleRoutes.members.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    readRole(id)
    const { cursor, limit } = parse(adminRoleRoutes.members.input, request.query)
    const rows = db.prepare('SELECT DISTINCT user_id AS id FROM user_roles WHERE role_id = ? AND user_id > ? ORDER BY user_id LIMIT ?')
      .all(id, cursor ?? '', limit + 1) as { id: string }[]
    const { totalCount } = db.prepare('SELECT COUNT(DISTINCT user_id) AS totalCount FROM user_roles WHERE role_id = ?').get(id) as { totalCount: number }
    const page = rows.slice(0, limit)
    return adminRoleRoutes.members.response.parse({ users: page.map(row => readUser(row.id)), totalCount,
      nextCursor: rows.length > limit ? page.at(-1)!.id : null })
  } })
  app.route({ method: adminRoleRoutes.delete.method, url: adminRoleRoutes.delete.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const { expectedRevision } = parse(adminRoleRoutes.delete.input, request.body)
    return change(request, adminRoleRoutes.delete.auditEvent, id, () => ({ id, deleted: true as const }), () => {
      if (readRole(id).revision !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      if (db.prepare('SELECT 1 FROM user_roles WHERE role_id = ? LIMIT 1').get(id)) {
        throw new ArtiumError('INVALID_INPUT', 'This role still has members.', 'Remove this role from every member before deleting it.')
      }
      if (db.prepare('SELECT 1 FROM role_rules WHERE role_id = ? LIMIT 1').get(id)) {
        throw new ArtiumError('INVALID_INPUT', 'This role is used by an SSO rule.', 'Remove or retarget its rules in Sign-in settings before deleting the role.')
      }
      if (db.prepare('SELECT 1 FROM invitation_roles WHERE role_id = ? LIMIT 1').get(id)) {
        throw new ArtiumError('INVALID_INPUT', 'This role is retained by an invitation.', 'Keep the role to preserve the invitation and its history.')
      }
      db.prepare('DELETE FROM role_tools WHERE role_id = ?').run(id)
      db.prepare('DELETE FROM roles WHERE id = ?').run(id)
    })
  } })

  app.route({ method: adminRoleRoutes.list.method, url: adminRoleRoutes.list.path, handler: async request => {
    authorize(request)
    const { cursor, limit } = parse(adminRoleRoutes.list.input, request.query)
    const rows = db.prepare('SELECT id FROM roles WHERE id > ? ORDER BY id LIMIT ?').all(cursor ?? '', limit + 1) as { id: string }[]
    const page = rows.slice(0, limit)
    return adminRoleRoutes.list.response.parse({ roles: page.map(row => readRole(row.id)),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null })
  } })
  app.route({ method: adminRoleRoutes.create.method, url: adminRoleRoutes.create.path, handler: async (request, reply) => {
    authorize(request)
    const input = parse(adminRoleRoutes.create.input, request.body)
    const id = randomUUID()
    const role = change(request, adminRoleRoutes.create.auditEvent, id, readRole, (actor, now) => {
      db.prepare('INSERT INTO roles (id, name, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(id, input.name, now, actor)
    })
    return reply.code(201).send(role)
  } })
  app.route({ method: adminRoleRoutes.patch.method, url: adminRoleRoutes.patch.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const input = parse(adminRoleRoutes.patch.input, request.body)
    return change(request, adminRoleRoutes.patch.auditEvent, id, readRole, (actor, now) => {
      if (readRole(id).revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      db.prepare('UPDATE roles SET name = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(input.name, now, actor, id)
    })
  } })
  app.route({ method: adminRoleRoutes.tools.method, url: adminRoleRoutes.tools.path, handler: async request => {
    authorize(request)
    const { id } = parse(adminUserParamsSchema, request.params)
    const input = parse(adminRoleRoutes.tools.input, request.body)
    return change(request, adminRoleRoutes.tools.auditEvent, id, readRole, (actor, now) => {
      if (readRole(id).revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      db.prepare('DELETE FROM role_tools WHERE role_id = ?').run(id)
      const grant = db.prepare('INSERT INTO role_tools (role_id, tool) VALUES (?, ?)')
      for (const tool of input.tools) grant.run(id, tool)
      db.prepare('UPDATE roles SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now, actor, id)
    })
  } })
}
