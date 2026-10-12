import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runnerLimits, runtimePath, toolPaths } from '../config.js'
import { SecretScanner } from './scan.js'
import { ArtiumError } from '../../shared/errors.js'
import { validateInput, writeInput } from './input.js'
import type { RunnerInput } from './input.js'
import type { TemporaryFile } from '../adapters/types.js'

export interface RunnerLimits {
  outputBytesPerStream?: number
  timeoutMs?: number
  runtime?: 'python'
  nodeHeapMiB?: number
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

export class RunnerError extends ArtiumError {
  durationMs?: number
  outputBytes?: { stdout: number, stderr: number }
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

  run(userId: string, executable: string, args: readonly string[], environment: Readonly<Record<string, string>>, secrets: readonly string[], limits: RunnerLimits = {}, input: RunnerInput = {}, files: readonly TemporaryFile[] = [], beforeSpawn?: () => void): Promise<RunnerResult> {
    if (!userId) return Promise.reject(new TypeError('An authenticated user is required'))
    try {
      input = validateInput(args, input)
    } catch (error) {
      return Promise.reject(error)
    }
    if (this.closed) return Promise.reject(new RunnerError('RUNNER_CLOSED'))
    const userCalls = [...this.active.values()].filter(call => call.userId === userId).length
    if (this.active.size >= runnerLimits.globalCalls || userCalls >= runnerLimits.userCalls) {
      return Promise.reject(new RunnerError('TOO_MANY_CALLS'))
    }
    const key = Symbol()
    const controller = new AbortController()
    const signal = limits.signal ? AbortSignal.any([limits.signal, controller.signal]) : controller.signal
    const result = execute(this.root, executable, args, environment, secrets, { ...limits, signal }, input, files, beforeSpawn)
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
  input: RunnerInput = {},
  files: readonly TemporaryFile[] = [],
  beforeSpawn?: () => void,
): Promise<RunnerResult> {
  const cap = limits.outputBytesPerStream ?? runnerLimits.outputBytesPerStream
  const timeoutMs = limits.timeoutMs ?? runnerLimits.timeoutMs
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('Output byte limit must be a non-negative integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Timeout must be a positive integer')
  const scanner = new SecretScanner(secrets)
  const started = performance.now()
  const directory = await mkdtemp(join(root, 'artium-call-')).catch(() => {
    throw new RunnerError('TEMP_UNAVAILABLE')
  })
  const directories = {
    HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'),
    XDG_RUNTIME_DIR: join(directory, 'runtime'),
  }
  try {
    if (limits.signal?.aborted) throw new RunnerError('CANCELLED')
    try {
      await Promise.all(Object.values(directories).map(path => mkdir(path, { mode: 0o700 })))
      const names = new Set<string>()
      for (const file of files) {
        if (!file.name.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) || names.has(file.name)) {
          throw new Error('Invalid adapter file name')
        }
        names.add(file.name)
        const target = join(directories.XDG_CONFIG_HOME, file.name)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await chmod(dirname(target), 0o700)
        const temporary = `${target}.tmp`
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(file.content); await handle.sync() }
        finally { await handle.close() }
        await rename(temporary, target)
      }
    } catch { throw new RunnerError('TEMP_UNAVAILABLE') }
    args = await writeInput(directories.TMPDIR, args, input)
    if (limits.signal?.aborted) throw new RunnerError('CANCELLED')
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
      beforeSpawn?.()
      const child = spawn(python ? '/usr/bin/python3' : executable, python ? ['-c', launcher, executable, ...args] : [...args], {
        shell: false,
        detached: true,
        cwd: directories.XDG_CONFIG_HOME,
        env: {
          ...environment,
          PATH: runtimePath,
          ...directories,
          NODE_OPTIONS: `--max-old-space-size=${limits.nodeHeapMiB ?? runnerLimits.nodeHeapMiB}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      // An upstream tool can finish without consuming stdin. Its exit status still owns the result.
      child.stdin.on('error', () => {})
      child.stdin.end(input.stdin, 'utf8')
      // Even a normally exited leader can leave descendants, with or without inherited pipes.
      const terminate = () => {
        if (killTimer || cleanupDone) return
        child.stdin.destroy()
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
        failure ??= new RunnerError('CANCELLED')
        terminate()
      }
      const timeout = setTimeout(() => {
        failure ??= new RunnerError('TIMEOUT')
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
            failure ??= new RunnerError('OUTPUT_LIMIT')
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
          failure = new RunnerError('SECRET_IN_OUTPUT')
        } else if (spawnFailed) {
          failure = new RunnerError('SPAWN_FAILED')
        } else if (!failure && exitCode === null) {
          failure = new RunnerError('PROCESS_SIGNAL')
        }
        if (failure) {
          failure.durationMs = performance.now() - started
          failure.outputBytes = { stdout: streams.stdout.observed, stderr: streams.stderr.observed }
          reject(failure)
        } else {
          const truncated = {
            stdout: streams.stdout.observed > cap,
            stderr: streams.stderr.observed > cap,
          }
          resolve({
            stdout: decode(Buffer.concat(streams.stdout.chunks), truncated.stdout),
            stderr: decode(Buffer.concat(streams.stderr.chunks), truncated.stderr),
            exitCode: exitCode!,
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
