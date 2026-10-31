import type Database from 'better-sqlite3'
import type { z } from 'zod'
import { transferAuditSchema, transferEvidenceSchema } from '../../shared/api.js'
import type { adminAuditQuerySchema, adminAuditRecordSchema, transferOutcomeSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Diagnostic, ErrorCode } from '../../shared/errors.js'
import { safeDiagnostic } from '../health/diagnostic.js'
import type { ToolName } from '../store/credential-store.js'
import type { RunAction } from '../adapters/run-journal.js'
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
  | ({ event: 'upload', outcome: 'success', file: { name: string, size: number, sha256: string } } & Arguments)
  | { event: 'ado-api', outcome: 'allowed' | 'refused', method: string, path: string | null, bodySha256: string, bodyBytes: number }
  | { event: 'transfer', outcome: z.infer<typeof transferOutcomeSchema>, credentialRevision: number,
    transfer: z.infer<typeof transferAuditSchema> }
  | ({ event: 'run-start', outcome: 'started' } & Arguments & Partial<CredentialTestEvidence>)
  // A normal managed run's errorCode is the tool's own bounded failure code; health-driven runs reuse Artium codes.
  | ({ event: 'run-terminal', action?: RunAction, nativeAuditId?: string, outcome: 'completed' | 'interrupted' | ErrorCode, exitCode: number | null, durationMs: number, outputBytes: { stdout: number | null, stderr: number | null }, errorCode?: string | null,
    failure?: { diagnostic: Diagnostic | undefined, secrets: readonly string[] } } & Partial<Omit<CredentialTestEvidence, 'errorCode'>>)
  | { event: 'denial', outcome: ErrorCode }
  | { event: 'sign-in' | 'reauth' | 'password-change', outcome: Outcome, authenticationMethod?: 'sso' | 'local' | 'break-glass', providerId?: string, subject?: string }
  | { event: 'lockout' | 'token-reuse', outcome: Outcome }
  | { event: 'device-approve' | 'device-deny', outcome: Outcome, requestingAddress: string }
  | { event: 'sign-out', outcome: Outcome, action?: string, targetId?: string }
  | ({ event: 'credential-test' | 'health-check', outcome: Outcome, action?: string } & CredentialTestEvidence)
  | { event: 'admin-change', outcome: Outcome, action: string, targetId: string, subject?: string }
  | { event: 'tool-write-access', outcome: Outcome, enabled: boolean, allowDeletes?: boolean, allowConfigurationWrites?: boolean, operations: string[], unsupportedOperationCount: number }
  | { event: 'invite-create' | 'invite-resend' | 'invite-revoke', outcome: Outcome, targetId: string }
  | { event: 'invite-claim' | 'identity-link', outcome: Outcome, targetId: string, providerId: string, subject: string }
  | { event: 'role-sync', outcome: Outcome, providerId: string, subject: string, added: string[], removed: string[] }
  | { event: 'maintenance', outcome: 'success', cutoff: number, deletedCount: number }
)

export interface AuditRecord extends Pick<z.infer<typeof adminAuditRecordSchema>,
  'transfer_id' | 'session_family_id' | 'transfer_operation' | 'artifact_type' | 'artifact_selector' |
  'requested_target_digest' | 'archive_bytes' | 'archive_sha256' | 'native_audit_id' | 'native_journal_result' | 'client_save_outcome'> {
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
  error_code: string | null
  authentication_method: string | null
  provider_id: string | null
  subject: string | null
}

const dayMs = 24 * 60 * 60 * 1000
const retentionMs = 90 * dayMs
const diagnosticRetentionMs = 14 * dayMs
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

  runDiagnostic(requestId: string): Diagnostic | undefined {
    const row = this.db.prepare('SELECT diagnostic FROM run_diagnostics WHERE request_id = ? AND occurred_at > ?')
      .get(requestId, this.clock() - diagnosticRetentionMs) as { diagnostic: string } | undefined
    return row ? JSON.parse(row.diagnostic) as Diagnostic : undefined
  }

  query(input: z.infer<typeof adminAuditQuerySchema>): { records: AuditRecord[], nextCursor: string | null } {
    const cursor = input.cursor?.split(':').map(Number)
    const ceiling = cursor?.[0] ?? (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit').get() as { id: number }).id
    const clauses = ['id <= @ceiling']
    const values: Record<string, string | number> = { ceiling, limit: input.limit + 1 }
    if (cursor) {
      clauses.push('(occurred_at < @time OR (occurred_at = @time AND id < @id))')
      values.time = cursor[1]!
      values.id = cursor[2]!
    }
    if (input.failed === '1') clauses.push("event = 'run-terminal' AND (exit_code IS NULL OR exit_code <> 0 OR outcome <> 'completed')")
    for (const [filter, column] of [['requestId', 'request_id'], ['user', 'user_id'], ['tool', 'tool'], ['event', 'event'], ['outcome', 'outcome'], ['errorCode', 'error_code']] as const) {
      if (input[filter] !== undefined) {
        clauses.push(`${column} = @${filter}`)
        values[filter] = input[filter]!
      }
    }
    for (const [filter, operator] of [['from', '>='], ['to', '<=']] as const) {
      if (input[filter] !== undefined) {
        clauses.push(`occurred_at ${operator} @${filter}`)
        values[filter] = Date.parse(input[filter]!)
      }
    }
    const rows = this.db.prepare(`SELECT * FROM audit WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC LIMIT @limit`).all(values) as AuditRecord[]
    const records = rows.slice(0, input.limit)
    const last = records.at(-1)
    return { records, nextCursor: rows.length > input.limit ? `${ceiling}:${last!.occurred_at}:${last!.id}` : null }
  }

  // Future mutation producers use this boundary to commit their change and event together.
  change<T>(event: AuditEvent | AuditEvent[], mutation: () => T): { value: T, record: AuditRecord } {
    if (this.db.inTransaction) throw new ArtiumError('AUDIT_UNAVAILABLE')
    let result: { value: T, records: AuditRecord[] }
    let mutationFailed = false
    try {
      result = this.db.transaction(() => {
        let value: T
        try { value = mutation() } catch (error) { mutationFailed = true; throw error }
        return { value, records: (Array.isArray(event) ? event : [event]).map(item => this.insert(item)) }
      }).immediate()
    } catch (error) {
      if (mutationFailed) throw error
      throw new ArtiumError('AUDIT_UNAVAILABLE')
    }
    for (const record of result.records) this.emit(record)
    return { value: result.value, record: result.records[0]! }
  }

  recoverInterrupted(): number {
    const starts = this.db.prepare(`SELECT * FROM audit AS start WHERE event = 'run-start'
      AND NOT EXISTS (SELECT 1 FROM audit AS terminal
        WHERE terminal.event = 'run-terminal' AND terminal.request_id = start.request_id)
      ORDER BY id`).all() as AuditRecord[]
    for (const start of starts) {
      this.record({ event: 'run-terminal', userId: start.user_id, tool: start.tool,
        requestId: start.request_id, clientAddress: start.client_address, outcome: 'interrupted', action: 'unknown',
        exitCode: null, durationMs: Math.max(0, this.clock() - start.occurred_at), outputBytes: { stdout: null, stderr: null },
        credentialRevision: start.credential_revision, checkedAt: null, errorCode: null })
    }
    return starts.length
  }

  // Called only after the dedicated artifact mount has been purged. Persistent
  // metadata never makes bytes from a previous process retrievable again.
  recoverInterruptedTransfers(): number {
    const pending = this.db.prepare(`SELECT * FROM audit AS prior WHERE event = 'transfer'
      AND outcome IN ('preview', 'ready') AND NOT EXISTS (SELECT 1 FROM audit AS later
        WHERE later.event = 'transfer' AND later.transfer_id = prior.transfer_id AND later.id > prior.id)
      ORDER BY id`).all() as AuditRecord[]
    for (const prior of pending) {
      const transfer = transferAuditSchema.parse(Object.fromEntries(Object.keys(transferAuditSchema.shape)
        .map(key => [key, prior[key as keyof AuditRecord]])))
      this.record({ event: 'transfer', userId: prior.user_id, tool: prior.tool,
        requestId: prior.request_id, clientAddress: prior.client_address, outcome: 'interrupted',
        credentialRevision: prior.credential_revision!, transfer: { ...transfer,
          archive_bytes: null, archive_sha256: null, client_save_outcome: 'unconfirmed' } })
    }
    return pending.length
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
          this.db.prepare('DELETE FROM run_diagnostics WHERE occurred_at <= ?').run(now - diagnosticRetentionMs)
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
    const transfer = event.event === 'transfer' ? transferAuditSchema.parse(event.transfer) : undefined
    if (transfer) transferEvidenceSchema.parse({ outcome: event.outcome,
      archive: transfer.archive_bytes === null ? null : { archiveBytes: transfer.archive_bytes, archiveSha256: transfer.archive_sha256 },
      saveOutcome: transfer.client_save_outcome })
    const terminal = event.event === 'run-terminal' ? event : undefined
    const admin = event.event === 'admin-change' || event.event === 'sign-out' ? event : undefined
    const maintenance = event.event === 'maintenance' ? event : undefined
    const test = event.event === 'health-check' || event.event === 'credential-test' || event.event === 'run-start' || event.event === 'run-terminal'
      ? event : undefined
    const row = {
      occurred_at: this.clock(), event: event.event, user_id: event.userId, tool: event.tool,
      arguments: event.event === 'upload' ? JSON.stringify({ command: redactArguments(event.args, event.sensitive), file: event.file }) :
        event.event === 'ado-api' ? JSON.stringify({ method: event.method, path: event.path,
          decision: event.outcome, bodySha256: event.bodySha256, bodyBytes: event.bodyBytes }) :
        event.event === 'run-start' ? JSON.stringify(redactArguments(event.args, event.sensitive)) :
        event.event === 'tool-write-access' ? JSON.stringify({ enabled: event.enabled, operations: event.operations,
          ...(event.allowDeletes !== undefined ? { allowDeletes: event.allowDeletes } : {}),
          ...(event.allowConfigurationWrites !== undefined ? { allowConfigurationWrites: event.allowConfigurationWrites } : {}),
          unsupportedOperationCount: event.unsupportedOperationCount }) :
        event.event === 'role-sync' ? JSON.stringify({ added: event.added, removed: event.removed }) :
        event.event === 'device-approve' || event.event === 'device-deny' ? JSON.stringify({ requestingAddress: event.requestingAddress }) : null,
      request_id: event.requestId, exit_code: terminal?.exitCode ?? null,
      duration_ms: terminal ? Math.round(terminal.durationMs) : null,
      stdout_bytes: terminal?.outputBytes.stdout ?? null, stderr_bytes: terminal?.outputBytes.stderr ?? null,
      client_address: event.clientAddress, outcome: event.outcome,
      action: admin?.action ?? terminal?.action ?? (event.event === 'health-check' ? event.action : null) ?? null,
      target_id: 'targetId' in event ? event.targetId ?? null : null,
      cutoff: maintenance?.cutoff ?? null, deleted_count: maintenance?.deletedCount ?? null,
      checked_at: test?.checkedAt ?? null, credential_revision: event.event === 'transfer' ? event.credentialRevision : test?.credentialRevision ?? null,
      error_code: test?.errorCode ?? null,
      authentication_method: 'authenticationMethod' in event ? event.authenticationMethod ?? null : null,
      provider_id: 'providerId' in event ? event.providerId ?? null : null,
      subject: 'subject' in event ? event.subject ?? null : null,
      transfer_id: transfer?.transfer_id ?? null, session_family_id: transfer?.session_family_id ?? null,
      transfer_operation: transfer?.transfer_operation ?? null, artifact_type: transfer?.artifact_type ?? null,
      artifact_selector: transfer?.artifact_selector ?? null, requested_target_digest: transfer?.requested_target_digest ?? null,
      archive_bytes: transfer?.archive_bytes ?? null, archive_sha256: transfer?.archive_sha256 ?? null,
      native_audit_id: transfer?.native_audit_id ?? terminal?.nativeAuditId ?? null, native_journal_result: transfer?.native_journal_result ?? null,
      client_save_outcome: transfer?.client_save_outcome ?? null,
    }
    const inserted = this.db.prepare(`INSERT INTO audit (${Object.keys(row).join(', ')})
      VALUES (${Object.keys(row).map(key => `@${key}`).join(', ')})`).run(row)
    if (terminal?.failure && (terminal.exitCode !== 0 || terminal.outcome !== 'completed')) {
      const detail = safeDiagnostic(terminal.failure.diagnostic, terminal.failure.secrets)
      if (detail) {
        // The shared diagnostic limit counts characters; persisted JSON also has a strict byte ceiling.
        let serialized = JSON.stringify(detail)
        for (const key of ['message', 'hint', 'issuer', 'host', 'toolCode', 'providerCode'] as const) {
          const excess = Buffer.byteLength(serialized) - 4096
          if (excess <= 0) break
          if (detail[key] !== undefined) {
            const points = Array.from(detail[key]!)
            detail[key] = points.slice(0, Math.max(0, points.length - excess)).join('')
            serialized = JSON.stringify(detail)
          }
        }
        this.db.prepare('INSERT INTO run_diagnostics (request_id, occurred_at, diagnostic) VALUES (?, ?, ?)')
          .run(event.requestId, row.occurred_at, serialized)
      }
    }
    return { id: Number(inserted.lastInsertRowid), ...row }
  }

  private emit(record: AuditRecord): void {
    // SQLite is authoritative. An unavailable optional stream cannot undo a committed event.
    try { this.stream?.(`${JSON.stringify(record)}\n`) } catch { /* Persistence remains durable. */ }
  }
}
