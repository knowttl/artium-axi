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
import type { Audit } from '../audit/audit.js'
import { healthDefaults } from '../config.js'
import { RunnerError, type Runner } from '../runner/runner.js'
import type { CredentialReference, MutableCredentialStore, ToolName } from '../store/credential-store.js'
import { readCredentialTrust } from '../store/trusted-certificates.js'
import { isAwxOriginOnly } from '../store/credential-store.js'

const healthReads = { 'falcon-axi': falconManifest.healthRead, 'vectra-axi': ['health', 'list'], 'az-axi': ['account', 'list'], 'mg-axi': ['entra', 'user', 'list', '--limit', '1'], 'ldap-axi': ['auth', 'status'], 'ado-axi': ['project', 'list', '--limit', '1'], 'awx-axi': ['job', 'list', '--limit', '1'] }

// Manual tests and background reads share exclusion, runner admission and cache writes.
export class ToolHealth {
  private readonly active = new Set<ToolName>()
  private timer?: NodeJS.Timeout
  private pending = new Set<Promise<unknown>>()
  private closed = false
  private readonly replaced = new Set<ToolName>()
  private readonly diagnostics = new Map<ToolName, Diagnostic>()
  private readonly due = new Map<ToolName, number>()
  private readonly failures = new Map<ToolName, number>()

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

  // Only reachability failures retry early, so a rejected credential is never retried into an account lockout.
  private reschedule(tool: ToolName, revision: CredentialReference['revision'], code: string | undefined): void {
    if (this.store?.findCredential(tool)?.revision !== revision) return
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
    if (replaced) this.failures.delete(tool)
    if (this.active.has(tool)) {
      if (replaced) this.replaced.add(tool)
      return
    }
    const reference = this.store?.findCredential(tool)
    if (!reference || (tool === 'awx-axi' && isAwxOriginOnly(tool, this.store!.readCredential(reference)))) return
    const row = this.db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number } | undefined
    if (!row?.enabled || !this.adapters.some(adapter => adapter.name === tool)) return
    if (this.pending.size >= healthDefaults.backgroundCalls) {
      this.due.set(tool, Date.now())
      return
    }
    const pending = this.check(tool, healthDefaults.actor, randomUUID(), null)
      .then(
        () => this.reschedule(tool, reference.revision, undefined),
        (error: unknown) => this.reschedule(tool, reference.revision, error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'),
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
        journal = await prepareRunJournal(prepared.environment, tool, prepared.effect)
        // Per-tool accounting leaves background reads governed by the global slots.
        const result = await runner.run(background ? `${actor}:${tool}` : actor, prepared.executable, prepared.args, journal.environment, prepared.secrets,
          { ...prepared.limits, credentialTrust }, {}, prepared.files, () => {
            authorize?.()
            if (background && !(db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number }).enabled) {
              throw new ArtiumError('TOOL_DISABLED')
            }
            if (store?.findCredential(tool)?.revision !== reference.revision) throw new ArtiumError('REVISION_CONFLICT')
          }, prepared.pathPrefix)
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
      audit.record({ ...context, event: 'run-terminal', action: await journal?.action(!failure) ?? 'unknown', outcome: failure?.code ?? 'completed', exitCode, durationMs, outputBytes, ...evidence })
      audit.change({ ...context, event: background ? 'health-check' : 'credential-test', action: background ? healthDefaults.actor : undefined, outcome: failure?.code ?? 'success', ...evidence }, () => {
        if (!['TOO_MANY_CALLS', 'RUNNER_CLOSED', 'TOKEN_INVALID', 'TOKEN_EXPIRED',
          'USER_DISABLED', 'ADMIN_REQUIRED', 'REAUTH_REQUIRED'].includes(failure?.code ?? '')
          && store?.findCredential(tool)?.revision === reference.revision) {
          db.prepare(`INSERT INTO tool_health (tool, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(tool) DO UPDATE SET credential_revision = excluded.credential_revision, checked_at = excluded.checked_at,
            status = excluded.status, error_code = excluded.error_code`)
            .run(tool, reference.revision, health.checkedAt, health.status, health.errorCode)
          this.diagnostics.delete(tool)
          if (diagnostic) this.diagnostics.set(tool, diagnostic)
        }
      })
      if (failure) throw failure
      return health
    } finally {
      this.active.delete(tool)
      if (this.replaced.delete(tool)) void this.refresh(tool)
    }
  }
}
