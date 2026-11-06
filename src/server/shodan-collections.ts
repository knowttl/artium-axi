import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { shodanScanInput, type shodanStreamStart } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import type { Audit } from './audit/audit.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { shodanOwner, shodanScanBinding, type ShodanOwner } from './policy/shodan-stream.js'
import type { Runner } from './runner/runner.js'
import { collectShodanEvents, inspectShodanScan, shodanMutation } from './shodan-scan-native.js'
import type { registerShodanSessions } from './shodan-sessions.js'
import type { CredentialReference } from './store/credential-store.js'

type Input = z.infer<typeof shodanScanInput>
type StreamInput = z.infer<typeof shodanStreamStart>
type Inspection = Awaited<ReturnType<typeof inspectShodanScan>>
type Sessions = ReturnType<typeof registerShodanSessions>
interface Plan { id: string, owner: ShodanOwner, credential: CredentialReference, input: Input, inspection: Inspection,
  binding: string, operations: string[], streamOperation?: string, expiresAt: number, timer: NodeJS.Timeout }
interface Collection extends Omit<Plan, 'timer'> { state: 'running' | 'completed' | 'partial', controller: AbortController,
  result?: Record<string, unknown>, job: Promise<void>, timer: NodeJS.Timeout, sessionId?: string, changed: EventEmitter }

export function registerShodanCollections(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: Adapter<unknown>, runner: Runner, audit: Audit, sessions: Sessions) {
  const prefix = '/v1/tools/shodan-axi/scan-collections', root = join(dirname(db.name), 'tool-logs', 'shodan-axi', 'collections')
  const plans = new Map<string, Plan>(), collections = new Map<string, Collection>()
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(root)) if (name.startsWith('scan-')) await rm(join(root, name), { recursive: true, force: true })
  })()
  app.addHook('onReady', () => initialized)
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const authorize = (plan: Pick<Plan, 'owner' | 'credential' | 'binding' | 'operations' | 'streamOperation'>) => {
    if (shodanScanBinding(db, plan.owner, plan.credential, plan.operations, plan.streamOperation).hash !== plan.binding) throw new ArtiumError('REVISION_CONFLICT')
  }
  const streamInput = (input: Input, alertId?: string): StreamInput => ({ operation: 'OP-053',
    selector: { flag: '--alert', value: alertId ?? 'pending' },
    bounds: { limit: input.limit, maxBytes: input.maxBytes, timeout: input.waitSeconds * 1000, idleTimeout: input.idleTimeout },
    limits: { events: input.limit, bytes: input.maxBytes, leaseSeconds: input.waitSeconds }, acceptUnknownCost: true })

  app.post(prefix + '/preview', async request => {
    const owner = shodanOwner(db, request), input = parse(shodanScanInput, request.body)
    const inspection = await inspectShodanScan(input)
    const collecting = input.waitSeconds > 0
    if (collecting && !input.acceptUnknownCost || input.destinationDigest && !collecting
      || collecting && (input.queryCreditBudget < 8 || input.maxRequests < 10)) throw new ArtiumError('INVALID_INPUT')
    const operations = collecting ? ['OP-013', inspection.operation, 'OP-015'] : [inspection.operation]
    const streamOperation = collecting ? 'OP-053' : undefined
    const credential = await resolver.resolve(owner.user, 'shodan-axi')
    const binding = shodanScanBinding(db, owner, credential, operations, streamOperation)
    if (input.scanCreditBudget > binding.settings.maxScanCredits || input.queryCreditBudget > binding.settings.maxQueryCredits
      || input.maxRequests > binding.settings.maxRequests) throw new ArtiumError('INVALID_INPUT')
    if (plans.size >= 128 || [...plans.values()].filter(plan => plan.owner.user === owner.user).length >= 8) throw new ArtiumError('TOO_MANY_CALLS')
    await initialized
    const id = randomUUID(), plan: Plan = { id, owner, credential, input, inspection, binding: binding.hash, operations, streamOperation,
      expiresAt: Date.now() + 15 * 60 * 1000, timer: setTimeout(() => {}, 0) }
    clearTimeout(plan.timer)
    plan.timer = setTimeout(() => plans.delete(id), 15 * 60 * 1000).unref()
    plans.set(id, plan)
    return { confirm: id, operations: collecting ? ['OP-013', 'OP-053', inspection.operation, 'OP-015'] : operations,
      scope: input.scope, bounds: { waitSeconds: input.waitSeconds, limit: input.limit, maxBytes: input.maxBytes, idleTimeout: input.idleTimeout },
      scanCreditBudget: input.scanCreditBudget, queryCreditBudget: input.queryCreditBudget, maxRequests: input.maxRequests,
      ...(input.destinationDigest ? { destinationDigest: input.destinationDigest } : {}),
      cost: 'unknown', expiresAt: plan.expiresAt }
  })

  app.post(prefix + '/start', async request => {
    const owner = shodanOwner(db, request), body = parse(shodanScanInput.extend({ confirm: z.uuid() }), request.body), plan = plans.get(body.confirm)
    if (!plan || plan.owner.user !== owner.user || plan.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    plans.delete(plan.id); clearTimeout(plan.timer)
    const { confirm: _confirm, ...input } = body
    if (plan.expiresAt <= Date.now() || JSON.stringify(input) !== JSON.stringify(plan.input)) throw new ArtiumError('INVALID_INPUT')
    authorize(plan)
    const stream = input.waitSeconds ? streamInput(input) : undefined
    const reservation = stream ? sessions.reserve(owner, plan.credential, plan.streamOperation!, stream) : undefined
    const retentionMs = (reservation?.limits.retentionSeconds ?? 900) * 1000
    const controller = new AbortController(), directory = join(root, `scan-${plan.id}`)
    const collection: Collection = { ...plan, state: 'running', controller, job: Promise.resolve(), timer: setTimeout(() => {}, 0), changed: new EventEmitter() }
    clearTimeout(collection.timer)
    try {
      audit.record({ event: 'run-start', userId: owner.user, tool: 'shodan-axi', requestId: plan.id, clientAddress: request.ip,
        outcome: 'started', args: ['scan', 'collection', ...plan.operations], sensitive: { positions: [], flags: [] } })
    } catch (error) { if (reservation) sessions.release(reservation); throw error }
    collections.set(plan.id, collection)
    const startedAt = Date.now()
    collection.job = (async () => {
      let alertId: string | undefined, sessionId: string | undefined, scanId: string | undefined
      let cleanup = stream ? 'not-created' : 'not-required'
      let failure: string | undefined, events: unknown[] = [], lost: unknown[] = [], upstreamLoss: Record<string, number> = {}
      let streamResult: Record<string, unknown> | undefined
      let duplicates = 0, outOfScope = 0, reserved = reservation
      const check = () => { if (controller.signal.aborted) throw new ArtiumError('CANCELLED'); authorize(plan) }
      const mutate = async (words: string[], operation: string, budget: number, scan: boolean, extra: string[] = []) => {
        const checkMutation = () => {
          check()
          if (scan && sessionId) sessions.assertRunning(owner, sessionId)
        }
        checkMutation()
        const requestId = randomUUID(), began = Date.now()
        audit.record({ event: 'run-start', userId: owner.user, tool: 'shodan-axi', requestId, clientAddress: request.ip,
          outcome: 'started', args: ['scan-action', operation], sensitive: { positions: [], flags: [] } })
        try {
          const result = await runner.runManaged(owner.user, controller.signal, signal => shodanMutation(directory, adapter, plan.credential,
            words, operation, budget, scan, signal, checkMutation, extra, runner.configuredCaPem))
          const completed = ['submitted', 'completed'].includes(result.status)
          audit.record({ event: 'run-terminal', userId: owner.user, tool: 'shodan-axi', requestId, clientAddress: request.ip,
            outcome: completed ? 'completed' : 'interrupted', action: completed ? 'write' : 'unknown', exitCode: completed ? 0 : null,
            durationMs: Date.now() - began, outputBytes: { stdout: null, stderr: null } })
          return result
        } catch (error) {
          audit.record({ event: 'run-terminal', userId: owner.user, tool: 'shodan-axi', requestId, clientAddress: request.ip,
            outcome: 'interrupted', action: 'unknown', exitCode: null, durationMs: Date.now() - began, outputBytes: { stdout: null, stderr: null } })
          throw error
        }
      }
      try {
        check()
        if (stream) {
          cleanup = 'unknown'
          const result = await mutate(['alert', 'create', `scan-${plan.id}`, plan.inspection.targets.join(',')], 'OP-013', 1, false)
          alertId = result.steps?.[0]?.id
          if (result.status !== 'completed' || !alertId) throw new ArtiumError('UNKNOWN_OUTCOME')
        }
        if (stream) {
          const selection = streamInput(input, alertId)
          const preview = await sessions.preview(owner, selection, reserved)
          reserved = undefined
          check()
          const started = await sessions.start(owner, { ...selection, confirm: preview.confirm }, request.ip)
          sessionId = started.id; collection.sessionId = sessionId
          await sessions.waitReady(owner, sessionId)
          check()
        }
        const result = await mutate(plan.inspection.words, plan.inspection.operation, input.scanCreditBudget, true,
          input.scope.force ? ['--force'] : [])
        if (result.status !== 'submitted' || !result.scanId) throw new ArtiumError('UNKNOWN_OUTCOME')
        scanId = result.scanId
        if (sessionId) await sessions.waitFinished(owner, sessionId)
      } catch { failure = 'OUTCOME_UNKNOWN' }
      finally {
        if (sessionId) {
          try { streamResult = await sessions.stop(owner, sessionId) }
          catch { failure ??= 'OUTCOME_UNKNOWN' }
        }
        if (reserved) sessions.release(reserved)
        if (alertId) {
          try {
            check()
            const result = await mutate(['alert', 'remove', alertId], 'OP-015', 1, false)
            cleanup = result.status === 'completed' ? 'completed' : 'failed'
          } catch { cleanup = 'failed' }
        }
        if (sessionId) {
          try {
            let continuation: string | undefined
            for (;;) {
              const batch = sessions.read(owner, sessionId, continuation, 1000)
              continuation = batch.continuation
              events.push(...batch.items.map(item => item.value)); lost.push(...batch.lost); upstreamLoss = batch.upstreamLoss
              if (!batch.hasMore) {
                if (!batch.complete) failure ??= 'OUTCOME_UNKNOWN'
                break
              }
            }
            const scope = { kind: 'targets' as const, networks: plan.inspection.targets }
            const collected = await collectShodanEvents(scope, events)
            events = collected.events; duplicates = collected.duplicates; outOfScope = collected.outOfScope
          } catch { failure ??= 'OUTCOME_UNKNOWN' }
        }
        try { await rm(directory, { recursive: true, force: true }) }
        catch { failure ??= 'OUTCOME_UNKNOWN' }
        collection.state = failure || cleanup === 'failed' || cleanup === 'unknown' ? 'partial' : 'completed'
        collection.result = { status: collection.state, ...(failure ? { error: failure } : {}), ...(scanId ? { scanId } : {}),
          vendorCompletion: 'unknown', vendorCancellation: 'not-requested', events, duplicates, outOfScope, lost, upstreamLoss,
          ...(streamResult ? { stream: streamResult } : {}),
          cleanup, ...(cleanup === 'failed' && alertId ? { cleanupAlertId: alertId } : {}),
          attribution: 'Matching stream records are not proof of scan ownership' }
        collection.changed.emit('change')
        const retainedUntil = typeof streamResult?.retainedUntil === 'number' ? streamResult.retainedUntil : Date.now() + retentionMs
        collection.timer = setTimeout(() => { collection.result = undefined; collections.delete(plan.id) }, Math.max(0, retainedUntil - Date.now())).unref()
        audit.record({ event: 'run-terminal', userId: owner.user, tool: 'shodan-axi', requestId: plan.id, clientAddress: request.ip,
          outcome: collection.state === 'completed' ? 'completed' : 'interrupted', action: collection.state === 'completed' ? 'write' : 'unknown',
          exitCode: collection.state === 'completed' ? 0 : null, durationMs: Date.now() - startedAt, outputBytes: { stdout: null, stderr: null } })
      }
    })()
    return { id: plan.id, state: collection.state }
  })
  app.get<{ Params: { id: string }, Querystring: { waitMs?: string } }>(prefix + '/:id', async request => {
    const owner = shodanOwner(db, request), collection = collections.get(request.params.id)
    if (!collection || collection.owner.user !== owner.user || collection.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    authorize(collection)
    const wait = request.query.waitMs === undefined ? 0 : Number(request.query.waitMs)
    if (!Number.isSafeInteger(wait) || wait < 0 || wait > 30000) throw new ArtiumError('INVALID_INPUT')
    if (wait && collection.state === 'running') await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); collection.changed.removeListener('change', done); resolve() }
      const timer = setTimeout(done, wait); collection.changed.once('change', done)
    })
    authorize(collection)
    return { id: collection.id, state: collection.state, ...(collection.result ? { result: collection.result } : {}) }
  })
  const reconcile = async () => {
    for (const plan of plans.values()) try { authorize(plan) } catch { clearTimeout(plan.timer); plans.delete(plan.id) }
    await Promise.all([...collections.values()].map(async collection => {
      try { authorize(collection) } catch {
        collection.controller.abort()
        if (collection.sessionId) await sessions.stop(collection.owner, collection.sessionId).catch(() => {})
        await collection.job; clearTimeout(collection.timer); collection.result = undefined; collections.delete(collection.id)
      }
    }))
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000).unref()
  app.addHook('onSend', reconcile)
  sessions.onShutdown(async () => {
    clearInterval(monitor)
    for (const plan of plans.values()) clearTimeout(plan.timer)
    plans.clear()
    await Promise.all([...collections.values()].map(async collection => {
      collection.controller.abort()
      if (collection.sessionId) await sessions.stop(collection.owner, collection.sessionId).catch(() => {})
      await collection.job; clearTimeout(collection.timer); collection.result = undefined
    }))
    collections.clear()
  })
}
