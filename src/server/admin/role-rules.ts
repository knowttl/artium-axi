import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminRoleRuleRoutes, adminRoleRuleSchema, adminUserParamsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'

export function registerRoleRuleAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string): void {
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  function provider(id: string): void {
    if (!db.prepare("SELECT 1 FROM sso_providers WHERE id = ? AND kind = 'entra'").get(id)) throw new ArtiumError('NOT_FOUND')
  }
  function read(id: string): z.infer<typeof adminRoleRuleSchema> {
    const row = db.prepare(`SELECT id, provider_id AS providerId, claim, value, role_id AS roleId,
      revision, updated_at AS updatedAt, updated_by AS updatedBy FROM role_rules WHERE id = ?`).get(id)
    if (!row) throw new ArtiumError('NOT_FOUND')
    return adminRoleRuleSchema.parse(row)
  }
  app.get(adminRoleRuleRoutes.list.path, async request => {
    authorize(request)
    const { providerId } = parse(adminRoleRuleRoutes.list.input, request.query)
    provider(providerId)
    const rows = db.prepare('SELECT id FROM role_rules WHERE provider_id = ? ORDER BY value, role_id, id').all(providerId) as { id: string }[]
    return adminRoleRuleRoutes.list.response.parse({ rules: rows.map(row => read(row.id)) })
  })
  for (const route of [adminRoleRuleRoutes.create, adminRoleRuleRoutes.patch, adminRoleRuleRoutes.delete]) {
    app.route({ method: route.method, url: route.path, handler: async request => {
      const actor = authorize(request)
      const input = parse<z.infer<typeof adminRoleRuleRoutes.create.input> | z.infer<typeof adminRoleRuleRoutes.patch.input> | z.infer<typeof adminRoleRuleRoutes.delete.input>>(route.input, request.body)
      const id = route === adminRoleRuleRoutes.create ? randomUUID() : parse(adminUserParamsSchema, request.params).id
      return audit.change({ event: 'admin-change', action: route.auditEvent, targetId: id, userId: actor,
        tool: null, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
        authorize(request)
        const current = 'expectedRevision' in input ? read(id) : null
        if (current && 'expectedRevision' in input && current.revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
        // Moving a granted rule would strand its old provider's grants outside that provider's sync.
        if (current && (!('roleId' in input) || input.roleId !== current.roleId || input.providerId !== current.providerId) &&
          db.prepare('SELECT 1 FROM user_roles WHERE origin = ? LIMIT 1').get(id)) {
          throw new ArtiumError('INVALID_INPUT', 'This rule still grants a role to users.', 'Remove its rule-origin grants before removing the rule or changing its provider or target role.')
        }
        if (!('providerId' in input)) {
          db.prepare('DELETE FROM role_rules WHERE id = ?').run(id)
          return { id, deleted: true as const }
        }
        provider(input.providerId)
        if (!db.prepare('SELECT 1 FROM roles WHERE id = ?').get(input.roleId)) throw new ArtiumError('NOT_FOUND')
        if (db.prepare('SELECT 1 FROM role_rules WHERE provider_id = ? AND claim = ? AND value = ? AND role_id = ? AND id != ?')
          .get(input.providerId, input.claim, input.value, input.roleId, id)) {
          throw new ArtiumError('INVALID_INPUT', 'This mapping already exists.', 'Edit the existing rule or choose a different claim value or role.')
        }
        if (current) {
          db.prepare(`UPDATE role_rules SET provider_id = ?, claim = ?, value = ?, role_id = ?,
            revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`)
            .run(input.providerId, input.claim, input.value, input.roleId, Date.now(), actor, id)
        } else {
          db.prepare(`INSERT INTO role_rules (id, provider_id, claim, value, role_id, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.providerId, input.claim, input.value, input.roleId, Date.now(), actor)
        }
        return read(id)
      }).value
    } })
  }
}
