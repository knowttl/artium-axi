import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import type { z } from 'zod'
import { shodanStreamStart } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { PreparedCall } from './adapters/types.js'
import { runtimePath, toolPaths } from './config.js'
import { SecretScanner } from './runner/scan.js'
import { ShodanStreamWire, type ShodanWorkerMessage } from './shodan-stream-wire.js'

type Input = z.infer<typeof shodanStreamStart>
type Profile = Pick<PreparedCall, 'environment' | 'files' | 'secrets'>
interface WorkerOptions {
  directory: string, input: Input, confirmation: string, profile: Profile, signal: AbortSignal,
  configuredCaPem?: string,
  authorize: () => void, onEvent: (event: Record<string, unknown>) => void,
  onLoss: (count: number, reason: string) => void, onReady: () => void,
  onClosed?: (summary: { stopReason: string, count: number, bytes: number, partialRecordCount: number, debugDiscarded: number, error?: string }) => void,
}

export class ShodanWorker {
  private child?: ChildProcess
  private pipe?: Duplex
  private ready = false
  private closed = false
  private stopping = false
  private startId = randomUUID()
  private admission = randomBytes(32).toString('hex')
  private extension?: { id: string, deadline: number, resolve: () => void, reject: (error: Error) => void }
  private finish?: Promise<void>

  constructor(private readonly options: WorkerOptions) {}

  private send(value: Record<string, unknown>) {
    if (!this.pipe || this.pipe.destroyed || this.closed) throw new ArtiumError('CANCELLED')
    this.pipe.write(JSON.stringify({ version: 1, ...value }) + '\n')
  }

  private accept(message: ShodanWorkerMessage) {
    this.options.authorize()
    if (this.closed) throw new Error('Worker sent output after close')
    if (message.type === 'ready') {
      if (this.ready || message.requestId !== this.startId) throw new Error('Unexpected worker readiness')
      this.ready = true; this.options.onReady(); return
    }
    if (message.type === 'closed') {
      if (Object.keys(this.options.input.bounds).some(key => message.bounds[key as keyof typeof message.bounds] !== this.options.input.bounds[key as keyof typeof message.bounds])) throw new Error('Worker bounds changed')
      if (!this.ready && !message.error && !['idle-timeout', 'max-seconds'].includes(message.stopReason)
        && !(this.stopping && message.stopReason === 'cancelled')) throw new Error('Worker closed before readiness')
      if (this.ready && message.partialRecordCount) this.options.onLoss(message.partialRecordCount, 'partial-record')
      this.options.onClosed?.({ stopReason: message.stopReason, count: message.count, bytes: message.bytes,
        partialRecordCount: message.partialRecordCount, debugDiscarded: message.debugDiscarded, ...(message.error ? { error: message.error } : {}) })
      this.closed = true
      if (message.error) throw new Error('Worker reported failure')
      return
    }
    if (!this.ready) throw new Error('Worker sent output before readiness')
    if (message.type === 'extended') {
      if (!this.extension || message.requestId !== this.extension.id || message.deadlineMs !== this.extension.deadline) throw new Error('Unexpected worker extension')
      const extension = this.extension; this.extension = undefined; extension.resolve(); return
    }
    if (message.type === 'event') this.options.onEvent(message.event)
    else this.options.onLoss(message.discarded, message.reason)
  }

  async run(): Promise<void> {
    const { directory, input, profile, signal } = this.options
    const privateDirs = Object.fromEntries(Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: 'state',
      XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp' }).map(([key, leaf]) => [key, resolve(directory, leaf)]))
    let scanner: SecretScanner | undefined = new SecretScanner(profile.secrets)
    let failure: Error | undefined
    try {
      for (const path of Object.values(privateDirs)) await mkdir(path, { recursive: true, mode: 0o700 })
      for (const file of profile.files) {
        const destination = join(privateDirs.XDG_CONFIG_HOME, file.name)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, file.content, { mode: 0o600, flag: 'wx' })
      }
      const caFile = join(privateDirs.XDG_CONFIG_HOME, 'artium-trusted-ca.pem')
      if (this.options.configuredCaPem) await writeFile(caFile, this.options.configuredCaPem, { mode: 0o600, flag: 'wx' })
      if (scanner.scan('stdout', Buffer.from(JSON.stringify(input)))) throw new ArtiumError('INVALID_INPUT')
      this.options.authorize()
      if (signal.aborted || this.stopping) throw new ArtiumError('CANCELLED')
      const child = spawn(process.execPath, [join(dirname(toolPaths['shodan-axi']), 'shodan-stream-worker.js')], {
        detached: true, cwd: privateDirs.HOME, env: { ...profile.environment, ...privateDirs,
          PATH: runtimePath, SHODAN_AXI_READ_ONLY: 'false', NODE_OPTIONS: '--max-old-space-size=256',
          ...(this.options.configuredCaPem ? { NODE_EXTRA_CA_CERTS: caFile } : {}) },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
      this.child = child
      this.pipe = child.stdio[3] as Duplex
      const kill = () => {
        if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      const fail = (error: Error) => { failure ??= error; kill() }
      const wire = new ShodanStreamWire(message => this.accept(message), Math.floor(input.bounds.maxBytes / 2) + 2)
      for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => {
        if (scanner?.scan(stream === child.stdout ? 'stdout' : 'stderr', chunk)) fail(new ArtiumError('SECRET_IN_OUTPUT'))
      })
      this.pipe.on('data', (chunk: Buffer) => {
        try {
          if (scanner?.scan('stdout', chunk)) throw new ArtiumError('SECRET_IN_OUTPUT')
          wire.push(chunk)
        } catch (error) { fail(error instanceof Error ? error : new Error('Invalid worker output')) }
      })
      this.pipe.on('error', () => fail(new Error('Worker channel failed')))
      this.pipe.on('end', () => { if (!this.closed) fail(new Error('Worker channel closed early')) })
      const cancel = () => { failure ??= new ArtiumError('CANCELLED'); kill() }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (signal.aborted) cancel()
        const exited = new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, childSignal) => {
            try { wire.finish() } catch (error) { failure ??= error as Error }
            if (failure) reject(failure)
            else if (!this.closed || code !== 0 || childSignal) reject(new Error('Worker did not close cleanly'))
            else resolve()
          })
        })
        this.send({ type: 'admit', requestId: randomUUID(), admission: this.admission,
          profilePath: join(privateDirs.XDG_CONFIG_HOME, 'shodan-axi/config.json') })
        this.send({ type: 'start', requestId: this.startId, admission: this.admission, operation: input.operation,
          selector: input.selector.flag ? input.selector : null, bounds: input.bounds, confirmation: this.options.confirmation })
        await exited
      } finally { signal.removeEventListener('abort', cancel) }
    } finally {
      this.extension?.reject(new ArtiumError('CANCELLED')); this.extension = undefined
      this.pipe?.destroy(); this.pipe = undefined; this.child = undefined; scanner = undefined
      this.options.confirmation = ''
      profile.secrets.fill(''); profile.files.length = 0
      for (const key of Object.keys(profile.environment)) delete profile.environment[key]
      await rm(directory, { recursive: true, force: true })
    }
  }

  start() { return this.finish ??= this.run() }

  async extend(deadline: number) {
    if (!this.ready || this.closed || this.stopping || this.extension) throw new ArtiumError('INVALID_INPUT')
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.extension = undefined
        if (this.child?.pid) try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* Already exited. */ }
        reject(new ArtiumError('TIMEOUT'))
      }, 5000).unref()
      this.extension = { id, deadline, resolve: () => { clearTimeout(timer); resolve() }, reject: error => { clearTimeout(timer); reject(error) } }
      try { this.send({ type: 'extend', requestId: id, admission: this.admission, deadlineMs: deadline }) }
      catch (error) { this.extension = undefined; clearTimeout(timer); reject(error) }
    })
  }

  async stop() {
    this.stopping = true
    try { if (!this.closed) this.send({ type: 'stop', requestId: randomUUID() }) } catch { /* Exit and cleanup still settle below. */ }
    const force = setTimeout(() => {
      if (this.child?.pid) try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* Already exited. */ }
    }, 2000).unref()
    try { await this.finish } finally { clearTimeout(force) }
  }
}
