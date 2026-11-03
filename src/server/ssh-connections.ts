import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { sshProfile, verifySshArtifact } from './adapters/ssh.js'
import { sshBinding, type SshOwner } from './policy/ssh.js'
import { SecretScanner } from './runner/scan.js'
import type { Runner } from './runner/runner.js'
import type { SshHosts } from './store/ssh-hosts.js'
import inventory from '../../tools/inventories/ssh-axi.json' with { type: 'json' }

interface Connection {
  id: string, owner: SshOwner, host: string, sudo: boolean, binding: string, child?: ChildProcess,
  state: 'opening' | 'idle' | 'active' | 'closed', idle: number, started: number, idleStart: number, wall: number,
  timer?: NodeJS.Timeout, closing?: Promise<void>, done: Promise<void>, finish: () => void, directory: string,
  pending: Map<string, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void }>,
}
const responseSchema = z.object({ id: z.uuid(), ok: z.boolean(), result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional() }).strict()

// The server owns transport lifetime; each command still acquires ordinary runner admission.
export class SshConnections {
  private readonly entries = new Map<string, Connection>()
  private readonly root: string
  private stopped = false
  constructor(private readonly db: Database.Database, private readonly hosts: SshHosts,
    private readonly writeLog: string, private readonly executable: string) {
    if (inventory.credentialSchema['x-connection-protocol-revision'] !== 2) throw new ArtiumError('CREDENTIAL_INVALID')
    this.root = join(dirname(writeLog), 'connections')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(this.root)) if (name.startsWith('connection-')) rmSync(join(this.root, name), { recursive: true, force: true })
  }
  private current(connection: Connection) {
    return !this.stopped && connection.state !== 'closed'
      && connection.binding === sshBinding(this.db, this.hosts, connection.owner, connection.host, connection.sudo).hash
  }
  private owned(owner: SshOwner, id: string) {
    const connection = this.entries.get(id)
    if (!connection || connection.owner.user !== owner.user || connection.owner.family !== owner.family) throw new ArtiumError('NOT_FOUND')
    sshBinding(this.db, this.hosts, owner, connection.host, connection.sudo)
    return connection
  }
  private view(connection: Connection) {
    const elapsed = connection.state === 'active' ? 8 * 3600000
      : Math.min(8 * 3600000, connection.idleStart - connection.started + connection.idle * 60000)
    return { id: connection.id, host: connection.host, sudo: connection.sudo, state: connection.state,
      idleTimeout: `${connection.idle}m`, openedAt: new Date(connection.wall).toISOString(),
      expiresAt: new Date(connection.wall + elapsed).toISOString() }
  }
  private record(connection: Connection, event: string) {
    try {
      this.db.prepare(`INSERT INTO ssh_connection_events (connection_id,user_id,family_id,host_id,sudo,event,occurred_at,binding)
        VALUES (?,?,?,?,?,?,?,?)`).run(connection.id, connection.owner.user, connection.owner.family,
        connection.host, Number(connection.sudo), event, Date.now(), connection.binding)
    } catch { throw new ArtiumError('AUDIT_UNAVAILABLE') }
  }
  list(owner: SshOwner) {
    const connections = [...this.entries.values()].filter(entry => entry.owner.user === owner.user && entry.owner.family === owner.family && entry.state !== 'closed').map(entry => this.view(entry))
    return { connections, count: connections.length, ...(connections.length ? {} : { message: 'No open connections found for this caller.' }) }
  }
  show(owner: SshOwner, id: string) { return this.view(this.owned(owner, id)) }
  assertAvailable(owner: SshOwner, host: string, id: string, sudo: boolean): void {
    const connection = this.owned(owner, id)
    if (connection.host !== host || connection.sudo !== sudo) throw new ArtiumError('NOT_FOUND')
    if (!this.current(connection) || performance.now() >= connection.started + 8 * 3600000
      || connection.state === 'idle' && performance.now() >= connection.idleStart + connection.idle * 60000) throw new ArtiumError('CONNECTION_CLOSED')
    if (connection.state !== 'idle') throw new ArtiumError('CONNECTION_BUSY')
  }
  private schedule(connection: Connection) {
    clearTimeout(connection.timer)
    if (connection.state === 'closed') return
    const maximum = connection.started + 8 * 3600000
    const remaining = (connection.state === 'active' ? maximum : Math.min(maximum, connection.idleStart + connection.idle * 60000)) - performance.now()
    if (remaining <= 0) { void this.closeEntry(connection, 'expired'); return }
    connection.timer = setTimeout(() => this.schedule(connection), remaining)
    connection.timer.unref()
  }
  async reconcile() {
    const closing: Promise<void>[] = []
    for (const connection of this.entries.values()) {
      if (connection.state === 'closed') {
        if (connection.closing) closing.push(connection.closing)
        else if (connection.wall <= Date.now() - 90 * 86400000) this.entries.delete(connection.id)
        continue
      }
      try {
        if (this.current(connection)) {
          this.schedule(connection)
          if (connection.closing) closing.push(connection.closing)
          continue
        }
      } catch { /* Current access is required for a live transport. */ }
      closing.push(this.closeEntry(connection, 'revoked'))
    }
    await Promise.all(closing)
  }
  private request(connection: Connection, operation: 'open' | 'exec' | 'cancel' | 'close', settings?: unknown) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!connection.child?.connected) { reject(new ArtiumError('CONNECTION_CLOSED')); return }
      const id = randomUUID()
      connection.pending.set(id, { resolve, reject })
      connection.child.send({ revision: 2, id, operation, ...(settings ? { settings } : {}) }, error => {
        if (error) { connection.pending.delete(id); reject(new ArtiumError('CONNECTION_CLOSED')) }
      })
    })
  }
  async open(owner: SshOwner, host: string, idle: number, sudo: boolean) {
    if (this.stopped) throw new ArtiumError('RUNNER_CLOSED')
    const state = sshBinding(this.db, this.hosts, owner, host, sudo)
    if (idle > state.selected.idle_minutes) throw new ArtiumError('INVALID_INPUT')
    const live = [...this.entries.values()].filter(entry => entry.state !== 'closed' || entry.closing)
    if (live.length >= 16 || live.filter(entry => entry.owner.user === owner.user).length >= 4) throw new ArtiumError('TOO_MANY_CALLS')
    verifySshArtifact(this.executable)
    const prepared = sshProfile.prepare('ssh-axi', this.hosts.profile(owner.user, host, sudo), this.writeLog, true)
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const now = performance.now()
    const connection: Connection = { id: `conn_${randomUUID()}`, owner, host, sudo, binding: state.hash,
      state: 'opening', idle, started: now, idleStart: now, wall: Date.now(), done, finish, pending: new Map(),
      directory: mkdtempSync(join(this.root, 'connection-')) }
    this.entries.set(connection.id, connection)
    try {
      this.record(connection, 'opening')
      const directories: Record<string, string> = {}
      for (const [name, leaf] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state',
        XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp' })) {
        directories[name] = join(connection.directory, leaf)
        mkdirSync(directories[name], { mode: 0o700 })
      }
      for (const file of prepared.files) {
        const target = join(directories.XDG_CONFIG_HOME, file.name)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        writeFileSync(target, file.content, { mode: 0o600, flag: 'wx' })
      }
      const scanner = new SecretScanner(prepared.secrets)
      const child = fork(join(dirname(this.executable), 'connection-worker.js'), [], {
        execArgv: [], detached: true, cwd: directories.HOME,
        env: { ...prepared.environment, ...directories, NODE_OPTIONS: '--max-old-space-size=128' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      connection.child = child
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        try { if (connection.state !== 'closed') this.record(connection, 'worker-failed') } catch { /* Cleanup must survive audit failure. */ }
        connection.state = 'closed'; clearTimeout(connection.timer)
        for (const pending of connection.pending.values()) pending.reject(new ArtiumError('CONNECTION_CLOSED'))
        connection.pending.clear()
        rmSync(connection.directory, { recursive: true, force: true })
        connection.closing = undefined
        finish()
      }
      child.once('error', cleanup)
      child.once('close', cleanup)
      child.on('message', raw => {
        const bytes = Buffer.from(JSON.stringify(raw))
        const response = responseSchema.safeParse(raw)
        if (bytes.length > 256 * 1024 || scanner.scan('stdout', bytes) || !response.success) { void this.closeEntry(connection); return }
        const message = response.data
        const pending = connection.pending.get(message.id)
        if (!pending) return
        connection.pending.delete(message.id)
        if (message.ok && message.result) pending.resolve(message.result)
        else {
          const code = message.error?.code
          pending.reject(new ArtiumError(code === 'CONNECTION_BUSY' ? 'CONNECTION_BUSY'
            : code === 'AUTH_FAILED' ? 'UPSTREAM_AUTH_FAILED' : code === 'AUTH_TIMEOUT' ? 'TIMEOUT'
              : ['TRUST_FAILED', 'ADDRESS_DENIED'].includes(code ?? '') ? 'CREDENTIAL_INVALID' : 'CONNECTION_CLOSED'))
        }
      })
      for (const stream of ['stdout', 'stderr'] as const) child[stream]!.on('data', () => { void this.closeEntry(connection) })
      const deadline = setTimeout(() => { void this.closeEntry(connection, 'authentication-timeout') }, 17000)
      try { await this.request(connection, 'open') } finally { clearTimeout(deadline) }
      if (!this.current(connection)) throw new ArtiumError('REVISION_CONFLICT')
      connection.state = 'idle'; connection.idleStart = performance.now(); this.schedule(connection)
      this.record(connection, 'opened')
      return this.view(connection)
    } catch (error) { await this.closeEntry(connection); throw error }
  }
  async set(owner: SshOwner, id: string, idle: number) {
    const connection = this.owned(owner, id)
    if (!this.current(connection)) throw new ArtiumError('CONNECTION_CLOSED')
    if (idle > this.hosts.executionBinding(owner.user, connection.host, connection.sudo).idle_minutes) throw new ArtiumError('INVALID_INPUT')
    connection.idle = idle; this.schedule(connection)
    await connection.closing
    this.record(connection, 'idle-timeout-changed')
    return this.view(connection)
  }
  private closeEntry(connection: Connection, reason = 'closed'): Promise<void> {
    if (connection.closing) return connection.closing
    if (connection.state === 'closed') return connection.done
    connection.state = 'closed'; clearTimeout(connection.timer)
    connection.closing = connection.done
    try { this.record(connection, reason) } catch { /* Fencing precedes acknowledgement even if recording fails. */ }
    if (!connection.child) {
      rmSync(connection.directory, { recursive: true, force: true }); connection.closing = undefined; connection.finish()
      return connection.done
    }
    const kill = setTimeout(() => {
      if (connection.child?.pid) {
        try { process.kill(-connection.child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    }, 500)
    if (connection.child.connected) void this.request(connection, 'close').catch(() => {})
    void connection.done.then(() => clearTimeout(kill))
    return connection.done
  }
  async close(owner: SshOwner, id: string, confirm: boolean) {
    const connection = this.owned(owner, id)
    if (connection.state === 'active' && !confirm) throw new ArtiumError('INVALID_INPUT', 'Closing an active connection requires --confirm.')
    await this.closeEntry(connection)
    return this.view(connection)
  }
  async execute(owner: SshOwner, host: string, id: string, sudo: boolean,
    settings: { command: string, timeout: number, outputLimit: number }, signal: AbortSignal, runner: Runner, beforeDispatch: () => void) {
    this.assertAvailable(owner, host, id, sudo)
    const connection = this.owned(owner, id)
    connection.state = 'active'; this.schedule(connection)
    let deadline: NodeJS.Timeout | undefined
    const cancel = () => { void this.request(connection, 'cancel').catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await runner.runManaged(owner.user, signal, async admittedSignal => {
        beforeDispatch()
        if (!this.current(connection) || admittedSignal.aborted || performance.now() >= connection.started + 8 * 3600000) throw new ArtiumError('CONNECTION_CLOSED')
        deadline = setTimeout(() => { void this.closeEntry(connection, 'command-timeout') }, (settings.timeout + 1) * 1000)
        const shutdown = () => { void this.closeEntry(connection, 'runner-stopped') }
        admittedSignal.addEventListener('abort', shutdown, { once: true })
        try { this.record(connection, 'execution'); return { ...await this.request(connection, 'exec', settings), connectionId: id } }
        finally { admittedSignal.removeEventListener('abort', shutdown) }
      })
    } finally {
      clearTimeout(deadline); signal.removeEventListener('abort', cancel)
      if (connection.child?.connected && !connection.closing) { connection.state = 'idle'; connection.idleStart = performance.now(); this.schedule(connection) }
    }
  }
  async shutdown() { this.stopped = true; await Promise.all([...this.entries.values()].map(connection => this.closeEntry(connection))) }
}
