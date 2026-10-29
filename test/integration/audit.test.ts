import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { Audit } from '../../src/server/audit/audit.js'
import type { AuditEvent, AuditRecord } from '../../src/server/audit/audit.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { adminAuditRecordSchema } from '../../src/shared/api.js'

let directory: string
let db: Database.Database
let audit: Audit
let now: number
let lines: string[]
const day = 24 * 60 * 60 * 1000
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const context = { userId: 'person', tool: 'falcon-axi' as const, requestId: 'synthetic-request', clientAddress: '192.0.2.1' }
const start = { ...context, event: 'run-start' as const, outcome: 'started' as const,
  args: ['read', '--password=CANARY-value'], sensitive: { flags: ['--password'], positions: [] } }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-audit-'))
  db = openStore(join(directory, 'artium.db'), provider)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('person', 'synthetic', 'Synthetic', 'CANARY-hash');
    UPDATE tools SET enabled = 1, pinned_version = 'synthetic-version' WHERE name = 'falcon-axi';`)
  now = Date.UTC(2026, 0, 1)
  lines = []
  audit = new Audit(db, () => now, line => { lines.push(line) })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const transfer = {
  transfer_id: 'f105c3b9-a58f-4d4c-bb60-8d17a70b5b86', session_family_id: 'family',
  transfer_operation: 'hash-download-bin' as const, artifact_type: 'bin' as const,
  artifact_selector: 'a'.repeat(64), requested_target_digest: 'b'.repeat(64),
  archive_bytes: null, archive_sha256: null, native_audit_id: null, native_journal_result: null,
  client_save_outcome: 'unconfirmed' as const,
}

test('transfer audit persists typed metadata with separate archive and client-save evidence', () => {
  const record = audit.record({ ...context, tool: 'hybrid-axi', event: 'transfer', outcome: 'preview',
    credentialRevision: 3, transfer })
  expect(adminAuditRecordSchema.parse(record)).toEqual(record)
  expect(record).toMatchObject({ ...transfer, credential_revision: 3, arguments: null })
  expect(db.prepare('SELECT * FROM audit WHERE id = ?').get(record.id)).toEqual(record)
  const delivered = audit.record({ ...context, tool: 'hybrid-axi', event: 'transfer', outcome: 'delivery-completed',
    credentialRevision: 3, transfer: { ...transfer, archive_bytes: 5, archive_sha256: 'c'.repeat(64), native_journal_result: 'SUCCESS' } })
  expect(delivered).toMatchObject({ outcome: 'delivery-completed', client_save_outcome: 'unconfirmed',
    artifact_selector: 'a'.repeat(64), archive_sha256: 'c'.repeat(64) })
})

test.each([
  { archive_bytes: 5 },
  { archive_sha256: 'c'.repeat(64) },
  { archive_bytes: 262144001, archive_sha256: 'c'.repeat(64) },
  { destination: '/synthetic/private/file' },
  { outputPath: '/synthetic/private/file' },
  { artifact_selector: '/synthetic/private/file' },
  { native_audit_id: '/synthetic/private/file' },
  { session_family_id: '/synthetic/private/file' },
  { archive_bytes: 5, archive_sha256: 'c'.repeat(64) },
  { transfer_operation: 'report-download-memory' as const },
])('transfer audit fails closed on incomplete digest, invalid scope and path fields: %j', change => {
  const input = { ...transfer, ...change }
  expect(() => audit.record({ ...context, event: 'transfer', outcome: 'preview', credentialRevision: 3,
    transfer: input })).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }))
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
  expect(lines).toEqual([])
})

test.each<AuditEvent>([
  start,
  { ...context, event: 'run-terminal', outcome: 'completed', exitCode: 3, durationMs: 20, outputBytes: { stdout: 12, stderr: 4 } },
  { ...context, event: 'denial', outcome: 'TOOL_NOT_GRANTED' },
  { ...context, event: 'sign-in', outcome: 'success' },
  { ...context, userId: null, tool: null, event: 'sign-in', outcome: 'failure' },
  { ...context, event: 'sign-out', outcome: 'success' },
  { ...context, event: 'lockout', outcome: 'failure' },
  { ...context, event: 'token-reuse', outcome: 'failure' },
  { ...context, event: 'password-change', outcome: 'success' },
  { ...context, event: 'credential-test', outcome: 'success', checkedAt: 1000, credentialRevision: 1, errorCode: null },
  { ...context, event: 'admin-change', outcome: 'success', action: 'disable-user', targetId: 'person' },
  { ...context, userId: null, tool: null, event: 'maintenance', outcome: 'success', cutoff: 100, deletedCount: 7 },
])('persists and streams the safe $event record', event => {
  // Extra request/output fields at a runtime boundary must never enter storage or the stream.
  const input = { ...event, body: 'CANARY-body', stdout: 'CANARY-output', token: 'CANARY-token' }
  const record = audit.record(input)
  db.close()
  db = openStore(join(directory, 'artium.db'), provider)
  const persisted = db.prepare('SELECT * FROM audit').get()
  expect(persisted).toEqual(record)
  expect(record).toMatchObject({ occurred_at: now, user_id: event.userId, tool: event.tool,
    request_id: event.requestId, client_address: event.clientAddress, outcome: event.outcome })
  expect(lines).toEqual([`${JSON.stringify(persisted)}\n`])
  expect(lines.join('')).not.toContain('CANARY-')
})

test('marks unmatched starts interrupted after reopening, once, without replay', () => {
  audit.record({ ...start, credentialRevision: 3, checkedAt: now, errorCode: null })
  audit.record({ ...start, requestId: 'completed-request' })
  audit.record({ ...context, requestId: 'completed-request', event: 'run-terminal', outcome: 'completed',
    exitCode: 0, durationMs: 2, outputBytes: { stdout: 3, stderr: 0 } })
  db.close()
  db = openStore(join(directory, 'artium.db'), provider)
  now += 100
  audit = new Audit(db, () => now, line => { lines.push(line) })
  expect(audit.recoverInterrupted()).toBe(1)
  expect(audit.recoverInterrupted()).toBe(0)
  expect(db.prepare("SELECT * FROM audit WHERE outcome = 'interrupted'").all()).toEqual([
    expect.objectContaining({ event: 'run-terminal', request_id: context.requestId, user_id: 'person',
      tool: 'falcon-axi', client_address: context.clientAddress, exit_code: null, duration_ms: 100,
      credential_revision: 3, checked_at: null, error_code: null }),
  ])
  expect(lines.map(line => JSON.parse(line))).toEqual(db.prepare('SELECT * FROM audit ORDER BY id').all())
})

test('failure diagnostics become unreadable at 14 days and daily retention removes them', () => {
  audit.record({ ...context, event: 'run-terminal', outcome: 'completed', exitCode: 1, durationMs: 1,
    outputBytes: { stdout: 0, stderr: 1 }, failure: { diagnostic: { stage: 'tool run', message: 'Synthetic failure' }, secrets: [] } })
  now += 14 * day - 1
  expect(audit.runDiagnostic(context.requestId)).toEqual({ stage: 'tool run', message: 'Synthetic failure' })
  now++
  expect(audit.runDiagnostic(context.requestId)).toBeUndefined()
  audit.maintain()
  expect(db.prepare('SELECT * FROM run_diagnostics').all()).toEqual([])
  expect(db.prepare("SELECT exit_code FROM audit WHERE event = 'run-terminal'").get()).toEqual({ exit_code: 1 })
})

test.each(['x', '界', '😀'])('persisted diagnostics bound serialized %s text to 4 KiB', character => {
  audit.record({ ...context, event: 'run-terminal', outcome: 'completed', exitCode: 1, durationMs: 1,
    outputBytes: { stdout: 0, stderr: 10000 }, failure: { diagnostic: { stage: 'tool run', message: character.repeat(10000), hint: 'Synthetic hint' }, secrets: [] } })
  const row = db.prepare('SELECT diagnostic FROM run_diagnostics').get() as { diagnostic: string }
  expect(Buffer.byteLength(row.diagnostic)).toBeLessThanOrEqual(4096)
  expect(JSON.parse(row.diagnostic)).toMatchObject({ stage: 'tool run', hint: 'Synthetic hint' })
})

test.each([
  ['message', 4060],
  ['hint', 4050],
  ['issuer', 4048],
] as const)('persisted diagnostics truncate %s without splitting a surrogate pair', (field, prefixLength) => {
  const record = audit.record({ ...context, event: 'run-terminal', outcome: 'completed', exitCode: 1, durationMs: 1,
    outputBytes: { stdout: 0, stderr: 4096 }, failure: { diagnostic: { stage: 'tool run', message: '',
      [field]: 'a'.repeat(prefixLength) + '😀' + 'b'.repeat(26) }, secrets: [] } })
  const row = db.prepare('SELECT diagnostic FROM run_diagnostics').get() as { diagnostic: string }
  expect(Buffer.byteLength(row.diagnostic)).toBeLessThanOrEqual(4096)
  expect(audit.runDiagnostic(context.requestId)).toMatchObject({ stage: 'tool run', [field]: 'a'.repeat(prefixLength) })
  expect(db.prepare('SELECT * FROM audit WHERE id = ?').get(record.id)).toEqual(record)
})

test('diagnostic persistence failure rolls back the terminal event and emits nothing', () => {
  db.exec("CREATE TRIGGER fail_diagnostic BEFORE INSERT ON run_diagnostics BEGIN SELECT RAISE(ABORT, 'synthetic full storage'); END")
  expect(() => audit.record({ ...context, event: 'run-terminal', outcome: 'completed', exitCode: 1, durationMs: 1,
    outputBytes: { stdout: 0, stderr: 1 }, failure: { diagnostic: { stage: 'tool run', message: 'Synthetic failure' }, secrets: [] } }))
    .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }))
  expect(db.prepare('SELECT * FROM audit').all()).toEqual([])
  expect(lines).toEqual([])
})

test.each([
  [501, [500, 1]],
  [1000, [500, 500, 0]],
] as const)('daily retention drains %i expired events in bounded batches', (expired, counts) => {
  db.prepare(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < ?)
    INSERT INTO audit (occurred_at, event, outcome) SELECT ?, 'sign-out', 'success' FROM rows`).run(expired, now - 90 * day - 1)
  db.prepare("INSERT INTO audit (occurred_at, event, outcome) VALUES (?, 'sign-out', 'success')").run(now - 90 * day)
  expect(audit.maintain()).toBe(expired)
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit WHERE occurred_at < ?').get(now - 90 * day)).toEqual({ count: 0 })
  expect(db.prepare("SELECT cutoff, deleted_count FROM audit WHERE event = 'maintenance' ORDER BY id").all())
    .toEqual(counts.map(deleted_count => ({ cutoff: now - 90 * day, deleted_count })))
  expect(db.prepare("SELECT occurred_at FROM audit WHERE event = 'sign-out'").all()).toEqual([{ occurred_at: now - 90 * day }])
  expect(audit.maintain()).toBe(0)
  db.prepare("INSERT INTO audit (occurred_at, event, outcome) VALUES (?, 'sign-out', 'success')").run(now - 90 * day - 1)
  expect(audit.maintain()).toBe(1)
  now += day
  expect(audit.maintain()).toBe(1)
  expect(lines.map(line => JSON.parse(line))).toEqual(db.prepare("SELECT * FROM audit WHERE event = 'maintenance' ORDER BY id").all())
})

test('retention commits earlier batches and rolls back only the failed batch', () => {
  db.prepare(`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 501)
    INSERT INTO audit (occurred_at, event, outcome) SELECT ?, 'sign-out', 'success' FROM rows`).run(now - 90 * day - 1)
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN NEW.event = 'maintenance' AND NEW.deleted_count = 1 BEGIN SELECT RAISE(ABORT, 'synthetic full storage'); END")
  expect(() => audit.maintain()).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }))
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit WHERE occurred_at < ?').get(now - 90 * day)).toEqual({ count: 1 })
  expect(db.prepare("SELECT deleted_count FROM audit WHERE event = 'maintenance'").all()).toEqual([{ deleted_count: 500 }])
  expect(lines.map(line => JSON.parse(line))).toEqual(db.prepare("SELECT * FROM audit WHERE event = 'maintenance'").all())
  db.exec('DROP TRIGGER fail_audit')
  expect(audit.maintain()).toBe(1)
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit WHERE occurred_at < ?').get(now - 90 * day)).toEqual({ count: 0 })
})

test('retention rolls deletion back when its maintenance audit cannot persist', () => {
  audit.record({ ...context, event: 'sign-out', outcome: 'success' })
  now += 91 * day
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic full storage'); END")
  expect(() => audit.maintain()).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }))
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 1 })
  expect(lines).toHaveLength(1)
})

test('an admin change commits with its event and rolls back on audit failure', () => {
  audit.change({ ...context, event: 'admin-change', outcome: 'success', action: 'disable-user', targetId: 'person' }, () => {
    db.exec('UPDATE users SET disabled = 1')
  })
  expect(db.prepare('SELECT disabled FROM users').get()).toEqual({ disabled: 1 })
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'synthetic full storage'); END")
  expect(() => audit.change({ ...context, event: 'admin-change', outcome: 'success', action: 'enable-user', targetId: 'person' }, () => {
    db.exec('UPDATE users SET disabled = 0')
  })).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }))
  expect(db.prepare('SELECT disabled FROM users').get()).toEqual({ disabled: 1 })
  expect(lines).toHaveLength(1)
})

test('a rejected mutation retains its own error and publishes no event', () => {
  const failure = new Error('synthetic revision conflict')
  expect(() => audit.change({ ...context, event: 'admin-change', outcome: 'success', action: 'disable-user', targetId: 'person' }, () => {
    db.exec('UPDATE users SET disabled = 1')
    throw failure
  })).toThrow(failure)
  expect(db.prepare('SELECT disabled FROM users').get()).toEqual({ disabled: 0 })
  expect(db.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 })
  expect(lines).toEqual([])
})

test('ARTIUM_AXI_AUDIT_STDOUT=1 emits exactly one persisted JSON line', () => {
  vi.stubEnv('ARTIUM_AXI_AUDIT_STDOUT', '1')
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  audit = new Audit(db, () => now)
  const record = audit.record({ ...context, event: 'sign-out', outcome: 'success' })
  expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(record)}\n`)
  expect(db.prepare('SELECT * FROM audit').get()).toEqual(record)
})

test('the audit stream is disabled by default', () => {
  vi.stubEnv('ARTIUM_AXI_AUDIT_STDOUT', '')
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  new Audit(db, () => now).record({ ...context, event: 'sign-out', outcome: 'success' })
  expect(stdout).not.toHaveBeenCalled()
})

test('a stream failure preserves the committed event', () => {
  audit = new Audit(db, () => now, () => { throw new Error('synthetic broken stream') })
  const record: AuditRecord = audit.record({ ...context, event: 'sign-out', outcome: 'success' })
  expect(db.prepare('SELECT * FROM audit').get()).toEqual(record)
})

test('an asynchronous stdout failure preserves run events and allows further auditing', async () => {
  vi.stubEnv('ARTIUM_AXI_AUDIT_STDOUT', '1')
  const failure = Object.assign(new Error('synthetic broken pipe'), { code: 'EPIPE' })
  const stdout = new Writable({
    write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)) },
  })
  const closed = new Promise<void>(resolve => { stdout.once('close', resolve) })
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as typeof process.stdout)
  audit = new Audit(db, () => now)
  const first = audit.record(start)
  await closed
  const terminal = audit.record({ ...context, event: 'run-terminal', outcome: 'completed',
    exitCode: 0, durationMs: 2, outputBytes: { stdout: 3, stderr: 0 } })
  expect(stdout.errored).toBe(failure)
  expect(db.prepare('SELECT * FROM audit ORDER BY id').all()).toEqual([first, terminal])
})
