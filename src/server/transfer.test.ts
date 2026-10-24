import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { transferExecuteSchema, transferLimits, transferPrepareSchema } from '../shared/api.js'
import { migrate } from './store/db.js'
import { checkTransferAccess, checkTransferCapacity, checkTransferScope, createTransferScope, transferTargetDigest } from './transfer.js'

const now = Date.UTC(2026, 0, 1)
const owner = { userId: 'person', sessionFamilyId: 'family', reauthenticatedAt: now }
const request = { selection: { operation: 'hash-download-bin' as const, selector: 'a'.repeat(64), type: 'bin' as const },
  targetDigest: transferTargetDigest('/synthetic/private/new-archive.gz') }
let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  db.exec(`INSERT INTO users (id, username, display_name, password_hash) VALUES ('person', 'synthetic', 'Synthetic', 'CANARY-hash');
    INSERT INTO session_families (id, user_id, created_at, expires_at) VALUES ('family', 'person', ${now}, ${now + 3600000});
    INSERT INTO tools (name, enabled, pinned_version) VALUES ('hybrid-axi', 1, 'synthetic');
    INSERT INTO roles (id, name) VALUES ('reader', 'Reader');
    INSERT INTO user_roles (user_id, role_id) VALUES ('person', 'reader');
    INSERT INTO role_tools (role_id, tool) VALUES ('reader', 'hybrid-axi');`)
})
afterEach(() => db.close())

test.each(['hash-download-bin', 'report-download-bin', 'report-download-dropped-files', 'report-download-memory'])(
  'only the independently selected %s passes current transfer access', selected => {
    db.prepare('UPDATE tools SET native_settings = ?').run(JSON.stringify({ writes: { allowWrites: true, operations: [selected] } }))
    const operations = ['hash-download-bin', 'report-download-bin', 'report-download-dropped-files', 'report-download-memory'] as const
    for (const operation of operations) {
      const access = () => checkTransferAccess(db, owner, operation, now)
      if (operation === selected) expect(access).not.toThrow()
      else expect(access).toThrow(expect.objectContaining({ code: 'FLAG_BLOCKED' }))
    }
  })

test('scope is immutable and binds exact destination without retaining a path', () => {
  const scope = createTransferScope(owner, 3, request, now)
  expect(() => checkTransferScope(scope, owner, 3, request, now)).not.toThrow()
  expect(Object.isFrozen(scope)).toBe(true)
  expect(Object.isFrozen(scope.selection)).toBe(true)
  expect(JSON.stringify(scope)).not.toContain('/synthetic')
  expect(scope.expiresAt).toBe(now + 600000)
  expect(() => checkTransferScope(scope, owner, 3, request, scope.expiresAt - 1)).not.toThrow()
  expect(transferTargetDigest('/synthetic/private/./new-archive.gz')).not.toBe(request.targetDigest)
})

test.each([
  { selection: { ...request.selection, type: 'memory' } },
  { selection: { ...request.selection, operation: 'arbitrary-export' } },
  { selection: { ...request.selection, selector: '/synthetic/private/file' } },
  { destination: '/synthetic/private/file' },
  { outputPath: '/synthetic/private/file' },
  { contentBase64: 'aW5lcnQ=' },
])('transfer input rejects invalid selections and byte/path fields: %j', change => {
  expect(transferPrepareSchema.safeParse({ ...request, ...change }).success).toBe(false)
})

test('execution requires explicit execute and the original native confirmation', () => {
  const input = { ...request, transferId: createTransferScope(owner, 3, request, now).transferId, confirm: 'exact native confirmation' }
  expect(transferExecuteSchema.safeParse(input).success).toBe(false)
  expect(transferExecuteSchema.parse({ ...input, execute: true }).confirm).toBe(input.confirm)
  expect(transferExecuteSchema.safeParse({ ...input, execute: true, confirm: '' }).success).toBe(false)
})

test.each([
  { changedOwner: { ...owner, userId: 'other' }, revision: 3, input: request, time: now, code: 'TOKEN_INVALID' },
  { changedOwner: { ...owner, sessionFamilyId: 'other' }, revision: 3, input: request, time: now, code: 'TOKEN_INVALID' },
  { changedOwner: owner, revision: 4, input: request, time: now, code: 'REVISION_CONFLICT' },
  { changedOwner: owner, revision: 3, input: { ...request, targetDigest: 'b'.repeat(64) }, time: now, code: 'INVALID_INPUT' },
  { changedOwner: owner, revision: 3, input: { ...request, selection: { ...request.selection, selector: 'b'.repeat(64) } }, time: now, code: 'INVALID_INPUT' },
  { changedOwner: owner, revision: 3, input: { ...request, selection: { operation: 'report-download-bin' as const, selector: 'synthetic-job', type: 'bin' as const } }, time: now, code: 'INVALID_INPUT' },
  { changedOwner: owner, revision: 3, input: request, time: now + transferLimits.lifetimeMs, code: 'TOKEN_EXPIRED' },
])('scope rejects changed identity/target/revision and absolute expiry: $code', ({ changedOwner, revision, input, time, code }) => {
  const scope = createTransferScope(owner, 3, request, now)
  expect(() => checkTransferScope(scope, changedOwner, revision, input, time)).toThrow(expect.objectContaining({ code }))
})

test('reserves the full artifact budget and retains expired capacity until cleanup', () => {
  const first = createTransferScope(owner, 3, request, now - transferLimits.lifetimeMs)
  expect(first.expiresAt).toBe(now)
  expect(() => checkTransferCapacity('other', [first])).not.toThrow()
  expect(() => checkTransferCapacity(owner.userId, [first])).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
  const reservations = [first,
    createTransferScope({ ...owner, userId: 'second' }, 3, request, now),
    createTransferScope({ ...owner, userId: 'third' }, 3, request, now),
    createTransferScope({ ...owner, userId: 'fourth' }, 3, request, now)]
  expect(() => checkTransferCapacity('fifth', reservations)).toThrow(expect.objectContaining({ code: 'TOO_MANY_CALLS' }))
  expect(transferLimits.artifactBytes).toBe(262144000)
  expect(transferLimits.reservedBytes).toBe(1073741824)
})

test.each([
  { sql: '', changedOwner: owner, code: 'FLAG_BLOCKED' },
  { sql: `UPDATE tools SET native_settings = '{"writes":{"allowWrites":true,"operations":["submitFile"]}}'`, changedOwner: owner, code: 'FLAG_BLOCKED' },
  { sql: 'DELETE FROM user_roles', changedOwner: owner, code: 'TOOL_NOT_GRANTED' },
  { sql: 'UPDATE tools SET enabled = 0', changedOwner: owner, code: 'TOOL_DISABLED' },
  { sql: 'UPDATE users SET disabled = 1', changedOwner: owner, code: 'USER_DISABLED' },
  { sql: `UPDATE session_families SET revoked_at = ${now}`, changedOwner: owner, code: 'TOKEN_INVALID' },
  { sql: `UPDATE session_families SET expires_at = ${now}`, changedOwner: owner, code: 'TOKEN_INVALID' },
  { sql: '', changedOwner: { ...owner, reauthenticatedAt: now - 900000 }, code: 'REAUTH_REQUIRED' },
  { sql: '', changedOwner: { ...owner, reauthenticatedAt: null }, code: 'REAUTH_REQUIRED' },
])('access rechecks current policy and stays default-off: $code', ({ sql, changedOwner, code }) => {
  db.exec(sql)
  expect(() => checkTransferAccess(db, changedOwner, request.selection.operation, now)).toThrow(expect.objectContaining({ code }))
})
