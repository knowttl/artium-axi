import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { decode } from '@toon-format/toon'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { transferLimits } from '../shared/api.js'
import { acceptsCliVersion } from '../shared/version.js'
import { ProxmoxFrameMeter, ProxmoxStreamWire, proxmoxStreamStart } from '../shared/proxmox-stream.js'
import type { ProxmoxAdapter, ProxmoxStreamSelection } from './adapters/proxmox.js'
import { hostedStatus } from './adapters/hosted-status.js'
import type { Audit } from './audit/audit.js'
import { delegationPaused, verifyPrincipal } from './auth/tokens.js'
import { authorizeDelegatedOperation, classifyDelegatedCommand, credentialIssuingCommand } from './auth/delegations.js'
import { protectedResultLimits } from './config.js'
import { checkToolPolicy } from './policy/policy.js'
import type { IdentityResolver } from './policy/identity-resolver.js'
import type { ProtectedResults, ResultScope } from './protected-results.js'
import { ProxmoxAccess, proxmoxTrust } from './runner/proxmox.js'
import { RunnerError, type Runner } from './runner/runner.js'
import { readCredentialTrust } from './store/trusted-certificates.js'
import { toolFailureCode } from './health/diagnostic.js'

type Input = z.infer<typeof proxmoxStreamStart>
const perUserStreams = 2
const delegatedStreams = 1
type Delegation = NonNullable<ReturnType<typeof verifyPrincipal>['delegation']>
interface Lease {
  id: string, owner: ResultScope & { familyId: string, trustRevision: string, delegation?: Delegation }, selection: ProxmoxStreamSelection,
  instance?: string,
  input: Input, directory: string, expiresAt: number, controller: AbortController, timer: NodeJS.Timeout,
  file?: FileHandle, received: number, hash: ReturnType<typeof createHash>, ended: boolean,
  socket?: Duplex, native?: Duplex, job?: Promise<void>, receiving: Promise<void>, cleaning?: Promise<void>,
  delivered: Promise<void>, acknowledge: () => void, accepted: boolean, resultSent: boolean, succeeded: boolean,
  reservation?: ReturnType<ProtectedResults['reserve']>,
  validateNative?: () => void,
}

export function registerProxmoxStreams(app: FastifyInstance, db: Database.Database, resolver: IdentityResolver,
  adapter: ProxmoxAdapter, runner: Runner, access: ProxmoxAccess, results: ProtectedResults, audit: Audit,
  environment: NodeJS.ProcessEnv, proxies: readonly string[]) {
  const positive = (name: string, fallback: number, maximum: number) => {
    const value = Number(environment[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid Proxmox stream limits')
    return value
  }
  const bytes = positive('ARTIUM_PVE_TRANSFER_BYTES', 8 * 1024 ** 3, 8 * 1024 ** 3)
  const streamMs = positive('ARTIUM_PVE_STREAM_MS', 300000, 1800000)
  const limits = { bytes, streamMs, idleMs: positive('ARTIUM_PVE_DUPLEX_IDLE_MS', 30000, 1800000),
    duplexBytes: Math.min(bytes, 64 * 1024 ** 2), uploadBytes: Math.min(bytes, transferLimits.artifactBytes),
    spiceBytes: Math.min(bytes, protectedResultLimits.bytes), perUser: perUserStreams, total: 16, frameBytes: 1048576 }
  const leases = new Map<string, Lease>(), prefix = '/v1/tools/proxmox-axi/streams'
  const admitted = new WeakMap<FastifyRequest, { credentialId: string, instance?: string }>()
  app.addHook('onError', async (request, _reply, error) => {
    if (!request.url.split('?')[0].startsWith(prefix)) return
    let userId: string | null = null, delegationId: string | null = null, familyId: string | undefined
    try {
      const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
      const principal = verifyPrincipal(db, token)
      userId = principal.userId; delegationId = principal.delegation?.id ?? null; familyId = principal.familyId
    } catch { /* Unauthenticated denials have no actor. */ }
    const id = (request.params as { id?: string } | undefined)?.id
    const lease = id ? leases.get(id) : undefined
    const candidates = userId && request.method === 'POST' && request.url.split('?')[0] === prefix
      ? db.prepare("SELECT id, name FROM credentials WHERE tool = 'proxmox-axi' AND enabled = 1 LIMIT 2").all() as { id: string, name: string }[] : []
    const identity = admitted.get(request) ?? (lease && userId === lease.owner.userId && familyId === lease.owner.familyId
      ? { credentialId: lease.owner.credential.id, instance: lease.instance }
      : candidates.length === 1 ? { credentialId: candidates[0]!.id, instance: candidates[0]!.name } : {})
    audit.record({ ...identity, event: 'denial', userId, delegationId, tool: 'proxmox-axi', requestId: request.id,
      clientAddress: request.ip, outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
  })
  const root = join(dirname(db.name), 'tool-logs', 'proxmox-axi', 'byte-streams')
  const initialized = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(root)) if (name.startsWith('stream-')) await rm(join(root, name), { recursive: true, force: true })
  })()
  app.addHook('onReady', () => initialized)
  const caller = (request: Pick<FastifyRequest, 'headers'>) => {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const { userId, familyId, delegation } = verifyPrincipal(db, token)
    checkToolPolicy(db, userId, 'proxmox-axi')
    return { userId, familyId, ...(delegation ? { delegation } : {}) }
  }
  const authorize = (lease: Lease) => {
    if (lease.controller.signal.aborted || lease.expiresAt <= Date.now() || !access.valid(lease.owner)) throw new ArtiumError('TOKEN_INVALID')
    const { delegation, userId } = lease.owner
    if (delegation) {
      if (delegation.expiresAt <= Date.now() || delegationPaused(db, userId) || !db.prepare(
        'SELECT 1 FROM delegations WHERE id=? AND creator_id=? AND revoked_at IS NULL AND expires_at>?',
      ).get(delegation.id, userId, Date.now())) throw new ArtiumError('TOKEN_INVALID')
      authorizeDelegatedOperation(db, userId, delegation, adapter, classifyDelegatedCommand(adapter, lease.input.args, { stdin: lease.input.stdin }))
      if (!lease.selection.preview && (lease.selection.duplex || lease.selection.spice)) {
        authorizeDelegatedOperation(db, userId, delegation, adapter, { command: 'result take', effect: 'write' })
      }
    }
  }
  const cleanup = (lease: Lease) => lease.cleaning ??= (async () => {
    lease.controller.abort(); lease.socket?.destroy(); lease.acknowledge()
    await Promise.allSettled([lease.receiving])
    await lease.file?.close(); lease.file = undefined
    await rm(lease.directory, { recursive: true, force: true })
    if (!lease.succeeded) lease.reservation?.cancel()
    clearTimeout(lease.timer); leases.delete(lease.id)
  })()
  const stop = async (lease: Lease) => {
    lease.controller.abort(); lease.socket?.destroy(); lease.acknowledge()
    await lease.job
    await cleanup(lease)
  }
  const reconcile = async () => {
    await Promise.all([...leases.values()].map(async lease => { try { authorize(lease) } catch { await stop(lease) } }))
  }
  const select = (request: Pick<FastifyRequest, 'headers'>, id: string) => {
    const owner = caller(request), lease = leases.get(id)
    if (!lease || lease.owner.userId !== owner.userId || lease.owner.familyId !== owner.familyId) throw new ArtiumError('NOT_FOUND')
    authorize(lease)
    return lease
  }
  app.get(prefix + '/limits', async request => {
    const owner = caller(request)
    if (owner.delegation) authorizeDelegatedOperation(db, owner.userId, owner.delegation, adapter, { command: 'stream limits', effect: 'read' })
    return limits
  })
  app.post(prefix, async (request, reply) => {
    const owner = caller(request), parsed = proxmoxStreamStart.safeParse(request.body)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    const input = parsed.data
    if (owner.delegation) authorizeDelegatedOperation(db, owner.userId, owner.delegation, adapter, classifyDelegatedCommand(adapter, input.args, { stdin: input.stdin }))
    const credential = await resolver.resolve(owner.userId, 'proxmox-axi')
    const instance = (db.prepare('SELECT name FROM credentials WHERE id = ?').get(credential.id) as { name: string } | undefined)?.name
    admitted.set(request, { credentialId: credential.id, instance })
    const selection = adapter.inspectStream(input.args, credential, { stdin: input.stdin })
    if (selection.upload !== !!input.source || input.source && input.source.bytes > limits.uploadBytes) throw new ArtiumError('INVALID_INPUT')
    await initialized
    const sourceBytes = [...leases.values()].reduce((sum, lease) => sum + (lease.input.source?.bytes ?? 0), 0)
    const owned = [...leases.values()].filter(lease => lease.owner.userId === owner.userId)
    if (leases.size >= limits.total || owned.length >= perUserStreams || owner.delegation && owned.filter(lease => lease.owner.delegation).length >= delegatedStreams
      || input.source && (sourceBytes + input.source.bytes > transferLimits.reservedBytes
        || [...leases.values()].filter(lease => lease.input.source).length >= transferLimits.reservations)) throw new ArtiumError('TOO_MANY_CALLS')
    const id = randomUUID(), scope = { ...owner, delegated: !!owner.delegation, credential, operation: selection.operation, trustRevision: proxmoxTrust(db, credential) }
    let acknowledge!: () => void
    const lifetime = Math.min(streamMs, (selection.duplex || selection.spice) ? protectedResultLimits.lifetimeMs : streamMs)
    const lease: Lease = { id, owner: scope, selection, instance, input, directory: join(root, 'stream-' + id),
      expiresAt: Date.now() + lifetime, controller: new AbortController(), received: 0, hash: createHash('sha256'),
      ended: false, receiving: Promise.resolve(), delivered: new Promise(resolve => { acknowledge = resolve }),
      acknowledge: () => acknowledge(), accepted: false, resultSent: false, succeeded: false,
      timer: setTimeout(() => {}, 0) }
    clearTimeout(lease.timer)
    authorize(lease)
    if (!selection.preview && (selection.duplex || selection.spice)) lease.reservation = results.reserve(scope)
    leases.set(id, lease)
    try {
      await mkdir(lease.directory, { mode: 0o700 })
      if (input.source) lease.file = await open(join(lease.directory, 'source.bin'), 'wx', 0o600)
      authorize(lease)
      lease.timer = setTimeout(() => { void stop(lease).catch(() => {}) }, lifetime).unref()
      return reply.header('cache-control', 'no-store').send({ id, selection, limits, expiresAt: lease.expiresAt })
    } catch (error) { await cleanup(lease); throw error }
  })
  app.delete<{ Params: { id: string } }>(prefix + '/:id', async (request, reply) => {
    await stop(select(request, request.params.id)); return reply.code(204).send()
  })
  app.server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? ''
    if (!url.startsWith(prefix + '/')) return
    void (async () => {
      const match = new RegExp(`^${prefix}/([a-f0-9-]{36})/pipe$`).exec(url)
      const key = request.headers['sec-websocket-key'], version = request.headers['x-artium-cli-version']
      if (!match || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket'
        || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string'
        || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16 || request.headers.origin
        || request.headers['sec-websocket-extensions']) throw new ArtiumError('INVALID_INPUT')
      if (version !== undefined && (typeof version !== 'string' || !acceptsCliVersion(version))) throw new ArtiumError('CLI_OUTDATED')
      if (!proxies.includes(request.socket.remoteAddress ?? '') && Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) throw new ArtiumError('PROXY_HEADERS_UNTRUSTED')
      const lease = select(request, match[1])
      if (lease.socket) throw new ArtiumError('INVALID_INPUT')
      lease.socket = socket
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      const incoming = new ProxmoxFrameMeter(limits.duplexBytes), outgoing = new ProxmoxFrameMeter(limits.duplexBytes)
      let setupSending = Promise.resolve()
      const publish = (bytes: Buffer) => {
        authorize(lease)
        let reference: ReturnType<NonNullable<Lease['reservation']>['commit']>
        try { reference = lease.reservation!.commit(bytes) } finally { bytes.fill(0) }
        setupSending = wire.send({ type: 'control', value: { event: 'setup', result: reference } })
        void setupSending.catch(() => { lease.controller.abort(); socket.destroy() })
      }
      const launch = () => {
        lease.job = (async () => {
          let dispatched = false
          const started = Date.now()
          const command = classifyDelegatedCommand(adapter, lease.input.args, { stdin: lease.input.stdin }).command
          const credentialIssue = !!lease.owner.delegation && credentialIssuingCommand('proxmox-axi', command)
          const identity = { credentialId: lease.owner.credential.id, instance: lease.instance }
          const recordCredential = (outcome: 'attempt' | 'preview' | 'success') => audit.record({ event: 'credential-issue',
            ...identity,
            userId: lease.owner.userId, delegationId: lease.owner.delegation?.id, tool: 'proxmox-axi', requestId: lease.id,
            clientAddress: request.socket.remoteAddress ?? null, targetId: command, outcome })
          try {
            authorize(lease)
            if (credentialIssue) recordCredential(lease.selection.preview ? 'preview' : 'attempt')
            const prepared = await adapter.prepareStream(lease.input.args, lease.owner.credential, { stdin: lease.input.stdin })
            authorize(lease)
            if (lease.input.source) prepared.args.push('--input-file', join(lease.directory, 'source.bin'))
            const lifetime = lease.expiresAt - Date.now()
            const nativeLifetime = Math.min(streamMs, (lease.selection.duplex || lease.selection.spice) ? protectedResultLimits.lifetimeMs : streamMs)
            Object.assign(prepared.environment, { PROXMOX_AXI_TRANSFER_BYTES: String(limits.bytes), PROXMOX_AXI_TRANSFER_MS: String(nativeLifetime),
              PROXMOX_AXI_DUPLEX_BYTES: String(limits.duplexBytes), PROXMOX_AXI_DUPLEX_MS: String(nativeLifetime), PROXMOX_AXI_DUPLEX_IDLE_MS: String(limits.idleMs) })
            prepared.beforeSpawn = () => authorize(lease)
            lease.validateNative = () => prepared.beforeSpawn?.()
            audit.record({ event: 'run-start', userId: lease.owner.userId, delegationId: lease.owner.delegation?.id, tool: 'proxmox-axi', requestId: lease.id,
              ...identity,
              clientAddress: request.socket.remoteAddress ?? null, outcome: 'started',
              args: lease.input.args.slice(0, 3), sensitive: { positions: [], flags: [] } })
            let downloaded = 0
            const downloadHash = createHash('sha256')
            let result = await access.execute({ userId: lease.owner.userId, familyId: lease.owner.familyId,
              credential: lease.owner.credential, requestId: lease.id, signal: lease.controller.signal, delegated: !!lease.owner.delegation }, prepared,
            overrides => runner.run(lease.owner.userId, prepared.executable, prepared.args, prepared.environment, prepared.secrets,
              { ...prepared.limits, delegated: !!lease.owner.delegation, publicContent: prepared.publicContent, outputBytesPerStream: 32768,
                credentialTrust: readCredentialTrust(db, lease.owner.credential), timeoutMs: lifetime,
                bytePipe: { environment: 'PROXMOX_AXI_STREAM_FD', async connect(native, signal) {
                  lease.native = native
                  const cancel = () => { native.destroy(); socket.destroy() }
                  signal.addEventListener('abort', cancel, { once: true })
                  const parts: Buffer[] = []
                  let count = 0
                  try {
                    if (signal.aborted) throw new ArtiumError('CANCELLED')
                    await wire.send({ type: 'control', value: { event: 'running' } })
                    for await (const chunk of native) {
                      prepared.beforeSpawn?.()
                      const bytes = Buffer.from(chunk)
                      count += bytes.length
                      if (lease.selection.duplex) outgoing.add(bytes)
                      else if (count > (lease.selection.spice ? limits.spiceBytes : limits.bytes)) throw new ArtiumError('OUTPUT_LIMIT')
                      else { downloaded += bytes.length; downloadHash.update(bytes) }
                      if (lease.selection.spice) parts.push(bytes)
                      else for (let index = 0; index < bytes.length; index += 32768) await wire.send({ type: 'data', bytes: bytes.subarray(index, index + 32768) })
                    }
                    if (lease.selection.spice && !lease.selection.preview && count > 0) {
                      const bytes = Buffer.concat(parts), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
                      const lines = text.split(/\r?\n/)
                      if (!lines.some(line => line.trim() === '[virt-viewer]') || lines.some(line => line.trim() && !/^\s*(?:\[[^\]]+\]|[#;].*|[A-Za-z0-9_-]+\s*=.*)$/.test(line))) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
                      const values = lines.flatMap(line => { const match = /^\s*[A-Za-z0-9_-]+\s*=(.*)$/.exec(line); return match?.[1] ? [match[1]] : [] })
                      prepared.secrets.push(...values, ...values.map(value => value.replace(/\\([sntr\\])/g,
                        (_match, key: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[key as 's' | 'n' | 't' | 'r' | '\\'])))
                      // The native completion metadata is verified before committing this raw subtype below.
                      spice = bytes
                    }
                    await wire.send({ type: 'eof' })
                  } finally { for (const part of parts) part.fill(0); signal.removeEventListener('abort', cancel) }
                } }, ...overrides }, {}, prepared.files, () => { prepared.beforeSpawn?.(); dispatched = true }), publish)
            authorize(lease)
            if (result.truncated.stdout || result.truncated.stderr) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
            result = hostedStatus('proxmox-axi', prepared.invocation, result)
            if (result.exitCode === 0 && !lease.selection.preview) {
              const metadata = (result.stdout.trimStart().startsWith('{') ? JSON.parse(result.stdout) : decode(result.stdout)) as { transfer?: Record<string, unknown> }
              const transfer = metadata.transfer
              if (transfer?.status !== 'complete') throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
              if (lease.selection.upload) {
                if (transfer.bytes !== lease.input.source!.bytes || transfer.sha256 !== lease.input.source!.sha256) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
              } else if (!lease.selection.duplex && (transfer.bytes !== downloaded || transfer.sha256 !== downloadHash.digest('hex'))) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
              if (lease.selection.duplex) {
                const sent = incoming.finish(), received = outgoing.finish()
                if (transfer.sent !== sent.bytes || transfer.sentSha256 !== sent.sha256 || transfer.framesSent !== sent.frames
                  || transfer.received !== received.bytes || transfer.receivedSha256 !== received.sha256 || transfer.framesReceived !== received.frames) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
              }
              if (lease.selection.spice) {
                if (!spice || transfer.bytes !== spice.length || transfer.sha256 !== createHash('sha256').update(spice).digest('hex')) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
                publish(spice)
              }
            }
            await setupSending
            authorize(lease)
            lease.resultSent = true
            await wire.send({ type: 'control', value: { event: 'result', stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } })
            await lease.delivered
            authorize(lease)
            if (!lease.accepted) throw new ArtiumError('CANCELLED')
            lease.succeeded = result.exitCode === 0
            if (credentialIssue && lease.succeeded && !lease.selection.preview) recordCredential('success')
            const uncertain = ['WRITE_UNCERTAIN', 'DELIVERY_UNCERTAIN', 'OUTCOME_UNKNOWN'].includes(toolFailureCode(result.stdout, result.stderr) ?? '')
            audit.record({ event: 'run-terminal', userId: lease.owner.userId, delegationId: lease.owner.delegation?.id, tool: 'proxmox-axi', requestId: lease.id,
              ...identity,
              clientAddress: request.socket.remoteAddress ?? null, action: lease.selection.write && !lease.selection.preview ? result.exitCode === 0 ? 'write' : 'unknown' : 'read',
              outcome: uncertain ? 'UNKNOWN_OUTCOME' : 'completed', errorCode: toolFailureCode(result.stdout, result.stderr) ?? null,
              exitCode: result.exitCode, durationMs: Date.now() - started, outputBytes: result.outputBytes })
          } catch (error) {
            const uncertain = lease.selection.write && !lease.selection.preview && (error instanceof RunnerError ? error.processStarted : dispatched)
            const code = uncertain ? 'UNKNOWN_OUTCOME' : error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR'
            audit.record({ event: 'run-terminal', userId: lease.owner.userId, delegationId: lease.owner.delegation?.id, tool: 'proxmox-axi', requestId: lease.id,
              ...identity,
              clientAddress: request.socket.remoteAddress ?? null, action: uncertain ? 'unknown' : 'read', outcome: code,
              exitCode: null, durationMs: Date.now() - started, outputBytes: { stdout: 0, stderr: 0 } })
            if (!socket.destroyed) await wire.send({ type: 'control', value: { event: 'failed', code } }).catch(() => {})
          } finally { spice?.fill(0); await cleanup(lease) }
        })()
        void lease.job.catch(() => {})
      }
      let spice: Buffer | undefined
      const wire = new ProxmoxStreamWire(socket, true, packet => {
        lease.receiving = (async () => {
          authorize(lease)
          lease.validateNative?.()
          if (packet.type === 'control') {
            if (packet.value.event !== 'delivered' || !lease.resultSent || lease.accepted) throw new ArtiumError('INVALID_INPUT')
            lease.accepted = true; lease.acknowledge(); return
          }
          if (lease.input.source && !lease.ended) {
            if (packet.type === 'data') {
              lease.received += packet.bytes.length
              if (lease.received > lease.input.source.bytes) throw new ArtiumError('INVALID_INPUT')
              lease.hash.update(packet.bytes)
              await lease.file!.writeFile(packet.bytes)
            } else {
              if (lease.received !== lease.input.source.bytes || lease.hash.digest('hex') !== lease.input.source.sha256) throw new ArtiumError('INVALID_INPUT')
              await lease.file!.sync(); await lease.file!.close(); lease.file = undefined; lease.ended = true; launch()
            }
            return
          }
          if (!lease.selection.duplex || lease.selection.preview || !lease.native || lease.ended) throw new ArtiumError('INVALID_INPUT')
          if (packet.type === 'eof') { incoming.finish(); lease.ended = true; lease.native.end() }
          else { incoming.add(packet.bytes); await new Promise<void>((resolve, reject) => lease.native!.write(packet.bytes, error => error ? reject(error) : resolve())) }
        })()
        return lease.receiving
      }, head)
      socket.once('close', () => { void stop(lease).catch(() => {}) })
      if (!lease.input.source) launch()
    })().catch(error => {
      let userId: string | null = null, delegationId: string | null = null
      let identity: { credentialId?: string, instance?: string } = {}
      try {
        const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
        const owner = verifyPrincipal(db, token); userId = owner.userId; delegationId = owner.delegation?.id ?? null
        const id = new RegExp(`^${prefix}/([a-f0-9-]{36})/pipe$`).exec(url)?.[1], lease = id && leases.get(id)
        if (lease && lease.owner.userId === owner.userId && lease.owner.familyId === owner.familyId) identity = { credentialId: lease.owner.credential.id, instance: lease.instance }
      } catch { /* Unverified callers remain unattributed. */ }
      audit.record({ ...identity, event: 'denial', userId, delegationId, tool: 'proxmox-axi', requestId: randomUUID(), clientAddress: request.socket.remoteAddress ?? null,
        outcome: error instanceof ArtiumError ? error.code : 'INTERNAL_ERROR' })
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
  })
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000).unref()
  app.addHook('onSend', reconcile)
  app.addHook('preClose', async () => { clearInterval(monitor); await Promise.all([...leases.values()].map(stop)) })
}
