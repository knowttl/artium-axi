import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { shodanStreamConfirm, shodanStreamExtendPreview, shodanStreamRead, shodanStreamStart } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import type { Audit } from './audit/audit.js'
import { inspectShodanStream } from './adapters/shodan-stream.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { log } from './log.js'
import { shodanBinding, shodanOwner, type ShodanOwner } from './policy/shodan-stream.js'
import type { CredentialReference } from './store/credential-store.js'
import type { Runner } from './runner/runner.js'
import { ShodanCapacity } from './shodan-capacity.js'
import { shodanNativePreview } from './shodan-preview.js'
import { ShodanSpool } from './shodan-spool.js'
import { ShodanWorker } from './shodan-worker.js'

type Input = z.infer<typeof shodanStreamStart>
type Limits = ReturnType<ShodanCapacity['reserve']>
interface Plan { id: string, owner: ShodanOwner, credential: CredentialReference, binding: string, input: Input,
  limits: Limits, directory: string, nativeToken: string, expiresAt: number, timer: NodeJS.Timeout }
interface Pending extends Pick<Plan, 'owner' | 'credential' | 'binding' | 'input'> { controller: AbortController, job: Promise<unknown> }
interface Session extends Omit<Plan, 'nativeToken' | 'timer'> {
  state: 'starting' | 'running' | 'stopping' | 'closed' | 'failed' | 'expired',
  controller: AbortController, spool: ShodanSpool, timer: NodeJS.Timeout, job: Promise<void>,
  changed: EventEmitter,
  retainedUntil?: number,
  cleaning?: Promise<void>, stopping?: Promise<void>, discard?: boolean,
  summary?: { stopReason: string, count: number, bytes: number, partialRecordCount: number, debugDiscarded: number, error?: string },
  worker?: ShodanWorker, cleaned: boolean, extending?: boolean, extension?: { confirm: string, deadline: number, previous: number, expiresAt: number },
}

export function registerShodanSessions(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: Adapter<unknown>, runner: Runner, audit: Audit) {
  const root = join(dirname(db.name), 'tool-logs', 'shodan-axi', 'sessions')
  const plans = new Map<string, Plan>(), sessions = new Map<string, Session>(), pending = new Map<string, Pending>(), capacity = new ShodanCapacity()
  const prefix = '/v1/tools/shodan-axi/sessions'
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(root)) if (name.startsWith('session-')) await rm(join(root, name), { recursive: true, force: true })
  })()
  app.addHook('onReady', () => initialized)
  const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const result = schema.safeParse(input)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const authorize = (session: Pick<Plan, 'owner' | 'credential' | 'binding' | 'input'>) => {
    if (shodanBinding(db, session.owner, session.credential, session.input.operation).hash !== session.binding) throw new ArtiumError('REVISION_CONFLICT')
  }
  const discardPlan = async (plan: Plan) => {
    plans.delete(plan.id); clearTimeout(plan.timer); capacity.release(plan.id)
    await rm(plan.directory, { recursive: true, force: true })
  }
  const clear = (session: Session) => {
    clearTimeout(session.timer); session.spool.clear(); sessions.delete(session.id); capacity.release(session.id)
  }
  const finish = (session: Session, state: 'closed' | 'failed' | 'expired') => {
    // stop() publishes its terminal state before cleanup wakes waiters.
    if (session.state === 'stopping') return
    return session.cleaning ??= (async () => {
      clearTimeout(session.timer)
      session.worker = undefined
      session.state = state
      await rm(session.directory, { recursive: true, force: true })
      session.cleaned = true; capacity.stopped(session.id)
      session.retainedUntil = Date.now() + session.limits.retentionSeconds * 1000
      session.timer = setTimeout(() => clear(session), session.limits.retentionSeconds * 1000).unref()
      session.changed.emit('change'); session.changed.emit('closed')
    })()
  }
  const stop = async (session: Session, state: 'closed' | 'failed' | 'expired', discard = false) => {
    session.discard ||= discard
    if (!session.stopping) session.stopping = (async () => {
      if (!session.cleaned) {
        session.state = 'stopping'
        if (session.worker) await session.worker.stop().catch(() => {})
        else session.controller.abort()
        await session.job.catch(() => {})
        session.state = state
        await finish(session, state)
      }
    })()
    await session.stopping
    if (session.discard) clear(session)
  }
  const select = (request: Pick<FastifyRequest, 'headers'>, id: string, recheck = true) => {
    const owner = shodanOwner(db, request), session = sessions.get(id)
    if (!session || session.owner.user !== owner.user || session.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    if (recheck) authorize(session)
    return session
  }
  const arm = (session: Session) => {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => { void stop(session, 'expired').catch(() => {}) }, Math.max(0, session.expiresAt - Date.now())).unref()
  }
  const view = (session: Session) => ({ id: session.id, state: session.state, operation: session.input.operation,
    selector: session.input.selector, bounds: session.input.bounds, limits: session.limits, expiresAt: session.expiresAt, cleaned: session.cleaned,
    ...(session.retainedUntil ? { retainedUntil: session.retainedUntil } : {}),
    ...(session.summary ? { summary: session.summary } : {}) })

  const preview = async (owner: ShodanOwner, input: Input, controller: AbortController) => {
    const args = await inspectShodanStream(input)
    const credential = await resolver.resolve(owner.user, 'shodan-axi')
    const binding = shodanBinding(db, owner, credential, input.operation)
    await initialized
    const id = randomUUID(), directory = join(root, `session-${id}`)
    const limits = capacity.reserve(id, owner.user, credential.id, binding.settings, input.limits)
    if (input.bounds.limit > limits.events || input.bounds.maxBytes > limits.bytes || input.bounds.timeout > limits.leaseSeconds * 1000) {
      capacity.release(id); throw new ArtiumError('INVALID_INPUT')
    }
    const pendingPreview: Pending = { owner, credential, binding: binding.hash, input, controller, job: Promise.resolve() }
    const job = (async () => {
      try {
        const nativeToken = await runner.runManaged(owner.user, controller.signal, async signal => {
          const plan = { owner, credential, binding: binding.hash, input }
          authorize(plan)
          const prepared = await adapter.prepare(['version'], credential)
          try {
            authorize(plan)
            return await shodanNativePreview(directory, args, input.operation, input.bounds, prepared, signal, () => authorize(plan), runner.configuredCaPem)
          } finally {
            prepared.secrets.fill(''); prepared.files.length = 0
            for (const key of Object.keys(prepared.environment)) delete prepared.environment[key]
          }
        })
        authorize(pendingPreview)
        const plan: Plan = { id, owner, credential, binding: binding.hash, input, limits, directory, nativeToken,
          expiresAt: Date.now() + 15 * 60 * 1000, timer: setTimeout(() => {}, 0) }
        clearTimeout(plan.timer)
        plan.timer = setTimeout(() => { void discardPlan(plan).catch(() => {}) }, 15 * 60 * 1000).unref()
        await Promise.all([...plans.values()].filter(previous => previous.owner.family === owner.family).map(discardPlan))
        plans.set(id, plan)
        capacity.release(id)
        return { confirm: id, operation: input.operation, selector: input.selector, bounds: input.bounds, limits,
          origin: 'https://stream.shodan.io', cost: 'unknown', status: 'preview', expiresAt: plan.expiresAt }
      } catch (error) { capacity.release(id); await rm(directory, { recursive: true, force: true }); throw error }
      finally { pending.delete(id) }
    })()
    pendingPreview.job = job; pending.set(id, pendingPreview)
    return job
  }
  app.post(prefix + '/preview', async (request, reply) => {
    const controller = new AbortController(), disconnect = () => { if (!reply.raw.writableFinished) controller.abort() }
    reply.raw.once('close', disconnect)
    try { return await preview(shodanOwner(db, request), parse(shodanStreamStart, request.body), controller) }
    finally { reply.raw.off('close', disconnect) }
  })

  const start = async (owner: ShodanOwner, body: Input & { confirm: string }, clientAddress: string | null) => {
    const plan = plans.get(body.confirm)
    if (!plan || plan.owner.user !== owner.user || plan.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    plans.delete(plan.id); clearTimeout(plan.timer)
    try {
      const { confirm: _confirm, ...input } = body
      if (plan.expiresAt <= Date.now() || JSON.stringify(input) !== JSON.stringify(plan.input)) throw new ArtiumError('INVALID_INPUT')
      authorize(plan)
      capacity.reserve(plan.id, owner.user, plan.credential.id, shodanBinding(db, owner, plan.credential, input.operation).settings, input.limits)
      const controller = new AbortController()
      const { nativeToken, ...sessionPlan } = plan
      const session: Session = { ...sessionPlan, state: 'starting', controller, spool: new ShodanSpool(plan.limits.events, plan.limits.bytes,
        plan.limits.retentionSeconds * 1000), expiresAt: Date.now() + Math.min(input.bounds.timeout, plan.limits.leaseSeconds * 1000),
        cleaned: false, changed: new EventEmitter(), job: Promise.resolve() }
      const startedAt = Date.now()
      audit.record({ event: 'run-start', userId: owner.user, tool: 'shodan-axi', requestId: session.id,
        clientAddress, outcome: 'started', args: ['stream', 'session', input.operation], sensitive: { positions: [], flags: [] } })
      sessions.set(plan.id, session); arm(session)
      session.job = runner.runManaged(owner.user, controller.signal, async signal => {
        authorize(session)
        const prepared = await adapter.prepare(['version'], session.credential)
        try {
          authorize(session)
          const worker = new ShodanWorker({ directory: session.directory, input: session.input, confirmation: nativeToken,
            profile: prepared, signal, configuredCaPem: runner.configuredCaPem, authorize: () => authorize(session), onReady: () => { if (session.state === 'starting') session.state = 'running'; session.changed.emit('ready') },
            onEvent: event => { if (!['running', 'stopping'].includes(session.state)) throw new ArtiumError('CANCELLED'); session.spool.append(event); session.changed.emit('change') },
            onLoss: (count, reason) => { if (!['running', 'stopping'].includes(session.state)) throw new ArtiumError('CANCELLED'); session.spool.upstreamLoss(count, reason); session.changed.emit('change') },
            onClosed: summary => { session.summary = summary } })
          session.worker = worker
          await worker.start()
        } finally {
          prepared.secrets.fill(''); prepared.files.length = 0
          for (const key of Object.keys(prepared.environment)) delete prepared.environment[key]
        }
      }).then(async () => {
        await finish(session, 'closed')
        audit.record({ event: 'run-terminal', userId: owner.user, tool: 'shodan-axi', requestId: session.id, clientAddress,
          outcome: 'completed', action: 'read', exitCode: 0, durationMs: Date.now() - startedAt, outputBytes: { stdout: null, stderr: null } })
      }, async () => {
        await finish(session, 'failed')
        audit.record({ event: 'run-terminal', userId: owner.user, tool: 'shodan-axi', requestId: session.id, clientAddress,
          outcome: 'interrupted', action: 'unknown', exitCode: null, durationMs: Date.now() - startedAt, outputBytes: { stdout: null, stderr: null } })
      }).catch(error => {
        log('error', 'shodan-session-terminal', { requestId: session.id,
          code: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      })
      return view(session)
    } catch (error) { capacity.release(plan.id); await rm(plan.directory, { recursive: true, force: true }); throw error }
  }
  app.post(prefix + '/start', request => {
    if (!request.body || typeof request.body !== 'object' || !('confirm' in request.body)) throw new ArtiumError('NOT_FOUND')
    return start(shodanOwner(db, request), parse(shodanStreamStart.extend({ confirm: z.uuid() }), request.body), request.ip)
  })

  app.get<{ Params: { id: string }, Querystring: { waitMs?: string } }>(prefix + '/:id', async request => {
    const session = select(request, request.params.id, false), wait = request.query.waitMs === undefined ? 0 : Number(request.query.waitMs)
    if (!Number.isSafeInteger(wait) || wait < 0 || wait > 30000) throw new ArtiumError('INVALID_INPUT')
    if (wait && !session.cleaned) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); session.changed.removeListener('closed', done); resolve() }
      const timer = setTimeout(done, wait); session.changed.once('closed', done)
    })
    select(request, request.params.id, false)
    return view(session)
  })
  app.post<{ Params: { id: string } }>(prefix + '/:id/read', async request => {
    const session = select(request, request.params.id), input = parse(shodanStreamRead, request.body)
    if (input.waitMs && !session.spool.available(input.continuation) && !session.cleaned) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); session.changed.removeListener('change', done); resolve() }
        const timer = setTimeout(done, input.waitMs)
        session.changed.once('change', done)
      })
      authorize(session)
    }
    return { ...session.spool.read(input.continuation, input.limit, session.cleaned && session.state === 'closed'),
      complete: false, upstreamCompleteness: 'unverified', state: session.state, cleaned: session.cleaned }
  })
  app.post<{ Params: { id: string } }>(prefix + '/:id/extend/preview', request => {
    const session = select(request, request.params.id), input = parse(shodanStreamExtendPreview, request.body)
    const deadline = session.expiresAt + input.seconds * 1000
    if (session.extending || session.state !== 'running' || session.expiresAt <= Date.now() || deadline > Date.now() + session.limits.leaseSeconds * 1000) throw new ArtiumError('INVALID_INPUT')
    session.extension = { confirm: randomUUID(), deadline, previous: session.expiresAt, expiresAt: Date.now() + 15 * 60 * 1000 }
    return { ...session.extension }
  })
  app.post<{ Params: { id: string } }>(prefix + '/:id/extend', async request => {
    const session = select(request, request.params.id), input = parse(shodanStreamConfirm, request.body), extension = session.extension
    if (session.extending) throw new ArtiumError('INVALID_INPUT')
    session.extension = undefined
    if (!extension || extension.confirm !== input.confirm || extension.expiresAt <= Date.now() || extension.previous !== session.expiresAt
      || session.expiresAt <= Date.now() || session.state !== 'running' || !session.worker) throw new ArtiumError('INVALID_INPUT')
    session.extending = true
    try {
      try { await session.worker.extend(extension.deadline) }
      catch (error) {
        if (!(error instanceof ArtiumError && ['INVALID_INPUT', 'CANCELLED'].includes(error.code))) await stop(session, 'failed')
        throw error
      }
      try { authorize(session) }
      catch (error) { await stop(session, 'failed', true); throw error }
      if (session.state !== 'running' || session.expiresAt <= Date.now()) throw new ArtiumError('INVALID_INPUT')
      session.expiresAt = extension.deadline; arm(session); return view(session)
    } finally { session.extending = false }
  })
  app.delete<{ Params: { id: string } }>(prefix + '/:id', async (request, reply) => {
    const session = select(request, request.params.id, false)
    await stop(session, 'closed'); return reply.send(view(session))
  })
  const reconcile = async () => {
    await Promise.all([...pending.values()].map(async preview => {
      try { authorize(preview) } catch { preview.controller.abort(); await preview.job.catch(() => {}) }
    }))
    await Promise.all([...sessions.values()].map(async session => {
      if (session.cleaned) return
      if (session.expiresAt <= Date.now()) { await stop(session, 'expired'); return }
      try { authorize(session) } catch { await stop(session, 'failed', true) }
    }))
    await Promise.all([...plans.values()].map(async plan => { try { authorize(plan) } catch { await discardPlan(plan) } }))
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000).unref()
  app.addHook('onSend', reconcile)
  app.addHook('preClose', async () => {
    clearInterval(monitor)
    await Promise.all([...pending.values()].map(async preview => { preview.controller.abort(); await preview.job.catch(() => {}) }))
    await Promise.all([...plans.values()].map(discardPlan))
    await Promise.all([...sessions.values()].map(session => stop(session, 'closed', true)))
  })
}
