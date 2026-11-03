import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import type { PreparedCall } from '../adapters/types.js'
import { proxmoxProfile } from '../adapters/proxmox.js'
import type { IdentityResolver } from '../policy/identity-resolver.js'
import { checkToolPolicy } from '../policy/policy.js'
import { toolFailure, toolFailureCode } from '../health/diagnostic.js'
import type { ProtectedResults, ResultScope } from '../protected-results.js'
import type { CredentialReference } from '../store/credential-store.js'
import { readCredentialTrust, type CredentialTrust } from '../store/trusted-certificates.js'
import { RunnerError, type Runner, type RunnerLimits, type RunnerResult } from './runner.js'
import { proxmoxResult, type ProxmoxResultBinding } from './proxmox-result.js'

const sessionSchema = z.strictObject({ session: z.uuid(), state: z.literal('ready'), expires: z.number().int(),
  ticket: z.string().min(1).regex(/^[\x21-\x7e]+$/), csrfPreventionToken: z.string().min(1).regex(/^[\x21-\x7e]+$/) })
type Session = Pick<z.infer<typeof sessionSchema>, 'ticket' | 'csrfPreventionToken' | 'expires'>
export const proxmoxTrust = (db: Database.Database, credential: CredentialReference) =>
  createHash('sha256').update(JSON.stringify(readCredentialTrust(db, credential))).digest('hex')

function resultBinding(prepared: PreparedCall, operation: string): ProxmoxResultBinding {
  return { origin: prepared.proxmox!.origin, identity: prepared.proxmox!.identity, operation,
    request: prepared.environment.PROXMOX_AXI_REQUEST_ID, actor: prepared.environment.PROXMOX_AXI_ACTOR,
    credentialRevision: prepared.environment.PROXMOX_AXI_CREDENTIAL_REVISION }
}

// Native acquisition is explicit inside the host; users never perform a separate PVE login.
export async function acquireProxmox(runner: Runner, user: string, prepared: PreparedCall,
  trust: readonly CredentialTrust[], signal: AbortSignal | undefined, beforeSpawn: () => void): Promise<Session> {
  let payload: unknown
  const binding = resultBinding(prepared, 'auth acquire')
  const result = await runner.run(user, prepared.executable, [prepared.args[0], 'auth', 'acquire', '--format', 'json'],
    prepared.environment, prepared.secrets, { ...prepared.limits, publicContent: prepared.publicContent, signal, credentialTrust: trust,
      protectedPipe: { environment: 'PROXMOX_AXI_RESULT_FD', receive(bytes) {
        const result = proxmoxResult(bytes, binding); payload = result.payload
        prepared.secrets.push(...result.secrets)
        return result.secrets
      } } }, {}, prepared.files, beforeSpawn).catch(error => {
    if (error instanceof RunnerError) error.processStarted = false
    throw error
  })
  if (result.exitCode !== 0) throw toolFailure(result.stdout, result.stderr, result.exitCode, 'proxmox-axi')
  if (payload && typeof payload === 'object' && 'state' in payload && payload.state === 'challenge') {
    payload = undefined
    throw new ArtiumError('UPSTREAM_AUTH_FAILED', 'This Proxmox account requires an interactive authentication challenge.', 'TFA accounts cannot sign in automatically. Configure a PVE API token instead.')
  }
  const value = sessionSchema.safeParse(payload)
  if (!value.success || value.data.expires <= Date.now() || value.data.expires > Date.now() + 300000) throw new ArtiumError('UPSTREAM_RESPONSE_INVALID')
  return { ticket: value.data.ticket, csrfPreventionToken: value.data.csrfPreventionToken, expires: value.data.expires }
}

function selectProxmoxTicket(prepared: PreparedCall, session: Session): void {
  proxmoxProfile.proxmoxTicket(prepared, session.ticket, session.csrfPreventionToken)
}

interface Owner extends ResultScope { familyId: string, trustRevision: string }
interface Context {
  userId: string, familyId: string, credential: CredentialReference, requestId: string, signal?: AbortSignal
}
interface Cached { owner: Owner, value: Session, deadline: number, timer: NodeJS.Timeout }
interface Pending { owner: Owner, controller: AbortController, users: number, job: Promise<Session> }
interface Active { valid: () => boolean, controller: AbortController, done: Promise<void> }

// Only ready tickets and CSRF values cross call boundaries; private profiles and passwords do not.
export class ProxmoxAccess {
  private readonly sessions = new Map<string, Cached>()
  private readonly pending = new Map<string, Pending>()
  private readonly active = new Set<Active>()
  private closed = false

  constructor(private readonly db: Database.Database, private readonly resolver: IdentityResolver,
    private readonly runner: Runner, private readonly results: ProtectedResults, private readonly now = () => performance.now()) {}

  private remove(key: string): void {
    const entry = this.sessions.get(key)
    if (entry) { clearTimeout(entry.timer); this.sessions.delete(key) }
  }

  valid(owner: ResultScope): boolean {
    try {
      if (this.closed || !owner.familyId || !owner.trustRevision) return false
      checkToolPolicy(this.db, owner.userId, 'proxmox-axi')
      if (!this.db.prepare(`SELECT 1 FROM session_families f JOIN users u ON u.id=f.user_id
        WHERE f.id=? AND f.user_id=? AND f.revoked_at IS NULL AND f.expires_at>? AND u.disabled=0`)
        .get(owner.familyId, owner.userId, Date.now())) return false
      const current = this.db.prepare("SELECT id,revision FROM credentials WHERE tool='proxmox-axi'")
        .get() as { id: string, revision: number } | undefined
      return current?.id === owner.credential.id && current.revision === owner.credential.revision
        && proxmoxTrust(this.db, owner.credential) === owner.trustRevision
    } catch { return false }
  }

  async reconcile(): Promise<void> {
    for (const [key, cached] of this.sessions) if (cached.deadline <= this.now() || !this.valid(cached.owner)) this.remove(key)
    for (const entry of this.pending.values()) if (!this.valid(entry.owner)) entry.controller.abort()
    const stopped: Promise<void>[] = []
    for (const entry of this.active) if (!entry.valid()) { entry.controller.abort(); stopped.push(entry.done) }
    this.results.invalidate(scope => scope.credential.tool === 'proxmox-axi' && !this.valid(scope))
    await Promise.allSettled(stopped)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const key of this.sessions.keys()) this.remove(key)
    for (const entry of this.pending.values()) entry.controller.abort()
    for (const entry of this.active) entry.controller.abort()
    await Promise.allSettled([...this.active].map(entry => entry.done))
  }

  async health(user: string, credential: CredentialReference, requestId: string, prepared: PreparedCall,
    authorize: () => void, invoke: (limits: Partial<RunnerLimits>) => Promise<RunnerResult>): Promise<RunnerResult> {
    const controller = new AbortController()
    const trust = proxmoxTrust(this.db, credential), previous = prepared.beforeSpawn
    prepared.beforeSpawn = () => {
      previous?.()
      if (this.closed || controller.signal.aborted || proxmoxTrust(this.db, credential) !== trust) throw new ArtiumError('CREDENTIAL_INVALID')
    }
    let settle!: () => void
    const valid = () => { try { authorize(); return !this.closed } catch { return false } }
    if (!valid()) throw new ArtiumError('CREDENTIAL_INVALID')
    const entry: Active = { valid, controller, done: new Promise(resolve => { settle = resolve }) }
    this.active.add(entry)
    prepared.environment.PROXMOX_AXI_ACTOR = createHash('sha256').update(JSON.stringify({ user, credential, health: requestId })).digest('hex')
    prepared.environment.PROXMOX_AXI_CREDENTIAL_REVISION = `${credential.id}:${credential.revision}`
    prepared.environment.PROXMOX_AXI_SESSION_FAMILY = `health:${requestId}`
    prepared.environment.PROXMOX_AXI_REQUEST_ID = requestId
    try {
      if (prepared.proxmox!.password && prepared.proxmox!.authenticate) {
        const session = await acquireProxmox(this.runner, user, prepared, readCredentialTrust(this.db, credential), controller.signal, authorize)
        selectProxmoxTicket(prepared, session)
      }
      if (controller.signal.aborted || !valid()) throw new RunnerError('CANCELLED')
      return await invoke({ signal: controller.signal })
    } finally { this.active.delete(entry); settle() }
  }

  private async login(key: string, owner: Owner, prepared: PreparedCall, signal: AbortSignal): Promise<Session> {
    const cached = this.sessions.get(key)
    if (cached && cached.deadline > this.now()) return cached.value
    this.remove(key)
    let pending = this.pending.get(key)
    if (!pending) {
      if (this.sessions.size + this.pending.size >= 64 || [...this.sessions.values(), ...this.pending.values()]
        .filter(entry => entry.owner.userId === owner.userId).length >= 4) throw new ArtiumError('TOO_MANY_CALLS')
      const controller = new AbortController()
      const job = acquireProxmox(this.runner, owner.userId, prepared, readCredentialTrust(this.db, owner.credential),
        controller.signal, () => { if (this.closed || !this.valid(owner)) throw new ArtiumError('CREDENTIAL_INVALID') })
        .then(value => {
          if (controller.signal.aborted || !this.valid(owner)) throw new RunnerError('CANCELLED')
          const lifetime = Math.min(300000, value.expires - Date.now())
          const timer = setTimeout(() => { this.remove(key); void this.reconcile().catch(() => {}) }, lifetime).unref()
          this.sessions.set(key, { owner, value, timer, deadline: this.now() + lifetime })
          return value
        }).finally(() => {
          if (controller.signal.aborted) this.remove(key)
          if (this.pending.get(key) === entry) this.pending.delete(key)
        })
      const entry: Pending = { owner, controller, users: 0, job }
      this.pending.set(key, entry); pending = entry
    }
    const entry = pending
    entry.users++
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (--entry.users === 0 && this.pending.get(key) === entry) entry.controller.abort()
    }
    signal.addEventListener('abort', release, { once: true })
    if (signal.aborted) release()
    try { const value = await entry.job; if (signal.aborted) throw new RunnerError('CANCELLED'); return value }
    finally { signal.removeEventListener('abort', release); release() }
  }

  async execute(context: Context, prepared: PreparedCall, invoke: (limits: Partial<RunnerLimits>) => Promise<RunnerResult>,
    receive: (bytes: Buffer) => void): Promise<RunnerResult> {
    const owner: Owner = { userId: context.userId, familyId: context.familyId, credential: { ...context.credential },
      operation: prepared.protectedResult?.operation ?? '', trustRevision: proxmoxTrust(this.db, context.credential) }
    if (this.closed || !this.valid(owner)) throw new ArtiumError('CREDENTIAL_INVALID')
    const current = await this.resolver.resolve(owner.userId, 'proxmox-axi')
    if (current.id !== owner.credential.id || current.revision !== owner.credential.revision) throw new ArtiumError('CREDENTIAL_INVALID')
    const controller = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal
    let settle!: () => void
    let authExpires: number | undefined
    const entry: Active = { valid: () => this.valid(owner) && (authExpires === undefined || authExpires > this.now()),
      controller, done: new Promise(resolve => { settle = resolve }) }
    this.active.add(entry)
    const previous = prepared.beforeSpawn
    prepared.beforeSpawn = () => {
      previous?.()
      if (signal.aborted || !entry.valid()) throw new ArtiumError('CREDENTIAL_INVALID')
    }
    prepared.environment.PROXMOX_AXI_SESSION_FAMILY = context.familyId
    prepared.environment.PROXMOX_AXI_REQUEST_ID = context.requestId
    prepared.environment.PROXMOX_AXI_ACTOR = createHash('sha256').update(JSON.stringify({
      userId: context.userId, family: context.familyId, reference: context.credential })).digest('hex')
    prepared.environment.PROXMOX_AXI_CREDENTIAL_REVISION = `${context.credential.id}:${context.credential.revision}`
    const key = createHash('sha256').update(JSON.stringify({ ...owner, operation: undefined,
      origin: prepared.proxmox!.origin, identity: prepared.proxmox!.identity })).digest('hex')
    try {
      if (prepared.proxmox!.password && prepared.proxmox!.authenticate) {
        const session = await this.login(key, owner, prepared, signal)
        authExpires = this.sessions.get(key)?.deadline ?? this.now()
        selectProxmoxTicket(prepared, session)
      }
      if (signal.aborted || !entry.valid()) throw new RunnerError('CANCELLED')
      const protectedPipe: RunnerLimits['protectedPipe'] = prepared.protectedResult?.source === 'proxmox'
        ? { environment: 'PROXMOX_AXI_RESULT_FD', early: prepared.proxmox?.stream?.duplex === true, receive(bytes) {
          const result = proxmoxResult(bytes, resultBinding(prepared, prepared.protectedResult!.operation))
          prepared.secrets.push(...result.secrets)
          receive(Buffer.from(bytes))
          return result.secrets
        } } : undefined
      const result = await invoke({ signal, ...(protectedPipe ? { protectedPipe } : {}) })
      if (!entry.valid()) throw Object.assign(new RunnerError('CANCELLED'), { processStarted: true,
        durationMs: result.durationMs, outputBytes: result.outputBytes, truncated: result.truncated })
      if (result.exitCode !== 0 && toolFailureCode(result.stdout, result.stderr) === 'AUTH_REQUIRED') {
        // A failed provider call is never replayed; discard cached auth for the next explicit request.
        this.remove(key)
      }
      return result
    } catch (error) {
      if (signal.aborted || error instanceof RunnerError && ['CANCELLED', 'TIMEOUT', 'PROCESS_SIGNAL'].includes(error.code)) this.remove(key)
      throw error
    } finally { this.active.delete(entry); settle() }
  }
}
