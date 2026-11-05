import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { toolAllowsWrites } from '../shared/api.js'
import { sshExecutionInput, sshExecutionStatus, type SshExecutionInput } from '../shared/ssh-execution.js'
import { ArtiumError } from '../shared/errors.js'
import { verifyFamilyPrincipal, verifyPrincipal } from './auth/tokens.js'
import { authorizeDelegatedOperation } from './auth/delegations.js'
import { checkToolPolicy } from './policy/policy.js'
import { sshBinding, type SshOwner as Owner } from './policy/ssh.js'
import { SshConnections } from './ssh-connections.js'
import { registerSshAudit } from './admin/ssh-audit.js'
import { createSshAdapter, sshProfile, verifySshArtifact } from './adapters/ssh.js'
import { toolPaths } from './config.js'
import { decryptCredential, encryptCredential, type EncryptedCredential } from './store/crypto.js'
import type { SshHosts } from './store/ssh-hosts.js'
import type { KeyProvider } from './store/key-provider.js'
import type { Runner } from './runner/runner.js'
import type { Audit } from './audit/audit.js'

export interface SshExecutionRow { id: string, request_key: string, input_hash: string, user_id: string, family_id: string,
  host_id: string, account: string, binding: string, command: string, sudo: number, request_id: string,
  started_at: number, finished_at: number | null, outcome: z.infer<typeof sshExecutionStatus>['outcome'], metadata: string }
type Row = SshExecutionRow
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const remoteCommand = (input: SshExecutionInput) => input.sudo ? `sudo -n -- /bin/sh -c '${input.command.replaceAll("'", "'\\''")}'` : input.command
const claimsSchema = z.object({ version: z.literal(1), keyId: z.string(), nonce: z.uuid(),
  user: z.string(), family: z.string(), input: z.string(), binding: z.string(), expires: z.number().int() }).strict()
const streamSchema = z.object({ text: z.string().max(8192), receivedBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().min(0).max(8192), truncated: z.boolean(), encodingLoss: z.boolean(), withheld: z.boolean(), unit: z.literal('bytes') })
const nativeResult = sshExecutionStatus.omit({ id: true, host: true }).extend({ address: z.string(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'timed_out', 'unknown']),
  stdout: streamSchema, stderr: streamSchema, durationMs: z.number().nonnegative(), diagnostic: z.string().optional() })

export interface SshExecutionOptions { provider: KeyProvider, writeLog: string, executable?: string }
export function registerSshExecutions(app: FastifyInstance, options: SshExecutionOptions & {
  db: Database.Database, hosts: SshHosts, runner: Runner, audit: Audit, environment: NodeJS.ProcessEnv,
  authorizeAdmin: (request: FastifyRequest) => string,
}): void {
  const { db, hosts, runner, audit, provider, writeLog, environment, executable = toolPaths['ssh-axi'] } = options
  const connections = new SshConnections(db, hosts, writeLog, executable)
  const adapter = createSshAdapter(hosts, writeLog, executable)
  const delegationId = (family: string) => (db.prepare('SELECT delegation_id FROM session_families WHERE id = ?').get(family) as { delegation_id: string | null }).delegation_id
  const active = new Map<string, { controller: AbortController, guard: () => void, done: Promise<void>, connection?: string }>()
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const authorize = (owner: Owner, command: string, effect: 'read' | 'write', setup = false) => {
    const principal = verifyFamilyPrincipal(db, owner.family)
    if (principal.userId !== owner.user) throw new ArtiumError('TOKEN_INVALID')
    checkToolPolicy(db, owner.user, 'ssh-axi')
    if (principal.delegation) {
      if (setup && principal.delegation.readOnly) throw new ArtiumError('DELEGATED_SCOPE_DENIED')
      authorizeDelegatedOperation(db, owner.user, principal.delegation, adapter, { command, effect })
    }
    return principal.delegation
  }
  const identity = (request: FastifyRequest, command: string, effect: 'read' | 'write' = 'read', setup = false): Owner => {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const principal = verifyPrincipal(db, token)
    const { userId: user, familyId: family } = principal
    authorize({ user, family }, command, effect, setup)
    prune()
    return { user, family }
  }
  const binding = (owner: Owner, input: SshExecutionInput) => {
    const tool = db.prepare("SELECT revision, native_settings FROM tools WHERE name='ssh-axi'").get() as { revision: number, native_settings: string }
    if (!toolAllowsWrites('ssh-axi', JSON.parse(tool.native_settings)) || environment.SSH_AXI_READ_ONLY && !['false', '0'].includes(environment.SSH_AXI_READ_ONLY)) throw new ArtiumError('FLAG_BLOCKED')
    const state = sshBinding(db, hosts, owner, input.host, input.sudo)
    const { selected } = state
    if (selected.read_only) throw new ArtiumError('FLAG_BLOCKED')
    if (input.timeout > selected.command_seconds || input.outputLimit > selected.output_bytes) throw new ArtiumError('INVALID_INPUT')
    return state
  }
  const scanner = () => import(pathToFileURL(join(dirname(executable), 'output.js')).href) as Promise<typeof import('../../tools/node_modules/@knowttl/ssh-axi/dist/output.js')>
  const admit = async (owner: Owner, raw: unknown) => {
    const input = parse(sshExecutionInput, raw)
    const state = binding(owner, input)
    if (input.connection) connections.assertAvailable(owner, input.host, input.connection, input.sudo)
    verifySshArtifact(executable)
    const credential = hosts.profile(owner.user, input.host, input.sudo)
    const profile = sshProfile.prepare('ssh-axi', credential, writeLog, false)
    try {
      const protection = await scanner()
      protection.checkCommand(input.command, profile.secrets)
      protection.checkCommand(remoteCommand(input), profile.secrets)
    }
    catch { throw new ArtiumError('INVALID_INPUT', 'Command is invalid or contains protected material; nothing was journaled or dispatched.') }
    if (binding(owner, input).hash !== state.hash) throw new ArtiumError('REVISION_CONFLICT')
    if (input.connection) connections.assertAvailable(owner, input.host, input.connection, input.sudo)
    return { input, state, profile }
  }
  const sign = (body: string) => createHmac('sha256', provider.getKey().bytes).update('ssh-execution-v1\0').update(body).digest('base64url')
  const verifyKey = (key: string, owner: Owner) => {
    const [body, signature, extra] = key.split('.')
    if (!body || !signature || extra || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(body)))) throw new ArtiumError('INVALID_INPUT')
    let raw: unknown
    try { raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { throw new ArtiumError('INVALID_INPUT') }
    const claims = parse(claimsSchema, raw)
    if (claims.keyId !== provider.getKey().id || claims.user !== owner.user || claims.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    return claims
  }
  const owned = (owner: Owner, selector: { id?: string, requestKey?: string }): Row => {
    const row = db.prepare(`SELECT * FROM ssh_executions WHERE user_id=? AND family_id=? AND ${selector.requestKey ? 'request_key' : 'id'}=?`)
      .get(owner.user, owner.family, selector.requestKey ?? selector.id) as Row | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    hosts.executionBinding(owner.user, row.host_id, Boolean(row.sudo))
    return row
  }
  const view = (row: Row, includeOutput = true) => {
    let result: Record<string, unknown> = JSON.parse(row.metadata)
    const encrypted = db.prepare('SELECT * FROM ssh_execution_results WHERE id=?').get(row.id) as EncryptedCredential | undefined
    if (encrypted && includeOutput) {
      const plain = decryptCredential(encrypted, provider.getKey())
      try { result = { ...result, ...JSON.parse(plain.toString('utf8')) } } finally { plain.fill(0) }
    }
    if (!includeOutput) {
      for (const stream of ['stdout', 'stderr']) if (result[stream] && typeof result[stream] === 'object') {
        const { text: _, ...counts } = result[stream] as Record<string, unknown>
        result[stream] = counts
      }
    }
    return { remoteExit: null, remoteSignal: null, termination: 'unknown', ...result,
      samples: !includeOutput ? 'omitted' : encrypted ? 'available' : row.finished_at === null ? 'pending' : 'unavailable-or-expired',
      id: row.id, host: row.host_id, account: row.account, sudo: Boolean(row.sudo), command: row.command,
      confirmed: true, requestId: row.request_id, startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
      outcome: row.outcome === 'running' && !active.has(row.id) ? 'unknown' : row.outcome,
      help: ['Inspect remote state before preparing another uncertain command. No automatic replay.', `artium-axi ssh-axi execution show ${row.id}`] }
  }
  const prune = () => db.transaction(() => {
    db.prepare('DELETE FROM ssh_execution_results WHERE updated_at<=?').run(Date.now() - 14 * 86400000)
    db.prepare('DELETE FROM ssh_executions WHERE finished_at<=?').run(Date.now() - 90 * 86400000)
    db.prepare('DELETE FROM ssh_connection_events WHERE occurred_at<=?').run(Date.now() - 90 * 86400000)
  }).immediate()
  prune()
  db.prepare("UPDATE ssh_executions SET outcome='unknown', finished_at=? WHERE outcome='running'").run(Date.now())
  audit.recoverInterrupted()

  const execute = async (row: Row, admitted: Awaited<ReturnType<typeof admit>>, controller: AbortController, guard: () => void) => {
    let result: Record<string, unknown> = { remoteExit: null, remoteSignal: null, termination: 'unknown', outcome: 'unknown',
      diagnostic: 'No proven remote result. Inspect remote state before preparing another command.' }
    try {
      const command = remoteCommand(admitted.input)
      const raw = admitted.input.connection ? await connections.execute({ user: row.user_id, family: row.family_id },
        row.host_id, admitted.input.connection, admitted.input.sudo, { command, timeout: admitted.input.timeout,
          outputLimit: Math.min(admitted.input.outputLimit, 8192) }, controller.signal, runner, guard)
        : JSON.parse((await runner.run(row.user_id, process.execPath, [executable, 'exec', row.host_id, '--confirm', '--json'],
        admitted.profile.environment, admitted.profile.secrets, { timeoutMs: (admitted.input.timeout + 18) * 1000, delegated: !!delegationId(row.family_id),
          signal: controller.signal, trustedIpc: { revision: 1, hosts: [{ id: row.host_id, address: admitted.state.selected.address,
            port: admitted.state.selected.port, username: row.account }], execution: { command,
            timeout: admitted.input.timeout, outputLimit: Math.min(admitted.input.outputLimit, 8192) } } }, {}, admitted.profile.files, guard)).stdout)
      const parsed = nativeResult.safeParse(raw)
      if (parsed.success) {
        result = parsed.data
        if (admitted.input.sudo && result.remoteExit !== 0 && /sudo:.*(?:password|terminal|tty|required|not allowed|not in the sudoers)/i.test(parsed.data.stderr.text)) {
          result = { ...result, code: 'SUDO_DENIED', diagnostic: 'The approved sudo account needs independently reviewed non-interactive passwordless authorization.' }
        }
      }
    } catch { /* A durable claim is never released, even without a proven remote result. */ }
    if (controller.signal.reason === 'user' && result.outcome === 'unknown') result.outcome = 'cancelled'
    const { stdout, stderr, ...metadata } = result
    const counts = (value: unknown) => value && typeof value === 'object' ? { ...value, text: '' } : undefined
    const plain = Buffer.from(JSON.stringify({ stdout, stderr }))
    try {
      const encrypted = encryptCredential(row.id, 'ssh-axi', plain, provider.getKey())
      audit.change({ event: 'run-terminal', userId: row.user_id, delegationId: delegationId(row.family_id), tool: 'ssh-axi', requestId: row.request_id,
        clientAddress: null, outcome: result.outcome === 'unknown' ? 'interrupted' : 'completed',
        action: result.outcome === 'unknown' ? 'unknown' : 'write', exitCode: typeof result.remoteExit === 'number' ? result.remoteExit : null,
        durationMs: Date.now() - row.started_at, outputBytes: { stdout: (stdout as { receivedBytes?: number } | undefined)?.receivedBytes ?? null,
          stderr: (stderr as { receivedBytes?: number } | undefined)?.receivedBytes ?? null } }, () => {
        db.prepare(`INSERT INTO ssh_execution_results (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag, updated_at, updated_by)
          VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag, @now, @user)`)
          .run({ ...encrypted, now: Date.now(), user: row.user_id })
        db.prepare('UPDATE ssh_executions SET metadata=?, outcome=?, finished_at=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(row.metadata), ...metadata, stdout: counts(stdout), stderr: counts(stderr) }), result.outcome, Date.now(), row.id)
      })
    } finally { plain.fill(0); active.delete(row.id) }
  }
  app.post('/v1/ssh/prepare', async request => {
    const owner = identity(request, 'exec', 'write')
    const admitted = await admit(owner, request.body)
    authorize(owner, 'exec', 'write')
    const body = Buffer.from(JSON.stringify({ version: 1, keyId: provider.getKey().id, nonce: randomUUID(), ...owner,
      input: hash(admitted.input), binding: admitted.state.hash, expires: Date.now() + 600000 })).toString('base64url')
    return { requestKey: `${body}.${sign(body)}`, host: admitted.input.host }
  })
  app.post('/v1/ssh/submit', async request => {
    const owner = identity(request, 'exec', 'write')
    const body = parse(z.object({ requestKey: z.string().min(1).max(4096), input: sshExecutionInput }).strict(), request.body)
    const existing = db.prepare('SELECT id FROM ssh_executions WHERE request_key=?').get(body.requestKey) as { id: string } | undefined
    if (existing) {
      const row = owned(owner, { id: existing.id })
      if (row.input_hash !== hash(body.input)) throw new ArtiumError('INVALID_INPUT')
      if (binding(owner, body.input).hash !== row.binding) throw new ArtiumError('REVISION_CONFLICT')
      return view(row)
    }
    const claims = verifyKey(body.requestKey, owner)
    const admitted = await admit(owner, body.input)
    authorize(owner, 'exec', 'write')
    if (claims.input !== hash(admitted.input) || claims.binding !== admitted.state.hash) throw new ArtiumError('REVISION_CONFLICT')
    if (claims.expires <= Date.now()) throw new ArtiumError('INVALID_INPUT', 'Unused execution preparation expired; prepare again only after inspecting remote state.')
    let created = false
    const row: Row = { id: `exec_${randomUUID()}`, request_key: body.requestKey, input_hash: claims.input,
      user_id: owner.user, family_id: owner.family, host_id: admitted.input.host, account: admitted.state.selected.username,
      binding: admitted.state.hash, command: admitted.input.command, sudo: Number(admitted.input.sudo), request_id: request.id,
      started_at: Date.now(), finished_at: null, outcome: 'running', metadata: JSON.stringify({
        connectionId: admitted.input.connection ?? null,
        owner: owner.user, sessionFamily: owner.family,
        endpoint: { address: admitted.state.selected.address, port: admitted.state.selected.port },
        binding: { hostRevision: admitted.state.selected.host_revision, bindingRevision: admitted.state.selected.binding_revision,
          credentialRevision: admitted.state.selected.credential_revision, credentialId: admitted.state.selected.credential_id },
      }) }
    const duplicateClaim = Symbol()
    try {
      audit.change({ event: 'run-start', userId: owner.user, delegationId: delegationId(owner.family), tool: 'ssh-axi', requestId: row.request_id,
        clientAddress: request.ip, outcome: 'started', args: ['exec', row.host_id, '--command', row.command, '--confirm'],
        sensitive: { flags: ['--command'], positions: [] } }, () => {
        if (db.prepare('SELECT 1 FROM ssh_executions WHERE request_key=?').get(body.requestKey)) throw duplicateClaim
        if (claims.expires <= Date.now()) throw new ArtiumError('INVALID_INPUT')
        if (admitted.input.connection) connections.assertAvailable(owner, admitted.input.host, admitted.input.connection, admitted.input.sudo)
        db.prepare(`INSERT INTO ssh_executions VALUES (@id, @request_key, @input_hash, @user_id, @family_id, @host_id,
          @account, @binding, @command, @sudo, @request_id, @started_at, @finished_at, @outcome, @metadata)`).run(row)
        created = true
      })
    } catch (error) { if (error !== duplicateClaim) throw error }
    const claimed = owned(owner, { requestKey: body.requestKey })
    if (created) {
      const controller = new AbortController()
      const guard = () => { if (controller.signal.aborted) throw new ArtiumError('CANCELLED'); authorize(owner, 'exec', 'write'); if (binding(owner, admitted.input).hash !== row.binding) throw new ArtiumError('REVISION_CONFLICT') }
      const done = execute(row, admitted, controller, guard)
      active.set(row.id, { controller, guard, done, connection: admitted.input.connection })
      void done.catch(() => {})
    }
    return view(claimed)
  })
  app.post('/v1/ssh/show', async request => {
    const owner = identity(request, 'execution show')
    const selector = parse(z.object({ id: z.string().optional(), requestKey: z.string().max(4096).optional(), full: z.boolean().default(false) }).strict()
      .refine(value => Boolean(value.id) !== Boolean(value.requestKey)), request.body)
    prune()
    const row = owned(owner, selector)
    audit.record({ event: 'admin-change', userId: owner.user, delegationId: delegationId(owner.family), tool: 'ssh-axi', requestId: request.id,
      clientAddress: request.ip, outcome: 'success', action: 'ssh-execution-read', targetId: row.id })
    return view(row)
  })
  const recordRead = (request: FastifyRequest, userId: string, action: string, targetId = 'ssh-executions') => {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const delegation = token ? verifyPrincipal(db, token).delegation : null
    audit.record({ event: 'admin-change', userId, delegationId: delegation?.id ?? null, tool: 'ssh-axi', requestId: request.id, clientAddress: request.ip, outcome: 'success', action, targetId })
  }
  app.post('/v1/ssh/list', async request => {
    const owner = identity(request, 'execution list')
    parse(z.object({}).strict(), request.body)
    const rows = db.prepare('SELECT * FROM ssh_executions WHERE user_id=? AND family_id=? ORDER BY started_at DESC,id DESC')
      .all(owner.user, owner.family) as Row[]
    const executions = rows.filter(row => {
      try { hosts.executionBinding(owner.user, row.host_id, Boolean(row.sudo)); return true } catch { return false }
    }).map(row => ({ id: row.id, host: row.host_id, outcome: row.outcome, startedAt: new Date(row.started_at).toISOString() }))
    recordRead(request, owner.user, 'ssh-execution-list')
    return { executions, count: executions.length, ...(executions.length ? {} : { message: 'No retained executions for this caller and session.' }),
      help: ['artium-axi ssh-axi execution show <id> --full'] }
  })
  app.post('/v1/ssh/cancel', async request => {
    const owner = identity(request, 'execution cancel', 'write')
    const body = parse(z.object({ id: z.string(), confirm: z.literal(true) }).strict(), request.body)
    const row = owned(owner, body)
    const job = active.get(row.id)
    if (job) { job.controller.abort('user'); await job.done }
    recordRead(request, owner.user, 'ssh-execution-cancel', row.id)
    return view(owned(owner, body))
  })
  const idle = z.number().int().min(1).max(60)
  app.post('/v1/ssh/connection/open', async request => {
    const owner = identity(request, 'connection open', 'read', true)
    const body = parse(z.object({ host: sshExecutionInput.shape.host, idle: idle.default(10), sudo: z.boolean().default(false) }).strict(), request.body)
    return connections.open(owner, body.host, body.idle, body.sudo)
  })
  app.post('/v1/ssh/connection/list', async request => {
    const owner = identity(request, 'connection list'); parse(z.object({}).strict(), request.body)
    await connections.reconcile()
    recordRead(request, owner.user, 'ssh-connection-list')
    return connections.list(owner)
  })
  app.post('/v1/ssh/connection/show', async request => {
    const owner = identity(request, 'connection show')
    const body = parse(z.object({ id: z.string() }).strict(), request.body)
    await connections.reconcile()
    const result = connections.show(owner, body.id)
    recordRead(request, owner.user, 'ssh-connection-show', body.id)
    return result
  })
  app.post('/v1/ssh/connection/set', async request => {
    const owner = identity(request, 'connection set', 'read', true)
    const body = parse(z.object({ id: z.string(), idle }).strict(), request.body)
    await connections.reconcile()
    const result = await connections.set(owner, body.id, body.idle)
    recordRead(request, owner.user, 'ssh-connection-set', body.id)
    return result
  })
  app.post('/v1/ssh/connection/close', async request => {
    const owner = identity(request, 'connection close', 'write')
    const body = parse(z.object({ id: z.string(), confirm: z.boolean().default(false) }).strict(), request.body)
    const result = await connections.close(owner, body.id, body.confirm)
    for (const job of active.values()) if (job.connection === body.id) { job.controller.abort('user'); await job.done }
    recordRead(request, owner.user, 'ssh-connection-close', body.id)
    return result
  })
  registerSshAudit(app, db, options.authorizeAdmin, recordRead, prune, view)
  const reconcile = async () => {
    await connections.reconcile()
    for (const job of active.values()) {
      try { job.guard() } catch { job.controller.abort(); await job.done }
    }
  }
  const monitor = setInterval(() => { void reconcile().catch(() => {}) }, 1000)
  const retention = setInterval(prune, 3600000)
  monitor.unref()
  retention.unref()
  app.addHook('onSend', reconcile)
  app.addHook('onError', async (request, _reply, error) => {
    if (!request.url.startsWith('/v1/ssh/')) return
    let userId: string | null = null
    let delegated: string | null = null
    try { const principal = verifyPrincipal(db, /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''); userId = principal.userId; delegated = principal.delegation?.id ?? null } catch { /* Anonymous denial. */ }
    audit.record({ event: 'denial', userId, delegationId: delegated, tool: 'ssh-axi', requestId: request.id, clientAddress: request.ip,
      outcome: error instanceof ArtiumError ? error.code : 'INVALID_INPUT' })
  })
  app.addHook('preClose', async () => {
    clearInterval(monitor)
    clearInterval(retention)
    await connections.shutdown()
    for (const job of active.values()) job.controller.abort()
    await Promise.allSettled([...active.values()].map(job => job.done))
  })
}
