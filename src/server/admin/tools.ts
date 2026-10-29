import type Database from 'better-sqlite3'
import { certificateFields } from './certificate.js'
import { registerCertificateAdmin } from './certificates.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminCredentialSchema, adminToolParamsSchema, adminToolRoutes, adminToolSchema, healthSchema,
  nativeSettingsSchemas, toolSchema, githubDeviceRoutes } from '../../shared/api.js'
import { ArtiumError, errorResponse, errors } from '../../shared/errors.js'
import { falconCredentialSchema, falconWritePolicy } from '../adapters/falcon.js'
import { vectraCredentialSchema, vectraWritePolicy } from '../adapters/vectra.js'
import { azCredentialSchema, azWritePolicy } from '../adapters/az.js'
import { mgCredentialSchema, mgWritePolicy } from '../adapters/mg.js'
import { ldapCredentialSchema, ldapWritePolicy } from '../adapters/ldap.js'
import { adoCredentialSchema, adoWritePolicy } from '../adapters/ado.js'
import { ghCredentialSchema, ghWritePolicy } from '../adapters/gh.js'
import { GithubDeviceFlow } from '../adapters/github-device.js'
import { awxCredentialSchema, awxWritePolicy } from '../adapters/awx.js'
import { tenableCredentialSchema, tenableWritePolicy } from '../adapters/tenable.js'
import { hybridCredentialSchema, hybridWritePolicy } from '../adapters/hybrid.js'
import { beyondtrustCredentialSchema, beyondtrustWritePolicy } from '../adapters/beyondtrust.js'
import { checkpointCredentialSchema, checkpointWritePolicy } from '../adapters/checkpoint.js'
import { exchangeAwxPassword, awxPasswordRequested } from '../adapters/awx-login.js'
import { toolManifests } from '../../shared/tool-manifests.js'
import type { Adapter } from '../adapters/types.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import type { Audit, AuditEvent } from '../audit/audit.js'
import type { Runner } from '../runner/runner.js'
import type { ToolHealth } from '../health/health.js'
import type { CredentialReference, MutableCredentialStore, ToolName } from '../store/credential-store.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { isAwxOriginOnly } from '../store/credential-store.js'
import { isCanonicalHttpsOrigin } from '../adapters/credential-input.js'

export interface ToolAdminOptions {
  adapters: readonly Adapter<unknown>[]
  runner: Runner
  store?: MutableCredentialStore
  health: ToolHealth
  credentialProfiles: Partial<Record<ToolName, CredentialProfile>>
}

const credentialSchemas = { 'beyondtrust-axi': beyondtrustCredentialSchema, 'gh-axi': ghCredentialSchema, 'checkpoint-axi': checkpointCredentialSchema, 'hybrid-axi': hybridCredentialSchema, 'falcon-axi': falconCredentialSchema, 'vectra-axi': vectraCredentialSchema, 'az-axi': azCredentialSchema, 'mg-axi': mgCredentialSchema, 'ldap-axi': ldapCredentialSchema, 'ado-axi': adoCredentialSchema, 'awx-axi': awxCredentialSchema, 'tenable-axi': tenableCredentialSchema }
const writePolicies = { 'beyondtrust-axi': beyondtrustWritePolicy, 'gh-axi': ghWritePolicy, 'checkpoint-axi': checkpointWritePolicy, 'falcon-axi': falconWritePolicy, 'vectra-axi': vectraWritePolicy, 'az-axi': azWritePolicy,
  'mg-axi': mgWritePolicy, 'ldap-axi': ldapWritePolicy, 'ado-axi': adoWritePolicy, 'awx-axi': awxWritePolicy, 'tenable-axi': tenableWritePolicy, 'hybrid-axi': hybridWritePolicy }
const publicFields = {
  'gh-axi': ['origin', 'auth', 'appId', 'installationId', 'repositories', 'permissions', 'login', 'accessTokenExpiresAt'],
  'beyondtrust-axi': ['host', 'clientId'],
  'checkpoint-axi': ['region', 'clientId', 'saas', 'scope'],
  'hybrid-axi': ['origin'],
  'tenable-axi': ['origin'],
  'awx-axi': ['origin'],
  'ado-axi': ['org', 'project', 'auth', 'tenantId', 'clientId'],
  'ldap-axi': ['url', 'auth', 'bindDn', 'base', 'pageSize', 'startTls', 'tlsMaxVersion', 'caFile'],
  'falcon-axi': ['clientId', 'region', 'memberCid'],
  'vectra-axi': ['kind', 'apiVersion', 'origin', 'auth', 'clientId', 'applianceRelease', 'caBundle'],
  'az-axi': ['tenantId', 'clientId', 'auth', 'thumbprintSha256'],
  'mg-axi': ['tenantId', 'clientId', 'auth', 'thumbprint'],
}
const legacySecretFields = {
  'gh-axi': ['token', 'privateKey', 'accessToken'],
  'checkpoint-axi': ['clientSecret'],
  'beyondtrust-axi': ['clientSecret'],
  'hybrid-axi': ['apiKey'],
  'tenable-axi': ['accessKey', 'secretKey'],
  'awx-axi': ['token'],
  'ado-axi': ['token', 'clientSecret'],
  'ldap-axi': ['bindPassword'],
  'falcon-axi': ['clientSecret'],
  'vectra-axi': ['token', 'clientSecret'],
  'az-axi': ['clientSecret', 'privateKey'],
  'mg-axi': ['clientSecret', 'privateKey'],
}

export function registerToolAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string, options: ToolAdminOptions): void {
  const { adapters, store, health, credentialProfiles } = options
  registerCertificateAdmin(app, db, audit, authorize, store, health)
  const schemaFor = (tool: ToolName) => credentialProfiles[tool]?.credentialSchema ?? credentialSchemas[tool]
  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const result = schema.safeParse(value)
    if (!result.success) {
      const issues = result.error.issues.filter(issue => issue.code === 'custom')
      throw new ArtiumError('INVALID_INPUT', issues.length ? issues.map(issue => issue.message).join(' ') : undefined)
    }
    return result.data
  }
  function toolName(request: FastifyRequest): ToolName {
    const parsed = adminToolParamsSchema.safeParse(request.params)
    if (!parsed.success) throw new ArtiumError('NOT_FOUND')
    return parsed.data.tool
  }
  function credentialStore(): MutableCredentialStore {
    if (!store) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return store
  }
  function readTool(tool: ToolName): z.infer<typeof adminToolSchema> {
    const row = db.prepare(`SELECT name, enabled, native_settings AS nativeSettings,
      revision, updated_at AS updatedAt, updated_by AS updatedBy FROM tools WHERE name = ?`).get(tool) as
      { name: ToolName, enabled: number, nativeSettings: string, revision: number, updatedAt: number | null, updatedBy: string | null } | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    const credential = db.prepare('SELECT revision FROM credentials WHERE tool = ?').get(tool) as { revision: number } | undefined
    const stored = healthSchema.safeParse(db.prepare(`SELECT status, checked_at AS checkedAt, credential_revision AS credentialRevision,
      error_code AS errorCode FROM tool_health WHERE tool = ? AND credential_revision = ?`).get(tool, credential?.revision ?? 0))
    // Cached categories from an older catalogue require a fresh test after upgrade.
    const cached = stored.success ? stored.data : undefined
    const reference = tool === 'awx-axi' ? store?.findCredential(tool) : undefined
    const configured = Boolean(credential) && !(reference && isAwxOriginOnly(tool, store!.readCredential(reference)))
    const status = !row.enabled || !adapters.some(adapter => adapter.name === tool) ? 'disabled' : !configured ? 'unconfigured' : options.health.checking(tool) ? 'checking' : 'unknown'
    const health = { checkedAt: null, credentialRevision: null, errorCode: null, ...cached,
      ...(['disabled', 'unconfigured'].includes(status) || !cached ? { status } : {}) }
    const nativeSettings = JSON.parse(row.nativeSettings)
    const writeAccess = writePolicies[tool].read(nativeSettings)
    const readOnly = !writeAccess.enabled
    const diagnostic = options.health.diagnostic(tool, health.credentialRevision, health.checkedAt)
    return adminToolSchema.parse({ ...row, version: toolManifests[tool].version, enabled: Boolean(row.enabled),
      nativeSettings, readOnly, writeAccess,
      health: { ...health, readOnly, ...(diagnostic ? { diagnostic } : {}) } })
  }
  function readCredential(tool: ToolName): z.infer<typeof adminCredentialSchema> {
    readTool(tool)
    const row = db.prepare('SELECT revision, updated_at AS updatedAt, updated_by AS updatedBy FROM credentials WHERE tool = ?').get(tool) as
      { revision: number, updatedAt: number | null, updatedBy: string | null } | undefined
    const reference = store?.findCredential(tool)
    const value = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
    const originOnly = isAwxOriginOnly(tool, value)
    const metadata = reference && credentialProfiles[tool] && !originOnly ? credentialProfiles[tool].metadata(value)
      : Object.fromEntries(publicFields[tool].filter(field => value[field] !== undefined).map(field => [field, value[field]]))
    return adminCredentialSchema.parse({ tool, configured: Boolean(row) && !originOnly, revision: 0, updatedAt: null, updatedBy: null, ...row, metadata })
  }
  function splitSettings(tool: ToolName, value: Record<string, unknown>) {
    const keys = Object.keys(nativeSettingsSchemas[tool].shape)
    return { credential: Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))),
      settings: Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))) }
  }
  function invalidate(reference: CredentialReference | undefined): void {
    if (reference) for (const adapter of adapters) if (adapter.name === reference.tool) adapter.invalidateCredential?.(reference)
  }
  function writeChange(request: FastifyRequest, actor: string, tool: ToolName,
    before: Record<string, unknown>, after: Record<string, unknown>): AuditEvent[] {
    const previous = writePolicies[tool].read(before)
    const next = writePolicies[tool].read(after)
    const deletes = (settings: Record<string, unknown>) => (settings.writes as { allowDeletes?: boolean } | undefined)?.allowDeletes === true
    if (deletes(before) === deletes(after) && previous.enabled === next.enabled &&
      JSON.stringify([...previous.allowedOperations].sort()) === JSON.stringify([...next.allowedOperations].sort())) return []
    // The advanced JSON editor accepts arbitrary names. Only catalogue identities belong in audit.
    const operations = next.allowedOperations.filter(operation => next.supportedOperations?.includes(operation))
    return [{ event: 'tool-write-access', userId: actor, tool, outcome: 'success', enabled: next.enabled,
      operations, ...(tool === 'beyondtrust-axi' ? { allowDeletes: deletes(after) } : {}), unsupportedOperationCount: next.allowedOperations.length - operations.length,
      requestId: request.id, clientAddress: request.ip }]
  }
  const githubDevice = new GithubDeviceFlow()
  function githubRevisions(expectedRevision: number, expectedToolRevision: number): void {
    if (readTool('gh-axi').revision !== expectedToolRevision
      || (credentialStore().findCredential('gh-axi')?.revision ?? 0) !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
  }
  app.post(githubDeviceRoutes.start.path, async (request, reply) => {
    const actor = authorize(request)
    const input = parse(githubDeviceRoutes.start.input, request.body)
    if (!isCanonicalHttpsOrigin(input.origin)) throw new ArtiumError('INVALID_INPUT')
    githubRevisions(input.expectedRevision, input.expectedToolRevision)
    const reference = credentialStore().findCredential('gh-axi')
    const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : undefined
    const trust = reference && stored?.origin === input.origin ? readCredentialTrust(db, reference) : []
    const result = await githubDevice.start(actor, input, trust)
    authorize(request)
    githubRevisions(input.expectedRevision, input.expectedToolRevision)
    return reply.header('Cache-Control', 'no-store').send(githubDeviceRoutes.start.response.parse(result))
  })
  app.post(githubDeviceRoutes.cancel.path, async request => {
    const actor = authorize(request)
    const input = parse(githubDeviceRoutes.cancel.input, request.body)
    githubDevice.cancel(actor, input.connectionId)
    return githubDeviceRoutes.cancel.response.parse({ status: 'cancelled' })
  })
  app.post(githubDeviceRoutes.poll.path, async (request, reply) => {
    const actor = authorize(request)
    const { connectionId } = parse(githubDeviceRoutes.poll.input, request.body)
    const connection = githubDevice.current(actor, connectionId)
    githubRevisions(connection.expectedRevision, connection.expectedToolRevision)
    const result = await githubDevice.poll(actor, connectionId)
    authorize(request)
    if (result.status === 'pending') return reply.header('Cache-Control', 'no-store').send(githubDeviceRoutes.poll.response.parse(result))
    let replacement: CredentialReference | undefined
    const credential = audit.change({ event: 'admin-change', action: 'connect-github-device', targetId: 'gh-axi',
      userId: actor, tool: 'gh-axi', outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      githubRevisions(connection.expectedRevision, connection.expectedToolRevision)
      const value = parse(ghCredentialSchema, result.value)
      const old = credentialStore().findCredential('gh-axi')
      const stored = old ? credentialStore().readCredential(old) as Record<string, unknown> : undefined
      const now = Date.now()
      replacement = credentialStore().replaceCredential('gh-axi', value, connection.expectedRevision, actor, now)
      if (stored?.origin !== connection.origin) db.prepare('DELETE FROM trusted_certificates WHERE credential_id = ?').run(replacement.id)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run('gh-axi')
      db.prepare('UPDATE tools SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?').run(now, actor, 'gh-axi')
      return readCredential('gh-axi')
    }).value
    invalidate(replacement)
    try { await health.checkReplacement('gh-axi', actor, request.id, request.ip, () => { authorize(request) }) }
    catch (error) {
      authorize(request)
      if (!(error instanceof ArtiumError)) throw error
    }
    return reply.header('Cache-Control', 'no-store').send(githubDeviceRoutes.poll.response.parse({ status: 'connected', credential }))
  })
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
  app.route({ method: adminToolRoutes.get.method, url: adminToolRoutes.get.path, handler: async request => {
    authorize(request)
    parse(adminToolRoutes.get.input, request.query)
    return readTool(toolName(request))
  } })
  app.route({ method: adminToolRoutes.writeAccess.method, url: adminToolRoutes.writeAccess.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const input = parse(adminToolRoutes.writeAccess.input, request.body)
    const current = readTool(tool)
    if (current.revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
    const settings = writePolicies[tool].update(current.nativeSettings, input)
    const events = writeChange(request, actor, tool, current.nativeSettings, settings)
    if (!events.length) return current
    let replacement: CredentialReference | undefined
    const result = audit.change(events, () => {
      authorize(request)
      const now = Date.now()
      const reference = store?.findCredential(tool)
      if (reference) {
        const value = credentialStore().readCredential(reference) as Record<string, unknown>
        replacement = credentialStore().replaceCredential(tool, splitSettings(tool, value).credential, reference.revision!, actor, now)
      }
      db.prepare('UPDATE tools SET native_settings = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?')
        .run(JSON.stringify(settings), now, actor, tool)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run(tool)
      return readTool(tool)
    }).value
    invalidate(replacement)
    if (replacement) await health.refresh(tool, true)
    return replacement ? readTool(tool) : result
  } })
  app.route({ method: adminToolRoutes.saveOrigin.method, url: adminToolRoutes.saveOrigin.path, handler: async request => {
    const actor = authorize(request)
    const input = parse(adminToolRoutes.saveOrigin.input, request.body)
    if (!isCanonicalHttpsOrigin(input.origin)) throw new ArtiumError('INVALID_INPUT',
      'origin must be an HTTPS origin without a path, query, fragment or embedded credentials.')
    const tool = 'awx-axi'
    let replacement: CredentialReference | undefined
    const result = audit.change({ event: 'admin-change', action: adminToolRoutes.saveOrigin.auditEvent, targetId: tool,
      userId: actor, tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
      const reference = credentialStore().findCredential(tool)
      const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
      const sameOrigin = stored.origin === input.origin
      const value = sameOrigin ? splitSettings(tool, stored).credential : { origin: input.origin }
      const now = Date.now()
      replacement = credentialStore().replaceCredential(tool, value, input.expectedRevision, actor, now)
      if (!sameOrigin) db.prepare('DELETE FROM trusted_certificates WHERE credential_id = ?').run(replacement.id)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run(tool)
      db.prepare('UPDATE tools SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?').run(now, actor, tool)
      return readCredential(tool)
    }).value
    invalidate(replacement)
    await health.refresh(tool, true)
    return result
  } })
  app.route({ method: adminToolRoutes.patch.method, url: adminToolRoutes.patch.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const input = parse(adminToolRoutes.patch.input, request.body)
    const settings = input.nativeSettings === undefined ? undefined : parse(nativeSettingsSchemas[tool], input.nativeSettings)
    if (input.enabled && !adapters.some(adapter => adapter.name === tool)) throw new ArtiumError('TOOL_DISABLED')
    let replacement: CredentialReference | undefined
    const events: AuditEvent[] = [{ event: 'admin-change', action: adminToolRoutes.patch.auditEvent, targetId: tool,
      userId: actor, tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }]
    const result = audit.change(events, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const now = Date.now()
      if (settings !== undefined) {
        events.push(...writeChange(request, actor, tool, current.nativeSettings, settings))
        const reference = credentialStore().findCredential(tool)
        if (reference) {
          const value = credentialStore().readCredential(reference) as Record<string, unknown>
          const credential = splitSettings(tool, value).credential
          if (!isAwxOriginOnly(tool, credential)) parse(schemaFor(tool), { ...credential, ...settings })
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
    return replacement ? readTool(tool) : result
  } })
  for (const route of [adminToolRoutes.replace, adminToolRoutes.save]) app.route({ method: route.method, url: route.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const input = parse(route.input, request.body)
    const saving = route === adminToolRoutes.save
    let value = parse(z.record(z.string(), z.unknown()), input.value)
    if (tool === 'gh-axi' && (value.auth === 'device' || ['accessToken', 'accessTokenExpiresAt', 'login'].some(key => Object.hasOwn(value, key)))) {
      throw new ArtiumError('INVALID_INPUT', 'Device credentials are managed by Connect with GitHub.', 'Use Connect with GitHub to connect or rotate this credential.')
    }
    const profile = credentialProfiles[tool]
    if (saving && Object.hasOwn(value, 'certificatePem')) {
      try {
        if (value.auth !== 'certificate' || !['az-axi', 'mg-axi'].includes(tool) || typeof value.certificatePem !== 'string') throw new Error('Invalid certificate input')
        const { certificatePem: _, ...fields } = value
        const sha256 = tool === 'az-axi' || Boolean(credentialProfiles[tool]?.fields().some(field => field.name === 'thumbprintSha256'))
        value = { ...fields, ...certificateFields(value.certificatePem, sha256) }
      } catch { throw new ArtiumError('INVALID_INPUT', 'The PEM must contain one certificate and its matching unencrypted private key.', 'Choose a matching certificate and key, then save again.') }
    }
    if (saving && Object.keys(splitSettings(tool, value).settings).length) throw new ArtiumError('INVALID_INPUT')
    const awx = tool === 'awx-axi'
    const normalized = profile ? (saving || awx ? profile.normalizeInput(value) : profile.parseInput(value)) : undefined
    const normalizations = [...normalized?.normalizations ?? []]
    if (normalized) value = normalized.value
    else if (!saving) value = parse(schemaFor(tool), value) as Record<string, unknown>
    if (awx) {
      const reference = credentialStore().findCredential(tool)
      if (awxPasswordRequested(value)) {
        const current = readTool(tool)
        if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
        if ((reference?.revision ?? 0) !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      }
      value = await exchangeAwxPassword(value, reference ? readCredentialTrust(db, reference) : [], () => {
        const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : undefined
        if (stored?.origin !== value.origin) throw new ArtiumError('INVALID_INPUT',
          'Save the controller address before signing in with a username and password.')
        parse(schemaFor(tool), { ...value, signIn: value.signIn === undefined ? 'password' : value.signIn,
          ...(saving ? readTool(tool).nativeSettings : {}) })
      })
      if (!saving && profile) {
        const parsed = profile.parseInput(value)
        value = parsed.value
        normalizations.push(...parsed.normalizations)
      }
    }
    let replacement: CredentialReference | undefined
    const events: AuditEvent[] = [{ event: 'admin-change', action: adminToolRoutes.replace.auditEvent, targetId: tool,
      userId: actor, tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }]
    const result = audit.change(events, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
      const reference = credentialStore().findCredential(tool)
      if (saving && (reference?.revision ?? 0) !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      let next = value
      if (saving) {
        const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
        const sameIdentity = ['mode', 'kind', 'auth', 'tenantId', 'clientId', 'origin', 'org', 'appId', 'installationId'].every(key => stored[key] === value[key])
        const secrets = credentialProfiles[tool]?.fields().filter(field => field.schema['x-secret'] && field.schema['x-ephemeral'] !== true)
          .map(field => field.name) ?? legacySecretFields[tool]
        const retained = sameIdentity ? Object.fromEntries(secrets.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]])) : {}
        next = parse(schemaFor(tool), { ...retained, ...value, ...current.nativeSettings }) as Record<string, unknown>
      }
      const { credential, settings } = splitSettings(tool, next)
      events.push(...writeChange(request, actor, tool, current.nativeSettings, settings))
      const now = Date.now()
      replacement = credentialStore().replaceCredential(tool, credential, input.expectedRevision, actor, now)
      db.prepare(`UPDATE tools SET native_settings = ?, pinned_version = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?`)
        .run(JSON.stringify(settings), toolManifests[tool].version, now, actor, tool)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run(tool)
      return { ...readCredential(tool), ...(normalizations.length ? { normalizations } : {}) }
    }).value
    invalidate(replacement)
    await health.refresh(tool, true)
    return result
  } })
  app.route({ method: adminToolRoutes.test.method, url: adminToolRoutes.test.path, handler: async (request, reply) => {
    const actor = authorize(request)
    const tool = toolName(request)
    parse(adminToolRoutes.test.input, request.body ?? {})
    try { return await health.check(tool, actor, request.id, request.ip, () => { authorize(request) }) }
    catch (error) {
      authorize(request)
      if (!(error instanceof ArtiumError)) throw error
      const response = errorResponse(error, request.id)
      return reply.code(errors[error.code].status).send({ error: { ...response.error,
        ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } })
    }
  } })
}
