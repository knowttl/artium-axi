import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminCredentialSchema, adminToolParamsSchema, adminToolRoutes, adminToolSchema, healthSchema,
  nativeSettingsSchemas, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { falconCredentialSchema } from '../adapters/falcon.js'
import { vectraCredentialSchema } from '../adapters/vectra.js'
import { azCredentialSchema } from '../adapters/az.js'
import { mgCredentialSchema } from '../adapters/mg.js'
import { toolManifests } from '../../shared/tool-manifests.js'
import type { Adapter } from '../adapters/types.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import type { Audit } from '../audit/audit.js'
import type { Runner } from '../runner/runner.js'
import type { ToolHealth } from '../health/health.js'
import type { CredentialReference, MutableCredentialStore, ToolName } from '../store/credential-store.js'

export interface ToolAdminOptions {
  adapters: readonly Adapter<unknown>[]
  runner: Runner
  store?: MutableCredentialStore
  health: ToolHealth
  credentialProfiles: Partial<Record<ToolName, CredentialProfile>>
}

const credentialSchemas = { 'falcon-axi': falconCredentialSchema, 'vectra-axi': vectraCredentialSchema, 'az-axi': azCredentialSchema, 'mg-axi': mgCredentialSchema }
const publicFields = {
  'falcon-axi': ['region', 'memberCid'],
  'vectra-axi': ['kind', 'apiVersion', 'origin', 'auth', 'clientId', 'applianceRelease'],
  'az-axi': ['tenantId', 'clientId', 'auth', 'thumbprintSha256'],
  'mg-axi': ['tenantId', 'clientId', 'auth', 'thumbprint'],
}

export function registerToolAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string, options: ToolAdminOptions): void {
  const { adapters, store, health, credentialProfiles } = options
  const schemaFor = (tool: ToolName) => credentialProfiles[tool]?.credentialSchema ?? credentialSchemas[tool]
  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  function toolName(request: FastifyRequest): ToolName {
    const parsed = adminToolParamsSchema.safeParse(request.params)
    if (!parsed.success) throw new ArtiumError('NOT_FOUND')
    return parsed.data.tool
  }
  function credentialStore(): MutableCredentialStore {
    if (!store) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
    return store
  }
  function readTool(tool: ToolName): z.infer<typeof adminToolSchema> {
    const row = db.prepare(`SELECT name, enabled, native_settings AS nativeSettings,
      revision, updated_at AS updatedAt, updated_by AS updatedBy FROM tools WHERE name = ?`).get(tool) as
      { name: ToolName, enabled: number, nativeSettings: string, revision: number, updatedAt: number | null, updatedBy: string | null } | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    const credential = db.prepare('SELECT revision FROM credentials WHERE tool = ?').get(tool) as { revision: number } | undefined
    const cached = db.prepare(`SELECT status, checked_at AS checkedAt, credential_revision AS credentialRevision,
      error_code AS errorCode FROM tool_health WHERE tool = ? AND credential_revision = ?`).get(tool, credential?.revision ?? 0) as z.infer<typeof healthSchema> | undefined
    const status = !row.enabled || !adapters.some(adapter => adapter.name === tool) ? 'disabled' : !credential ? 'unconfigured' : 'unknown'
    const health = { checkedAt: null, credentialRevision: null, errorCode: null, ...cached,
      ...(['disabled', 'unconfigured'].includes(status) || !cached ? { status } : {}) }
    return adminToolSchema.parse({ ...row, version: toolManifests[tool].version, enabled: Boolean(row.enabled), nativeSettings: JSON.parse(row.nativeSettings), health })
  }
  function readCredential(tool: ToolName): z.infer<typeof adminCredentialSchema> {
    readTool(tool)
    const row = db.prepare('SELECT revision, updated_at AS updatedAt, updated_by AS updatedBy FROM credentials WHERE tool = ?').get(tool) as
      { revision: number, updatedAt: number | null, updatedBy: string | null } | undefined
    const reference = store?.findCredential(tool)
    const value = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
    const metadata = reference && credentialProfiles[tool] ? credentialProfiles[tool].metadata(value)
      : Object.fromEntries(publicFields[tool].filter(field => value[field] !== undefined).map(field => [field, value[field]]))
    return adminCredentialSchema.parse({ tool, configured: Boolean(row), revision: 0, updatedAt: null, updatedBy: null, ...row, metadata })
  }
  function splitSettings(tool: ToolName, value: Record<string, unknown>) {
    const keys = Object.keys(nativeSettingsSchemas[tool].shape)
    return { credential: Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))),
      settings: Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))) }
  }
  function invalidate(reference: CredentialReference | undefined): void {
    if (reference) for (const adapter of adapters) if (adapter.name === reference.tool) adapter.invalidateCredential?.(reference)
  }
  app.route({ method: adminToolRoutes.list.method, url: adminToolRoutes.list.path, handler: async request => {
    authorize(request)
    parse(adminToolRoutes.list.input, request.query)
    return adminToolRoutes.list.response.parse({ tools: toolSchema.options.map(readTool) })
  } })
  app.route({ method: adminToolRoutes.credential.method, url: adminToolRoutes.credential.path, handler: async request => {
    authorize(request)
    parse(adminToolRoutes.credential.input, request.query)
    return readCredential(toolName(request))
  } })
  app.route({ method: adminToolRoutes.patch.method, url: adminToolRoutes.patch.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const input = parse(adminToolRoutes.patch.input, request.body)
    const settings = input.nativeSettings === undefined ? undefined : parse(nativeSettingsSchemas[tool], input.nativeSettings)
    if (input.enabled && !adapters.some(adapter => adapter.name === tool)) throw new ArtiumError('TOOL_DISABLED')
    let replacement: CredentialReference | undefined
    const result = audit.change({ event: 'admin-change', action: adminToolRoutes.patch.auditEvent, targetId: tool,
      userId: actor, tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const now = Date.now()
      if (settings !== undefined) {
        const reference = credentialStore().findCredential(tool)
        if (reference) {
          const value = credentialStore().readCredential(reference) as Record<string, unknown>
          const credential = splitSettings(tool, value).credential
          parse(schemaFor(tool), { ...credential, ...settings })
          replacement = credentialStore().replaceCredential(tool, credential, reference.revision!, actor, now)
        }
        db.prepare('DELETE FROM tool_health WHERE tool = ?').run(tool)
      }
      db.prepare(`UPDATE tools SET enabled = ?, native_settings = ?, pinned_version = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?`)
        .run(Number(input.enabled ?? current.enabled), JSON.stringify(settings ?? current.nativeSettings), toolManifests[tool].version, now, actor, tool)
      return readTool(tool)
    }).value
    invalidate(replacement)
    if (replacement) await health.refresh(tool, true)
    return result
  } })
  app.route({ method: adminToolRoutes.replace.method, url: adminToolRoutes.replace.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const input = parse(adminToolRoutes.replace.input, request.body)
    const value = parse(schemaFor(tool), input.value) as Record<string, unknown>
    const { credential, settings } = splitSettings(tool, value)
    let replacement: CredentialReference | undefined
    const result = audit.change({ event: 'admin-change', action: adminToolRoutes.replace.auditEvent, targetId: tool,
      userId: actor, tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
      const now = Date.now()
      replacement = credentialStore().replaceCredential(tool, credential, input.expectedRevision, actor, now)
      db.prepare(`UPDATE tools SET native_settings = ?, pinned_version = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?`)
        .run(JSON.stringify(settings), toolManifests[tool].version, now, actor, tool)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run(tool)
      return readCredential(tool)
    }).value
    invalidate(replacement)
    await health.refresh(tool, true)
    return result
  } })
  app.route({ method: adminToolRoutes.test.method, url: adminToolRoutes.test.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    parse(adminToolRoutes.test.input, request.body ?? {})
    return health.check(tool, actor, request.id, request.ip, () => { authorize(request) })
  } })
}
