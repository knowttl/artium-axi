import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { kubernetesFile, kubernetesSessionStart, kubernetesWorkspacePath } from '../shared/kubernetes.js'
import { ArtiumError } from '../shared/errors.js'
import type { Adapter } from './adapters/types.js'
import type { Audit } from './audit/audit.js'
import { runnerLimits, runtimePath } from './config.js'
import { authorizeKubernetesOwner, kubernetesBinding, kubernetesOwner, type KubernetesOwner } from './policy/kubernetes.js'
import { checkDelegation, classifyDelegatedCommand, credentialIssuingCommand } from './auth/delegations.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import type { registerKubernetesWorkspaces } from './kubernetes-workspaces.js'
import { kubernetesByteLease, sendKubernetesBytes } from './kubernetes-workspaces.js'
import { SecretScanner } from './runner/scan.js'
import type { Runner } from './runner/runner.js'
import { readCredentialTrust } from './store/trusted-certificates.js'
import { verifyPrincipal } from './auth/tokens.js'
import { attachKubernetesTunnel } from './kubernetes-tunnels.js'
import { acceptsCliVersion } from '../shared/version.js'

const messageSchema = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('prepared'), preview: z.record(z.string(), z.unknown()) }),
  z.strictObject({ event: z.literal('running') }),
  z.strictObject({ event: z.literal('ports'), ports: z.array(z.strictObject({
    remote: z.number().int().min(1).max(65535), local: z.number().int().min(1).max(65535),
  })).min(1).max(8) }),
  z.strictObject({ event: z.literal('output'), channel: z.enum(['stdout', 'stderr']), base64: z.string().max(2 * 1024 * 1024) }),
  z.strictObject({ event: z.literal('result'), value: z.unknown() }),
  z.strictObject({ event: z.literal('artifacts'), files: z.array(kubernetesFile).max(100)
    .refine(files => files.reduce((sum, file) => sum + file.bytes, 0) <= 250 * 1024 * 1024) }),
  z.strictObject({ event: z.literal('exit'), exitCode: z.number().int(), stdoutEOF: z.boolean(), stderrEOF: z.boolean() }),
  z.strictObject({ event: z.literal('failed'), code: z.string().regex(/^[A-Z_]{1,64}$/), message: z.string().max(8192) }),
])
type Input = z.infer<typeof kubernetesSessionStart>
interface Chunk { channel: 'stdout' | 'stderr', sequence: number, offset: number, length: number, base64: string }
interface Session {
  id: string, owner: KubernetesOwner, kind: Input['kind'], binding: string, directory: string,
  credentialId: string, instance?: string,
  state: 'starting' | 'prepared' | 'running' | 'exited' | 'failed' | 'cancelled' | 'expired',
  expiresAt: number, startedAt: number, controller: AbortController, child?: ChildProcess, job: Promise<void>, timer: NodeJS.Timeout,
  changed: EventEmitter, active: Set<Promise<unknown>>, ready: Promise<void>, acknowledge: () => void,
  preview?: Record<string, unknown>, digest?: string, confirmed: boolean, exitCode?: number, code?: string,
  artifacts?: z.infer<typeof kubernetesFile>[], result?: unknown, chunks: Chunk[], sequence: number,
  offsets: { stdout: number, stderr: number }, retained: number, limit: number, truncated: boolean,
  approvedPorts: number[], ports: Map<number, number>, tunnels: Set<Promise<void>>,
  usedConnections: Set<string>, activeConnections: Set<string>, portsReady: Promise<void>, portsAcknowledge: () => void,
}

// A worker owns one operation through preview and confirmation, never a reusable connection.
export function registerKubernetesSessions(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: Adapter<unknown>, runner: Runner, audit: Audit, workspaces: ReturnType<typeof registerKubernetesWorkspaces>, trustedProxies: readonly string[] = []) {
  const sessions = new Map<string, Session>()
  const admitted = new WeakMap<FastifyRequest, { credentialId: string, instance?: string }>()
  const root = join(dirname(db.name), 'tool-logs', 'kubernetes-axi', 'byte-sessions')
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(root)) if (name.startsWith('session-')) await rm(join(root, name), { recursive: true, force: true })
  })()
  app.addHook('onReady', () => initialized)
  const prefix = '/v1/tools/kubernetes-axi/sessions'
  const active = (session: Session) => ['starting', 'prepared', 'running'].includes(session.state)
  const access = (session: Session) => {
    if (session.expiresAt <= Date.now()) throw new ArtiumError('TOKEN_EXPIRED')
    if (kubernetesBinding(db, session.owner, session.kind).hash !== session.binding) throw new ArtiumError('REVISION_CONFLICT')
  }
  const record = (request: FastifyRequest, session: Session, action: string) => audit.record({ event: 'admin-change',
    userId: session.owner.user, delegationId: session.owner.delegation?.id, tool: 'kubernetes-axi', requestId: request.id, clientAddress: request.ip,
    outcome: 'success', action: 'kubernetes-session-' + action, targetId: session.id })
  async function stop(session: Session, state: 'cancelled' | 'expired' | 'failed') {
    if (active(session)) session.state = state
    session.controller.abort(); session.acknowledge(); session.portsAcknowledge(); session.changed.emit('change')
    await session.job
    await Promise.allSettled([...session.active])
    session.chunks = []; session.retained = 0; session.preview = undefined; session.result = undefined
    session.artifacts = undefined
    await rm(session.directory, { recursive: true, force: true })
  }
  async function selected(request: Pick<FastifyRequest, 'headers'>, id: string, command: string) {
    const owner = kubernetesOwner(db, request)
    authorizeKubernetesOwner(db, owner, adapter, command)
    const session = sessions.get(id)
    if (!session || session.owner.user !== owner.user || session.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    try { access(session) } catch (error) { await stop(session, 'cancelled'); throw error }
    return session
  }
  const view = (session: Session) => ({ id: session.id, operation: session.kind, state: session.state,
    expiresAt: session.expiresAt, nextSequence: session.sequence, exitCode: session.exitCode ?? null,
    stdoutEOF: !active(session), stderrEOF: !active(session),
    outputBytes: session.offsets, truncated: session.truncated, limits: { outputBytes: session.limit },
    ...(session.kind === 'port-forward' ? { remotePorts: session.approvedPorts,
      tunnelReady: session.state === 'running' && session.approvedPorts.length > 0 && session.ports.size === session.approvedPorts.length } : {}),
    ...(session.preview ? { preview: session.preview } : {}), ...(session.code ? { code: session.code } : {}),
    ...(session.result ? { result: session.result } : {}), ...(session.artifacts ? { artifacts: session.artifacts } : {}) })
  async function execute(session: Session, input: Input, request: FastifyRequest) {
    try {
      await runner.runManaged(session.owner.user, session.controller.signal, async signal => {
        access(session)
        const binding = kubernetesBinding(db, session.owner, session.kind)
        const credential = await resolver.resolve(session.owner.user, 'kubernetes-axi')
        if (credential.id !== binding.credential.id || credential.revision !== binding.credential.revision) throw new ArtiumError('REVISION_CONFLICT')
        const prepared = await adapter.prepare(['version'], credential)
        if (typeof prepared.limits.systemCaBundle !== 'object') throw new ArtiumError('CREDENTIAL_INVALID')
        const trustPem = runner.caBundleFor(prepared.limits.systemCaBundle.endpoint, readCredentialTrust(db, credential))
        let scanner: SecretScanner | undefined = new SecretScanner(prepared.secrets)
        let metadataScanner: SecretScanner | undefined = new SecretScanner(prepared.secrets)
        if (metadataScanner.scan('stdout', Buffer.from(JSON.stringify(input)))) throw new ArtiumError('INVALID_INPUT')
        // Each operation has isolated config/state/cache directories and only its selected SecretRefs.
        const directories: Record<string, string> = {}
        for (const [name, leaf] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state',
          XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime' })) {
          directories[name] = join(session.directory, leaf)
          await mkdir(directories[name], { mode: 0o700 })
        }
        for (const file of prepared.files) {
          const path = join(directories.XDG_CONFIG_HOME, file.name)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          let content = file.content
          if (file.name === 'kubernetes-axi/config.json') {
            const profile = JSON.parse(Buffer.from(content).toString('utf8'))
            profile.profiles.artium.certificateAuthority += '\n' + trustPem
            content = JSON.stringify(profile)
          }
          await writeFile(path, content, { mode: 0o600, flag: 'wx' })
        }
        if (input.inputArtifact) await workspaces.materializeFile(request, input.inputArtifact.workspace, input.inputArtifact.path, join(session.directory, 'stdin.bin'), `session start ${input.kind}`)
        let argv = input.argv
        if (input.workspace) {
          const destination = join(session.directory, 'workspace')
          await workspaces.materialize(request, input.workspace, destination, `session start ${input.kind}`)
          const materialize = (value: string) => value.split(',').map(value => value.startsWith('workspace:')
            ? join(destination, kubernetesWorkspacePath.parse(value.slice(10))) : value).join(',')
          const commandSeparator = argv.indexOf('--', argv[0] === 'prepare' ? 2 : 0)
          argv = argv.map((arg, index) => {
            if (commandSeparator >= 0 && index > commandSeparator) return arg
            const flag = /^(--(?:filename|kustomize|patch-file)=|-[fk]=?)(.+)$/.exec(arg)
            return flag ? flag[1] + materialize(flag[2]) : input.kind === 'cp'
              || ['-f', '--filename', '-k', '--kustomize', '--patch-file'].includes(argv[index - 1]) ? materialize(arg) : arg
          })
        }
        access(session)
        if (signal.aborted) throw new ArtiumError('CANCELLED')
        const child = spawn(process.execPath, [join(dirname(adapter.executable), '../dist/hosted-session.js')], {
          detached: true, cwd: directories.HOME, env: { ...prepared.environment, ...directories,
            TMPDIR: session.directory, PATH: runtimePath, NODE_OPTIONS: '--max-old-space-size=256',
            KUBERNETES_AXI_READ_ONLY: String(['logs', 'watch'].includes(session.kind)),
            KUBERNETES_AXI_COLLECTION_DELETE: String(binding.settings.collectionDelete === true) },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        session.child = child
        const kill = () => {
          if (!child.pid) return
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
        let force: NodeJS.Timeout | undefined
        const cancel = () => {
          if (active(session)) session.state = 'cancelled'
          if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
          force ??= setTimeout(kill, 500)
        }
        const failure = () => { session.state = 'failed'; session.code ??= 'SPAWN_FAILED'; cancel() }
        const unexpected = () => { session.code = 'INVALID_OUTPUT'; failure() }
        const receive = (raw: unknown) => {
          try {
            access(session)
            if (!active(session) || !scanner || !metadataScanner) return
            if (Buffer.byteLength(JSON.stringify(raw)) > 2 * 1024 * 1024) throw new Error('IPC bound')
            const event = messageSchema.parse(raw)
            if (event.event === 'output') {
              const bytes = Buffer.from(event.base64, 'base64')
              if (scanner.scan(event.channel, bytes)) throw new Error('Credential output')
              session.offsets[event.channel] += bytes.length
              if (session.offsets.stdout + session.offsets.stderr > 64 * 1024 * 1024) throw new Error('Output bound')
              session.chunks.push({ channel: event.channel, sequence: session.sequence++, offset: session.offsets[event.channel] - bytes.length,
                length: bytes.length, base64: event.base64 }); session.retained += bytes.length
              while (session.retained > session.limit && session.chunks.length) {
                const first = session.chunks[0], excess = session.retained - session.limit
                if (excess < first.length) { first.base64 = Buffer.from(first.base64, 'base64').subarray(excess).toString('base64'); first.offset += excess; first.length -= excess; session.retained -= excess }
                else session.retained -= session.chunks.shift()!.length
                session.truncated = true
              }
            } else {
              if (metadataScanner.scan('stdout', Buffer.from(JSON.stringify(event)))) throw new Error('Credential metadata')
              if (event.event === 'prepared') {
                if (session.state !== 'starting' || typeof event.preview.digest !== 'string' || !/^[a-f0-9]{64}$/.test(event.preview.digest)) throw new Error('Preview state')
                if (session.kind === 'port-forward') {
                  const { execution } = z.object({ execution: z.object({ argv: z.array(z.string()) }) }).parse(event.preview)
                  const end = execution.argv.indexOf('--namespace')
                  const ports = execution.argv.slice(2, end).map(value => {
                    const match = /^0:([1-9][0-9]{0,4})$/.exec(value)
                    if (!match || Number(match[1]) > 65535) throw new Error('Invalid native port')
                    return Number(match[1])
                  })
                  if (execution.argv[0] !== 'port-forward' || end < 3 || !ports.length || ports.length > 8 || new Set(ports).size !== ports.length) throw new Error('Invalid native ports')
                  session.approvedPorts = ports
                }
                const display = (value: unknown): unknown => typeof value === 'string'
                  ? value.replaceAll(join(session.directory, 'workspace') + '/', 'workspace:').replaceAll(session.directory, '[private session]')
                  : Array.isArray(value) ? value.map(display) : value !== null && typeof value === 'object'
                    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, display(item)])) : value
                session.preview = { ...display(event.preview) as Record<string, unknown>,
                  help: [`artium-axi kubernetes-axi session confirm ${session.id} --digest ${event.preview.digest}`] }
                session.digest = event.preview.digest; session.state = 'prepared'; session.acknowledge()
              } else if (event.event === 'running') { session.state = 'running'; session.acknowledge() }
              else if (event.event === 'ports') {
                if (session.kind !== 'port-forward' || session.state !== 'running' || !session.confirmed
                  || event.ports.some(port => !session.approvedPorts.includes(port.remote))
                  || new Set(event.ports.map(port => port.remote)).size !== event.ports.length) throw new Error('Unexpected native ports')
                session.ports = new Map(event.ports.map(port => [port.remote, port.local]))
                if (session.ports.size === session.approvedPorts.length) session.portsAcknowledge()
              }
              else if (event.event === 'result') session.result = event.value
              else if (event.event === 'artifacts') session.artifacts = event.files
              else if (event.event === 'exit') { session.exitCode = event.exitCode; session.state = event.exitCode === 0 ? 'exited' : 'failed' }
              else { session.code = event.code; failure() }
            }
            session.changed.emit('change')
          } catch { session.code = 'OUTPUT_REFUSED'; session.chunks = []; session.retained = 0; failure() }
        }
        child.on('message', receive); child.once('error', failure)
        child.stdout!.on('data', unexpected); child.stderr!.on('data', unexpected)
        signal.addEventListener('abort', cancel, { once: true })
        try {
          await new Promise<void>(resolve => {
            child.once('close', () => { if (active(session)) { session.state = 'failed'; session.code = 'PROCESS_SIGNAL' }; resolve() })
            child.send({ action: 'start', args: argv, ...(input.inputArtifact ? { inputFile: 'stdin.bin' }
              : { stdinBase64: input.stdinBase64 ?? '' }), timeoutMs: session.expiresAt - Date.now() }, error => { if (error) failure() })
          })
        } finally {
          kill(); clearTimeout(force); signal.removeEventListener('abort', cancel)
          child.off('message', receive); child.off('error', failure)
          child.stdout!.off('data', unexpected); child.stderr!.off('data', unexpected)
          scanner = undefined; metadataScanner = undefined; session.child = undefined
        }
      }, !!session.owner.delegation)
    } catch (error) { if (active(session)) { session.state = 'failed'; session.code ??= error instanceof ArtiumError ? error.code : 'SESSION_FAILED' } }
    finally {
      if (session.kind === 'port-forward') {
        session.controller.abort()
        await Promise.allSettled([...session.tunnels])
      }
      try {
        if (session.state !== 'exited') await rm(session.directory, { recursive: true, force: true })
        else for (const name of await readdir(session.directory)) if (name !== 'artifacts') await rm(join(session.directory, name), { recursive: true, force: true })
        audit.record({ event: 'run-terminal', userId: session.owner.user, delegationId: session.owner.delegation?.id, tool: 'kubernetes-axi', requestId: request.id,
          credentialId: session.credentialId, instance: session.instance,
          clientAddress: request.ip, outcome: session.state === 'exited' ? 'completed' : 'interrupted',
          exitCode: session.exitCode ?? null, durationMs: Date.now() - session.startedAt, outputBytes: session.offsets })
      } catch { session.state = 'failed'; session.code = 'AUDIT_UNAVAILABLE' }
      session.acknowledge(); session.portsAcknowledge(); session.changed.emit('change')
    }
  }
  app.get(prefix, async (request, reply) => {
    const owner = kubernetesOwner(db, request)
    authorizeKubernetesOwner(db, owner, adapter, 'session list')
    await reconcile()
    const owned = [...sessions.values()].filter(session => session.owner.user === owner.user && session.owner.family === owner.family)
    return reply.header('cache-control', 'no-store').send({ sessions: owned.map(session => ({ id: session.id,
      operation: session.kind, state: session.state, expiresAt: session.expiresAt })), count: owned.length })
  })
  app.post(prefix, async (request, reply) => {
    const owner = kubernetesOwner(db, request)
    const parsed = kubernetesSessionStart.safeParse(request.body)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const input = parsed.data
    authorizeKubernetesOwner(db, owner, adapter, `session start ${input.kind}`)
    if (owner.delegation && input.kind === 'create') {
      const operation = classifyDelegatedCommand(adapter, input.argv)
      if (credentialIssuingCommand(adapter.name, operation.command)) checkDelegation(owner.delegation.scopeJson, owner.delegation.readOnly, adapter, operation.command, 'write')
    }
    const binding = kubernetesBinding(db, owner, input.kind), policy = binding.settings.sessions!
    const instance = (db.prepare('SELECT name FROM credentials WHERE id = ?').get(binding.credential.id) as { name: string } | undefined)?.name
    admitted.set(request, { credentialId: binding.credential.id, instance })
    const writing = !['watch', 'logs'].includes(input.kind), command = input.kind === 'watch' ? 'get' : input.kind
    if (writing ? input.argv[0] !== 'prepare' || input.argv[1] !== '--' || input.argv[2] !== command : input.argv[0] !== command) throw new ArtiumError('INVALID_INPUT')
    const lifetime = input.limits.lifetimeSeconds ?? Math.min(300, policy.lifetimeSeconds ?? 1800)
    const limit = input.limits.outputBytes ?? policy.outputBytes ?? 1048576
    if (lifetime > (policy.lifetimeSeconds ?? 1800) || limit > (policy.outputBytes ?? 1048576)) throw new ArtiumError('INVALID_INPUT')
    await initialized
    const owned = [...sessions.values()].filter(entry => entry.owner.user === owner.user)
    if (sessions.size >= runnerLimits.globalCalls || owned.length >= runnerLimits.userCalls ||
      owner.delegation && owned.filter(entry => entry.owner.delegation).length >= 2) throw new ArtiumError('TOO_MANY_CALLS')
    const directory = join(root, 'session-' + randomUUID())
    let acknowledge!: () => void
    let portsAcknowledge!: () => void
    const session: Session = { id: randomUUID(), owner, kind: input.kind, binding: binding.hash, credentialId: binding.credential.id, instance, directory, state: 'starting',
      expiresAt: Date.now() + lifetime * 1000, startedAt: Date.now(), controller: new AbortController(), job: Promise.resolve(),
      changed: new EventEmitter(), active: new Set(), ready: new Promise(resolve => { acknowledge = resolve }), acknowledge: () => acknowledge(),
      confirmed: false, chunks: [], sequence: 1, offsets: { stdout: 0, stderr: 0 }, retained: 0, limit, truncated: false,
      approvedPorts: [], ports: new Map(), tunnels: new Set(), usedConnections: new Set(), activeConnections: new Set(),
      portsReady: new Promise(resolve => { portsAcknowledge = resolve }), portsAcknowledge: () => portsAcknowledge(),
      timer: setTimeout(() => {}, 0) }
    clearTimeout(session.timer)
    sessions.set(session.id, session)
    try {
      await mkdir(directory, { mode: 0o700 })
      access(session)
      audit.record({ event: 'run-start', userId: owner.user, delegationId: owner.delegation?.id, tool: 'kubernetes-axi', requestId: request.id,
        credentialId: session.credentialId, instance: session.instance,
        clientAddress: request.ip, outcome: 'started', args: [input.kind], sensitive: { flags: [], positions: [] } })
      session.job = execute(session, input, request)
      session.timer = setTimeout(() => { void stop(session, 'expired').then(() => sessions.delete(session.id)) }, lifetime * 1000)
      session.timer.unref()
      await session.ready
      if (!active(session)) await session.job
      access(session)
      return reply.header('cache-control', 'no-store').send(view(session))
    } catch (error) { await stop(session, 'failed'); sessions.delete(session.id); throw error }
  })
  app.get<{ Params: { id: string } }>(`${prefix}/:id`, async (request, reply) => {
    const parsed = z.strictObject({ wait: z.enum(['true', 'false', 'ready']).default('false'),
      operation: z.enum(['show', 'artifact', 'tunnel']).default('show') }).safeParse(request.query)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const command = parsed.data.operation === 'tunnel' ? 'tunnel' : `session ${parsed.data.operation}`
    const session = await selected(request, request.params.id, command)
    if (parsed.data.wait === 'ready') {
      if (session.kind !== 'port-forward' || !session.confirmed) throw new ArtiumError('INVALID_INPUT')
      await session.portsReady
    }
    if (parsed.data.wait === 'true' || !active(session)) await session.job
    await selected(request, session.id, command); record(request, session, parsed.data.operation)
    return reply.header('cache-control', 'no-store').send(view(session))
  })
  app.post<{ Params: { id: string } }>(`${prefix}/:id/confirm`, async (request, reply) => {
    const session = await selected(request, request.params.id, 'session confirm')
    const parsed = z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request.body)
    if (!parsed.success || parsed.data.digest !== session.digest) throw new ArtiumError('INVALID_INPUT')
    record(request, session, 'confirm')
    if (!session.confirmed) {
      if (session.state !== 'prepared' || !session.child?.connected) throw new ArtiumError('INVALID_INPUT')
      session.confirmed = true
      session.child.send({ action: 'confirm', digest: parsed.data.digest }, error => { if (error) { void stop(session, 'failed') } })
    }
    return reply.header('cache-control', 'no-store').send(view(session))
  })
  app.get<{ Params: { id: string } }>(`${prefix}/:id/output`, async (request, reply) => {
    const session = await selected(request, request.params.id, 'session output')
    const parsed = z.strictObject({ after: z.coerce.number().int().min(0).default(0), wait: z.enum(['true', 'false']).default('false') }).safeParse(request.query)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    if (parsed.data.wait === 'true' && active(session) && !session.chunks.some(chunk => chunk.sequence > parsed.data.after)) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); session.changed.off('change', changed); resolve() }
        const changed = () => { if (!active(session) || session.chunks.some(chunk => chunk.sequence > parsed.data.after)) finish() }
        const timer = setTimeout(finish, 20000)
        session.changed.on('change', changed)
      })
    }
    if (!active(session)) await session.job
    await selected(request, session.id, 'session output')
    record(request, session, 'output')
    return reply.header('cache-control', 'no-store').send({ ...view(session), chunks: session.chunks.filter(chunk => chunk.sequence > parsed.data.after) })
  })
  app.delete<{ Params: { id: string } }>(`${prefix}/:id`, async (request, reply) => {
    const session = await selected(request, request.params.id, 'session cancel')
    await stop(session, 'cancelled'); record(request, session, 'cancel')
    sessions.delete(session.id); clearTimeout(session.timer)
    return reply.code(204).send()
  })
  app.get<{ Params: { id: string, '*': string } }>(`${prefix}/:id/artifacts/*`, async (request, reply) => {
    const session = await selected(request, request.params.id, 'session artifact')
    const { bytes, sha256 } = await kubernetesByteLease(session, async () => {
      await session.job; access(session)
      const file = session.artifacts?.find(file => file.path === request.params['*'])
      if (session.state !== 'exited' || !file || request.headers.range) throw new ArtiumError('NOT_FOUND')
      const reference = await resolver.resolve(session.owner.user, 'kubernetes-axi')
      const prepared = await adapter.prepare(['version'], reference)
      const source = await open(join(session.directory, 'artifacts', file.path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await source.stat()
        if (!info.isFile() || info.size !== file.bytes) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
        const bytes = await source.readFile()
        access(session)
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256 || new SecretScanner(prepared.secrets).scan('stdout', bytes)) throw new ArtiumError('SECRET_IN_OUTPUT')
        record(request, session, 'artifact')
        return { bytes, sha256: file.sha256 }
      } finally { await source.close() }
    })
    access(session)
    return sendKubernetesBytes(reply, session, bytes, sha256)
  })
  const reconcile = async () => {
    for (const session of sessions.values()) {
      try { access(session) } catch { await stop(session, 'cancelled'); sessions.delete(session.id); clearTimeout(session.timer) }
    }
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000)
  monitor.unref(); app.addHook('onSend', reconcile)
  app.server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith(prefix + '/')) return
    void (async () => {
      const match = new RegExp(`^${prefix}/([a-f0-9-]{36})/tunnel$`).exec(request.url ?? '')
      const key = request.headers['sec-websocket-key'], version = request.headers['x-artium-cli-version']
      if (!match || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket'
        || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string'
        || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16 || request.headers.origin) throw new ArtiumError('INVALID_INPUT')
      if (version !== undefined && (typeof version !== 'string' || !acceptsCliVersion(version))) throw new ArtiumError('CLI_OUTDATED')
      if (!trustedProxies.includes(request.socket.remoteAddress ?? '') && Object.keys(request.headers).some(name =>
        name === 'forwarded' || name.startsWith('x-forwarded-'))) throw new ArtiumError('PROXY_HEADERS_UNTRUSTED')
      const session = await selected(request, match[1], 'tunnel')
      if (session.kind !== 'port-forward' || session.state !== 'running' || !session.approvedPorts.length
        || session.ports.size !== session.approvedPorts.length || session.tunnels.size >= 4) throw new ArtiumError('INVALID_INPUT')
      audit.record({ event: 'admin-change', userId: session.owner.user, delegationId: session.owner.delegation?.id, tool: 'kubernetes-axi', requestId: randomUUID(),
        clientAddress: request.socket.remoteAddress ?? null, outcome: 'success', action: 'kubernetes-session-tunnel', targetId: session.id })
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nX-Artium-Remote-Ports: ${session.approvedPorts.join(',')}\r\n\r\n`)
      const drained = attachKubernetesTunnel(socket, head, session.id, session.ports, session.usedConnections,
        session.activeConnections, session.controller.signal, () => {
          kubernetesOwner(db, request); access(session)
        })
      session.active.add(drained)
      session.tunnels.add(drained)
      void drained.then(() => { session.tunnels.delete(drained); session.active.delete(drained) })
    })().catch(error => {
      try {
        let userId: string | null = null, delegationId: string | undefined, familyId: string | undefined
        try { const principal = verifyPrincipal(db, /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''); userId = principal.userId; delegationId = principal.delegation?.id; familyId = principal.familyId } catch { /* Unverified callers remain unattributed. */ }
        const id = new RegExp(`^${prefix}/([a-f0-9-]{36})/tunnel$`).exec(request.url ?? '')?.[1], session = id ? sessions.get(id) : undefined
        const identity = session && session.owner.user === userId && session.owner.family === familyId ? { credentialId: session.credentialId, instance: session.instance } : {}
        audit.record({ ...identity, event: 'denial', userId, delegationId, tool: 'kubernetes-axi', requestId: randomUUID(),
          clientAddress: request.socket.remoteAddress ?? null, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      } catch { socket.destroy() }
    })
  })
  app.addHook('onError', async (request, _reply, error) => {
    if (!request.url.startsWith('/v1/tools/kubernetes-axi/')) return
    let userId: string | null = null, delegationId: string | undefined, familyId: string | undefined
    try { const principal = verifyPrincipal(db, /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''); userId = principal.userId; delegationId = principal.delegation?.id; familyId = principal.familyId } catch { /* Unverified callers remain unattributed. */ }
    const id = request.url.startsWith(prefix + '/') ? (request.params as { id?: string } | undefined)?.id : undefined
    const session = id ? sessions.get(id) : undefined
    const candidates = userId && request.method === 'POST' && request.url.split('?')[0] === prefix
      ? db.prepare("SELECT id, name FROM credentials WHERE tool = 'kubernetes-axi' AND enabled = 1 LIMIT 2").all() as { id: string, name: string }[] : []
    const identity = admitted.get(request) ?? (session && session.owner.user === userId && session.owner.family === familyId
      ? { credentialId: session.credentialId, instance: session.instance }
      : candidates.length === 1 ? { credentialId: candidates[0]!.id, instance: candidates[0]!.name } : {})
    audit.record({ ...identity, event: 'denial', userId, delegationId, tool: 'kubernetes-axi', requestId: request.id,
      clientAddress: request.ip, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
  })
  app.addHook('preClose', async () => {
    clearInterval(monitor)
    for (const session of sessions.values()) clearTimeout(session.timer)
    await Promise.all([...sessions.values()].map(session => stop(session, 'cancelled')))
    sessions.clear(); await rm(root, { recursive: true, force: true })
  })
}
