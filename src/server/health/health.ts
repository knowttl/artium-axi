import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { healthSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Adapter } from '../adapters/types.js'
import { prepareRunJournal } from '../adapters/run-journal.js'
import { falconManifest } from '../adapters/falcon.js'
import type { Audit } from '../audit/audit.js'
import { healthDefaults } from '../config.js'
import { RunnerError, type Runner } from '../runner/runner.js'
import type { CredentialReference, MutableCredentialStore, ToolName } from '../store/credential-store.js'

const healthReads = { 'falcon-axi': falconManifest.healthRead, 'vectra-axi': ['health', 'list'], 'az-axi': ['account', 'list'], 'mg-axi': ['entra', 'user', 'list', '--limit', '1'] }

// Manual tests and background reads share exclusion, runner admission and cache writes.
export class ToolHealth {
  private readonly active = new Set<ToolName>()
  private timer?: NodeJS.Timeout
  private pending = new Set<Promise<unknown>>()
  private closed = false
  private readonly replaced = new Set<ToolName>()

  constructor(private readonly db: Database.Database, private readonly audit: Audit,
    private readonly runner: Runner, private readonly adapters: readonly Adapter<unknown>[],
    private readonly store?: MutableCredentialStore) {}

  start(): void {
    this.timer = setInterval(() => {
      for (const adapter of this.adapters) void this.refresh(adapter.name)
    }, healthDefaults.intervalMs)
    this.timer.unref()
  }

  refresh(tool: ToolName, replaced = false): Promise<unknown> | undefined {
    if (this.closed) return
    if (this.active.has(tool)) {
      if (replaced) this.replaced.add(tool)
      return
    }
    if (!this.store?.findCredential(tool)) return
    const row = this.db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number } | undefined
    if (!row?.enabled || !this.adapters.some(adapter => adapter.name === tool)) return
    const pending = this.check(tool, healthDefaults.actor, randomUUID(), null).catch(() => {})
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
      if (!reference) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      if (this.active.has(tool)) throw new ArtiumError('TOO_MANY_CALLS')
    } catch (error) {
      const errorCode = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
      audit.record({ ...context, event: background ? 'health-check' : 'credential-test', action: background ? healthDefaults.actor : undefined, outcome: errorCode,
        checkedAt: Date.now(), credentialRevision: reference?.revision ?? null, errorCode })
      throw error
    }
    this.active.add(tool)
    const args = healthReads[tool]
    const started = Date.now()
    let failure: ArtiumError | undefined
    let exitCode: number | null = null
    let durationMs = 0
    let outputBytes = { stdout: 0, stderr: 0 }
    let journal: Awaited<ReturnType<typeof prepareRunJournal>> | undefined
    try {
      audit.record({ ...context, event: 'run-start', outcome: 'started', args, sensitive: adapter.sensitiveArguments(args),
        checkedAt: started, credentialRevision: reference.revision ?? null, errorCode: null })
      try {
        const prepared = await adapter.prepare(args, reference)
        journal = await prepareRunJournal(prepared.environment)
        // Per-tool accounting leaves background reads governed by the global slots.
        const result = await runner.run(background ? `${actor}:${tool}` : actor, prepared.executable, prepared.args, journal.environment, prepared.secrets,
          prepared.limits, {}, prepared.files, () => {
            authorize?.()
            if (background && !(db.prepare('SELECT enabled FROM tools WHERE name = ?').get(tool) as { enabled: number }).enabled) {
              throw new ArtiumError('TOOL_DISABLED')
            }
            if (store?.findCredential(tool)?.revision !== reference.revision) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
          })
        exitCode = result.exitCode
        durationMs = result.durationMs
        outputBytes = result.outputBytes
        if (exitCode !== 0) failure = new ArtiumError('CREDENTIAL_UNAVAILABLE')
      } catch (error) {
        failure = error instanceof ArtiumError ? error : new ArtiumError('INTERNAL_ERROR')
        const runnerError = error instanceof RunnerError ? error : undefined
        durationMs = runnerError?.durationMs ?? Date.now() - started
        outputBytes = runnerError?.outputBytes ?? { stdout: 0, stderr: 0 }
      }
      const health = healthSchema.parse({ status: failure ? 'error' : 'ok', checkedAt: Date.now(),
        credentialRevision: reference.revision, errorCode: failure?.code ?? null })
      const evidence = { checkedAt: health.checkedAt, credentialRevision: health.credentialRevision, errorCode: health.errorCode }
      audit.record({ ...context, event: 'run-terminal', action: await journal?.action() ?? 'unknown', outcome: failure?.code ?? 'completed', exitCode, durationMs, outputBytes, ...evidence })
      audit.change({ ...context, event: background ? 'health-check' : 'credential-test', action: background ? healthDefaults.actor : undefined, outcome: failure?.code ?? 'success', ...evidence }, () => {
        if (!['TOO_MANY_CALLS', 'RUNNER_CLOSED', 'TOKEN_INVALID', 'TOKEN_EXPIRED',
          'USER_DISABLED', 'ADMIN_REQUIRED', 'REAUTH_REQUIRED'].includes(failure?.code ?? '')
          && store?.findCredential(tool)?.revision === reference.revision) {
          db.prepare(`INSERT INTO tool_health (tool, credential_revision, checked_at, status, error_code) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(tool) DO UPDATE SET credential_revision = excluded.credential_revision, checked_at = excluded.checked_at,
            status = excluded.status, error_code = excluded.error_code`)
            .run(tool, reference.revision, health.checkedAt, health.status, health.errorCode)
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
