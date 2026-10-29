import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { transferLimits, transferScopeSchema, transferTool } from '../shared/api.js'
import type { TransferScope } from '../shared/api.js'
import type { transferOutcomeSchema } from '../shared/api.js'
import type { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { checkTransferCapacity, transferAuditSelector } from './transfer.js'
import type { Audit } from './audit/audit.js'
import type { RunContext } from './runner/run.js'
import { log } from './log.js'

export const artifactDefaults = {
  directory: '/tmp/artium-artifacts',
  // The pinned buffered native path needs resident memory outside its Node heap.
  childResidentBytes: 768 * 1024 * 1024,
  containerBytes: 6 * 1024 * 1024 * 1024,
} as const

export interface ArtifactHostEvidence {
  mountinfo: string
  filesystemType: number
  capacityBytes: number
  freeBytes: number
  memoryMax: number
  memoryCurrent: number
  swapMax: number
  swapCurrent: number
}

async function inspectHost(root: string): Promise<ArtifactHostEvidence> {
  const [mountinfo, filesystem, memoryMax, memoryCurrent, swapMax, swapCurrent] = await Promise.all([
    readFile('/proc/self/mountinfo', 'utf8'), statfs(root),
    readFile('/sys/fs/cgroup/memory.max', 'utf8'), readFile('/sys/fs/cgroup/memory.current', 'utf8'),
    readFile('/sys/fs/cgroup/memory.swap.max', 'utf8'),
    readFile('/sys/fs/cgroup/memory.swap.current', 'utf8'),
  ])
  return { mountinfo, filesystemType: filesystem.type,
    capacityBytes: filesystem.blocks * filesystem.bsize, freeBytes: filesystem.bavail * filesystem.bsize,
    memoryMax: Number(memoryMax.trim()), memoryCurrent: Number(memoryCurrent.trim()),
    swapMax: Number(swapMax.trim()), swapCurrent: Number(swapCurrent.trim()) }
}

interface ArtifactDependencies {
  // Only external host/filesystem boundaries are substituted by fake-only tests.
  inspect?: typeof inspectHost
  remove?: (path: string) => Promise<void>
  cleanupError?: () => void
}

export interface ArtifactArchive {
  archiveBytes: number
  archiveSha256: string
}

export interface NativeArtifactIdentity {
  nativeAuditId: string | null
  nativeJournalResult: 'SUCCESS' | 'FAILED' | 'NOT_SENT' | 'OUTCOME_UNKNOWN' | null
}

export interface NativeArtifactEvidence extends NativeArtifactIdentity {
  archiveBytes: number
  nativeJournalResult: 'SUCCESS' | null
  verifiedSha256?: string
}

export class ArtifactGenerationFailure extends Error {
  constructor(readonly outcome: 'denied-not-sent' | 'upstream-failure' | 'native-outcome-unknown', readonly cause: unknown,
    readonly nativeEvidence?: NativeArtifactIdentity) {
    super('Native artifact generation did not complete')
  }
}

function unavailable(): never { throw new ArtiumError('TEMP_UNAVAILABLE') }

function checkHost(root: string, host: ArtifactHostEvidence): void {
  const mounts = host.mountinfo.trim().split('\n').map(line => line.split(' '))
  const mount = mounts.find(fields => fields[4] === root)
  const separator = mount?.indexOf('-') ?? -1
  const flags = new Set([...(mount?.[5]?.split(',') ?? []), ...(mount?.[separator + 3]?.split(',') ?? [])])
  if (!mount || separator < 6 || mount[3] !== '/' || mount[separator + 1] !== 'tmpfs'
    || !['rw', 'noexec', 'nosuid', 'nodev'].every(flag => flags.has(flag))
    || host.filesystemType !== 0x01021994 || host.capacityBytes !== transferLimits.reservedBytes
    || !Number.isSafeInteger(host.freeBytes) || host.freeBytes < 0 || host.freeBytes > host.capacityBytes
    || !Number.isSafeInteger(host.memoryMax) || host.memoryMax < artifactDefaults.containerBytes
    // Tmpfs swap allocation is charged to its writer's memory cgroup. Require
    // enforced zero swap and no existing swapped pages; Docker rejects noswap
    // in --tmpfs even on kernels that support that optional mount flag.
    || !Number.isSafeInteger(host.memoryCurrent) || host.memoryCurrent < 0 || host.swapMax !== 0 || host.swapCurrent !== 0
    || host.memoryCurrent + transferLimits.reservedBytes
      + transferLimits.reservations * artifactDefaults.childResidentBytes > host.memoryMax) unavailable()
}

// One owner per server, created before transfer admission. No mount is created
// and no ordinary directory/disk fallback exists.
export class ArtifactStore {
  private readonly entries = new Map<string, ArtifactReservation>()
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private cleanupFailed = false
  private readonly inspect: typeof inspectHost
  private readonly remove: (path: string) => Promise<void>

  private constructor(private readonly audit: Audit, private readonly root: string, private readonly dependencies: ArtifactDependencies) {
    this.inspect = dependencies.inspect ?? inspectHost
    this.remove = dependencies.remove ?? (path => rm(path, { recursive: true, force: true }))
  }

  static async create(audit: Audit, root: string = artifactDefaults.directory, dependencies: ArtifactDependencies = {}): Promise<ArtifactStore> {
    const store = new ArtifactStore(audit, root, dependencies)
    try {
      await store.host()
      // Purge before admitting anything. rm unlinks symlinks without following them.
      for (const leaf of await readdir(root)) await store.remove(join(root, leaf))
    } catch { unavailable() }
    audit.recoverInterruptedTransfers()
    return store
  }

  private async host(): Promise<ArtifactHostEvidence> {
    try {
      for (let path = this.root; ; path = dirname(path)) {
        const info = await lstat(path)
        if (!info.isDirectory() || info.isSymbolicLink()) unavailable()
        if (path === this.root && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())) unavailable()
        if (dirname(path) === path) break
      }
      const host = await this.inspect(this.root)
      checkHost(this.root, host)
      return host
    } catch { unavailable() }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.catch(() => {})
    return next
  }

  async reserve(input: TransferScope, context: Pick<RunContext, 'requestId' | 'clientAddress'>): Promise<ArtifactReservation> {
    const scope = transferScopeSchema.parse(input)
    return this.serialized(async () => {
      if (this.closed) throw new ArtiumError('RUNNER_CLOSED')
      if (this.cleanupFailed) unavailable()
      if (scope.expiresAt <= Date.now()) throw new ArtiumError('TOKEN_EXPIRED')
      checkTransferCapacity(scope.userId, [...this.entries.values()].map(entry => entry.scope))
      if (this.entries.has(scope.transferId)) throw new ArtiumError('INVALID_INPUT')
      const host = await this.host()
      const bytes = await this.inventory()
      if (host.freeBytes + bytes < (this.entries.size + 1) * transferLimits.artifactBytes) unavailable()
      const record = (outcome: z.infer<typeof transferOutcomeSchema>, evidence?: NativeArtifactIdentity, archive?: ArtifactArchive) => {
        this.audit.record({ event: 'transfer', userId: scope.userId, tool: transferTool(scope.selection.operation), requestId: context.requestId,
          clientAddress: context.clientAddress, outcome, credentialRevision: scope.credentialRevision,
          transfer: { transfer_id: scope.transferId, session_family_id: scope.sessionFamilyId,
            transfer_operation: scope.selection.operation, artifact_type: scope.selection.type, artifact_selector: transferAuditSelector(scope),
            requested_target_digest: scope.targetDigest, archive_bytes: archive?.archiveBytes ?? null,
            archive_sha256: archive?.archiveSha256 ?? null, native_audit_id: evidence?.nativeAuditId ?? null,
            native_journal_result: evidence?.nativeJournalResult ?? null, client_save_outcome: 'unconfirmed' } })
      }
      // Persist preparation intent before bytes or a child can exist.
      record('preview')
      const directory = join(this.root, scope.transferId)
      await mkdir(directory, { mode: 0o700 })
      const reservation = new ArtifactReservation(Object.freeze({ ...scope, selection: Object.freeze(scope.selection) }), directory,
        entry => this.delete(entry), record)
      this.entries.set(scope.transferId, reservation)
      return reservation
    })
  }

  private async inventory(): Promise<number> {
    let bytes = 0
    for (const leaf of await readdir(this.root)) {
      const entry = this.entries.get(leaf)
      if (!entry) unavailable()
      bytes += await artifactBytes(entry.directory)
    }
    return bytes
  }

  private delete(entry: ArtifactReservation): Promise<void> {
    return this.serialized(async () => {
      try {
        await this.remove(entry.directory)
        this.entries.delete(entry.scope.transferId)
      } catch {
        this.cleanupFailed = true
        // Fixed diagnostic only: never payloads, paths or arbitrary filesystem errors.
        if (this.dependencies.cleanupError) this.dependencies.cleanupError()
        else log('error', 'artifact-cleanup', { code: 'ARTIFACT_UNAVAILABLE' })
        throw new ArtiumError('TEMP_UNAVAILABLE')
      }
    })
  }

  async retryCleanup(): Promise<void> {
    for (const entry of this.entries.values()) if (entry.terminal) await entry.cancel()
    await this.serialized(async () => { this.cleanupFailed = [...this.entries.values()].some(entry => entry.terminal) })
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.queue
    const results = await Promise.allSettled([...this.entries.values()].map(entry => entry.cancel()))
    if (results.some(result => result.status === 'rejected')) unavailable()
  }
}

// Native atomic publication can leave its temporary and output names linked to
// one inode. Count that inode once, including partial files before publication.
async function artifactBytes(directory: string): Promise<number> {
  const owner = await lstat(directory)
  if (!owner.isDirectory() || owner.isSymbolicLink() || (owner.mode & 0o777) !== 0o700 || owner.uid !== process.getuid?.()) unavailable()
  const inodes = new Set<number>()
  let bytes = 0
  for (const name of await readdir(directory)) {
    if (name !== 'archive' && !/^\.hybrid-artifact-[a-f0-9-]+\.tmp$/.test(name)) unavailable()
    let info
    try { info = await lstat(join(directory, name)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) unavailable()
    if (!inodes.has(info.ino)) { inodes.add(info.ino); bytes += info.size }
  }
  if (bytes > transferLimits.artifactBytes) unavailable()
  return bytes
}

export class ArtifactReservation {
  readonly outputPath: string
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private active?: Promise<unknown>
  private state: 'reserved' | 'previewing' | 'executing' | 'ready' | 'consuming' | 'delivered' | 'terminal' = 'reserved'
  private cancellation?: Promise<void>
  private cleaned = false
  private archive?: Readonly<ArtifactArchive>
  private evidence?: NativeArtifactIdentity
  private failureOutcome: 'denied-not-sent' | 'upstream-failure' | 'native-outcome-unknown' = 'native-outcome-unknown'

  constructor(readonly scope: TransferScope, readonly directory: string,
    private readonly remove: (entry: ArtifactReservation) => Promise<void>,
    private readonly record: (outcome: z.infer<typeof transferOutcomeSchema>, evidence?: NativeArtifactIdentity, archive?: ArtifactArchive) => void) {
    this.outputPath = join(directory, 'archive')
    this.timer = setTimeout(() => { void this.cancel().catch(() => {}) }, Math.max(0, scope.expiresAt - Date.now()))
    this.timer.unref()
  }

  get terminal(): boolean { return this.state === 'terminal' }

  private alive(): void {
    if (this.scope.expiresAt <= Date.now()) throw new ArtiumError('TOKEN_EXPIRED')
    if (this.controller.signal.aborted) throw new ArtiumError('CANCELLED')
  }

  async preview<T>(native: (output: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.state !== 'reserved') throw new ArtiumError('INVALID_INPUT')
    this.state = 'previewing'
    const disconnect = () => { void this.cancel().catch(() => {}) }
    signal?.addEventListener('abort', disconnect, { once: true })
    const task = Promise.resolve().then(async () => {
      if (signal?.aborted) throw new ArtiumError('CANCELLED')
      this.alive()
      const result = await native(this.outputPath, this.controller.signal)
      this.alive()
      if (await artifactBytes(this.directory) !== 0) unavailable()
      return result
    })
    this.active = task
    try {
      const result = await task
      this.alive()
      this.state = 'reserved'
      return result
    } catch (error) { await this.cancel(); throw error }
    finally { this.active = undefined; signal?.removeEventListener('abort', disconnect) }
  }

  async execute(native: (output: string, signal: AbortSignal) => Promise<NativeArtifactEvidence>,
    signal?: AbortSignal): Promise<Readonly<ArtifactArchive & NativeArtifactEvidence>> {
    if (this.state !== 'reserved') throw new ArtiumError('INVALID_INPUT')
    this.state = 'executing'
    const disconnect = () => { void this.cancel().catch(() => {}) }
    signal?.addEventListener('abort', disconnect, { once: true })
    const task = Promise.resolve().then(async () => {
      if (signal?.aborted) throw new ArtiumError('CANCELLED')
      this.alive()
      if (await artifactBytes(this.directory) !== 0) unavailable()
      const evidence = await native(this.outputPath, this.controller.signal)
      const checkpoint = ['checkpoint-axi', 'beyondtrust-axi'].includes(transferTool(this.scope.selection.operation))
      const boundedMail = transferTool(this.scope.selection.operation) !== 'hybrid-axi'
      if (checkpoint ? evidence.nativeAuditId !== null || evidence.nativeJournalResult !== null || !/^[a-f0-9]{64}$/.test(evidence.verifiedSha256 ?? '')
        : evidence.nativeJournalResult !== 'SUCCESS') unavailable()
      if (boundedMail && !/^[a-f0-9]{64}$/.test(evidence.verifiedSha256 ?? '')) unavailable()
      this.evidence = evidence
      this.alive()
      await artifactBytes(this.directory)
      const file = await open(this.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > (boundedMail ? 50 * 1024 * 1024 : transferLimits.artifactBytes) || info.size !== evidence.archiveBytes) unavailable()
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(64 * 1024)
        let size = 0
        while (true) {
          this.alive()
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
          if (!bytesRead) break
          size += bytesRead
          if (size > transferLimits.artifactBytes) unavailable()
          hash.update(buffer.subarray(0, bytesRead))
        }
        if (size !== info.size || (await file.stat()).size !== size) unavailable()
        this.alive()
        const archiveSha256 = hash.digest('hex')
        if (boundedMail && archiveSha256 !== evidence.verifiedSha256) unavailable()
        const archive = Object.freeze({ ...evidence, archiveBytes: size, archiveSha256 })
        // Synchronous durable audit must succeed before ready state can be observed.
        this.record('ready', evidence, archive)
        this.evidence = evidence
        this.archive = archive
        return archive
      } finally { await file.close() }
    }).catch(error => {
      if (error instanceof ArtifactGenerationFailure) {
        this.failureOutcome = error.outcome
        this.evidence = error.nativeEvidence
        throw error.cause
      }
      throw error
    })
    this.active = task
    try {
      const archive = await task
      this.alive()
      this.state = 'ready'
      return archive
    }
    catch (error) { await this.cancel(); throw error }
    finally { this.active = undefined; signal?.removeEventListener('abort', disconnect) }
  }

  // The authenticated one-shot delivery owns the stream until completion/cancellation.
  async consume<T>(consumer: (path: string, archive: Readonly<ArtifactArchive>, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal): Promise<T> {
    if (this.state !== 'ready') throw new ArtiumError('INVALID_INPUT')
    this.state = 'consuming'
    const disconnect = () => { void this.cancel().catch(() => {}) }
    signal?.addEventListener('abort', disconnect, { once: true })
    const task = Promise.resolve().then(async () => {
      if (signal?.aborted) throw new ArtiumError('CANCELLED')
      this.alive()
      const result = await consumer(this.outputPath, this.archive!, this.controller.signal)
      this.alive()
      this.record('delivery-completed', this.evidence, this.archive)
      this.state = 'delivered'
      return result
    })
    this.active = task
    try { return await task }
    finally {
      this.active = undefined
      signal?.removeEventListener('abort', disconnect)
      await this.cancel()
    }
  }

  cancel(): Promise<void> {
    if (this.cleaned) return Promise.resolve()
    if (this.cancellation) return this.cancellation
    const previous = this.state
    this.state = 'terminal'
    clearTimeout(this.timer)
    this.controller.abort()
    this.cancellation = (async () => {
      await this.active?.catch(() => {})
      try {
        if (this.scope.expiresAt <= Date.now()) this.record('expired', this.evidence, this.archive)
        else if (previous === 'consuming') this.record('delivery-interrupted', this.evidence, this.archive)
        else if (previous === 'previewing') this.record('denied-not-sent')
        else if (previous === 'executing') this.record(this.failureOutcome, this.evidence)
      } finally {
        await this.remove(this)
        this.cleaned = true
      }
      this.record('deleted', this.evidence, this.archive)
    })().finally(() => { this.cancellation = undefined })
    return this.cancellation
  }
}
