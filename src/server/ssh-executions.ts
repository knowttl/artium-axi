import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { toolAllowsWrites } from '../shared/api.js'
import { sshExecutionInput, sshExecutionStatus, type SshExecutionInput } from '../shared/ssh-execution.js'
import { ArtiumError } from '../shared/errors.js'
import { verifyAccessToken, verifyAccessFamily } from './auth/tokens.js'
import { checkToolPolicy } from './policy/policy.js'
import { sshProfile, verifySshArtifact } from './adapters/ssh.js'
import { toolPaths } from './config.js'
import { decryptCredential, encryptCredential, type EncryptedCredential } from './store/crypto.js'
import type { SshHosts } from './store/ssh-hosts.js'
import type { KeyProvider } from './store/key-provider.js'
import type { Runner } from './runner/runner.js'
import type { Audit } from './audit/audit.js'

interface Owner { user: string, family: string }
interface Row { id: string, request_key: string, input_hash: string, user_id: string, family_id: string,
  host_id: string, account: string, binding: string, command: string, sudo: number, request_id: string,
  started_at: number, finished_at: number | null, outcome: z.infer<typeof sshExecutionStatus>['outcome'], metadata: string }
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
}): void {
  const { db, hosts, runner, audit, provider, writeLog, environment, executable = toolPaths['ssh-axi'] } = options
  const active = new Map<string, { controller: AbortController, guard: () => void, done: Promise<void> }>()
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  const identity = (request: FastifyRequest): Owner => {
    const token = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const user = verifyAccessToken(db, token)
    checkToolPolicy(db, user, 'ssh-axi')
    const family = verifyAccessFamily(db, token)
    prune()
    return { user, family }
  }
  const current = (owner: Owner) => {
    checkToolPolicy(db, owner.user, 'ssh-axi')
    if (!db.prepare('SELECT 1 FROM session_families WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?')
      .get(owner.family, owner.user, Date.now())) throw new ArtiumError('TOKEN_INVALID')
  }
  const binding = (owner: Owner, input: SshExecutionInput) => {
    current(owner)
    const tool = db.prepare("SELECT revision, native_settings FROM tools WHERE name='ssh-axi'").get() as { revision: number, native_settings: string }
    if (!toolAllowsWrites('ssh-axi', JSON.parse(tool.native_settings)) || environment.SSH_AXI_READ_ONLY && !['false', '0'].includes(environment.SSH_AXI_READ_ONLY)) throw new ArtiumError('FLAG_BLOCKED')
    const selected = hosts.executionBinding(owner.user, input.host, input.sudo)
    if (selected.read_only) throw new ArtiumError('FLAG_BLOCKED')
    if (input.timeout > selected.command_seconds || input.outputLimit > selected.output_bytes) throw new ArtiumError('INVALID_INPUT')
    return { selected, hash: hash({ selected, tool }) }
  }
  const scanner = () => import(pathToFileURL(join(dirname(executable), 'output.js')).href) as Promise<typeof import('../../tools/node_modules/@knowttl/ssh-axi/dist/output.js')>
  const admit = async (owner: Owner, raw: unknown) => {
    const input = parse(sshExecutionInput, raw)
    const state = binding(owner, input)
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
  const view = (row: Row) => {
    let result: Record<string, unknown> = JSON.parse(row.metadata)
    const encrypted = db.prepare('SELECT * FROM ssh_execution_results WHERE id=?').get(row.id) as EncryptedCredential | undefined
    if (encrypted) {
      const plain = decryptCredential(encrypted, provider.getKey())
      try { result = { ...result, ...JSON.parse(plain.toString('utf8')) } } finally { plain.fill(0) }
    }
    return { remoteExit: null, remoteSignal: null, termination: 'unknown', ...result,
      id: row.id, host: row.host_id, account: row.account, sudo: Boolean(row.sudo), command: row.command,
      confirmed: true, requestId: row.request_id, startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
      outcome: row.outcome === 'running' && !active.has(row.id) ? 'unknown' : row.outcome,
      help: ['Inspect remote state before preparing another uncertain command. No automatic replay.', `artium-axi ssh-axi execution show ${row.id}`] }
  }
  const prune = () => db.transaction(() => {
    db.prepare('DELETE FROM ssh_execution_results WHERE updated_at<=?').run(Date.now() - 14 * 86400000)
    db.prepare('DELETE FROM ssh_executions WHERE finished_at<=?').run(Date.now() - 90 * 86400000)
  }).immediate()
  prune()
  db.prepare("UPDATE ssh_executions SET outcome='unknown', finished_at=? WHERE outcome='running'").run(Date.now())
  audit.recoverInterrupted()

  const execute = async (row: Row, admitted: Awaited<ReturnType<typeof admit>>, controller: AbortController, guard: () => void) => {
    let result: Record<string, unknown> = { remoteExit: null, remoteSignal: null, termination: 'unknown', outcome: 'unknown',
      diagnostic: 'No proven remote result. Inspect remote state before preparing another command.' }
    try {
      const command = remoteCommand(admitted.input)
      const output = await runner.run(row.user_id, process.execPath, [executable, 'exec', row.host_id, '--confirm', '--json'],
        admitted.profile.environment, admitted.profile.secrets, { timeoutMs: (admitted.input.timeout + 18) * 1000,
          signal: controller.signal, trustedIpc: { revision: 1, hosts: [{ id: row.host_id, address: admitted.state.selected.address,
            port: admitted.state.selected.port, username: row.account }], execution: { command,
            timeout: admitted.input.timeout, outputLimit: Math.min(admitted.input.outputLimit, 8192) } } }, {}, admitted.profile.files, guard)
      const parsed = nativeResult.safeParse(JSON.parse(output.stdout))
      if (parsed.success) {
        result = parsed.data
        if (admitted.input.sudo && result.remoteExit !== 0 && /sudo:.*(?:password|terminal|tty|required|not allowed|not in the sudoers)/i.test(parsed.data.stderr.text)) {
          result = { ...result, code: 'SUDO_DENIED', diagnostic: 'The approved sudo account needs independently reviewed non-interactive passwordless authorization.' }
        }
      }
    } catch { /* A durable claim is never released, even without a proven remote result. */ }
    const { stdout, stderr, ...metadata } = result
    const counts = (value: unknown) => value && typeof value === 'object' ? { ...value, text: '' } : undefined
    const plain = Buffer.from(JSON.stringify({ stdout, stderr }))
    try {
      const encrypted = encryptCredential(row.id, 'ssh-axi', plain, provider.getKey())
      audit.change({ event: 'run-terminal', userId: row.user_id, tool: 'ssh-axi', requestId: row.request_id,
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
    const owner = identity(request)
    const admitted = await admit(owner, request.body)
    const body = Buffer.from(JSON.stringify({ version: 1, keyId: provider.getKey().id, nonce: randomUUID(), ...owner,
      input: hash(admitted.input), binding: admitted.state.hash, expires: Date.now() + 600000 })).toString('base64url')
    return { requestKey: `${body}.${sign(body)}`, host: admitted.input.host }
  })
  app.post('/v1/ssh/submit', async request => {
    const owner = identity(request)
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
    if (claims.input !== hash(admitted.input) || claims.binding !== admitted.state.hash) throw new ArtiumError('REVISION_CONFLICT')
    if (claims.expires <= Date.now()) throw new ArtiumError('INVALID_INPUT', 'Unused execution preparation expired; prepare again only after inspecting remote state.')
    let created = false
    const row: Row = { id: `exec_${randomUUID()}`, request_key: body.requestKey, input_hash: claims.input,
      user_id: owner.user, family_id: owner.family, host_id: admitted.input.host, account: admitted.state.selected.username,
      binding: admitted.state.hash, command: admitted.input.command, sudo: Number(admitted.input.sudo), request_id: request.id,
      started_at: Date.now(), finished_at: null, outcome: 'running', metadata: JSON.stringify({
        owner: owner.user, sessionFamily: owner.family,
        endpoint: { address: admitted.state.selected.address, port: admitted.state.selected.port },
        binding: { hostRevision: admitted.state.selected.host_revision, bindingRevision: admitted.state.selected.binding_revision,
          credentialRevision: admitted.state.selected.credential_revision, credentialId: admitted.state.selected.credential_id },
      }) }
    const duplicateClaim = Symbol()
    try {
      audit.change({ event: 'run-start', userId: owner.user, tool: 'ssh-axi', requestId: row.request_id,
        clientAddress: request.ip, outcome: 'started', args: ['exec', row.host_id, '--command', row.command, '--confirm'],
        sensitive: { flags: ['--command'], positions: [] } }, () => {
        if (db.prepare('SELECT 1 FROM ssh_executions WHERE request_key=?').get(body.requestKey)) throw duplicateClaim
        if (claims.expires <= Date.now()) throw new ArtiumError('INVALID_INPUT')
        db.prepare(`INSERT INTO ssh_executions VALUES (@id, @request_key, @input_hash, @user_id, @family_id, @host_id,
          @account, @binding, @command, @sudo, @request_id, @started_at, @finished_at, @outcome, @metadata)`).run(row)
        created = true
      })
    } catch (error) { if (error !== duplicateClaim) throw error }
    const claimed = owned(owner, { requestKey: body.requestKey })
    if (created) {
      const controller = new AbortController()
      const guard = () => { if (controller.signal.aborted) throw new ArtiumError('CANCELLED'); if (binding(owner, admitted.input).hash !== row.binding) throw new ArtiumError('REVISION_CONFLICT') }
      const done = execute(row, admitted, controller, guard)
      active.set(row.id, { controller, guard, done })
      void done.catch(() => {})
    }
    return view(claimed)
  })
  app.post('/v1/ssh/show', async request => {
    const owner = identity(request)
    const selector = parse(z.object({ id: z.string().optional(), requestKey: z.string().max(4096).optional() }).strict()
      .refine(value => Boolean(value.id) !== Boolean(value.requestKey)), request.body)
    prune()
    const row = owned(owner, selector)
    audit.record({ event: 'admin-change', userId: owner.user, tool: 'ssh-axi', requestId: request.id,
      clientAddress: request.ip, outcome: 'success', action: 'ssh-execution-read', targetId: row.id })
    return view(row)
  })
  const reconcile = async () => {
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
    try { userId = verifyAccessToken(db, /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '') } catch { /* Anonymous denial. */ }
    audit.record({ event: 'denial', userId, tool: 'ssh-axi', requestId: request.id, clientAddress: request.ip,
      outcome: error instanceof ArtiumError ? error.code : 'INVALID_INPUT' })
  })
  app.addHook('preClose', async () => {
    clearInterval(monitor)
    clearInterval(retention)
    for (const job of active.values()) job.controller.abort()
    await Promise.allSettled([...active.values()].map(job => job.done))
  })
}
