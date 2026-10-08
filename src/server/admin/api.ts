import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminAuditRoute, adminRoleRoutes, adminRoleSchema, adminUserParamsSchema, adminUserRoutes, adminUserSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import type { AuthAttempts } from '../auth/attempts.js'
import { readUsername } from '../auth/bootstrap.js'
import { hashPassword } from '../auth/local.js'
import { requireRecentAuth, revokeUserSessions, verifyAccessToken } from '../auth/tokens.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { registerToolAdmin, type ToolAdminOptions } from './tools.js'

type PublicUser = z.infer<typeof adminUserSchema>

export function registerAdmin(app: FastifyInstance, db: Database.Database, audit: Audit, authAttempts: AuthAttempts, tools: ToolAdminOptions): void {
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
      revision, updated_at AS updatedAt, updated_by AS updatedBy FROM users WHERE id = ?`).get(id) as
      (Omit<PublicUser, 'enabled' | 'administrator' | 'mustChange' | 'roleIds'> &
        { disabled: number, administrator: number, mustChange: number }) | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    const { disabled, ...fields } = row
    const roleIds = (db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id').all(id) as { role_id: string }[])
      .map(role => role.role_id)
    return adminUserSchema.parse({ ...fields, enabled: !disabled, administrator: Boolean(row.administrator),
      mustChange: Boolean(row.mustChange), roleIds })
  }

  registerToolAdmin(app, db, audit, authorize, tools)

  app.route({ method: adminAuditRoute.method, url: adminAuditRoute.path, handler: async request => {
    authorize(request)
    return adminAuditRoute.response.parse(audit.query(parse(adminAuditRoute.input, request.query)))
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
    const { cursor, limit } = parse(adminUserRoutes.list.input, request.query)
    const rows = db.prepare('SELECT id FROM users WHERE id > ? ORDER BY id LIMIT ?').all(cursor ?? '', limit + 1) as { id: string }[]
    const page = rows.slice(0, limit)
    return adminUserRoutes.list.response.parse({ users: page.map(row => readUser(row.id)),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null })
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
    readUser(id)
    const hash = await hashPassword(input.temporaryPassword)
    const user = change(request, adminUserRoutes.reset.auditEvent, id, readUser, (actor, now) => {
      readUser(id)
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
      if (readUser(id).revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id)
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
