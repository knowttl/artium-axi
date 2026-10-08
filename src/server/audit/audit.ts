import type Database from 'better-sqlite3'
import { ArtiumError } from '../../shared/errors.js'
import type { ErrorCode } from '../../shared/errors.js'
import type { ToolName } from '../store/credential-store.js'
import { redactArguments } from './redact.js'
import type { SensitiveArguments } from './redact.js'

interface Context {
  userId: string | null
  tool: ToolName | null
  requestId: string
  // The HTTP owner supplies the verified address, never a raw forwarded header.
  clientAddress: string | null
}

type Outcome = 'success' | 'failure' | ErrorCode
type Arguments = { args: readonly string[], sensitive: SensitiveArguments }
type CredentialTestEvidence = { checkedAt: number | null, credentialRevision: number | null, errorCode: ErrorCode | null }
export type AuditEvent = Context & (
  | ({ event: 'run-start', outcome: 'started' } & Arguments & Partial<CredentialTestEvidence>)
  | ({ event: 'run-terminal', outcome: 'completed' | 'interrupted' | ErrorCode, exitCode: number | null, durationMs: number, outputBytes: { stdout: number | null, stderr: number | null } } & Partial<CredentialTestEvidence>)
  | { event: 'denial', outcome: ErrorCode }
  | { event: 'sign-in' | 'sign-out' | 'lockout' | 'token-reuse' | 'password-change', outcome: Outcome }
  | ({ event: 'credential-test', outcome: Outcome } & CredentialTestEvidence)
  | { event: 'admin-change', outcome: Outcome, action: string, targetId: string }
  | { event: 'maintenance', outcome: 'success', cutoff: number, deletedCount: number }
)

export interface AuditRecord {
  id: number
  occurred_at: number
  event: AuditEvent['event']
  user_id: string | null
  tool: ToolName | null
  arguments: string | null
  request_id: string
  exit_code: number | null
  duration_ms: number | null
  stdout_bytes: number | null
  stderr_bytes: number | null
  client_address: string | null
  outcome: string
  action: string | null
  target_id: string | null
  cutoff: number | null
  deleted_count: number | null
  checked_at: number | null
  credential_revision: number | null
  error_code: ErrorCode | null
}

const dayMs = 24 * 60 * 60 * 1000
const retentionMs = 90 * dayMs
const retentionBatch = 500

const ignoreStdoutError = () => {}

function writeToStdout(line: string): void {
  if (!process.stdout.listeners('error').includes(ignoreStdoutError)) {
    process.stdout.on('error', ignoreStdoutError)
  }
  process.stdout.write(line)
}

// One instance belongs to the server. Startup calls recoverInterrupted before admitting runs.
export class Audit {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => number = Date.now,
    private readonly stream: ((line: string) => void) | undefined = process.env.ARTIUM_AXI_AUDIT_STDOUT === '1'
      ? writeToStdout
      : undefined,
  ) {}

  record(event: AuditEvent): AuditRecord {
    return this.change(event, () => undefined).record
  }

  // Future mutation producers use this boundary to commit their change and event together.
  change<T>(event: AuditEvent, mutation: () => T): { value: T, record: AuditRecord } {
    if (this.db.inTransaction) throw new ArtiumError('AUDIT_UNAVAILABLE')
    let result: { value: T, record: AuditRecord }
    let mutationFailed = false
    try {
      result = this.db.transaction(() => {
        let value: T
        try { value = mutation() } catch (error) { mutationFailed = true; throw error }
        return { value, record: this.insert(event) }
      }).immediate()
    } catch (error) {
      if (mutationFailed) throw error
      throw new ArtiumError('AUDIT_UNAVAILABLE')
    }
    this.emit(result.record)
    return result
  }

  recoverInterrupted(): number {
    const starts = this.db.prepare(`SELECT * FROM audit AS start WHERE event = 'run-start'
      AND NOT EXISTS (SELECT 1 FROM audit AS terminal
        WHERE terminal.event = 'run-terminal' AND terminal.request_id = start.request_id)
      ORDER BY id`).all() as AuditRecord[]
    for (const start of starts) {
      this.record({ event: 'run-terminal', userId: start.user_id, tool: start.tool,
        requestId: start.request_id, clientAddress: start.client_address, outcome: 'interrupted',
        exitCode: null, durationMs: Math.max(0, this.clock() - start.occurred_at), outputBytes: { stdout: null, stderr: null },
        credentialRevision: start.credential_revision, checkedAt: null, errorCode: null })
    }
    return starts.length
  }

  maintain(): number {
    if (this.db.inTransaction) throw new ArtiumError('AUDIT_UNAVAILABLE')
    const now = this.clock()
    const cutoff = now - retentionMs
    let total = 0
    let record: AuditRecord
    do {
      try {
        record = this.db.transaction(() => {
          const deletedCount = this.db.prepare(`DELETE FROM audit WHERE id IN (
            SELECT id FROM audit WHERE occurred_at < ? ORDER BY occurred_at, id LIMIT ?
          )`).run(cutoff, retentionBatch).changes
          return this.insert({ event: 'maintenance', userId: null, tool: null,
            requestId: `retention-${now}`, clientAddress: null, outcome: 'success', cutoff, deletedCount })
        }).immediate()
      } catch { throw new ArtiumError('AUDIT_UNAVAILABLE') }
      this.emit(record)
      total += record.deleted_count!
    } while (record.deleted_count === retentionBatch)
    return total
  }

  private insert(event: AuditEvent): AuditRecord {
    const terminal = event.event === 'run-terminal' ? event : undefined
    const admin = event.event === 'admin-change' ? event : undefined
    const maintenance = event.event === 'maintenance' ? event : undefined
    const test = event.event === 'credential-test' || event.event === 'run-start' || event.event === 'run-terminal'
      ? event : undefined
    const row = {
      occurred_at: this.clock(), event: event.event, user_id: event.userId, tool: event.tool,
      arguments: event.event === 'run-start' ? JSON.stringify(redactArguments(event.args, event.sensitive)) : null,
      request_id: event.requestId, exit_code: terminal?.exitCode ?? null,
      duration_ms: terminal ? Math.round(terminal.durationMs) : null,
      stdout_bytes: terminal?.outputBytes.stdout ?? null, stderr_bytes: terminal?.outputBytes.stderr ?? null,
      client_address: event.clientAddress, outcome: event.outcome,
      action: admin?.action ?? null, target_id: admin?.targetId ?? null,
      cutoff: maintenance?.cutoff ?? null, deleted_count: maintenance?.deletedCount ?? null,
      checked_at: test?.checkedAt ?? null, credential_revision: test?.credentialRevision ?? null,
      error_code: test?.errorCode ?? null,
    }
    const inserted = this.db.prepare(`INSERT INTO audit (${Object.keys(row).join(', ')})
      VALUES (${Object.keys(row).map(key => `@${key}`).join(', ')})`).run(row)
    return { id: Number(inserted.lastInsertRowid), ...row }
  }

  private emit(record: AuditRecord): void {
    // SQLite is authoritative. An unavailable optional stream cannot undo a committed event.
    try { this.stream?.(`${JSON.stringify(record)}\n`) } catch { /* Persistence remains durable. */ }
  }
}
