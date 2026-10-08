import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminUserParamsSchema, adminUserRoutes, adminUserSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import type { AuthAttempts } from '../auth/attempts.js'
import { readUsername } from '../auth/bootstrap.js'
import { hashPassword } from '../auth/local.js'
import { requireRecentAuth, revokeUserSessions, verifyAccessToken } from '../auth/tokens.js'

type PublicUser = z.infer<typeof adminUserSchema>

export function registerUserAdmin(app: FastifyInstance, db: Database.Database, audit: Audit, authAttempts: AuthAttempts): void {
  function authorize(request: FastifyRequest): string {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    let userId: string | null = null
    try {
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

  function change(request: FastifyRequest, action: string, id: string, mutation: (actor: string, now: number) => void): PublicUser {
    const actor = authorize(request)
    try {
      return audit.change({ event: 'admin-change', action, targetId: id, userId: actor, tool: null,
        outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
        authorize(request)
        mutation(actor, Date.now())
        return readUser(id)
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
    const user = change(request, adminUserRoutes.create.auditEvent, id, (actor, now) => {
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
    return change(request, adminUserRoutes.patch.auditEvent, id, (actor, now) => {
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
    const user = change(request, adminUserRoutes.unlock.auditEvent, id, (actor, now) => {
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
    const user = change(request, adminUserRoutes.reset.auditEvent, id, (actor, now) => {
      readUser(id)
      db.prepare(`UPDATE users SET password_hash = ?, must_change = 1, failed_attempts = 0, locked_until = NULL,
        revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`).run(hash, now, actor, id)
      revokeUserSessions(db, id, now)
    })
    authAttempts.clearUsername(user.username)
    return user
  } })
}
