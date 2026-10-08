import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runnerLimits, runtimePath, toolPaths } from '../config.js'
import { SecretScanner } from './scan.js'

export interface RunnerLimits {
  outputBytesPerStream?: number
  timeoutMs?: number
  runtime?: 'node' | 'python'
  signal?: AbortSignal
}

export interface RunnerResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  outputBytes: { stdout: number, stderr: number }
  timedOut: boolean
  truncated: { stdout: boolean, stderr: boolean }
}

export class RunnerError extends Error {
  readonly source = 'artium-axi'
  constructor(readonly code: 'SECRET_IN_OUTPUT' | 'SPAWN_FAILED' | 'PROCESS_SIGNAL' | 'TIMEOUT' | 'CANCELLED' | 'OUTPUT_LIMIT' | 'TOO_MANY_CALLS' | 'RUNNER_CLOSED' | 'TEMP_UNAVAILABLE', message: string, readonly next: string) {
    super(message)
  }
}

// A byte cap must not introduce a replacement character from an incomplete UTF-8 suffix.
function decode(bytes: Buffer, truncated: boolean): string {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  return decoder.decode(bytes, { stream: truncated })
}

// One server owns one runner. Admission covers setup, child execution and cleanup.
export class Runner {
  private readonly active = new Map<symbol, { userId: string, controller: AbortController, result: Promise<RunnerResult> }>()
  private closed = false

  private constructor(private readonly root: string) {}

  static async create(root = join(tmpdir(), 'artium-calls')): Promise<Runner> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(root)) {
      if (entry.startsWith('artium-call-')) await rm(join(root, entry), { recursive: true, force: true })
    }
    return new Runner(root)
  }

  run(userId: string, executable: string, args: readonly string[], environment: Readonly<Record<string, string>>, secrets: readonly string[], limits: RunnerLimits = {}): Promise<RunnerResult> {
    if (!userId) return Promise.reject(new TypeError('An authenticated user is required'))
    if (this.closed) return Promise.reject(new RunnerError('RUNNER_CLOSED', 'The runner is shutting down.', 'Wait for the server to become available.'))
    const userCalls = [...this.active.values()].filter(call => call.userId === userId).length
    if (this.active.size >= runnerLimits.globalCalls || userCalls >= runnerLimits.userCalls) {
      return Promise.reject(new RunnerError('TOO_MANY_CALLS', 'The concurrent call limit was reached.', 'Wait for an active call to finish.'))
    }
    const key = Symbol()
    const controller = new AbortController()
    const signal = limits.signal ? AbortSignal.any([limits.signal, controller.signal]) : controller.signal
    const result = execute(this.root, executable, args, environment, secrets, { ...limits, signal })
      .finally(() => this.active.delete(key))
    this.active.set(key, { userId, controller, result })
    return result
  }

  async shutdown(): Promise<void> {
    this.closed = true
    const calls = [...this.active.values()]
    for (const call of calls) call.controller.abort()
    await Promise.allSettled(calls.map(call => call.result))
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (pid === undefined) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    return false
  }
}

async function execute(
  root: string,
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  secrets: readonly string[],
  limits: RunnerLimits = {},
): Promise<RunnerResult> {
  const cap = limits.outputBytesPerStream ?? runnerLimits.outputBytesPerStream
  const timeoutMs = limits.timeoutMs ?? runnerLimits.timeoutMs
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('Output byte limit must be a non-negative integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Timeout must be a positive integer')
  const scanner = new SecretScanner(secrets)
  const started = performance.now()
  const directory = await mkdtemp(join(root, 'artium-call-')).catch(() => {
    throw new RunnerError('TEMP_UNAVAILABLE', 'The private call directory could not be created.', 'Check temporary storage capacity and permissions.')
  })
  try {
    if (limits.signal?.aborted) throw new RunnerError('CANCELLED', 'The call was cancelled.', 'Check the tool status before retrying.')
    return await new Promise<RunnerResult>((resolve, reject) => {
      const streams = {
        stdout: { chunks: [] as Buffer[], retained: 0, observed: 0 },
        stderr: { chunks: [] as Buffer[], retained: 0, observed: 0 },
      }
      let secretDetected = false
      let spawnFailed = false
      let failure: RunnerError | undefined
      let killTimer: NodeJS.Timeout | undefined
      let cleanupDone = false
      let closed = false
      let exitCode: number | null = null
      const python = limits.runtime === 'python' || executable === toolPaths['falcon-axi']
      const launcher = `import os,resource,sys; resource.setrlimit(resource.RLIMIT_AS, (${runnerLimits.pythonAddressSpaceBytes}, ${runnerLimits.pythonAddressSpaceBytes})); os.execv(sys.argv[1], sys.argv[1:])`
      const child = spawn(python ? '/usr/bin/python3' : executable, python ? ['-c', launcher, executable, ...args] : [...args], {
        shell: false,
        detached: true,
        cwd: directory,
        env: {
          ...environment,
          PATH: runtimePath,
          HOME: directory,
          TMPDIR: directory,
          XDG_CONFIG_HOME: directory,
          XDG_CACHE_HOME: directory,
          XDG_DATA_HOME: directory,
          XDG_STATE_HOME: directory,
          XDG_RUNTIME_DIR: directory,
          NODE_OPTIONS: `--max-old-space-size=${runnerLimits.nodeHeapMiB}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // Even a normally exited leader can leave descendants, with or without inherited pipes.
      const terminate = () => {
        if (killTimer || cleanupDone) return
        const signalled = signalGroup(child.pid, 'SIGTERM')
        if (signalled || !closed) {
          killTimer = setTimeout(() => {
            signalGroup(child.pid, 'SIGKILL')
            cleanupDone = true
            // Escaped sessions can hold inherited pipes open after the group is gone.
            child.stdout.destroy()
            child.stderr.destroy()
            finish()
          }, runnerLimits.terminationGraceMs)
        } else {
          cleanupDone = true
        }
      }
      const cancel = () => {
        failure ??= new RunnerError('CANCELLED', 'The call was cancelled.', 'Check the tool status before retrying.')
        terminate()
      }
      const timeout = setTimeout(() => {
        failure ??= new RunnerError('TIMEOUT', 'The upstream tool exceeded its timeout.', 'Check the tool status before retrying.')
        terminate()
      }, timeoutMs)
      limits.signal?.addEventListener('abort', cancel, { once: true })
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on('data', (chunk: Buffer) => {
          const output = streams[stream]
          output.observed += chunk.length
          if (scanner.scan(stream, chunk)) {
            secretDetected = true
            streams.stdout.chunks = []
            streams.stderr.chunks = []
            terminate()
          }
          if (streams.stdout.observed + streams.stderr.observed >= runnerLimits.floodBytes) {
            failure ??= new RunnerError('OUTPUT_LIMIT', 'The upstream tool exceeded the output limit.', 'Use a command that produces less output.')
            terminate()
          }
          if (secretDetected) return
          const count = Math.min(chunk.length, cap - output.retained)
          if (count > 0) output.chunks.push(Buffer.from(chunk.subarray(0, count)))
          output.retained += count
        })
      }
      child.on('error', () => { spawnFailed = true })
      child.on('exit', () => {
        clearTimeout(timeout)
        terminate()
      })
      // close follows exit and stream drainage, including failed executable lookup.
      const finish = () => {
        if (!closed || !cleanupDone) return
        clearTimeout(timeout)
        limits.signal?.removeEventListener('abort', cancel)
        if (secretDetected) {
          reject(new RunnerError('SECRET_IN_OUTPUT', 'A known secret was detected in tool output.', 'Check upstream output redaction before retrying.'))
        } else if (spawnFailed) {
          reject(new RunnerError('SPAWN_FAILED', 'The upstream tool could not be started.', 'Check the configured executable and environment.'))
        } else if (failure) {
          reject(failure)
        } else if (exitCode === null) {
          reject(new RunnerError('PROCESS_SIGNAL', 'The upstream tool ended on a signal.', 'Check the tool status before retrying.'))
        } else {
          const truncated = {
            stdout: streams.stdout.observed > cap,
            stderr: streams.stderr.observed > cap,
          }
          resolve({
            stdout: decode(Buffer.concat(streams.stdout.chunks), truncated.stdout),
            stderr: decode(Buffer.concat(streams.stderr.chunks), truncated.stderr),
            exitCode,
            durationMs: performance.now() - started,
            outputBytes: { stdout: streams.stdout.observed, stderr: streams.stderr.observed },
            timedOut: false,
            truncated,
          })
        }
      }
      child.on('close', (code) => {
        exitCode = code
        closed = true
        if (!signalGroup(child.pid, 0)) {
          clearTimeout(killTimer)
          cleanupDone = true
        }
        terminate()
        finish()
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
