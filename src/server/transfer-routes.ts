import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { transferExecuteSchema, transferPrepareSchema, transferReceiptSchema, transferRetrieveSchema,
  transferRoutes, transferStatusSchema, transferWarning } from '../shared/api.js'
import { transferSelectionSchema } from '../shared/api.js'
import type { TransferScope } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { hybridWritePolicy } from './adapters/hybrid.js'
import { ArtifactStore } from './artifacts.js'
import type { ArtifactArchive, ArtifactReservation } from './artifacts.js'
import type { Audit } from './audit/audit.js'
import { hashToken, requireRecentAuth, verifyAccessToken } from './auth/tokens.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { previewNativeArtifact, executeNativeArtifact } from './runner/artifact.js'
import type { Runner } from './runner/runner.js'
import { readCredentialTrust } from './store/trusted-certificates.js'
import { checkTransferAccess, checkTransferScope, createTransferScope } from './transfer.js'
import type { TransferOwner } from './transfer.js'

interface Entry {
  reservation: ArtifactReservation
  confirm?: string
  archive?: ArtifactArchive
  delivered: boolean
  receipt: boolean
  delivery?: Promise<unknown>
  timer: ReturnType<typeof setTimeout>
}

export function registerTransfers(app: FastifyInstance, db: Database.Database, audit: Audit, runner: Runner,
  resolver: IdentityResolver, adapter: Adapter<unknown> | undefined, providedStore?: ArtifactStore) {
  const entries = new Map<string, Entry>()
  let store: Promise<ArtifactStore> | undefined = providedStore ? Promise.resolve(providedStore) : undefined
  audit.recoverInterruptedTransfers()
  app.addHook('onReady', async () => {
    if (store || !adapter?.prepareArtifact) return
    const tool = db.prepare("SELECT native_settings FROM tools WHERE name = 'hybrid-axi'").get() as { native_settings: string } | undefined
    const supported = tool ? hybridWritePolicy.read(JSON.parse(tool.native_settings)).supportedOperations : null
    // Purge stale bytes before serving, even with writes off.
    if (!transferSelectionSchema.options.some(selection => supported?.includes(selection.shape.operation.value))) return
    store = ArtifactStore.create(audit)
    try { await store }
    catch (error) {
      store = undefined
      if (!(error instanceof ArtiumError) || error.code !== 'TEMP_UNAVAILABLE') throw error
    }
  })
  const tokenFor = (request: FastifyRequest) => /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  function ownerFor(request: FastifyRequest): TransferOwner {
    const token = tokenFor(request)
    const userId = verifyAccessToken(db, token)
    const ticket = request.headers['x-artium-reauth-ticket']
    requireRecentAuth(db, token, typeof ticket === 'string' ? ticket : '')
    const family = db.prepare('SELECT family_id FROM tokens WHERE hash = ?').get(hashToken(token)) as { family_id: string }
    // The proof was verified above, including its bounded lifetime. This value is
    // only used by the common access check; it is never a replacement for proof.
    return { userId, sessionFamilyId: family.family_id, reauthenticatedAt: Date.now() }
  }
  function revision(): number {
    const row = db.prepare("SELECT revision FROM credentials WHERE tool = 'hybrid-axi'").get() as { revision: number } | undefined
    if (!row) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return row.revision
  }
  function access(scope: TransferScope) {
    checkTransferAccess(db, { userId: scope.userId, sessionFamilyId: scope.sessionFamilyId,
      reauthenticatedAt: Date.now() }, scope.selection.operation)
    if (revision() !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
    if (scope.expiresAt <= Date.now()) throw new ArtiumError('TOKEN_EXPIRED')
  }
  async function discard(entry: Entry) {
    clearTimeout(entry.timer)
    entries.delete(entry.reservation.scope.transferId)
    await entry.reservation.cancel()
  }
  async function selected(request: FastifyRequest, input: { transferId: string } & Parameters<typeof checkTransferScope>[3]) {
    const identity = db.prepare('SELECT user_id, family_id FROM tokens WHERE hash = ?').get(hashToken(tokenFor(request))) as
      { user_id: string, family_id: string } | undefined
    const entry = entries.get(input.transferId)
    if (!entry) throw new ArtiumError('TOKEN_INVALID')
    const scope = entry.reservation.scope
    // An unrelated caller must not be able to cancel the owner's transfer.
    if (identity?.user_id !== scope.userId || identity.family_id !== scope.sessionFamilyId) throw new ArtiumError('TOKEN_INVALID')
    try { checkTransferScope(scope, ownerFor(request), revision(), { selection: input.selection, targetDigest: input.targetDigest }); access(scope) }
    catch (error) { await discard(entry); throw error }
    return entry
  }
  async function native(entry: Entry) {
    if (!adapter?.prepareArtifact) throw new ArtiumError('FLAG_BLOCKED')
    const reference = await resolver.resolve(entry.reservation.scope.userId, 'hybrid-axi')
    if (reference.revision !== entry.reservation.scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
    return async (args: string[]) => {
      const prepared = await adapter.prepareArtifact!(args, reference, entry.reservation.scope)
      return { ...prepared, limits: { ...prepared.limits, credentialTrust: readCredentialTrust(db, reference) } }
    }
  }
  const context = (request: FastifyRequest, signal: AbortSignal) => ({ requestId: request.id, clientAddress: request.ip, signal })
  // Every application mutation is followed by synchronous authority rechecks
  // before its response. Active child/stream cancellation is awaited as well.
  app.addHook('onSend', async (request, _reply, payload) => {
    // Retrieval has already claimed the entry and checks authority while reading.
    // A revoking mutation's response still waits for cancellation below.
    if (request.routeOptions.url === transferRoutes.retrieve.path) return payload
    for (const entry of entries.values()) {
      try { access(entry.reservation.scope) }
      catch { await discard(entry) }
    }
    return payload
  })
  for (const route of Object.values(transferRoutes)) {
    app.post(route.path, async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const controller = new AbortController()
      let entry: Entry | undefined
      const disconnect = () => {
        if (!reply.raw.writableFinished) {
          controller.abort()
          if (entry && !entry.delivered) void discard(entry).catch(() => {})
        }
      }
      reply.raw.once('close', disconnect)
      reply.raw.once('finish', () => reply.raw.off('close', disconnect))
      try {
        const parsed = route.input.safeParse(request.body)
        if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
        if (route === transferRoutes.prepare) {
          const input = transferPrepareSchema.parse(parsed.data)
          const owner = ownerFor(request)
          checkTransferAccess(db, owner, input.selection.operation)
          const scope = createTransferScope(owner, revision(), input)
          store ??= ArtifactStore.create(audit).catch(error => { store = undefined; throw error })
          const reservation = await (await store).reserve(scope, context(request, controller.signal))
          entry = { reservation, delivered: false, receipt: false,
            timer: setTimeout(() => { void discard(entry!).catch(() => {}) }, Math.max(0, scope.expiresAt - Date.now())) }
          entry.timer.unref()
          entries.set(scope.transferId, entry)
          const prepared = await native(entry)
          const preview = await previewNativeArtifact(reservation, runner, prepared, () => { ownerFor(request); access(scope) }, context(request, controller.signal))
          entry.confirm = preview.confirm
          return { ...preview, warnings: [...new Set([transferWarning, ...preview.warnings])] }
        }
        if (!('transferId' in parsed.data)) throw new ArtiumError('INVALID_INPUT')
        const input = transferRetrieveSchema.parse({ transferId: parsed.data.transferId,
          selection: parsed.data.selection, targetDigest: parsed.data.targetDigest })
        entry = await selected(request, input)
        const scope = entry.reservation.scope
        if (route === transferRoutes.status) {
          await entry.delivery
          return transferStatusSchema.parse({ transferId: scope.transferId,
          expiresAt: scope.expiresAt, outcome: entry.delivered ? 'delivery-completed' : entry.archive ? 'ready' : 'preview',
          archive: entry.archive ?? null, saveOutcome: 'unconfirmed' })
        }
        if (route === transferRoutes.cancel) { await discard(entry); return reply.code(204).send() }
        if (route === transferRoutes.execute) {
          const execute = transferExecuteSchema.parse(parsed.data)
          if (execute.confirm !== entry.confirm) throw new ArtiumError('INVALID_INPUT')
          const prepare = await native(entry)
          const archive = await executeNativeArtifact(entry.reservation, runner, prepare, execute.confirm,
            () => { ownerFor(request); access(scope) }, context(request, controller.signal))
          entry.archive = { archiveBytes: archive.archiveBytes, archiveSha256: archive.archiveSha256 }
          return transferStatusSchema.parse({ transferId: scope.transferId, expiresAt: scope.expiresAt,
            outcome: 'ready', archive: entry.archive, saveOutcome: 'unconfirmed' })
        }
        if (route === transferRoutes.receipt) {
          const receipt = transferReceiptSchema.parse(parsed.data)
          await entry.delivery
          if (!entry.delivered || entry.receipt || !entry.archive
            || receipt.archive.archiveBytes !== entry.archive.archiveBytes
            || receipt.archive.archiveSha256 !== entry.archive.archiveSha256) throw new ArtiumError('INVALID_INPUT')
          const prior = db.prepare("SELECT * FROM audit WHERE transfer_id = ? AND outcome = 'delivery-completed' ORDER BY id DESC LIMIT 1")
            .get(scope.transferId) as Record<string, unknown>
          audit.record({ event: 'transfer', userId: scope.userId, tool: 'hybrid-axi', requestId: request.id,
            clientAddress: request.ip, credentialRevision: scope.credentialRevision, outcome: 'delivery-completed',
            transfer: { transfer_id: scope.transferId, session_family_id: scope.sessionFamilyId,
              transfer_operation: scope.selection.operation, artifact_type: scope.selection.type,
              artifact_selector: scope.selection.selector, requested_target_digest: scope.targetDigest,
              archive_bytes: entry.archive.archiveBytes, archive_sha256: entry.archive.archiveSha256,
              native_audit_id: prior.native_audit_id as string, native_journal_result: 'SUCCESS', client_save_outcome: receipt.saveOutcome } })
          entry.receipt = true
          await discard(entry)
          return reply.code(204).send()
        }
        if (request.headers.range || request.headers['if-range'] || request.headers['accept-encoding'] && request.headers['accept-encoding'] !== 'identity') {
          throw new ArtiumError('INVALID_INPUT')
        }
        const delivering = entry
        entry.delivery = entry.reservation.consume(async (path, archive, signal) => {
          ownerFor(request); access(scope)
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const info = await file.stat()
            if (!info.isFile() || info.size !== archive.archiveBytes) throw new ArtiumError('INVALID_RESPONSE')
            reply.headers({ 'content-type': 'application/octet-stream',
              'content-disposition': 'attachment; filename="artium-archive.bin"',
              'content-length': archive.archiveBytes, 'x-artium-archive-sha256': archive.archiveSha256,
              'x-content-type-options': 'nosniff', 'cache-control': 'no-store, no-transform' })
            let bytes = 0
            const source = Readable.from((async function* () {
              for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
                ownerFor(request); access(scope)
                bytes += chunk.length
                yield chunk
              }
            })(), { objectMode: false, highWaterMark: 64 * 1024, signal })
            const completion = finished(reply.raw, { cleanup: true, signal })
            reply.send(source)
            try {
              await completion
              if (reply.raw.statusCode !== 200 || bytes !== archive.archiveBytes) throw new ArtiumError('CANCELLED')
            } finally { source.destroy() }
          } finally { await file.close() }
        }, controller.signal).then(() => { delivering.delivered = true })
        await entry.delivery
        return reply
      } catch (error) {
        if (entry && !entry.delivered) await discard(entry)
        if (reply.raw.headersSent) { reply.raw.destroy(); return reply }
        if (error instanceof ArtiumError && !reply.raw.headersSent) {
          let userId: string | null = null
          try { userId = verifyAccessToken(db, tokenFor(request)) } catch { /* Unauthenticated denials retain no actor. */ }
          audit.record({ event: 'denial', userId, tool: 'hybrid-axi', requestId: request.id,
            clientAddress: request.ip, outcome: error.code })
        }
        throw error
      }
    })
  }
  app.addHook('preClose', async () => {
    await Promise.all([...entries.values()].map(discard))
    await (await store)?.shutdown()
  })
}
