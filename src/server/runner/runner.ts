import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isIP } from 'node:net'
import { connect, getCACertificates } from 'node:tls'
import type { TrustedCaBundle, TrustedCertificate } from '../trusted-ca.js'
import { adoPathPrefix, runnerLimits, runtimePath, toolPaths } from '../config.js'
import { SecretScanner } from './scan.js'
import { ArtiumError } from '../../shared/errors.js'
import { inputFileSchema } from '../../shared/api.js'
import { validateInput, writeInput } from './input.js'
import type { RunnerInput } from './input.js'
import type { TemporaryFile } from '../adapters/types.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { certificateEndpoint } from '../certificate-endpoint.js'
import { classifyCertificateFailure, observeCertificate } from '../credential-tls.js'
import { nodeTrustBootstrap, pythonTrustBootstrap } from './runtime-trust.js'

export interface RunnerLimits {
  outputBytesPerStream?: number
  timeoutMs?: number
  terminationGraceMs?: number
  runtime?: 'python'
  systemCaBundle?: boolean
  nodeHeapMiB?: number
  signal?: AbortSignal
  credentialTrust?: readonly CredentialTrust[]
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
  processStarted = false
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

  private constructor(private readonly root: string, private readonly trustedCa?: TrustedCaBundle) {}

  get trustedCertificates(): readonly TrustedCertificate[] { return this.trustedCa?.certificates ?? [] }

  static async create(root = join(tmpdir(), 'artium-calls'), trustedCa?: TrustedCaBundle): Promise<Runner> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(root)) {
      if (entry.startsWith('artium-call-')) await rm(join(root, entry), { recursive: true, force: true })
    }
    return new Runner(root, trustedCa)
  }

  run(userId: string, executable: string, args: readonly string[], environment: Readonly<Record<string, string>>, secrets: readonly string[], limits: RunnerLimits = {}, input: RunnerInput = {}, files: readonly TemporaryFile[] = [], beforeSpawn?: () => void, pathPrefix?: string): Promise<RunnerResult> {
    if (!userId) return Promise.reject(new TypeError('An authenticated user is required'))
    if (pathPrefix !== undefined && (!isAbsolute(pathPrefix) || pathPrefix !== adoPathPrefix)) {
      return Promise.reject(new TypeError('Unsupported runtime PATH prefix'))
    }
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
    const result = execute(this.root, executable, args, environment, secrets, { ...limits, signal }, input, files, beforeSpawn, this.trustedCa, pathPrefix)
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
  trustedCa?: TrustedCaBundle,
  pathPrefix?: string,
): Promise<RunnerResult> {
  const credentialTrust = limits.credentialTrust ?? []
  if (limits.systemCaBundle && credentialTrust.some(certificate => certificate.mode !== 'ca')) {
    throw new RunnerError('INVALID_INPUT', 'This tool requires an issuing CA; certificate pinning is unavailable.')
  }
  const trustPem = trustedCa || credentialTrust.length || limits.systemCaBundle
    ? [...getCACertificates('default'), ...(trustedCa ? [trustedCa.pem] : []),
      ...(limits.systemCaBundle ? credentialTrust.map(certificate => certificate.pem) : [])].join('\n') : ''
  const pins = credentialTrust.map(certificate => {
    const endpoint = certificateEndpoint(certificate.endpoint)
    return { hostname: endpoint.hostname, port: endpoint.port, protocol: new URL(certificate.endpoint).protocol,
      leafFingerprint: certificate.leafFingerprint, pem: certificate.pem, mode: certificate.mode }
  })
  const cap = limits.outputBytesPerStream ?? runnerLimits.outputBytesPerStream
  const timeoutMs = limits.timeoutMs ?? runnerLimits.timeoutMs
  const terminationGraceMs = limits.terminationGraceMs ?? runnerLimits.terminationGraceMs
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('Output byte limit must be a non-negative integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Timeout must be a positive integer')
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) throw new RangeError('Termination grace must be a positive integer')
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
      const trustFile = 'artium-trusted-ca.pem'
      const materialized: readonly TemporaryFile[] = [...files,
        ...(trustPem ? [{ name: trustFile, content: trustPem }] : []),
        ...(credentialTrust.length ? [
          { name: 'artium-certificate-pins.json', content: JSON.stringify(pins) },
          { name: 'artium-tls.cjs', content: nodeTrustBootstrap },
          { name: 'sitecustomize.py', content: pythonTrustBootstrap },
        ] : [])]
      for (const file of materialized) {
        if (!file.name.split('/').every(part => inputFileSchema.shape.name.safeParse(part).success) || names.has(file.name)) {
          throw new Error('Invalid adapter file name')
        }
        names.add(file.name)
        const target = join(directories.XDG_CONFIG_HOME, file.name)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await chmod(dirname(target), 0o700)
        const temporary = join(directories.TMPDIR, 'adapter-file')
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(file.appendTrustedCa && trustPem
            ? Buffer.concat([Buffer.from(file.content), Buffer.from('\n' + trustPem)]) : file.content)
          await handle.sync()
        }
        finally { await handle.close() }
        await rename(temporary, target)
      }
    } catch { throw new RunnerError('TEMP_UNAVAILABLE') }
    args = await writeInput(directories.TMPDIR, args, input)
    if (limits.signal?.aborted) throw new RunnerError('CANCELLED')
    const result = await new Promise<RunnerResult>((resolve, reject) => {
      const streams = {
        stdout: { chunks: [] as Buffer[], retained: 0, observed: 0 },
        stderr: { chunks: [] as Buffer[], retained: 0, observed: 0 },
      }
      let secretDetected = false
      let spawnFailed = false
      let processStarted = false
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
          ...(trustPem ? {
            NODE_EXTRA_CA_CERTS: join(directories.XDG_CONFIG_HOME, 'artium-trusted-ca.pem'),
            REQUESTS_CA_BUNDLE: join(directories.XDG_CONFIG_HOME, 'artium-trusted-ca.pem'),
            ...(limits.systemCaBundle ? { SSL_CERT_FILE: join(directories.XDG_CONFIG_HOME, 'artium-trusted-ca.pem') } : {}),
          } : {}),
          ...(credentialTrust.length ? {
            ARTIUM_CERTIFICATE_PINS: join(directories.XDG_CONFIG_HOME, 'artium-certificate-pins.json'),
            PYTHONPATH: directories.XDG_CONFIG_HOME,
          } : {}),
          PATH: pathPrefix ? `${pathPrefix}:${runtimePath}` : runtimePath,
          ...directories,
          NODE_OPTIONS: `--max-old-space-size=${limits.nodeHeapMiB ?? runnerLimits.nodeHeapMiB}${credentialTrust.length ? ` --require=${join(directories.XDG_CONFIG_HOME, 'artium-tls.cjs')}` : ''}`,
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
          }, terminationGraceMs)
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
      child.on('spawn', () => { processStarted = true })
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
          failure.processStarted = processStarted
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
    if (result.exitCode !== 0) {
      const original = new Error(result.stderr)
      const endpoints = new Set(credentialTrust.filter(certificate => certificate.mode === 'pin')
        .map(certificate => certificateEndpoint(certificate.endpoint).href))
      for (const endpoint of endpoints) {
        const scoped = credentialTrust.filter(certificate => certificateEndpoint(certificate.endpoint).href === endpoint)
        const { hostname: host, port } = certificateEndpoint(endpoint)
        const failure = await classifyCertificateFailure(original, scoped, undefined, () => observeCertificate(connect,
          { host, port, servername: isIP(host) ? undefined : host }, new URL(endpoint).protocol))
        if (failure === original) continue
        const diagnostic = Buffer.from(`code: CERTIFICATE_PIN_MISMATCH\nmessage: ${failure.message}\n`)
        if (new SecretScanner(secrets).scan('stderr', diagnostic)) {
          throw Object.assign(new RunnerError('SECRET_IN_OUTPUT'), { processStarted: true,
            durationMs: performance.now() - started, outputBytes: result.outputBytes })
        }
        result.stdout = ''
        result.stderr = decode(diagnostic.subarray(0, cap), diagnostic.length > cap)
        result.truncated = { stdout: false, stderr: diagnostic.length > cap }
        break
      }
    }
    result.durationMs = performance.now() - started
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
