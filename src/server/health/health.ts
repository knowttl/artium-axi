import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { healthSchema, toolAllowsWrites } from '../../shared/api.js'
import { ArtiumError, errors } from '../../shared/errors.js'
import type { Diagnostic } from '../../shared/errors.js'
import { diagnosticError, safeDiagnostic, toolFailure } from './diagnostic.js'
import { preflight } from './preflight.js'
import { toolEndpoints } from '../tool-endpoints.js'
import type { Adapter } from '../adapters/types.js'
import { prepareRunJournal } from '../adapters/run-journal.js'
import { falconManifest } from '../adapters/falcon.js'
import { hostedGhOutput } from '../adapters/gh-output.js'
import type { Audit } from '../audit/audit.js'
import { healthDefaults } from '../config.js'
import { RunnerError, type Runner, type RunnerLimits } from '../runner/runner.js'
import type { ProxmoxAccess } from '../runner/proxmox.js'
import { logRun } from '../runner/log.js'
import type { CredentialInstance, CredentialReference, MutableCredentialStore, ToolName } from '../store/credential-store.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { isAwxOriginOnly } from '../store/credential-store.js'

const healthReads = { 'shodan-axi': ['info'], 'kubernetes-axi': ['get', 'pods'], 'gitea-axi': ['doctor'], 'technitium-axi': ['user', 'session', 'get'], 'unifi-axi': ['info'], 'proxmox-axi': ['get', '/version'], 'beyondtrust-axi': ['doctor'], 'gh-axi': ['api', '/rate_limit'], 'checkpoint-axi': ['doctor'], 'hybrid-axi': ['quota'], 'falcon-axi': falconManifest.healthRead, 'vectra-axi': ['health', 'list'], 'az-axi': ['account', 'list'], 'mg-axi': ['entra', 'user', 'list', '--limit', '1'], 'ldap-axi': ['auth', 'status'], 'ado-axi': ['project', 'list', '--limit', '1'], 'awx-axi': ['job', 'list', '--limit', '1'], 'tenable-axi': ['tag', 'category', 'list', '--limit', '1'] }

// Manual tests and background reads share exclusion, runner admission and cache writes.
export class ToolHealth {
  private readonly active = new Set<ToolName>()
  private timer?: NodeJS.Timeout
  private pending = new Set<Promise<unknown>>()
  private closed = false
  private readonly replaced = new Map<ToolName, string | undefined>()
  private readonly queued = new Set<ToolName>()
  private readonly required = new Map<ToolName, CredentialReference>()
  private readonly generations = new Map<ToolName, number>()
  private readonly diagnostics = new Map<string, Diagnostic>()
  private readonly rotation = new Map<ToolName, number>()
  private readonly due = new Map<ToolName, number>()
  private readonly failures = new Map<ToolName, number>()

  // A check is running, queued behind a running check, or waiting for background or runner capacity.
  checking(tool: ToolName): boolean {
    return this.active.has(tool) || this.replaced.has(tool) || this.queued.has(tool)
  }

  diagnostic(tool: ToolName, revision: number | null, checkedAt: number | null, credentialId = this.store?.findCredential(tool)?.id): Diagnostic | undefined {
    const detail = credentialId === undefined ? undefined : this.diagnostics.get(credentialId)
    return detail?.credentialRevision === revision && detail?.checkedAt === checkedAt ? detail : undefined
  }

  constructor(private readonly db: Database.Database, private readonly audit: Audit,
    private readonly runner: Runner, private readonly adapters: readonly Adapter<unknown>[],
    private readonly store?: MutableCredentialStore, private readonly proxmox?: ProxmoxAccess) {}

  // Eligible tools are due on the first tick; the background slot cap staggers them.
  start(): void {
    this.timer = setInterval(() => {
      for (const adapter of this.adapters) {
        if ((this.due.get(adapter.name) ?? 0) > Date.now()) continue
        void this.refresh(adapter.name)
      }
    }, healthDefaults.tickMs)
    this.timer.unref()
  }

  // Rejected credentials use the normal interval to avoid retries into an account lockout.
  private isCurrent(tool: ToolName, reference: CredentialReference): boolean {
    const current = this.store?.listInstances(tool).find(instance => instance.id === reference.id)
    return current !== undefined && current.revision === reference.revision
  }

  private instances(tool: ToolName): CredentialInstance[] {
    return (this.store?.listInstances(tool) ?? []).filter(instance => !(tool === 'awx-axi' && isAwxOriginOnly(tool, this.store!.readCredential(instance))))
  }

  private resolve(tool: ToolName, credentialId: string | undefined): CredentialReference | undefined {
    return credentialId === undefined ? this.store?.findCredential(tool) : this.store?.listInstances(tool).find(instance => instance.id === credentialId)
  }

  private isRequired(tool: ToolName, reference: CredentialReference): boolean {
    const required = this.required.get(tool)
    return required?.id === reference.id && required.revision === reference.revision
  }

  private reschedule(tool: ToolName, reference: CredentialReference, generation: number, code: string | undefined): void {
    if (!this.isCurrent(tool, reference) || (this.generations.get(tool) ?? 0) !== generation) return
    if (code === 'TOO_MANY_CALLS' && this.queued.has(tool)) {
      this.due.set(tool, Date.now())
      return
    }
    this.queued.delete(tool)
    this.required.delete(tool)
    const retryable = code === 'UPSTREAM_NETWORK_FAILED' || code === 'TIMEOUT' || code === 'TEMP_UNAVAILABLE'
    const failures = retryable ? (this.failures.get(tool) ?? 0) + 1 : 0
    if (failures) this.failures.set(tool, failures)
    else this.failures.delete(tool)
    const delay = failures === 0
      ? healthDefaults.intervalMs / Math.max(1, this.instances(tool).length)
      : Math.min(healthDefaults.retryMs * 2 ** (failures - 1), healthDefaults.intervalMs)
    this.due.set(tool, Date.now() + delay)
  }

  // Instances of one tool are checked one at a time. Each background run takes the next enabled instance in turn,
  // and a run for a replaced credential names it.
  refresh(tool: ToolName, replaced = false, credentialId?: string): Promise<unknown> | undefined {
    // Shodan reads require an explicit action, including after credential replacement.
    if (this.closed || tool === 'shodan-axi') return
    if (replaced) {
      this.queued.add(tool)
      this.failures.delete(tool)
      this.generations.set(tool, (this.generations.get(tool) ?? 0) + 1)
    }
    if (this.active.has(tool)) {
      if (replaced) this.replaced.set(tool, credentialId)
      return
    }
    const candidates = this.instances(tool).filter(instance => instance.enabled || this.isRequired(tool, instance))
    const turn = this.rotation.get(tool) ?? 0
    const reference = credentialId === undefined ? candidates[turn % candidates.length] : candidates.find(instance => instance.id === credentialId)
    if (!reference) { this.queued.delete(tool); return }
    const row = this.db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number } | undefined
    if (!this.isRequired(tool, reference)) this.required.delete(tool)
    if ((!row?.enabled && !this.required.has(tool)) || !this.adapters.some(adapter => adapter.name === tool)) { this.queued.delete(tool); return }
    if (this.pending.size >= healthDefaults.backgroundCalls) {
      this.queued.add(tool)
      this.due.set(tool, Date.now())
      return
    }
    if (credentialId === undefined) this.rotation.set(tool, turn + 1)
    const generation = this.generations.get(tool) ?? 0
    const required = this.required.has(tool)
    const pending = this.check(tool, healthDefaults.actor, randomUUID(), null, undefined, reference.id)
      .then(
        () => { if (!required) this.reschedule(tool, reference, generation, undefined) },
        (error: unknown) => { if (!required) this.reschedule(tool, reference, generation, error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR') },
      )
      .finally(() => this.pending.delete(pending))
    this.pending.add(pending)
    return pending
  }

  async stop(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await Promise.allSettled(this.pending)
  }

  async checkReplacement(tool: ToolName, actor: string, requestId: string, clientAddress: string | null,
    authorize: () => void, credentialId?: string) {
    const reference = this.resolve(tool, credentialId)
    if (!reference) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const generation = (this.generations.get(tool) ?? 0) + 1
    this.generations.set(tool, generation)
    this.required.set(tool, reference)
    this.queued.add(tool)
    try {
      return await this.check(tool, actor, requestId, clientAddress, authorize, reference.id)
    } catch (error) {
      const code = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
      if (this.isRequired(tool, reference)) this.reschedule(tool, reference, generation, code)
      if (code === 'TOO_MANY_CALLS' && this.isCurrent(tool, reference)
        && this.generations.get(tool) === generation) {
        const checkedAt = Date.now()
        this.db.prepare(`INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, ?, 'error', ?)
          ON CONFLICT(credential_id) DO UPDATE SET credential_revision = excluded.credential_revision, checked_at = excluded.checked_at,
          status = excluded.status, error_code = excluded.error_code`).run(reference.id, tool, reference.revision, checkedAt, code)
        this.diagnostics.set(reference.id, { stage: 'configuration', message: 'Credential check pending: runner busy.',
          checkedAt, credentialRevision: reference.revision })
        if (this.active.has(tool)) this.replaced.set(tool, reference.id)
      }
      throw error
    }
  }

  async check(tool: ToolName, actor: string, requestId: string, clientAddress: string | null,
    authorize?: () => void, credentialId?: string) {
    const { db, audit, runner, adapters, store } = this
    const background = actor === healthDefaults.actor
    const adapter = adapters.find(adapter => adapter.name === tool)
    let reference: CredentialReference | undefined
    const target = this.resolve(tool, credentialId)
    const context = { userId: background ? null : actor, tool, requestId, clientAddress, credentialId: target?.id ?? null,
      instance: target && store?.listInstances(tool).find(instance => instance.id === target.id)?.name || null }
    try {
      if (tool === 'ssh-axi') throw new ArtiumError('INVALID_INPUT', 'SSH authentication is checked per host.', 'Run artium-axi ssh-axi doctor <host> as a caller with a shell grant.')
      reference = this.resolve(tool, credentialId)
      if (!adapter) throw new ArtiumError('TOOL_DISABLED')
      if (!reference) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
      if (this.active.has(tool)) throw new ArtiumError('TOO_MANY_CALLS')
    } catch (error) {
      const failure = error instanceof ArtiumError ? error : new ArtiumError('INTERNAL_ERROR')
      const errorCode = failure.code
      const checkedAt = Date.now()
      failure.diagnostic = safeDiagnostic({ stage: 'configuration', message: errors[errorCode].message,
        checkedAt, credentialRevision: reference?.revision ?? null }, [])
      audit.record({ ...context, event: background ? 'health-check' : 'credential-test', action: background ? healthDefaults.actor : undefined, outcome: errorCode,
        checkedAt, credentialRevision: reference?.revision ?? null, errorCode })
      throw failure
    }
    this.active.add(tool)
    const generation = this.generations.get(tool) ?? 0
    const args = healthReads[tool]
    const started = Date.now()
    let failure: ArtiumError | undefined
    let exitCode: number | null = null
    let durationMs = 0
    let outputBytes = { stdout: 0, stderr: 0 }
    let journal: Awaited<ReturnType<typeof prepareRunJournal>> | undefined
    let secrets: string[] = []
    let credential: Record<string, unknown> | undefined
    try {
      audit.record({ ...context, event: 'run-start', outcome: 'started', args, sensitive: adapter.sensitiveArguments(args),
        checkedAt: started, credentialRevision: reference.revision ?? null, errorCode: null })
      try {
        credential = store!.readCredential(reference) as Record<string, unknown> | undefined
        if (!credential) throw new ArtiumError('REVISION_CONFLICT')
        if (isAwxOriginOnly(tool, credential)) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
        // Include schema-declared secrets, including custom profile fields, before preflight.
        const secretFields = new Set(adapter.credentialProfile?.fields().filter(field => field.schema['x-secret']).map(field => field.name))
        secrets = Object.entries(credential).filter(([key]) => secretFields.has(key) || /secret|password|privateKey|token|assertion/i.test(key))
          .flatMap(([, value]) => typeof value === 'string' && value ? [value] : [])
        const parsed = adapter.credentialSchema.safeParse(credential)
        if (!parsed.success) {
          let issue = parsed.error.issues[0]
          // Union errors wrap field errors; prefer the branch closest to the stored profile.
          while (issue?.code === 'invalid_union') {
            issue = issue.errors.reduce((closest, branch) => branch.length < closest.length ? branch : closest)[0]
          }
          const path = issue?.path.filter(key => typeof key === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)).join('.')
          throw diagnosticError('CREDENTIAL_INVALID', { stage: 'configuration', message: `Invalid credential field: ${path || 'profile'}.` })
        }
        const credentialTrust = readCredentialTrust(db, reference)
        if (!background) await preflight(tool, credential, credentialTrust)
        const prepared = await adapter.prepare(args, reference)
        secrets.push(...prepared.secrets)
        const preparedJournal = await prepareRunJournal(prepared.environment, tool, prepared.effect)
        journal = preparedJournal
        // Per-tool accounting leaves background reads governed by the global slots.
        const beforeSpawn = () => {
            prepared.beforeSpawn?.()
            authorize?.()
            if (background && !this.isRequired(tool, reference)
              && !(db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number }).enabled) {
              throw new ArtiumError('TOOL_DISABLED')
            }
            if (!this.isCurrent(tool, reference)) throw new ArtiumError('REVISION_CONFLICT')
          }
        const invoke = (limits: Partial<RunnerLimits> = {}) => runner.run(background ? `${actor}:${tool}` : actor,
          prepared.executable, prepared.args, preparedJournal.environment, prepared.secrets,
          { ...prepared.limits, publicContent: prepared.publicContent, credentialTrust, ...limits }, {}, prepared.files, beforeSpawn, prepared.pathPrefix)
        let result = await logRun({ requestId, tool }, () => prepared.proxmox && this.proxmox
          ? this.proxmox.health(actor, reference, requestId, prepared, beforeSpawn, invoke) : invoke())
        if (prepared.proxmox) secrets.push(...prepared.secrets)
        if (tool === 'gh-axi') result = hostedGhOutput(prepared.invocation, result)
        exitCode = result.exitCode
        durationMs = result.durationMs
        outputBytes = result.outputBytes
        if (exitCode !== 0) failure = toolFailure(result.stdout, result.stderr, exitCode, tool)
      } catch (error) {
        failure = error instanceof ArtiumError ? error : new ArtiumError('INTERNAL_ERROR')
        const runnerError = error instanceof RunnerError ? error : undefined
        durationMs = runnerError?.durationMs ?? Date.now() - started
        outputBytes = runnerError?.outputBytes ?? { stdout: 0, stderr: 0 }
      }
      const checkedAt = Date.now()
      const detail: Diagnostic | undefined = failure && {
        ...(failure.diagnostic ?? { stage: 'tool run', message: errors[failure.code].message }),
        checkedAt, credentialRevision: reference.revision,
      }
      if (failure && ['UPSTREAM_NETWORK_FAILED', 'UPSTREAM_TLS_FAILED'].includes(failure.code)
        && detail && !detail.host && credential) {
        const endpoints = toolEndpoints(tool, credential)
        detail.host = (detail.stage === 'token acquisition' ? endpoints[0] : endpoints[
          ['az-axi', 'mg-axi'].includes(tool) || tool === 'ado-axi' && credential.auth === 'client-secret' ? 1 : 0])?.hostname
      }
      const diagnostic = safeDiagnostic(detail, secrets)
      if (failure) failure.diagnostic = diagnostic
      const settings = db.prepare('SELECT native_settings FROM tools WHERE name = ?').get(tool) as { native_settings: string }
      const health = healthSchema.parse({ status: failure ? 'error' : 'ok', checkedAt, diagnostic,
        readOnly: !toolAllowsWrites(tool, JSON.parse(settings.native_settings)),
        credentialRevision: reference.revision, errorCode: failure?.code ?? null })
      const evidence = { checkedAt: health.checkedAt, credentialRevision: health.credentialRevision, errorCode: health.errorCode }
      audit.record({ ...context, event: 'run-terminal', action: await journal?.action(!failure) ?? 'unknown', outcome: failure?.code ?? 'completed', exitCode, durationMs, outputBytes, ...evidence,
        failure: failure ? { diagnostic, secrets } : undefined })
      audit.change({ ...context, event: background ? 'health-check' : 'credential-test', action: background ? healthDefaults.actor : undefined, outcome: failure?.code ?? 'success', ...evidence }, () => {
        if (!['TOO_MANY_CALLS', 'RUNNER_CLOSED', 'TOKEN_INVALID', 'TOKEN_EXPIRED',
          'USER_DISABLED', 'ADMIN_REQUIRED', 'REAUTH_REQUIRED'].includes(failure?.code ?? '')
          && this.isCurrent(tool, reference)
          && (this.generations.get(tool) ?? 0) === generation) {
          db.prepare(`INSERT INTO tool_health (credential_id, tool, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(credential_id) DO UPDATE SET credential_revision = excluded.credential_revision, checked_at = excluded.checked_at,
            status = excluded.status, error_code = excluded.error_code`)
            .run(reference.id, tool, reference.revision, health.checkedAt, health.status, health.errorCode)
          this.diagnostics.delete(reference.id)
          if (diagnostic) this.diagnostics.set(reference.id, diagnostic)
        }
      })
      if (this.isRequired(tool, reference)) this.reschedule(tool, reference, generation, failure?.code)
      if (failure) throw failure
      return health
    } finally {
      this.active.delete(tool)
      if (this.replaced.has(tool)) {
        const replacedId = this.replaced.get(tool)
        this.replaced.delete(tool)
        void this.refresh(tool, false, replacedId)
      }
    }
  }
}
