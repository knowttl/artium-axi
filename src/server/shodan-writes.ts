import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { instanceNameSchema } from '../shared/api.js'
import { ArtiumError } from '../shared/errors.js'
import { shodanWriteInput } from '../shared/shodan-stream.js'
import type { Adapter } from './adapters/types.js'
import type { Audit } from './audit/audit.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { shodanOwner, shodanWriteBinding, type ShodanOwner } from './policy/shodan-stream.js'
import type { Runner } from './runner/runner.js'
import type { registerShodanSessions } from './shodan-sessions.js'
import { executeShodanWrite, previewShodanWrite, shodanWriteOperation } from './shodan-write-native.js'
import type { CredentialReference } from './store/credential-store.js'

type Input = z.infer<typeof shodanWriteInput>
interface Plan { id: string, owner: ShodanOwner, credential: CredentialReference, instance: string, input: Input, operation: string,
  token: string, directory: string, binding: string, expiresAt: number, timer: NodeJS.Timeout }

export function registerShodanWrites(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: Adapter<unknown>, runner: Runner, audit: Audit, sessions: ReturnType<typeof registerShodanSessions>) {
  const prefix = '/v1/tools/shodan-axi/writes', root = join(dirname(db.name), 'tool-logs', 'shodan-axi', 'writes')
  const plans = new Map<string, Plan>()
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true })
  })()
  app.addHook('onReady', () => initialized)
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const authorize = (plan: Pick<Plan, 'owner' | 'credential' | 'binding' | 'operation'>) => {
    if (shodanWriteBinding(db, plan.owner, plan.credential, [plan.operation]).hash !== plan.binding) throw new ArtiumError('REVISION_CONFLICT')
  }
  const discard = async (plan: Plan) => {
    clearTimeout(plan.timer); plans.delete(plan.id)
    await rm(plan.directory, { recursive: true, force: true })
  }

  app.post(prefix + '/preview', async request => {
    const owner = shodanOwner(db, request), { instance, ...input } = parse(shodanWriteInput.extend({ instance: instanceNameSchema.optional() }), request.body)
    const operation = shodanWriteOperation(input)
    const credential = await resolver.resolve(owner.user, 'shodan-axi', instance)
    const binding = shodanWriteBinding(db, owner, credential, [operation])
    if (input.queryCreditBudget > binding.settings.maxQueryCredits || input.maxRequests > binding.settings.maxRequests) throw new ArtiumError('INVALID_INPUT')
    if (plans.size >= 128 || [...plans.values()].filter(plan => plan.owner.user === owner.user).length >= 8) throw new ArtiumError('TOO_MANY_CALLS')
    await initialized
    const id = randomUUID(), directory = join(root, `write-${id}`)
    const check = () => authorize({ owner, credential, binding: binding.hash, operation })
    try {
      const preview = await runner.runManaged(owner.user, undefined, signal => previewShodanWrite(directory, adapter, credential, input, operation,
        signal, check, runner.configuredCaPem))
      const plan: Plan = { id, owner, credential, instance: binding.instance, input, operation, token: preview.token, directory, binding: binding.hash,
        expiresAt: Date.now() + 15 * 60 * 1000, timer: setTimeout(() => {}, 0) }
      clearTimeout(plan.timer)
      plan.timer = setTimeout(() => { void discard(plan) }, 15 * 60 * 1000).unref()
      plans.set(id, plan)
      return { confirm: id, instance: plan.instance, command: input.command, operation,
        effects: preview.effects, ...input.body ? { arguments: Object.keys(input.body.args) } : {},
        queryCreditBudget: input.queryCreditBudget, maxRequests: input.maxRequests, cost: 'unknown', expiresAt: plan.expiresAt }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  })

  app.post(prefix + '/execute', async request => {
    const owner = shodanOwner(db, request), body = parse(shodanWriteInput.extend({ confirm: z.uuid(), instance: instanceNameSchema.optional() }), request.body)
    const plan = plans.get(body.confirm)
    if (!plan || plan.owner.user !== owner.user || plan.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    clearTimeout(plan.timer); plans.delete(plan.id)
    const { confirm: _confirm, instance, ...input } = body
    try {
      if (plan.expiresAt <= Date.now() || instance !== undefined && instance !== plan.instance
        || JSON.stringify(input) !== JSON.stringify(plan.input)) throw new ArtiumError('INVALID_INPUT')
      authorize(plan)
      const identity = { credentialId: plan.credential.id, instance: plan.instance }
      const base = { userId: owner.user, tool: 'shodan-axi' as const, requestId: plan.id, clientAddress: request.ip, ...identity }
      audit.record({ ...base, event: 'run-start', outcome: 'started', args: ['write', plan.operation], sensitive: { positions: [], flags: [] } })
      const startedAt = Date.now()
      let result: Awaited<ReturnType<typeof executeShodanWrite>> | undefined
      try {
        result = await runner.runManaged(owner.user, undefined, signal => executeShodanWrite(plan.directory, adapter, plan.credential, plan.input,
          plan.operation, plan.token, signal, () => authorize(plan), runner.configuredCaPem))
        return result
      } finally {
        const completed = result?.status === 'completed'
        audit.record({ ...base, event: 'run-terminal', outcome: completed ? 'completed' : 'interrupted', action: completed ? 'write' : 'unknown',
          exitCode: completed ? 0 : null, durationMs: Date.now() - startedAt, outputBytes: { stdout: null, stderr: null } })
      }
    } finally {
      await rm(plan.directory, { recursive: true, force: true })
    }
  })

  const reconcile = async () => {
    for (const plan of [...plans.values()]) try { authorize(plan) } catch { await discard(plan) }
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000).unref()
  app.addHook('onSend', reconcile)
  sessions.onShutdown(async () => {
    clearInterval(monitor)
    await Promise.all([...plans.values()].map(discard))
  })
}
