import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { transferExecuteSchema, transferPrepareRequestSchema, transferReceiptSchema, transferRetrieveSchema,
  transferRoutesFor, transferStatusSchema, transferWarningFor, transferTool } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { ArtifactStore } from './artifacts.js'
import type { ArtifactArchive, ArtifactReservation } from './artifacts.js'
import type { Audit } from './audit/audit.js'
import { hashToken, requireRecentAuth, verifyPrincipal } from './auth/tokens.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { checkToolPolicy } from './policy/policy.js'
import type { CredentialReference } from './store/credential-store.js'
import { previewNativeArtifact, executeNativeArtifact } from './runner/artifact.js'
import type { Runner } from './runner/runner.js'
import { readCredentialTrust } from './store/trusted-certificates.js'
import { checkTransferAccess, checkTransferScope, createTransferScope, transferAuditSelector } from './transfer.js'
import type { TransferOwner } from './transfer.js'

interface Entry {
  reservation: ArtifactReservation
  credential: CredentialReference
  identity: { credentialId: string, instance: string }
  confirm?: string
  archive?: ArtifactArchive
  executing: boolean
  delivered: boolean
  receipt: boolean
  delivery?: Promise<unknown>
  timer: ReturnType<typeof setTimeout>
}

export function registerTransfers(app: FastifyInstance, db: Database.Database, audit: Audit, runner: Runner,
  resolver: IdentityResolver, adapters: readonly Adapter<unknown>[], providedStore?: ArtifactStore) {
  const entries = new Map<string, Entry>()
  const admitted = new WeakMap<FastifyRequest, { credentialId: string, instance: string }>()
  let store: Promise<ArtifactStore> | undefined = providedStore ? Promise.resolve(providedStore) : undefined
  audit.recoverInterruptedTransfers()
  app.addHook('onReady', async () => {
    if (store || !adapters.some(adapter => adapter.prepareArtifact)) return
    // Purge stale bytes before serving, even with writes off.
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
    const principal = verifyPrincipal(db, token)
    if (!principal.delegation) {
      const ticket = request.headers['x-artium-reauth-ticket']
      requireRecentAuth(db, token, typeof ticket === 'string' ? ticket : '')
    }
    // Undelegated proof is checked above; delegated access is checked against
    // the selected operation by the common access check.
    return { userId: principal.userId, sessionFamilyId: principal.familyId, reauthenticatedAt: Date.now() }
  }
  function revision(credential: CredentialReference): number {
    const row = db.prepare('SELECT revision FROM credentials WHERE tool = ? AND id = ?').get(credential.tool, credential.id) as { revision: number } | undefined
    if (!row) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return row.revision
  }
  function access(entry: Entry) {
    const scope = entry.reservation.scope
    checkTransferAccess(db, { userId: scope.userId, sessionFamilyId: scope.sessionFamilyId,
      reauthenticatedAt: Date.now() }, scope.selection.operation)
    checkToolPolicy(db, scope.userId, entry.credential.tool, entry.credential.id)
    if (entry.executing && (db.prepare('SELECT read_only FROM credentials WHERE id = ? AND tool = ?').get(entry.credential.id, entry.credential.tool) as { read_only: number } | undefined)?.read_only) throw new ArtiumError('FLAG_BLOCKED')
    if (revision(entry.credential) !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
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
    if (!entry || identity?.user_id !== entry.reservation.scope.userId || identity.family_id !== entry.reservation.scope.sessionFamilyId) {
      verifyPrincipal(db, tokenFor(request))
      throw new ArtiumError('TOKEN_INVALID')
    }
    const scope = entry.reservation.scope
    admitted.set(request, entry.identity)
    try { checkTransferScope(scope, ownerFor(request), revision(entry.credential), { selection: input.selection, targetDigest: input.targetDigest }); access(entry) }
    catch (error) { await discard(entry); throw error }
    return entry
  }
  async function native(entry: Entry) {
    const tool = transferTool(entry.reservation.scope.selection.operation)
    const adapter = adapters.find(adapter => adapter.name === tool)
    if (!adapter?.prepareArtifact) throw new ArtiumError('FLAG_BLOCKED')
    const instance = db.prepare('SELECT name FROM credentials WHERE tool = ? AND id = ?').get(tool, entry.credential.id) as { name: string } | undefined
    if (!instance) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    const reference = await resolver.resolve(entry.reservation.scope.userId, tool, instance.name)
    if (reference.id !== entry.reservation.scope.credentialId
      || reference.revision !== entry.reservation.scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
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
    if ((['hybrid-axi', 'checkpoint-axi', 'mg-axi', 'beyondtrust-axi', 'gitea-axi'] as const).some(tool => request.routeOptions.url === transferRoutesFor(tool).retrieve.path)) return payload
    for (const entry of entries.values()) {
      try { access(entry) }
      catch { await discard(entry) }
    }
    return payload
  })
  const routeGroups = (['hybrid-axi', 'checkpoint-axi', 'mg-axi', 'beyondtrust-axi', 'gitea-axi'] as const).flatMap(tool => {
    const routes = transferRoutesFor(tool)
    return Object.values(routes).map(route => ({ tool, routes, route }))
  })
  for (const { tool, routes: transferRoutes, route } of routeGroups) {
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
        if (transferTool(parsed.data.selection.operation) !== tool) throw new ArtiumError('INVALID_INPUT')
        if (route === transferRoutes.prepare) {
          const { instance, ...input } = transferPrepareRequestSchema.parse(parsed.data)
          const owner = ownerFor(request)
          checkTransferAccess(db, owner, input.selection.operation)
          const credential = await resolver.resolve(owner.userId, tool, instance, verifyPrincipal(db, tokenFor(request)).delegation)
          checkToolPolicy(db, owner.userId, tool, credential.id)
          const identity = { credentialId: credential.id,
            instance: (db.prepare('SELECT name FROM credentials WHERE id = ?').get(credential.id) as { name: string }).name }
          admitted.set(request, identity)
          const scope = createTransferScope(owner, { id: credential.id, revision: revision(credential) }, input)
          store ??= ArtifactStore.create(audit).catch(error => { store = undefined; throw error })
          const reservation = await (await store).reserve(scope, { ...context(request, controller.signal), delegationId: verifyPrincipal(db, tokenFor(request)).delegation?.id })
          entry = { reservation, credential, identity, executing: false, delivered: false, receipt: false,
            timer: setTimeout(() => { void discard(entry!).catch(() => {}) }, Math.max(0, scope.expiresAt - Date.now())) }
          entry.timer.unref()
          entries.set(scope.transferId, entry)
          const prepared = await native(entry)
          const current = entry
          const preview = await previewNativeArtifact(reservation, runner, prepared, () => { ownerFor(request); access(current) }, context(request, controller.signal))
          entry.confirm = preview.confirm
          return { ...preview, warnings: [...new Set([transferWarningFor(scope.selection.operation), ...preview.warnings])] }
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
          entry.executing = true
          access(entry)
          const prepare = await native(entry)
          const current = entry
          const archive = await executeNativeArtifact(entry.reservation, runner, prepare, execute.confirm,
            () => { ownerFor(request); access(current) }, context(request, controller.signal))
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
          audit.record({ event: 'transfer', userId: scope.userId, delegationId: verifyPrincipal(db, tokenFor(request)).delegation?.id, tool, requestId: request.id,
            clientAddress: request.ip, credentialRevision: scope.credentialRevision, outcome: 'delivery-completed',
            transfer: { transfer_id: scope.transferId, session_family_id: scope.sessionFamilyId,
              transfer_operation: scope.selection.operation, artifact_type: scope.selection.type,
              artifact_selector: transferAuditSelector(scope), requested_target_digest: scope.targetDigest,
              archive_bytes: entry.archive.archiveBytes, archive_sha256: entry.archive.archiveSha256,
              native_audit_id: prior.native_audit_id as string | null, native_journal_result: prior.native_journal_result as 'SUCCESS' | null,
              client_save_outcome: receipt.saveOutcome } })
          entry.receipt = true
          await discard(entry)
          return reply.code(204).send()
        }
        if (request.headers.range || request.headers['if-range'] || request.headers['accept-encoding'] && request.headers['accept-encoding'] !== 'identity') {
          throw new ArtiumError('INVALID_INPUT')
        }
        if (entry.delivery) { await entry.delivery; throw new ArtiumError('INVALID_INPUT') }
        const delivering = entry
        entry.delivery = entry.reservation.consume(async (path, archive, signal) => {
          ownerFor(request); access(delivering)
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
                ownerFor(request); access(delivering)
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
          let principal: ReturnType<typeof verifyPrincipal> | undefined
          try { principal = verifyPrincipal(db, tokenFor(request)) } catch { /* Unauthenticated denials retain no actor. */ }
          const transferId = request.body && typeof request.body === 'object' && 'transferId' in request.body && typeof request.body.transferId === 'string' ? request.body.transferId : undefined
          const owned = transferId ? entries.get(transferId) : undefined
          const scope = owned?.reservation.scope
          const candidates = principal && route === transferRoutes.prepare
            ? db.prepare('SELECT id, name FROM credentials WHERE tool = ? AND enabled = 1 LIMIT 2').all(tool) as { id: string, name: string }[] : []
          const identity = admitted.get(request) ?? (scope && transferTool(scope.selection.operation) === tool && principal?.userId === scope.userId && principal.familyId === scope.sessionFamilyId
            ? owned?.identity : candidates.length === 1 ? { credentialId: candidates[0]!.id, instance: candidates[0]!.name } : undefined)
          audit.record({ ...identity, event: 'denial', userId: principal?.userId ?? null, delegationId: principal?.delegation?.id, tool, requestId: request.id,
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
