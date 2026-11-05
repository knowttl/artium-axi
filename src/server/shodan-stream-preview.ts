import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { shodanStreamStart } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import { inspectShodanStream } from './adapters/shodan-stream.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import { shodanBinding, shodanOwner } from './policy/shodan-stream.js'
import type { Runner } from './runner/runner.js'
import { ShodanCapacity } from './shodan-capacity.js'
import { shodanNativePreview } from './shodan-preview.js'

export function registerShodanStreamPreview(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: Adapter<unknown>, runner: Runner) {
  const capacity = new ShodanCapacity()
  app.post('/v1/tools/shodan-axi/sessions/preview', async (request, reply) => {
    const owner = shodanOwner(db, request)
    const parsed = shodanStreamStart.safeParse(request.body)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const input = parsed.data, args = await inspectShodanStream(input)
    const credential = await resolver.resolve(owner.user, 'shodan-axi')
    const binding = shodanBinding(db, owner, credential, input.operation)
    const authorize = () => {
      shodanOwner(db, request)
      if (shodanBinding(db, owner, credential, input.operation).hash !== binding.hash) throw new ArtiumError('REVISION_CONFLICT')
    }
    const id = randomUUID(), limits = capacity.reserve(id, owner.user, credential.id, binding.settings, input.limits)
    let directory: string | undefined
    const controller = new AbortController()
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort() }
    reply.raw.once('close', disconnect)
    try {
      if (input.bounds.limit > limits.events || input.bounds.maxBytes > limits.bytes || input.bounds.timeout > limits.leaseSeconds * 1000) throw new ArtiumError('INVALID_INPUT')
      directory = await mkdtemp(join(tmpdir(), 'artium-shodan-preview-'))
      await runner.runManaged(owner.user, controller.signal, async signal => {
        authorize()
        const prepared = await adapter.prepare(['version'], credential)
        await shodanNativePreview(directory!, args, input.operation, input.bounds, prepared, signal, authorize, runner.configuredCaPem)
      })
      authorize()
      return { operation: input.operation, selector: input.selector, bounds: input.bounds, limits,
        origin: 'https://stream.shodan.io', cost: 'unknown', status: 'preview' }
    } finally {
      reply.raw.off('close', disconnect)
      capacity.release(id)
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  })
}
