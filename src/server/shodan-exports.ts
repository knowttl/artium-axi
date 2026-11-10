import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { instanceNameSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { shodanExportInput } from '../shared/shodan-stream.js'
import type { Adapter } from './adapters/types.js'
import { verifyShodanPackage } from './adapters/shodan-package.js'
import type { Audit } from './audit/audit.js'
import { toolPaths } from './config.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { shodanExportBinding, shodanOwner, type ShodanOwner, type auditShodanDenials } from './policy/shodan-stream.js'
import type { Runner } from './runner/runner.js'
import type { registerShodanSessions } from './shodan-sessions.js'
import { runShodanNative } from './shodan-preview.js'
import type { CredentialReference } from './store/credential-store.js'

type Input = z.infer<typeof shodanExportInput>
type Sessions = ReturnType<typeof registerShodanSessions>
interface Plan { id: string, owner: ShodanOwner, credential: CredentialReference, instance: string, input: Input, operation: string,
  binding: string, retentionMs: number, directory: string, token: string, expiresAt: number, timer: NodeJS.Timeout }
interface Export extends Omit<Plan, 'token' | 'timer' | 'expiresAt'> { state: 'running' | 'completed' | 'partial' | 'failed', controller: AbortController,
  job: Promise<void>, timer: NodeJS.Timeout, changed: EventEmitter, retrieving: boolean, result?: Record<string, unknown> }

const nativePreview = z.object({ status: z.literal('preview'), token: z.uuid(), operation: z.literal('OP-003'),
  total: z.number().int().nonnegative(), queryCredits: z.number().nonnegative() }).passthrough()
const nativeResult = z.object({ path: z.string(), count: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(),
  requests: z.number().int().nonnegative(), complete: z.boolean(), bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()
const requestFields = z.looseObject({ instance: instanceNameSchema.optional(), confirm: z.uuid().optional() })

async function exportBoundsAreSufficient(input: Input) {
  verifyShodanPackage()
  const flags = new Map<string, string | boolean>([['--allow-operation', 'OP-003'], ['--filename', '/export'], ['--limit', String(input.limit)],
    ['--max-bytes', String(input.maxBytes)], ['--query-credit-budget', String(input.queryCreditBudget)]])
  try {
    const native = await import(pathToFileURL(resolve(dirname(toolPaths['shodan-axi']), '../dist/hosted-writes.js')).href) as {
      hostedWriteBudget: (words: string[], flags: Map<string, string | boolean>, credentials: () => Promise<never>) => Promise<{ minimumCredit: number, minimumRequests: number }>
    }
    const rules = await native.hostedWriteBudget(['download', input.command === 'download' ? input.query : 'selected-alert-networks'], flags,
      async () => { throw new Error('Credentials are unavailable before the gates pass') })
    return input.queryCreditBudget >= rules.minimumCredit && input.maxRequests >= rules.minimumRequests
  } catch { return false }
}

export function registerShodanExports(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: Adapter<unknown>, runner: Runner, audit: Audit, sessions: Sessions, denials: ReturnType<typeof auditShodanDenials>) {
  const prefix = '/v1/tools/shodan-axi/exports', root = join(dirname(db.name), 'tool-logs', 'shodan-axi', 'exports')
  const plans = new Map<string, Plan>(), jobs = new Map<string, Export>()
  denials.register((request, owner) => {
    const path = request.url.split('?')[0], body = request.body as { confirm?: unknown } | null
    const id = path === prefix + '/start' && typeof body?.confirm === 'string' ? body.confirm : path.startsWith(prefix + '/') ? path.slice(prefix.length + 1).split('/')[0] : undefined
    const resource = id && (path === prefix + '/start' ? plans.get(id) : jobs.get(id))
    if (resource && resource.owner.user === owner.user && resource.owner.family === owner.family) return { credentialId: resource.credential.id, instance: resource.instance }
  })
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(root)) if (name.startsWith('export-')) await rm(join(root, name), { recursive: true, force: true })
  })()
  app.addHook('onReady', () => initialized)
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const parseRequest = (body: unknown) => {
    const { instance, confirm, ...rest } = parse(requestFields, body)
    return { instance, confirm, input: parse(shodanExportInput, rest) }
  }
  const authorize = (resource: Pick<Plan, 'owner' | 'credential' | 'operation' | 'binding'>) => {
    if (shodanExportBinding(db, resource.owner, resource.credential, resource.operation).hash !== resource.binding) throw new ArtiumError('REVISION_CONFLICT')
  }
  const nativeArguments = (input: Input, directory: string) => [...(input.command === 'download' ? ['download', input.query] : ['alert', 'download']),
    ...(input.command === 'alert download' && input.alertId ? ['--alert-id', input.alertId] : []),
    '--json', '--allow-operation', 'OP-003', '--filename', join(directory, 'files', 'export'), '--limit', String(input.limit),
    '--max-bytes', String(input.maxBytes), '--max-requests', String(input.maxRequests), '--query-credit-budget', String(input.queryCreditBudget),
    ...(input.fields.length ? ['--fields', input.fields.join(',')] : [])]
  const nativeCall = async (resource: Pick<Plan, 'credential' | 'directory' | 'input' | 'owner' | 'operation' | 'binding'>, extra: string[], signal: AbortSignal, timeoutMs?: number) => {
    const check = () => authorize(resource)
    check()
    const profile = await adapter.prepare(['version'], resource.credential)
    profile.environment.SHODAN_AXI_READ_ONLY = 'false'
    return runShodanNative(resource.directory, [...nativeArguments(resource.input, resource.directory), ...extra], profile, signal, check, runner.configuredCaPem, undefined, timeoutMs)
  }
  const discardDirectory = (directory: string) => rm(directory, { recursive: true, force: true })
  const discardExport = async (job: Export) => { clearTimeout(job.timer); jobs.delete(job.id); await discardDirectory(job.directory) }
  const discardPlan = async (plan: Plan) => { clearTimeout(plan.timer); plans.delete(plan.id); await discardDirectory(plan.directory) }

  app.post(prefix + '/preview', async request => {
    const owner = shodanOwner(db, request), { instance, confirm, input } = parseRequest(request.body)
    if (confirm !== undefined) throw new ArtiumError('INVALID_INPUT')
    const operation = input.command === 'download' ? 'CLI-005' : 'CLI-020'
    const credential = await resolver.resolve(owner.user, 'shodan-axi', instance)
    denials.markCredential(request, credential)
    const binding = shodanExportBinding(db, owner, credential, operation), policy = binding.settings
    if (input.queryCreditBudget > policy.maxQueryCredits || input.maxRequests > policy.maxRequests || input.limit > policy.maxRecords
      || input.maxBytes > policy.maxBytes || !await exportBoundsAreSufficient(input)) throw new ArtiumError('INVALID_INPUT')
    if (plans.size >= 128 || [...plans.values()].filter(plan => plan.owner.user === owner.user).length >= 8) throw new ArtiumError('TOO_MANY_CALLS')
    await initialized
    const id = randomUUID(), directory = join(root, `export-${id}`)
    await mkdir(join(directory, 'files'), { recursive: true, mode: 0o700 })
    const resource = { owner, credential, input, operation, binding: binding.hash, directory }
    let preview: z.infer<typeof nativePreview>
    try {
      const parsed = nativePreview.safeParse(await runner.runManaged(owner.user, undefined, signal => nativeCall(resource, [], signal)))
      if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
      preview = parsed.data
    } catch (error) {
      await discardDirectory(directory)
      throw error
    }
    const plan: Plan = { ...resource, id, instance: binding.instance, token: preview.token, retentionMs: policy.retentionSeconds * 1000,
      expiresAt: Date.now() + 15 * 60 * 1000, timer: setTimeout(() => {}, 0) }
    clearTimeout(plan.timer)
    plan.timer = setTimeout(() => { void discardPlan(plan).catch(() => {}) }, 15 * 60 * 1000).unref()
    plans.set(id, plan)
    return { confirm: id, instance: plan.instance, command: input.command, operation, total: preview.total, queryCredits: preview.queryCredits,
      limit: input.limit, maxBytes: input.maxBytes, queryCreditBudget: input.queryCreditBudget, maxRequests: input.maxRequests,
      retentionSeconds: policy.retentionSeconds, expiresAt: plan.expiresAt }
  })

  app.post(prefix + '/start', async request => {
    const owner = shodanOwner(db, request), { instance, confirm, input } = parseRequest(request.body), plan = confirm === undefined ? undefined : plans.get(confirm)
    if (!plan || plan.owner.user !== owner.user || plan.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    denials.mark(request, plan)
    if (jobs.size >= 8 || [...jobs.values()].filter(job => job.owner.user === owner.user).length >= 2) throw new ArtiumError('TOO_MANY_CALLS')
    const identity = { credentialId: plan.credential.id, instance: plan.instance }
    try {
      if (plan.expiresAt <= Date.now() || instance !== undefined && instance !== plan.instance || JSON.stringify(input) !== JSON.stringify(plan.input)) throw new ArtiumError('INVALID_INPUT')
      authorize(plan)
      clearTimeout(plan.timer); plans.delete(plan.id)
      audit.record({ event: 'run-start', userId: owner.user, tool: 'shodan-axi', requestId: plan.id, clientAddress: request.ip, ...identity,
        outcome: 'started', args: ['export', plan.operation], sensitive: { positions: [], flags: [] } })
    } catch (error) {
      await discardPlan(plan)
      throw error
    }
    const { token, timer: _timer, expiresAt: _expiresAt, ...resource } = plan
    const job: Export = { ...resource, state: 'running', controller: new AbortController(), job: Promise.resolve(), timer: setTimeout(() => {}, 0),
      changed: new EventEmitter(), retrieving: false }
    clearTimeout(job.timer)
    jobs.set(job.id, job)
    const startedAt = Date.now()
    job.job = (async () => {
      let failure: string | undefined
      try {
        const timeoutMs = Math.min(3600000, 30000 + input.maxRequests * 10000)
        const parsed = nativeResult.safeParse(await runner.runManaged(owner.user, job.controller.signal,
          signal => nativeCall(job, ['--execute', '--confirm', token], signal, timeoutMs)))
        const file = join(job.directory, 'files', parsed.success && parsed.data.complete ? 'export.json.gz' : 'export.json.gz.partial')
        if (!parsed.success || parsed.data.path !== file || (await stat(file)).size !== parsed.data.bytes) throw new ArtiumError('INVALID_RESPONSE')
        job.state = parsed.data.complete ? 'completed' : 'partial'
        job.result = { count: parsed.data.count, total: parsed.data.total, complete: parsed.data.complete, bytes: parsed.data.bytes,
          sha256: parsed.data.sha256, requests: parsed.data.requests, retainedUntil: Date.now() + job.retentionMs }
      } catch (error) {
        failure = error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
        job.state = 'failed'
        job.result = { error: failure }
        await discardDirectory(job.directory).catch(() => {})
      }
      job.timer = setTimeout(() => { void discardExport(job).catch(() => {}) }, job.retentionMs).unref()
      job.changed.emit('change')
      audit.record({ event: 'run-terminal', userId: owner.user, tool: 'shodan-axi', requestId: job.id, clientAddress: request.ip, ...identity,
        outcome: failure ? 'interrupted' : 'completed', action: 'read', exitCode: failure ? null : 0, durationMs: Date.now() - startedAt,
        outputBytes: { stdout: null, stderr: null } })
    })()
    return { id: job.id, state: job.state }
  })

  const ownedJob = (request: Parameters<typeof shodanOwner>[1] & { params: { id: string } }) => {
    const owner = shodanOwner(db, request), job = jobs.get(request.params.id)
    if (!job || job.retrieving || job.owner.user !== owner.user || job.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    return job
  }

  app.get<{ Params: { id: string }, Querystring: { waitMs?: string } }>(prefix + '/:id', async request => {
    const job = ownedJob(request)
    denials.mark(request, job)
    authorize(job)
    const wait = request.query.waitMs === undefined ? 0 : Number(request.query.waitMs)
    if (!Number.isSafeInteger(wait) || wait < 0 || wait > 30000) throw new ArtiumError('INVALID_INPUT')
    if (wait && job.state === 'running') await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); job.changed.removeListener('change', finish); done() }
      const timer = setTimeout(finish, wait); job.changed.once('change', finish)
    })
    authorize(job)
    return { id: job.id, state: job.state, instance: job.instance, ...(job.result ? { result: job.result } : {}) }
  })

  app.post<{ Params: { id: string } }>(prefix + '/:id/retrieve', async (request, reply) => {
    const job = ownedJob(request)
    denials.mark(request, job)
    authorize(job)
    if (job.state !== 'completed' && job.state !== 'partial') throw new ArtiumError('INVALID_INPUT')
    job.retrieving = true
    clearTimeout(job.timer)
    const file = join(job.directory, 'files', job.state === 'completed' ? 'export.json.gz' : 'export.json.gz.partial')
    const result = job.result!
    reply.raw.once('close', () => { void discardExport(job).catch(() => {}) })
    reply.headers({ 'content-type': 'application/gzip', 'content-length': result.bytes as number, 'x-artium-export-sha256': result.sha256 as string,
      'x-artium-export-complete': String(result.complete), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store, no-transform' })
    return reply.send(Readable.from((async function* () {
      try { for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) { authorize(job); yield chunk } }
      finally { await discardExport(job) }
    })(), { objectMode: false }))
  })

  const reconcile = async () => {
    for (const plan of plans.values()) try { authorize(plan) } catch { await discardPlan(plan) }
    await Promise.all([...jobs.values()].map(async job => {
      try { authorize(job) } catch { job.controller.abort(); await job.job; await discardExport(job) }
    }))
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000).unref()
  app.addHook('onSend', reconcile)
  sessions.onShutdown(async () => {
    clearInterval(monitor)
    await Promise.all([...jobs.values()].map(async job => { job.controller.abort(); await job.job; await discardExport(job) }))
    await Promise.all([...plans.values()].map(discardPlan))
  })
}
