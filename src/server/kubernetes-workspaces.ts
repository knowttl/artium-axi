import { createHash, randomUUID } from 'node:crypto'
import { constants, mkdirSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { authorizeKubernetesOwner, kubernetesBinding, kubernetesOwner, type KubernetesOwner } from './policy/kubernetes.js'
import { kubernetesWorkspaceManifest as manifestSchema, kubernetesWorkspacePath as workspacePath } from '../shared/kubernetes.js'
import type { Audit } from './audit/audit.js'
import { runnerLimits } from './config.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import type { Adapter } from './adapters/types.js'
import type { CredentialReference } from './store/credential-store.js'
import { SecretScanner } from './runner/scan.js'

const workspaceLimit = 250 * 1024 * 1024
export { workspacePath }
type FileEntry = z.infer<typeof manifestSchema>['files'][number] & { state: 'empty' | 'uploading' | 'ready' }
interface Workspace {
  id: string, owner: KubernetesOwner, credential: CredentialReference, binding: string, directory: string,
  instance?: string,
  expiresAt: number, files: Map<string, FileEntry>, controller: AbortController,
  active: Set<Promise<unknown>>, timer: ReturnType<typeof setTimeout>, closing?: Promise<void>,
}

export async function kubernetesByteLease<T>(owner: { active: Set<Promise<unknown>> }, operation: () => Promise<T>): Promise<T> {
  const pending = operation()
  owner.active.add(pending)
  try { return await pending } finally { owner.active.delete(pending) }
}

export function sendKubernetesBytes(reply: FastifyReply, owner: { controller: AbortController, active: Set<Promise<unknown>> }, bytes: Buffer, sha256: string) {
  if (owner.controller.signal.aborted) throw new ArtiumError('CANCELLED')
  const cancel = () => { reply.raw.destroy() }
  const pending = finished(reply.raw).catch(() => {})
  owner.active.add(pending)
  owner.controller.signal.addEventListener('abort', cancel, { once: true })
  void pending.then(() => { owner.active.delete(pending); owner.controller.signal.removeEventListener('abort', cancel) })
  return reply.headers({ 'cache-control': 'no-store, no-transform', 'content-type': 'application/octet-stream',
    'content-length': bytes.length, 'x-artium-content-sha256': sha256, 'x-artium-archive-sha256': sha256,
    'content-disposition': 'attachment; filename="artifact.bin"', 'x-content-type-options': 'nosniff' }).send(bytes)
}

export function registerKubernetesWorkspaces(app: FastifyInstance, db: Database.Database,
  resolver: IdentityResolver, adapter: Adapter<unknown>, audit: Audit) {
  const workspaces = new Map<string, Workspace>()
  const admitted = new WeakMap<FastifyRequest, { credentialId: string, instance?: string }>()
  const root = (async () => {
    const path = join(dirname(db.name), 'tool-logs', 'kubernetes-axi', 'workspaces')
    await mkdir(path, { recursive: true, mode: 0o700 })
    for (const name of await readdir(path)) if (name.startsWith('workspace-')) await rm(join(path, name), { recursive: true, force: true })
    return path
  })()
  app.addHook('onReady', async () => { await root })
  const ownerFor = (request: FastifyRequest, command?: string) => {
    const owner = kubernetesOwner(db, request)
    if (command) authorizeKubernetesOwner(db, owner, adapter, command)
    return owner
  }
  const record = (request: FastifyRequest, owner: KubernetesOwner, id: string, action: string) =>
    audit.record({ event: 'admin-change', userId: owner.user, delegationId: owner.delegation?.id, tool: 'kubernetes-axi', requestId: request.id,
      clientAddress: request.ip, outcome: 'success', action: 'kubernetes-workspace-' + action, targetId: id })
  function access(workspace: Workspace) {
    if (workspace.controller.signal.aborted || workspace.expiresAt <= Date.now()) throw new ArtiumError('TOKEN_EXPIRED')
    if (kubernetesBinding(db, workspace.owner).hash !== workspace.binding) throw new ArtiumError('REVISION_CONFLICT')
  }
  function discard(workspace: Workspace): Promise<void> {
    workspace.closing ??= (async () => {
      workspaces.delete(workspace.id)
      clearTimeout(workspace.timer)
      workspace.controller.abort()
      await Promise.allSettled([...workspace.active])
      await rm(workspace.directory, { recursive: true, force: true })
    })()
    return workspace.closing
  }
  async function selected(request: FastifyRequest, id: string, command: string) {
    const owner = ownerFor(request, command)
    const workspace = workspaces.get(id)
    if (!workspace || workspace.owner.user !== owner.user || workspace.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    admitted.set(request, { credentialId: workspace.credential.id, instance: workspace.instance })
    try { access(workspace) }
    catch (error) { await discard(workspace); throw error }
    const credential = await resolver.resolve(owner.user, 'kubernetes-axi')
    const instance = (db.prepare('SELECT name FROM credentials WHERE id = ?').get(credential.id) as { name: string } | undefined)?.name
    admitted.set(request, { credentialId: credential.id, instance })
    if (credential.id !== workspace.credential.id || credential.revision !== workspace.credential.revision) {
      await discard(workspace)
      throw new ArtiumError('REVISION_CONFLICT')
    }
    return workspace
  }
  const view = (workspace: Workspace) => ({ id: workspace.id, owner: workspace.owner.user,
    expiresAt: workspace.expiresAt, files: [...workspace.files.values()].map(file => ({ ...file })),
    ready: [...workspace.files.values()].every(file => file.state === 'ready') })
  const prefix = '/v1/tools/kubernetes-axi/workspaces'
  app.post(prefix, async (request, reply) => {
    const owner = ownerFor(request, 'workspace create')
    const parsed = manifestSchema.safeParse(request.body)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const { files, lifetimeSeconds } = parsed.data
    const paths = new Set(files.map(file => file.path))
    if (paths.size !== files.length || files.reduce((sum, file) => sum + file.bytes, 0) > workspaceLimit ||
      files.some(file => file.path.split('/').slice(0, -1).some((_, index, parts) => paths.has(parts.slice(0, index + 1).join('/'))))) {
      throw new ArtiumError('INVALID_INPUT')
    }
    const credential = await resolver.resolve(owner.user, 'kubernetes-axi')
    const prepared = await adapter.prepare(['version'], credential)
    if (new SecretScanner(prepared.secrets).scan('stdout', Buffer.from(JSON.stringify(files)))) throw new ArtiumError('SECRET_IN_OUTPUT')
    const id = randomUUID()
    const directory = join(await root, 'workspace-' + id)
    const owned = [...workspaces.values()].filter(entry => entry.owner.user === owner.user)
    if (workspaces.size >= runnerLimits.globalCalls || owned.length >= runnerLimits.userCalls ||
      owner.delegation && owned.filter(entry => entry.owner.delegation).length >= 2) throw new ArtiumError('TOO_MANY_CALLS')
    const binding = kubernetesBinding(db, owner)
    if (binding.credential.id !== credential.id || binding.credential.revision !== credential.revision) throw new ArtiumError('REVISION_CONFLICT')
    mkdirSync(directory, { mode: 0o700 })
    const workspace: Workspace = { id, owner, credential, instance, binding: binding.hash, directory, expiresAt: Date.now() + lifetimeSeconds * 1000,
      files: new Map(files.map(file => [file.path, { ...file, state: 'empty' }])), controller: new AbortController(),
      active: new Set(), timer: setTimeout(() => { void discard(workspace) }, lifetimeSeconds * 1000) }
    workspace.timer.unref()
    workspaces.set(id, workspace)
    try { access(workspace) } catch (error) { await discard(workspace); throw error }
    record(request, owner, id, 'create')
    return reply.header('cache-control', 'no-store').send(view(workspace))
  })
  app.get<{ Params: { id: string } }>(`${prefix}/:id`, async (request, reply) => {
    const parsed = z.strictObject({ operation: z.enum(['create', 'download', 'show']).default('show') }).safeParse(request.query)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const workspace = await selected(request, request.params.id, `workspace ${parsed.data.operation}`)
    record(request, workspace.owner, workspace.id, parsed.data.operation)
    return reply.header('cache-control', 'no-store').send(view(workspace))
  })
  app.delete<{ Params: { id: string } }>(`${prefix}/:id`, async (request, reply) => {
    const parsed = z.strictObject({ operation: z.enum(['create', 'delete']).default('delete') }).safeParse(request.query)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const workspace = await selected(request, request.params.id, `workspace ${parsed.data.operation}`)
    await discard(workspace)
    record(request, workspace.owner, workspace.id, 'delete')
    return reply.code(204).send()
  })
  // Scoped parsing leaves the ordinary tool input limits unchanged. Consume
  // upload chunks directly rather than buffering the request in Fastify.
  app.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
    routes.put<{ Params: { id: string, '*': string } }>(`${prefix}/:id/files/*`, async (request, reply) => {
      const workspace = await selected(request, request.params.id, 'workspace create')
      const file = workspace.files.get(request.params['*'])
      if (!file || file.state !== 'empty' || !(request.body instanceof Readable)) throw new ArtiumError('INVALID_INPUT')
      file.state = 'uploading'
      const input = request.body
      input.on('error', () => {})
      const cancel = () => input.destroy(new ArtiumError('CANCELLED'))
      workspace.controller.signal.addEventListener('abort', cancel, { once: true })
      const upload = (async () => {
        const path = join(workspace.directory, file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const output = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
        try {
          const hash = createHash('sha256')
          let bytes = 0
          for await (const chunk of input) {
            ownerFor(request); access(workspace)
            bytes += chunk.length
            if (bytes > file.bytes) throw new ArtiumError('INVALID_INPUT')
            hash.update(chunk)
            await output.writeFile(chunk)
          }
          if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new ArtiumError('INVALID_INPUT')
          access(workspace)
          file.state = 'ready'
        } finally { await output.close() }
      })()
      workspace.active.add(upload)
      try { await upload; record(request, workspace.owner, workspace.id, 'upload'); return reply.header('cache-control', 'no-store').send({ ...file }) }
      catch (error) {
        workspace.active.delete(upload)
        await discard(workspace)
        throw error
      } finally {
        workspace.active.delete(upload)
        workspace.controller.signal.removeEventListener('abort', cancel)
      }
    })
  })
  app.get<{ Params: { id: string, '*': string } }>(`${prefix}/:id/files/*`, async (request, reply) => {
    const workspace = await selected(request, request.params.id, 'workspace download')
    const { bytes, sha256 } = await kubernetesByteLease(workspace, async () => {
      const file = workspace.files.get(request.params['*'])
      if (!file || file.state !== 'ready' || request.headers.range) throw new ArtiumError('INVALID_INPUT')
      const prepared = await adapter.prepare(['version'], workspace.credential)
      const scanner = new SecretScanner(prepared.secrets)
      const source = await open(join(workspace.directory, file.path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await source.stat()
        if (!info.isFile() || info.size !== file.bytes) throw new ArtiumError('INVALID_INPUT')
        // Scan the entire immutable artifact before releasing even its first byte.
        const bytes = await source.readFile()
        ownerFor(request); access(workspace)
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new ArtiumError('INVALID_INPUT')
        if (scanner.scan('stdout', bytes)) throw new ArtiumError('SECRET_IN_OUTPUT')
        record(request, workspace.owner, workspace.id, 'retrieve')
        return { bytes, sha256: file.sha256 }
      } finally { await source.close() }
    })
    ownerFor(request); access(workspace)
    return sendKubernetesBytes(reply, workspace, bytes, sha256)
  })
  const reconcile = async () => {
    for (const workspace of workspaces.values()) {
      try { access(workspace) } catch { await discard(workspace) }
    }
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000)
  monitor.unref()
  app.addHook('onSend', async (_request, _reply, payload) => {
    await reconcile()
    return payload
  })
  app.addHook('preClose', async () => {
    clearInterval(monitor)
    await Promise.all([...workspaces.values()].map(discard))
    await rm(await root, { recursive: true, force: true })
  })
  return {
    auditIdentity(request: FastifyRequest, userId: string | null, familyId: string | undefined) {
      const id = request.url.startsWith(prefix + '/') ? (request.params as { id?: string } | undefined)?.id : undefined
      const workspace = id ? workspaces.get(id) : undefined
      return admitted.get(request) ?? (workspace && workspace.owner.user === userId && workspace.owner.family === familyId
        ? { credentialId: workspace.credential.id, instance: workspace.instance } : undefined)
    },
    async materializeFile(request: FastifyRequest, id: string, path: string, destination: string, command: string) {
      const workspace = await selected(request, id, command)
      const file = workspace.files.get(path)
      if (!file || file.state !== 'ready') throw new ArtiumError('INVALID_INPUT')
      await copyFile(join(workspace.directory, file.path), destination, constants.COPYFILE_EXCL)
      access(workspace)
    },
    async materialize(request: FastifyRequest, id: string, directory: string, command: string) {
      const workspace = await selected(request, id, command)
      if (![...workspace.files.values()].every(file => file.state === 'ready')) throw new ArtiumError('INVALID_INPUT')
      for (const file of workspace.files.values()) {
        access(workspace)
        const target = join(directory, file.path)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copyFile(join(workspace.directory, file.path), target, constants.COPYFILE_EXCL)
      }
      access(workspace)
    },
  }
}
