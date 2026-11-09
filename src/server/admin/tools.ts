import type Database from 'better-sqlite3'
import { certificateFields } from './certificate.js'
import { registerCertificateAdmin } from './certificates.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminCredentialSchema, adminInstanceRoutes, adminInstanceSchema, adminToolParamsSchema, adminToolRoutes, adminToolSchema,
  healthSchema, instanceNameSchema, nativeSettingsSchemas, toolSchema, githubDeviceRoutes } from '../../shared/api.js'
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
import { proxmoxProfile, proxmoxWritePolicy } from '../adapters/proxmox.js'
import { unifiProfile, unifiWritePolicy } from '../adapters/unifi.js'
import { technitiumProfile, technitiumWritePolicy } from '../adapters/technitium.js'
import { shodanProfile, shodanWritePolicy } from '../adapters/shodan.js'
import { giteaProfile, giteaWritePolicy } from '../adapters/gitea.js'
import { kubernetesProfile, kubernetesWritePolicy } from '../adapters/kubernetes.js'
import { sshWritePolicy } from '../adapters/ssh.js'
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
import { hasSshConfiguration, type SshHosts } from '../store/ssh-hosts.js'

export interface ToolAdminOptions {
  adapters: readonly Adapter<unknown>[]
  runner: Runner
  store?: MutableCredentialStore
  health: ToolHealth
  credentialProfiles: Partial<Record<ToolName, CredentialProfile>>
  sshHosts?: SshHosts
}

const credentialSchemas = { 'shodan-axi': shodanProfile.credentialSchema, 'ssh-axi': z.never(), 'kubernetes-axi': kubernetesProfile.credentialSchema, 'gitea-axi': giteaProfile.credentialSchema, 'technitium-axi': technitiumProfile.credentialSchema, 'unifi-axi': unifiProfile.credentialSchema, 'proxmox-axi': proxmoxProfile.credentialSchema, 'beyondtrust-axi': beyondtrustCredentialSchema, 'gh-axi': ghCredentialSchema, 'checkpoint-axi': checkpointCredentialSchema, 'hybrid-axi': hybridCredentialSchema, 'falcon-axi': falconCredentialSchema, 'vectra-axi': vectraCredentialSchema, 'az-axi': azCredentialSchema, 'mg-axi': mgCredentialSchema, 'ldap-axi': ldapCredentialSchema, 'ado-axi': adoCredentialSchema, 'awx-axi': awxCredentialSchema, 'tenable-axi': tenableCredentialSchema }
const writePolicies = { 'ssh-axi': sshWritePolicy, 'kubernetes-axi': kubernetesWritePolicy, 'gitea-axi': giteaWritePolicy, 'unifi-axi': unifiWritePolicy, 'proxmox-axi': proxmoxWritePolicy, 'beyondtrust-axi': beyondtrustWritePolicy, 'gh-axi': ghWritePolicy, 'checkpoint-axi': checkpointWritePolicy, 'falcon-axi': falconWritePolicy, 'vectra-axi': vectraWritePolicy, 'az-axi': azWritePolicy,
  'mg-axi': mgWritePolicy, 'ldap-axi': ldapWritePolicy, 'ado-axi': adoWritePolicy, 'awx-axi': awxWritePolicy, 'tenable-axi': tenableWritePolicy, 'hybrid-axi': hybridWritePolicy, 'technitium-axi': technitiumWritePolicy, 'shodan-axi': shodanWritePolicy }
const publicFields = {
  'ssh-axi': [],
  'kubernetes-axi': ['origin', 'auth', 'namespace', 'certificateAuthority', 'clientCertificate'],
  'technitium-axi': ['origin', 'auth', 'tokenKind', 'username', 'tlsServerName'],
  'shodan-axi': ['origin', 'auth'],
  'gitea-axi': ['origin', 'tokenOrigin'],
  'unifi-axi': ['origin', 'siteId', 'apiContract'],
  'proxmox-axi': ['origin', 'auth', 'tokenId', 'userId'],
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
  'ssh-axi': [],
  'kubernetes-axi': ['token', 'privateKey'],
  'technitium-axi': ['token'],
  'shodan-axi': ['apiKey'],
  'gitea-axi': ['token'],
  'unifi-axi': ['apiKey'],
  'proxmox-axi': ['token', 'password'],
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
    const parsed = adminToolParamsSchema.safeParse({ tool: (request.params as { tool?: unknown }).tool })
    if (!parsed.success) throw new ArtiumError('NOT_FOUND')
    return parsed.data.tool
  }
  function credentialStore(): MutableCredentialStore {
    if (!store) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return store
  }
  function instanceName(request: FastifyRequest): string | undefined {
    const { name } = request.params as { name?: string }
    if (name !== undefined && !instanceNameSchema.safeParse(name).success) throw new ArtiumError('NOT_FOUND')
    return name
  }
  function find(tool: ToolName, name: string | undefined): CredentialReference | undefined {
    return name === undefined ? store?.findCredential(tool) : store?.findInstance(tool, name)
  }
  function requireInstance(tool: ToolName, name: string) {
    const instance = store?.findInstance(tool, name)
    if (!instance) throw new ArtiumError('NOT_FOUND')
    return instance
  }
  function writeCredential(tool: ToolName, name: string | undefined, value: unknown, expectedId: string | undefined,
    expectedRevision: number, actor: string, now: number, description = ''): CredentialReference {
    if (name === undefined) return credentialStore().replaceCredential(tool, value, expectedRevision, actor, now, expectedId)
    if (expectedRevision === 0) return credentialStore().createInstance(tool, { name, description }, value, actor, now)
    if (expectedId === undefined) throw new ArtiumError('INVALID_INPUT')
    return credentialStore().replaceInstance(tool, name, value, expectedId, expectedRevision, actor, now)
  }
  function expectIdentity(name: string | undefined, reference: CredentialReference | undefined, expectedId: string | undefined): void {
    if (name !== undefined && reference?.id !== expectedId) throw new ArtiumError('REVISION_CONFLICT')
  }
  function readTool(tool: ToolName): z.infer<typeof adminToolSchema> {
    const row = db.prepare(`SELECT name, enabled, native_settings AS nativeSettings,
      revision, updated_at AS updatedAt, updated_by AS updatedBy FROM tools WHERE name = ?`).get(tool) as
      { name: ToolName, enabled: number, nativeSettings: string, revision: number, updatedAt: number | null, updatedBy: string | null } | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    // A tool reports its worst enabled instance: a failing one, else unknown until every enabled instance has a current result.
    const instances = (store?.listInstances(tool) ?? []).filter(instance => !isAwxOriginOnly(tool, store!.readCredential(instance)))
    const eligible = new Set(instances.filter(instance => instance.enabled).map(instance => instance.id))
    const results = (db.prepare(`SELECT credentials.id, tool_health.status AS status, checked_at AS checkedAt, credential_revision AS credentialRevision,
      error_code AS errorCode FROM credentials LEFT JOIN tool_health ON tool_health.credential_id = credentials.id
      AND tool_health.credential_revision = credentials.revision WHERE credentials.tool = ? AND credentials.enabled = 1
      ORDER BY tool_health.status = 'error' DESC, credentials.name`).all(tool) as Array<{ id: string, status: string | null }>)
      .filter(result => eligible.has(result.id))
    const selected = results.length && results.every(result => result.status !== null) || results[0]?.status === 'error' ? results[0] : undefined
    const { id: selectedId, ...selectedHealth } = selected ?? {}
    const stored = healthSchema.safeParse(selected ? selectedHealth : undefined)
    // Cached categories from an older catalogue require a fresh test after upgrade.
    const cached = tool !== 'ssh-axi' && stored.success ? stored.data : undefined
    const configured = tool === 'ssh-axi' ? hasSshConfiguration(db)
      : instances.length > 0
    const status = !row.enabled || !adapters.some(adapter => adapter.name === tool) ? 'disabled' : !configured ? 'unconfigured' : options.health.checking(tool) ? 'checking' : 'unknown'
    const health = { checkedAt: null, credentialRevision: null, errorCode: null, ...cached,
      ...(['disabled', 'unconfigured'].includes(status) || !cached ? { status } : {}) }
    const nativeSettings = JSON.parse(row.nativeSettings)
    const writeAccess = writePolicies[tool].read(nativeSettings)
    const readOnly = !writeAccess.enabled
    const diagnostic = cached && selectedId ? options.health.diagnostic(tool, health.credentialRevision, health.checkedAt, selectedId) : undefined
    return adminToolSchema.parse({ ...row, version: toolManifests[tool].version, enabled: Boolean(row.enabled),
      nativeSettings, readOnly, writeAccess,
      health: { ...health, readOnly, ...(diagnostic ? { diagnostic } : {}) } })
  }
  function readCredential(tool: ToolName): z.infer<typeof adminCredentialSchema> {
    readTool(tool)
    if (tool === 'ssh-axi') return adminCredentialSchema.parse({ tool, configured: hasSshConfiguration(db),
      revision: 0, updatedAt: null, updatedBy: null, metadata: {} })
    const reference = store?.findCredential(tool)
    const row = reference ? db.prepare('SELECT revision, updated_at AS updatedAt, updated_by AS updatedBy FROM credentials WHERE id = ?').get(reference.id) as
      { revision: number, updatedAt: number | null, updatedBy: string | null } | undefined : undefined
    const value = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
    return adminCredentialSchema.parse({ tool, configured: Boolean(row) && !isAwxOriginOnly(tool, value), revision: 0, updatedAt: null, updatedBy: null, ...row,
      metadata: credentialMetadata(tool, value, Boolean(reference)) })
  }
  function credentialMetadata(tool: ToolName, value: Record<string, unknown>, stored: boolean) {
    return stored && credentialProfiles[tool] && !isAwxOriginOnly(tool, value) ? credentialProfiles[tool].metadata(value)
      : Object.fromEntries(publicFields[tool].filter(field => value[field] !== undefined).map(field => [field, value[field]]))
  }
  function readInstance(tool: ToolName, name: string): z.infer<typeof adminInstanceSchema> {
    const instance = requireInstance(tool, name)
    const parent = readTool(tool)
    const value = credentialStore().readCredential(instance) as Record<string, unknown>
    const configured = !isAwxOriginOnly(tool, value)
    const row = db.prepare('SELECT updated_at AS updatedAt, updated_by AS updatedBy FROM credentials WHERE id = ?').get(instance.id) as
      { updatedAt: number | null, updatedBy: string | null }
    const stored = healthSchema.safeParse(db.prepare(`SELECT status, checked_at AS checkedAt, credential_revision AS credentialRevision,
      error_code AS errorCode FROM tool_health WHERE credential_id = ? AND credential_revision = ?`).get(instance.id, instance.revision))
    const cached = stored.success ? stored.data : undefined
    const status = !parent.enabled || !instance.enabled || !adapters.some(adapter => adapter.name === tool) ? 'disabled'
      : !configured ? 'unconfigured' : options.health.checking(tool) ? 'checking' : 'unknown'
    const diagnostic = options.health.diagnostic(tool, cached?.credentialRevision ?? null, cached?.checkedAt ?? null, instance.id)
    return adminInstanceSchema.parse({ ...instance, ...row, tool, configured, metadata: credentialMetadata(tool, value, true),
      health: { checkedAt: null, credentialRevision: null, errorCode: null, ...cached,
        ...(['disabled', 'unconfigured'].includes(status) || !cached ? { status } : {}),
        readOnly: parent.readOnly || instance.readOnly, ...(diagnostic ? { diagnostic } : {}) } })
  }
  function readCredentialView(tool: ToolName, name: string | undefined) {
    return name === undefined ? readCredential(tool) : readInstance(tool, name)
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
      operations, ...(tool === 'beyondtrust-axi' ? { allowDeletes: deletes(after) } : {}),
      unsupportedOperationCount: next.allowedOperations.length - operations.length,
      requestId: request.id, clientAddress: request.ip }]
  }
  const githubDevice = new GithubDeviceFlow()
  function githubRevisions(expectedRevision: number, expectedToolRevision: number, expectedCredentialId: string | undefined, instance: string | undefined): void {
    const current = find('gh-axi', instance)
    if (readTool('gh-axi').revision !== expectedToolRevision
      || (current?.revision ?? 0) !== expectedRevision || current?.id !== expectedCredentialId) throw new ArtiumError('REVISION_CONFLICT')
  }
  app.post(githubDeviceRoutes.start.path, async (request, reply) => {
    const actor = authorize(request)
    const input = parse(githubDeviceRoutes.start.input, request.body)
    if (!isCanonicalHttpsOrigin(input.origin)) throw new ArtiumError('INVALID_INPUT')
    const reference = find('gh-axi', input.instance)
    const expectedCredentialId = input.instance === undefined ? reference?.id : input.expectedId
    githubRevisions(input.expectedRevision, input.expectedToolRevision, expectedCredentialId, input.instance)
    const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : undefined
    const trust = reference && stored?.origin === input.origin ? readCredentialTrust(db, reference) : []
    const result = await githubDevice.start(actor, { ...input, expectedCredentialId }, trust)
    authorize(request)
    githubRevisions(input.expectedRevision, input.expectedToolRevision, expectedCredentialId, input.instance)
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
    githubRevisions(connection.expectedRevision, connection.expectedToolRevision, connection.expectedCredentialId, connection.instance)
    const result = await githubDevice.poll(actor, connectionId)
    authorize(request)
    if (result.status === 'pending') return reply.header('Cache-Control', 'no-store').send(githubDeviceRoutes.poll.response.parse(result))
    let replacement: CredentialReference | undefined
    const event: AuditEvent = { event: 'admin-change', action: 'connect-github-device', targetId: 'gh-axi',
      userId: actor, tool: 'gh-axi', instance: connection.instance, outcome: 'success', requestId: request.id, clientAddress: request.ip }
    const credential = audit.change(event, () => {
      authorize(request)
      githubRevisions(connection.expectedRevision, connection.expectedToolRevision, connection.expectedCredentialId, connection.instance)
      const value = parse(ghCredentialSchema, result.value)
      const old = find('gh-axi', connection.instance)
      const stored = old ? credentialStore().readCredential(old) as Record<string, unknown> : undefined
      const now = Date.now()
      replacement = writeCredential('gh-axi', connection.instance, value, connection.expectedCredentialId, connection.expectedRevision, actor, now)
      event.credentialId = replacement.id
      event.instance = credentialStore().listInstances('gh-axi').find(item => item.id === replacement!.id)!.name
      if (stored?.origin !== connection.origin) db.prepare('DELETE FROM trusted_certificates WHERE credential_id = ?').run(replacement.id)
      db.prepare('DELETE FROM tool_health WHERE credential_id = ?').run(replacement.id)
      db.prepare('UPDATE tools SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?').run(now, actor, 'gh-axi')
      return readCredentialView('gh-axi', connection.instance)
    }).value
    invalidate(replacement)
    try { await health.checkReplacement('gh-axi', actor, request.id, request.ip, () => { authorize(request) }, replacement!.id) }
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
    const event: AuditEvent = { event: 'admin-change', action: adminToolRoutes.saveOrigin.auditEvent, targetId: tool,
      userId: actor, tool, instance: input.instance, outcome: 'success', requestId: request.id, clientAddress: request.ip }
    const result = audit.change(event, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
      const reference = find(tool, input.instance)
      expectIdentity(input.instance, reference, input.expectedId)
      const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
      const sameOrigin = stored.origin === input.origin
      const value = sameOrigin ? splitSettings(tool, stored).credential : { origin: input.origin }
      const now = Date.now()
      replacement = writeCredential(tool, input.instance, value, input.expectedId, input.expectedRevision, actor, now)
      event.credentialId = replacement.id
      event.instance = credentialStore().listInstances(tool).find(item => item.id === replacement!.id)!.name
      if (!sameOrigin) db.prepare('DELETE FROM trusted_certificates WHERE credential_id = ?').run(replacement.id)
      db.prepare('DELETE FROM tool_health WHERE credential_id = ?').run(replacement.id)
      db.prepare('UPDATE tools SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?').run(now, actor, tool)
      return readCredentialView(tool, input.instance)
    }).value
    invalidate(replacement)
    await health.refresh(tool, true, replacement!.id)
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
  const credentialRoutes = [adminToolRoutes.replace, adminToolRoutes.save, adminInstanceRoutes.create, adminInstanceRoutes.replace, adminInstanceRoutes.save]
  for (const route of credentialRoutes) app.route({ method: route.method, url: route.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const input = parse(route.input, request.body) as { value: unknown, expectedToolRevision: number, expectedRevision?: number,
      expectedId?: string, name?: string, description?: string }
    if (tool === 'ssh-axi') throw new ArtiumError('INVALID_INPUT', 'SSH uses dedicated host bindings and credentials.')
    const saving = route === adminToolRoutes.save || route === adminInstanceRoutes.save
    const name = route === adminInstanceRoutes.create ? input.name : instanceName(request)
    const expectedRevision = input.expectedRevision ?? 0
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
      const reference = find(tool, name)
      if (awxPasswordRequested(value)) {
        const current = readTool(tool)
        if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
        if ((reference?.revision ?? 0) !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
        expectIdentity(name, reference, input.expectedId)
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
    const events: AuditEvent[] = [{ event: 'admin-change', action: route.auditEvent, targetId: tool,
      userId: actor, tool, instance: name, outcome: 'success', requestId: request.id, clientAddress: request.ip }]
    const result = audit.change(events, () => {
      authorize(request)
      const current = readTool(tool)
      if (current.revision !== input.expectedToolRevision) throw new ArtiumError('REVISION_CONFLICT')
      const reference = find(tool, name)
      if (saving && (reference?.revision ?? 0) !== expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      expectIdentity(name, reference, input.expectedId)
      let next = value
      if (saving) {
        const stored = reference ? credentialStore().readCredential(reference) as Record<string, unknown> : {}
        const sameIdentity = ['mode', 'kind', 'auth', 'tenantId', 'clientId', 'origin', 'org', 'appId', 'installationId', 'tokenId', 'userId', 'tokenKind', 'clientCertificate'].every(key => stored[key] === value[key])
        const secrets = credentialProfiles[tool]?.fields().filter(field => field.schema['x-secret'] && field.schema['x-ephemeral'] !== true)
          .map(field => field.name) ?? legacySecretFields[tool]
        const retained = sameIdentity ? Object.fromEntries(secrets.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]])) : {}
        next = parse(schemaFor(tool), { ...retained, ...value, ...current.nativeSettings }) as Record<string, unknown>
      }
      const { credential, settings: suppliedSettings } = splitSettings(tool, next)
      const settings = name === undefined ? suppliedSettings : current.nativeSettings
      events.push(...writeChange(request, actor, tool, current.nativeSettings, settings))
      const now = Date.now()
      replacement = writeCredential(tool, name, credential, input.expectedId, expectedRevision, actor, now, input.description)
      events[0]!.credentialId = replacement.id
      events[0]!.instance = credentialStore().listInstances(tool).find(item => item.id === replacement!.id)!.name
      db.prepare(`UPDATE tools SET native_settings = ?, pinned_version = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE name = ?`)
        .run(JSON.stringify(settings), toolManifests[tool].version, now, actor, tool)
      db.prepare('DELETE FROM tool_health WHERE credential_id = ?').run(replacement.id)
      return { ...readCredentialView(tool, name), ...(normalizations.length ? { normalizations } : {}) }
    }).value
    invalidate(replacement)
    await health.refresh(tool, true, replacement!.id)
    return result
  } })
  for (const route of [adminToolRoutes.test, adminInstanceRoutes.test]) app.route({ method: route.method, url: route.path, handler: async (request, reply) => {
    const actor = authorize(request)
    const tool = toolName(request)
    const name = instanceName(request)
    const credentialId = name === undefined ? undefined : requireInstance(tool, name).id
    parse(route.input, request.body ?? {})
    try { return await health.check(tool, actor, request.id, request.ip, () => { authorize(request) }, credentialId) }
    catch (error) {
      authorize(request)
      if (!(error instanceof ArtiumError)) throw error
      const response = errorResponse(error, request.id)
      return reply.code(errors[error.code].status).send({ error: { ...response.error,
        ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } })
    }
  } })
  app.route({ method: adminInstanceRoutes.list.method, url: adminInstanceRoutes.list.path, handler: async request => {
    authorize(request)
    parse(adminInstanceRoutes.list.input, request.query)
    const tool = toolName(request)
    return adminInstanceRoutes.list.response.parse({ instances: credentialStore().listInstances(tool).map(instance => readInstance(tool, instance.name)) })
  } })
  app.route({ method: adminInstanceRoutes.get.method, url: adminInstanceRoutes.get.path, handler: async request => {
    authorize(request)
    parse(adminInstanceRoutes.get.input, request.query)
    return readInstance(toolName(request), instanceName(request)!)
  } })
  app.route({ method: adminInstanceRoutes.update.method, url: adminInstanceRoutes.update.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const name = instanceName(request)!
    const input = parse(adminInstanceRoutes.update.input, request.body)
    requireInstance(tool, name)
    const event = { event: 'admin-change' as const, targetId: tool, userId: actor, tool, instance: name,
      credentialId: input.expectedId, outcome: 'success' as const, requestId: request.id, clientAddress: request.ip }
    const events: AuditEvent[] = [
      ...input.enabled === undefined ? [] : [{ ...event, action: input.enabled ? 'enable-instance' : 'disable-instance' }],
      ...input.readOnly === undefined ? [] : [{ ...event, action: input.readOnly ? 'set-instance-read-only' : 'set-instance-writable' }],
      ...input.description === undefined ? [] : [{ ...event, action: 'edit-instance-description' }],
    ]
    const result = audit.change(events, () => {
      authorize(request)
      credentialStore().setInstanceFlags(tool, name, { enabled: input.enabled, readOnly: input.readOnly, description: input.description },
        input.expectedId, input.expectedRevision, actor, Date.now())
      return readInstance(tool, name)
    }).value
    if (result.enabled) await health.refresh(tool, true, result.id)
    return result
  } })
  app.route({ method: adminInstanceRoutes.remove.method, url: adminInstanceRoutes.remove.path, handler: async request => {
    const actor = authorize(request)
    const tool = toolName(request)
    const name = instanceName(request)!
    const input = parse(adminInstanceRoutes.remove.input, request.body)
    requireInstance(tool, name)
    audit.change({ event: 'admin-change', action: adminInstanceRoutes.remove.auditEvent, targetId: tool, userId: actor, tool, instance: name,
      credentialId: input.expectedId, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      credentialStore().deleteInstance(tool, name, input.expectedId, input.expectedRevision)
    })
    invalidate({ id: input.expectedId, tool, revision: input.expectedRevision })
    return { removed: true as const }
  } })
}
