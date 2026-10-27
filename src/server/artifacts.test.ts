import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fakeTool } from '../../test/fake-tool/tool.js'
import { transferLimits } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { ArtifactStore, artifactDefaults } from './artifacts.js'
import type { ArtifactHostEvidence, ArtifactReservation, NativeArtifactEvidence } from './artifacts.js'
import { Audit } from './audit/audit.js'
import { hybridProfile } from './adapters/hybrid.js'
import { executeNativeArtifact, previewNativeArtifact } from './runner/artifact.js'
import { Runner } from './runner/runner.js'
import { migrate } from './store/db.js'
import { createTransferScope, transferTargetDigest } from './transfer.js'

const now = Date.UTC(2026, 0, 1)
test.each([
  { digest: createHash('sha256').update('different bytes').digest('hex'), nativeAuditId: null, nativeJournalResult: null },
  { digest: createHash('sha256').update('inert').digest('hex'), nativeAuditId: 'synthetic-native-id', nativeJournalResult: 'SUCCESS' as const },
])('the artifact store refuses contradictory Check Point byte or native journal evidence: %j', async ({ digest, nativeAuditId, nativeJournalResult }) => {
  db.exec("INSERT INTO tools (name, pinned_version) VALUES ('checkpoint-axi', 'synthetic')")
  const reservation = await store.reserve({ ...scope(),
    selection: { operation: 'email.download', selector: 'synthetic-email', type: 'email' } }, context)
  await expect(reservation.execute(async output => {
    await writeFile(output, 'inert', { mode: 0o600, flag: 'wx' })
    return { archiveBytes: 5, verifiedSha256: digest, nativeAuditId, nativeJournalResult }
  })).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  expect(await readdir(root)).toEqual([])
})
const context = { requestId: 'synthetic-request', clientAddress: null }
const request = { selection: { operation: 'hash-download-bin' as const, selector: 'a'.repeat(64), type: 'bin' as const },
  targetDigest: transferTargetDigest('/synthetic/new-archive.gz') }
const evidence: NativeArtifactEvidence = { archiveBytes: 3, nativeAuditId: '77066c24-bcb0-4a39-9304-551a617ac080', nativeJournalResult: 'SUCCESS' }
let fixture: string
let root: string
let db: Database.Database
let audit: Audit
let store: ArtifactStore
let runner: Runner
let host: ArtifactHostEvidence
let emitted: string[]

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  fixture = await mkdtemp(join(tmpdir(), 'artium-artifacts-test-'))
  root = join(fixture, 'artifacts')
  await mkdir(root, { mode: 0o700 })
  db = new Database(':memory:')
  migrate(db)
  db.exec("INSERT INTO tools (name, pinned_version) VALUES ('hybrid-axi', 'synthetic')")
  emitted = []
  audit = new Audit(db, Date.now, line => emitted.push(line))
  host = { mountinfo: `1 2 0:1 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,size=1048576k`,
    filesystemType: 0x01021994, capacityBytes: transferLimits.reservedBytes, freeBytes: transferLimits.reservedBytes,
    memoryMax: artifactDefaults.containerBytes, memoryCurrent: 256 * 1024 * 1024, swapMax: 0, swapCurrent: 0 }
  store = await ArtifactStore.create(audit, root, { inspect: async () => host })
  runner = await Runner.create(join(fixture, 'calls'))
})

afterEach(async () => {
  await runner.shutdown()
  await store.shutdown()
  db.close()
  vi.useRealTimers()
  await rm(fixture, { recursive: true, force: true })
})

function scope(userId = 'person') {
  db.prepare('INSERT OR IGNORE INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)')
    .run(userId, userId, 'Synthetic', 'CANARY-hash')
  return createTransferScope({ userId, sessionFamilyId: 'family', reauthenticatedAt: now }, 1, request)
}
const reserve = (userId = 'person') => store.reserve(scope(userId), context)
const events = () => db.prepare("SELECT * FROM audit WHERE event = 'transfer' ORDER BY id").all() as { outcome: string, archive_bytes: number | null }[]
async function complete(reservation: ArtifactReservation) {
  return reservation.execute(async output => {
    await writeFile(output, Uint8Array.of(0, 255, 128), { mode: 0o600 })
    return evidence
  })
}

function native(reservation: ArtifactReservation, variant = 'success', bytes = 257, authorize = () => {}, signal?: AbortSignal) {
  const confirmation = JSON.stringify(['artium', reservation.scope.selection.operation,
    { sha256: reservation.scope.selection.selector, type: 'bin', output: reservation.outputPath }, 'c'.repeat(64)])
  return executeNativeArtifact(reservation, runner, async args => {
    const profile = hybridProfile.prepare('hybrid-axi', { apiKey: 'CANARY-artifact-key',
      writes: { allowWrites: true, operations: [reservation.scope.selection.operation] } }, join(fixture, 'writes.log'), false)
    return { executable: fakeTool.executable, args: [...fakeTool.args, 'artifact', ...args], ...profile,
    environment: { ...profile.environment, ARTIUM_TEST_ARTIFACT_VARIANT: variant,
      ARTIUM_TEST_ARTIFACT_BYTES: String(bytes), ARTIUM_TEST_RSS_FILE: join(fixture, 'rss.json'),
      ARTIUM_TEST_READY_FILE: join(fixture, 'ready.json') },
    limits: { timeoutMs: 60_000 },
  } }, confirmation, authorize, { signal })
}

async function pinnedNative(reservation: ArtifactReservation, bytes = 257) {
  const prepare = async (args: string[]) => {
    const profile = hybridProfile.prepare('hybrid-axi', { apiKey: 'CANARY-artifact-key',
      writes: { allowWrites: true, operations: [reservation.scope.selection.operation] } }, join(fixture, 'writes.log'), false)
    return { executable: fakeTool.executable, args: [...fakeTool.args, 'native-artifact', ...args], ...profile,
      environment: { ...profile.environment, ARTIUM_TEST_ARTIFACT_BYTES: String(bytes), ARTIUM_TEST_RSS_FILE: join(fixture, 'rss.json') },
      limits: { timeoutMs: 60_000 } }
  }
  const preview = await previewNativeArtifact(reservation, runner, prepare, () => {})
  expect(await readdir(reservation.directory)).toEqual([])
  expect(JSON.parse(await readFile(join(fixture, 'rss.json'), 'utf8')).requests).toBe(0)
  expect(preview.warnings).toContain('Live-malware warning: this artifact may contain executable malware. Save only; do not extract or execute.')
  return executeNativeArtifact(reservation, runner, prepare, preview.confirm, () => {})
}

test('native handoff retains opaque binary after call cleanup and audits only complete size/digest', async () => {
  const reservation = await reserve()
  const archive = await pinnedNative(reservation)
  const bytes = await readFile(reservation.outputPath)
  expect(bytes).toEqual(Buffer.alloc(257, 0xa5))
  expect(archive).toMatchObject({ archiveBytes: bytes.length, archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    nativeJournalResult: 'SUCCESS' })
  expect(await readdir(join(fixture, 'calls'))).toEqual([])
  expect(JSON.stringify(archive)).not.toContain('stdout')
  expect(events().map(event => event.outcome)).toEqual(['preview', 'ready'])
  expect(emitted.join('')).not.toContain(bytes.toString('base64'))
  const delivered = await reservation.consume(async (path, metadata) => {
    expect(metadata.archiveSha256).toBe(archive.archiveSha256)
    return readFile(path)
  })
  expect(delivered).toEqual(bytes)
  expect(await readdir(root)).toEqual([])
  expect(events().map(event => event.outcome)).toEqual(['preview', 'ready', 'delivery-completed', 'deleted'])
  await expect(reservation.consume(async () => {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('native maximum-size buffered transport fits the declared child resident allowance', async () => {
  const reservation = await reserve()
  const archive = await pinnedNative(reservation, transferLimits.artifactBytes)
  const rss = JSON.parse(await readFile(join(fixture, 'rss.json'), 'utf8'))
  const hash = createHash('sha256')
  const block = Buffer.alloc(1024 * 1024, 0xa5)
  for (let index = 0; index < 250; index++) hash.update(block)
  expect(archive).toMatchObject({ archiveBytes: transferLimits.artifactBytes, archiveSha256: hash.digest('hex') })
  expect(rss.maxRssBytes).toBeLessThan(artifactDefaults.childResidentBytes)
  expect(rss.bytes).toBe(transferLimits.artifactBytes)
  console.log(`artifact-memory: maximum inert native archive=${rss.bytes} child maxRSS=${rss.maxRssBytes} allowance=${artifactDefaults.childResidentBytes}`)
}, 30_000)

test.each(['missing-journal', 'failed-journal', 'wrong-target', 'incomplete-journal', 'size-mismatch', 'symlink', 'directory', 'missing-output', 'failure'])(
  'rejects %s native completion and removes every unexposed byte', async variant => {
    const reservation = await reserve()
    await expect(native(reservation, variant)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
    expect(events().some(event => event.outcome === 'ready')).toBe(false)
    expect(events().every(event => event.archive_bytes === null)).toBe(true)
  })

test('native limit rejects the first byte above 250 MiB without ready evidence', async () => {
  await expect(native(await reserve(), 'success', transferLimits.artifactBytes + 1)).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
  expect(events().some(event => event.outcome === 'ready')).toBe(false)
}, 30_000)

test('authorization denial immediately before spawn cleans the reservation without executing', async () => {
  const reservation = await reserve()
  await expect(native(reservation, 'success', 257, () => { throw new ArtiumError('TOOL_DISABLED') }))
    .rejects.toMatchObject({ code: 'TOOL_DISABLED' })
  expect(await readdir(root)).toEqual([])
  expect(await readdir(join(fixture, 'calls'))).toEqual([])
  expect(events().map(event => event.outcome)).toEqual(['preview', 'denied-not-sent', 'deleted'])
})

test('native upstream failure retains correlated journal evidence without inventing archive metadata', async () => {
  await expect(native(await reserve(), 'upstream-failure')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  const failure = db.prepare("SELECT * FROM audit WHERE outcome = 'upstream-failure'").get()
  expect(failure).toMatchObject({ native_audit_id: evidence.nativeAuditId, native_journal_result: 'FAILED',
    archive_bytes: null, archive_sha256: null })
  expect(await readdir(root)).toEqual([])
})

test('one reservation cannot execute twice, including concurrent execution', async () => {
  const reservation = await reserve()
  const first = complete(reservation)
  await expect(complete(reservation)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await first
  await expect(complete(reservation)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('an abandoned ready artifact expires and cleans up without any follow-up request', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(now)
  const reservation = await reserve()
  await complete(reservation)
  await vi.advanceTimersByTimeAsync(transferLimits.lifetimeMs)
  await reservation.cancel()
  expect(await readdir(root)).toEqual([])
  expect(events().map(event => event.outcome)).toEqual(['preview', 'ready', 'expired', 'deleted'])
})

test('hardlinked publication names count once against the reservation capacity', async () => {
  const reservation = await reserve()
  await native(reservation, 'hardlink', transferLimits.artifactBytes)
  // A second reservation performs inventory while both names still exist.
  await expect(reserve('second')).resolves.toHaveProperty('outputPath')
  expect(await readdir(reservation.directory)).toHaveLength(2)
}, 30_000)

test('admission serializes preparation, reserving one full artifact per user and four globally', async () => {
  const results = await Promise.allSettled([reserve(), reserve(), reserve('second'), reserve('third'), reserve('fourth'), reserve('fifth')])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected'])
  expect(await readdir(root)).toHaveLength(4)
})

test('free-space admission counts partial inode bytes once while retaining unused reservations', async () => {
  const first = await reserve()
  const partial = join(first.directory, '.hybrid-artifact-aaaa.tmp')
  await writeFile(partial, Buffer.alloc(1024, 1), { mode: 0o600 })
  await link(partial, first.outputPath)
  host.freeBytes = 2 * transferLimits.artifactBytes - 1025
  await expect(reserve('second')).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  host.freeBytes++
  await expect(reserve('second')).resolves.toHaveProperty('outputPath')
})

test.each([
  ['disk', { filesystemType: 0xef53 }],
  ['wrong capacity', { capacityBytes: transferLimits.reservedBytes + 1 }],
  ['insufficient free space', { freeBytes: transferLimits.artifactBytes - 1 }],
  ['unbounded container', { memoryMax: NaN }],
  ['small container', { memoryMax: artifactDefaults.containerBytes - 1 }],
  ['missing resident headroom', { memoryCurrent: 3 * 1024 * 1024 * 1024 }],
  ['swappable container', { swapMax: 1 }],
  ['missing swap limit evidence', { swapMax: NaN }],
  ['existing swapped pages', { swapCurrent: 1 }],
  ['missing swap usage evidence', { swapCurrent: NaN }],
] as const)('fails closed on %s host evidence', async (_name, change) => {
  Object.assign(host, change)
  await expect(reserve()).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  expect(await readdir(root)).toEqual([])
})

test.each(['noexec', 'nosuid', 'nodev'])('requires explicit %s on the dedicated mount', async flag => {
  host.mountinfo = host.mountinfo.replace(flag, 'relatime')
  await expect(reserve()).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
})

test('refuses a mount inherited from the parent or reached through a symlink', async () => {
  host.mountinfo = host.mountinfo.replace(root, fixture)
  await expect(reserve()).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  await symlink(root, join(fixture, 'alias'))
  await expect(ArtifactStore.create(audit, join(fixture, 'alias'), { inspect: async () => host }))
    .rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
})

test('expiration cancels a consumer before unlinking and never refreshes the preparation deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(now)
  const reservation = await reserve()
  await complete(reservation)
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const consumed = reservation.consume(async (path, _archive, signal) => {
    start()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128]))
  }).catch(error => error)
  await started
  await vi.advanceTimersByTimeAsync(transferLimits.lifetimeMs)
  expect(await consumed).toMatchObject({ code: 'TOKEN_EXPIRED' })
  expect(await readdir(root)).toEqual([])
  expect(events().some(event => event.outcome === 'expired')).toBe(true)
})

test('expiry stops generation and cleans its incomplete file without another request', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(now)
  const reservation = await reserve()
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const generation = reservation.execute(async (_output, signal) => {
    await writeFile(join(reservation.directory, '.hybrid-artifact-aaaa.tmp'), 'inert', { mode: 0o600 })
    start()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    expect(await readdir(reservation.directory)).toEqual(['.hybrid-artifact-aaaa.tmp'])
    throw new ArtiumError('CANCELLED')
  }).catch(error => error)
  await started
  await vi.advanceTimersByTimeAsync(transferLimits.lifetimeMs)
  expect(await generation).toMatchObject({ code: 'CANCELLED' })
  expect(await readdir(root)).toEqual([])
})

test('expiry stops a native preview before deleting its stable output directory', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(now)
  const reservation = await reserve()
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const preview = reservation.preview(async (output, signal) => {
    expect(output).toBe(reservation.outputPath)
    start()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    expect(await readdir(reservation.directory)).toEqual([])
  }).catch(error => error)
  await started
  await vi.advanceTimersByTimeAsync(transferLimits.lifetimeMs)
  expect(await preview).toMatchObject({ code: 'TOKEN_EXPIRED' })
  expect(await readdir(root)).toEqual([])
})

test('disconnect aborts the actual native child and removes partial bytes after it exits', async () => {
  const reservation = await reserve()
  const controller = new AbortController()
  let markReady!: () => void
  const ready = new Promise<void>(resolve => { markReady = resolve })
  const watcher = watch(fixture, (_event, name) => { if (name === 'ready.json') markReady() })
  try {
    const generation = native(reservation, 'partial', 257, () => {}, controller.signal).catch(error => error)
    await ready
    const { parent } = JSON.parse(await readFile(join(fixture, 'ready.json'), 'utf8'))
    controller.abort()
    expect(await generation).toMatchObject({ code: 'CANCELLED' })
    expect(() => process.kill(parent, 0)).toThrow()
    expect(await readdir(root)).toEqual([])
  } finally { watcher.close() }
})

test('shutdown waits for an active consumer before unlinking and closes admission', async () => {
  const reservation = await reserve()
  await complete(reservation)
  let start!: () => void
  let stop!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const stopped = new Promise<void>(resolve => { stop = resolve })
  const consumed = reservation.consume(async (path, _archive, signal) => {
    start()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    expect(await readFile(path)).toHaveLength(3)
    stop()
  }).catch(error => error)
  await started
  await store.shutdown()
  await stopped
  expect(await consumed).toMatchObject({ code: 'CANCELLED' })
  expect(await readdir(root)).toEqual([])
  await expect(reserve('second')).rejects.toMatchObject({ code: 'RUNNER_CLOSED' })
})

test('deletion failure retains ownership and blocks all admission until explicit cleanup succeeds', async () => {
  await store.shutdown()
  let refuse = true
  const cleanupError = vi.fn()
  store = await ArtifactStore.create(audit, root, { inspect: async () => host, cleanupError,
    remove: async path => { if (refuse) throw new Error('synthetic lock'); await rm(path, { recursive: true, force: true }) } })
  const reservation = await reserve()
  await complete(reservation)
  await expect(reservation.cancel()).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  expect(cleanupError).toHaveBeenCalledOnce()
  expect(await readFile(reservation.outputPath)).toHaveLength(3)
  await expect(reserve('second')).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  refuse = false
  await store.retryCleanup()
  expect(await readdir(root)).toEqual([])
  await expect(reserve()).resolves.toHaveProperty('outputPath')
})

test('startup purges abandoned bytes and symlinks before marking prior metadata interrupted', async () => {
  const reservation = await reserve()
  await complete(reservation)
  // Simulate process loss without invoking orderly cleanup. Its timer is inert
  // under the fake clock, and the old owner is closed after restart evidence.
  const outside = join(fixture, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'inert')
  await symlink(outside, join(root, 'stale-link'))
  const restarted = await ArtifactStore.create(audit, root, { inspect: async () => host })
  expect(await readdir(root)).toEqual([])
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('inert')
  expect(events().filter(event => event.outcome === 'interrupted')).toEqual([expect.objectContaining({ archive_bytes: null })])
  expect(audit.recoverInterruptedTransfers()).toBe(0)
  await restarted.shutdown()
})

test('startup deletion failure refuses the store and leaves metadata unrecovered', async () => {
  const reservation = await reserve()
  await complete(reservation)
  await expect(ArtifactStore.create(audit, root, { inspect: async () => host,
    remove: async () => { throw new Error('synthetic lock') } })).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  expect(events().some(event => event.outcome === 'interrupted')).toBe(false)
})

test.each(['preparation', 'ready'])('%s audit failure prevents byte exposure and cleans all files', async phase => {
  if (phase === 'preparation') {
    db.exec('DROP TABLE audit')
    await expect(reserve()).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
  } else {
    const reservation = await reserve()
    db.exec("CREATE TRIGGER reject_ready BEFORE INSERT ON audit WHEN NEW.outcome = 'ready' BEGIN SELECT RAISE(ABORT, 'synthetic'); END")
    await expect(complete(reservation)).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' })
  }
  expect(await readdir(root)).toEqual([])
})
