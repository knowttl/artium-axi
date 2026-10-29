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
import { RunnerError, type Runner } from '../runner/runner.js'
import { logRun } from '../runner/log.js'
import type { CredentialReference, MutableCredentialStore, ToolName } from '../store/credential-store.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { isAwxOriginOnly } from '../store/credential-store.js'

const healthReads = { 'beyondtrust-axi': ['doctor'], 'gh-axi': ['api', '/rate_limit'], 'checkpoint-axi': ['doctor'], 'hybrid-axi': ['quota'], 'falcon-axi': falconManifest.healthRead, 'vectra-axi': ['health', 'list'], 'az-axi': ['account', 'list'], 'mg-axi': ['entra', 'user', 'list', '--limit', '1'], 'ldap-axi': ['auth', 'status'], 'ado-axi': ['project', 'list', '--limit', '1'], 'awx-axi': ['job', 'list', '--limit', '1'], 'tenable-axi': ['card', 'list', '--limit', '1'] }

// Manual tests and background reads share exclusion, runner admission and cache writes.
export class ToolHealth {
  private readonly active = new Set<ToolName>()
  private timer?: NodeJS.Timeout
  private pending = new Set<Promise<unknown>>()
  private closed = false
  private readonly replaced = new Set<ToolName>()
  private readonly queued = new Set<ToolName>()
  private readonly required = new Map<ToolName, CredentialReference['revision']>()
  private readonly generations = new Map<ToolName, number>()
  private readonly diagnostics = new Map<ToolName, Diagnostic>()
  private readonly due = new Map<ToolName, number>()
  private readonly failures = new Map<ToolName, number>()

  // A check is running, queued behind a running check, or waiting for background or runner capacity.
  checking(tool: ToolName): boolean {
    return this.active.has(tool) || this.replaced.has(tool) || this.queued.has(tool)
  }

  diagnostic(tool: ToolName, revision: number | null, checkedAt: number | null): Diagnostic | undefined {
    const detail = this.diagnostics.get(tool)
    return detail?.credentialRevision === revision && detail?.checkedAt === checkedAt ? detail : undefined
  }

  constructor(private readonly db: Database.Database, private readonly audit: Audit,
    private readonly runner: Runner, private readonly adapters: readonly Adapter<unknown>[],
    private readonly store?: MutableCredentialStore) {}

  // Every tool is due on the first tick; the background slot cap staggers them.
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
  private reschedule(tool: ToolName, revision: CredentialReference['revision'], generation: number, code: string | undefined): void {
    if (this.store?.findCredential(tool)?.revision !== revision || (this.generations.get(tool) ?? 0) !== generation) return
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
      ? healthDefaults.intervalMs
      : Math.min(healthDefaults.retryMs * 2 ** (failures - 1), healthDefaults.intervalMs)
    this.due.set(tool, Date.now() + delay)
  }

  refresh(tool: ToolName, replaced = false): Promise<unknown> | undefined {
    if (this.closed) return
    if (replaced) {
      this.queued.add(tool)
      this.failures.delete(tool)
      this.generations.set(tool, (this.generations.get(tool) ?? 0) + 1)
    }
    if (this.active.has(tool)) {
      if (replaced) this.replaced.add(tool)
      return
    }
    const reference = this.store?.findCredential(tool)
    if (!reference || (tool === 'awx-axi' && isAwxOriginOnly(tool, this.store!.readCredential(reference)))) { this.queued.delete(tool); return }
    const row = this.db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number } | undefined
    if (this.required.get(tool) !== reference.revision) this.required.delete(tool)
    if ((!row?.enabled && !this.required.has(tool)) || !this.adapters.some(adapter => adapter.name === tool)) { this.queued.delete(tool); return }
    if (this.pending.size >= healthDefaults.backgroundCalls) {
      this.queued.add(tool)
      this.due.set(tool, Date.now())
      return
    }
    const generation = this.generations.get(tool) ?? 0
    const required = this.required.has(tool)
    const pending = this.check(tool, healthDefaults.actor, randomUUID(), null)
      .then(
        () => { if (!required) this.reschedule(tool, reference.revision, generation, undefined) },
        (error: unknown) => { if (!required) this.reschedule(tool, reference.revision, generation, error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR') },
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
    authorize: () => void) {
    const reference = this.store?.findCredential(tool)
    if (!reference) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const generation = (this.generations.get(tool) ?? 0) + 1
    this.generations.set(tool, generation)
    this.required.set(tool, reference.revision)
    this.queued.add(tool)
    try {
      return await this.check(tool, actor, requestId, clientAddress, authorize)
    } catch (error) {
      const code = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
      if (this.required.get(tool) === reference.revision) this.reschedule(tool, reference.revision, generation, code)
      if (code === 'TOO_MANY_CALLS' && this.store?.findCredential(tool)?.revision === reference.revision
        && this.generations.get(tool) === generation) {
        const checkedAt = Date.now()
        this.db.prepare(`INSERT INTO tool_health (tool, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, 'error', ?)
          ON CONFLICT(tool) DO UPDATE SET credential_revision = excluded.credential_revision, checked_at = excluded.checked_at,
          status = excluded.status, error_code = excluded.error_code`).run(tool, reference.revision, checkedAt, code)
        this.diagnostics.set(tool, { stage: 'configuration', message: 'Credential check pending: runner busy.',
          checkedAt, credentialRevision: reference.revision })
        if (this.active.has(tool)) this.replaced.add(tool)
      }
      throw error
    }
  }

  async check(tool: ToolName, actor: string, requestId: string, clientAddress: string | null,
    authorize?: () => void) {
    const { db, audit, runner, adapters, store } = this
    const background = actor === healthDefaults.actor
    const adapter = adapters.find(adapter => adapter.name === tool)
    const context = { userId: background ? null : actor, tool, requestId, clientAddress }
    let reference: CredentialReference | undefined
    try {
      reference = store?.findCredential(tool)
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
        let result = await logRun({ requestId, tool }, () => runner.run(background ? `${actor}:${tool}` : actor, prepared.executable, prepared.args, preparedJournal.environment, prepared.secrets,
          { ...prepared.limits, credentialTrust }, {}, prepared.files, () => {
            authorize?.()
            if (background && this.required.get(tool) !== reference.revision
              && !(db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number }).enabled) {
              throw new ArtiumError('TOOL_DISABLED')
            }
            if (store?.findCredential(tool)?.revision !== reference.revision) throw new ArtiumError('REVISION_CONFLICT')
          }, prepared.pathPrefix))
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
          && store?.findCredential(tool)?.revision === reference.revision
          && (this.generations.get(tool) ?? 0) === generation) {
          db.prepare(`INSERT INTO tool_health (tool, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(tool) DO UPDATE SET credential_revision = excluded.credential_revision, checked_at = excluded.checked_at,
            status = excluded.status, error_code = excluded.error_code`)
            .run(tool, reference.revision, health.checkedAt, health.status, health.errorCode)
          this.diagnostics.delete(tool)
          if (diagnostic) this.diagnostics.set(tool, diagnostic)
        }
      })
      if (this.required.get(tool) === reference.revision) this.reschedule(tool, reference.revision, generation, failure?.code)
      if (failure) throw failure
      return health
    } finally {
      this.active.delete(tool)
      if (this.replaced.delete(tool)) void this.refresh(tool)
    }
  }
}
