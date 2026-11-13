import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Serializable, ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isIP } from 'node:net'
import { connect, getCACertificates } from 'node:tls'
import type { TrustedCaBundle, TrustedCertificate } from '../trusted-ca.js'
import { adoPathPrefix, runnerLimits, runtimePath, toolPaths, protectedResultLimits } from '../config.js'
import { SecretScanner } from './scan.js'
import type { PrivateOutput } from './scan.js'
import { ArtiumError } from '../../shared/errors.js'
import { inputFileSchema } from '../../shared/api.js'
import { validateInput, writeInput } from './input.js'
import type { RunnerInput } from './input.js'
import type { Readable, Duplex } from 'node:stream'
import type { TemporaryFile } from '../adapters/types.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { certificateEndpoint } from '../certificate-endpoint.js'
import { classifyCertificateFailure, observeCertificate } from '../credential-tls.js'
import { nodeTrustBootstrap, pythonTrustBootstrap } from './runtime-trust.js'
import { acquireFalconRtrLock } from './falcon-rtr-lock.js'
import { kubernetesRequestProfile } from './kubernetes-requests.js'
import { pinnedHttp, type PinnedHttpUpstream } from './pinned-http.js'
import type { CompletedMutation, MutationReceipt } from '../../shared/mutation-outcome.js'

export type GoTransportTrust = { transport: 'github' } | {
  endpoint: string, transport: 'kubectl', hostModule?: string, clientIdentity?: PinnedHttpUpstream['clientIdentity'], mutationWorkflow?: boolean
}
const goPinEnforcement: Record<GoTransportTrust['transport'], 'http-unix' | 'host-socket' | 'refuse'> = { github: 'http-unix', kubectl: 'host-socket' }

export interface RunnerLimits {
  delegated?: boolean
  // A native confirmation may bind file names. The directory is still empty on every call.
  directoryScope?: string
  publicContent?: import('./scan.js').PublicContent
  validateOutput?: (stdout: string) => void
  unifiScope?: string
  kubernetesRequests?: { root: string, scope: string }
  falconRtrDevice?: string
  trustedIpc?: Serializable
  outputBytesPerStream?: number
  timeoutMs?: number
  terminationGraceMs?: number
  runtime?: 'python'
  systemCaBundle?: GoTransportTrust
  nodeHeapMiB?: number
  signal?: AbortSignal
  credentialTrust?: readonly CredentialTrust[]
  protectedResult?: { name: string, flag: string, receive: (bytes: Buffer) => void }
  protectedPipe?: ({ flag: string, argumentIndex: number } | { environment: string }) & {
    receive: (bytes: Buffer) => readonly string[] | void
    early?: boolean
  }
  bytePipe?: { environment: string, connect: (socket: Duplex, signal: AbortSignal) => Promise<void> }
  privateOutput?: PrivateOutput
  mutationReceipt?: (stdout: string, capture: (receipt: MutationReceipt) => void) => void | Promise<void>
}

export interface RunnerResult {
  completedMutation?: CompletedMutation
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  outputBytes: { stdout: number, stderr: number }
  timedOut: boolean
  truncated: { stdout: boolean, stderr: boolean }
}

export class RunnerError extends ArtiumError {
  spawnError?: Error
  durationMs?: number
  outputBytes?: { stdout: number, stderr: number }
  truncated = { stdout: false, stderr: false }
  processStarted = false
}

// A byte cap must not introduce a replacement character from an incomplete UTF-8 suffix.
function decode(bytes: Buffer, truncated: boolean): string {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  return decoder.decode(bytes, { stream: truncated })
}

// One server owns one runner. Admission covers setup, child execution and cleanup.
export class Runner {
  private readonly directoryScopes = new Set<string>()
  private readonly active = new Map<symbol, { userId: string, delegated: boolean, controller: AbortController, result: Promise<unknown> }>()
  private closed = false
  private readonly queue: { userId: string, delegated: boolean, admit: () => void, reject: (code: 'CANCELLED' | 'RUNNER_CLOSED' | 'TOO_MANY_CALLS') => void }[] = []

  private drain(): void {
    while (!this.closed && this.queue.length && this.active.size < runnerLimits.globalCalls) {
      const index = this.queue.findIndex(pending =>
        [...this.active.values()].filter(call => call.userId === pending.userId).length < runnerLimits.userCalls
        && (!pending.delegated || [...this.active.values()].filter(call => call.userId === pending.userId && call.delegated).length < 2))
      if (index === -1) return
      const [next] = this.queue.splice(index, 1)
      next.admit()
    }
  }

  private constructor(private readonly root: string, private readonly trustedCa?: TrustedCaBundle) {}

  get trustedCertificates(): readonly TrustedCertificate[] { return this.trustedCa?.certificates ?? [] }
  get configuredCaPem(): string | undefined { return this.trustedCa?.pem }

  caBundleFor(endpoint: string, credentialTrust: readonly CredentialTrust[]): string {
    return runtimeTrust({ systemCaBundle: { endpoint, transport: 'kubectl' }, credentialTrust }, this.trustedCa).trustPem
  }

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
    return this.runManaged(userId, limits.signal, async signal => {
      if (limits.directoryScope !== undefined && !/^[a-f0-9]{64}$/.test(limits.directoryScope)) throw new TypeError('Invalid directory scope')
      const directoryScope = limits.directoryScope && createHash('sha256').update(JSON.stringify([userId, limits.directoryScope])).digest('hex')
      if (directoryScope && this.directoryScopes.has(directoryScope)) throw new RunnerError('TOO_MANY_CALLS')
      if (directoryScope) this.directoryScopes.add(directoryScope)
      try {
        const custody = limits.falconRtrDevice ? await acquireFalconRtrLock(this.root,
          executable === process.execPath ? args[0] : executable, limits.falconRtrDevice) : undefined
        try { return await execute(this.root, executable, args, environment, secrets, { ...limits, directoryScope, signal }, input, files, beforeSpawn, this.trustedCa, pathPrefix) }
        finally { custody?.close() }
      } finally { if (directoryScope) this.directoryScopes.delete(directoryScope) }
    }, limits.delegated)
  }

  runManaged<T>(userId: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>, delegated = false): Promise<T> {
    if (!userId) return Promise.reject(new TypeError('An authenticated user is required'))
    if (this.closed) return Promise.reject(new RunnerError('RUNNER_CLOSED'))
    if (signal?.aborted) return Promise.reject(new RunnerError('CANCELLED'))
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
      }
      const pending = {
        userId, delegated,
        admit: () => {
          cleanup()
          const key = Symbol()
          const controller = new AbortController()
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
          const result = Promise.resolve().then(() => operation(combined)).finally(() => {
            this.active.delete(key)
            this.drain()
          })
          this.active.set(key, { userId, delegated, controller, result })
          resolve(result)
        },
        reject: (code: 'CANCELLED' | 'RUNNER_CLOSED' | 'TOO_MANY_CALLS') => {
          cleanup()
          this.queue.splice(this.queue.indexOf(pending), 1)
          reject(new RunnerError(code))
          this.drain()
        },
      }
      const cancel = () => pending.reject('CANCELLED')
      const timer = setTimeout(() => pending.reject('TOO_MANY_CALLS'), runnerLimits.admissionWaitMs)
      signal?.addEventListener('abort', cancel, { once: true })
      this.queue.push(pending)
      this.drain()
    })
  }

  async shutdown(): Promise<void> {
    this.closed = true
    for (const pending of [...this.queue]) pending.reject('RUNNER_CLOSED')
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

function runtimeTrust(limits: Pick<RunnerLimits, 'systemCaBundle' | 'credentialTrust'>, trustedCa?: TrustedCaBundle) {
  const caEndpoint = limits.systemCaBundle?.transport === 'kubectl' ? certificateEndpoint(limits.systemCaBundle.endpoint).href : undefined
  const credentialTrust = (limits.credentialTrust ?? []).filter(certificate => !caEndpoint || certificateEndpoint(certificate.endpoint).href === caEndpoint)
  if (limits.systemCaBundle?.transport === 'kubectl' && limits.systemCaBundle.clientIdentity && limits.systemCaBundle.mutationWorkflow
    && credentialTrust.some(certificate => certificate.mode === 'pin')) {
    throw new RunnerError('INVALID_INPUT', 'certificate-pinned changes need kubernetes-axi binding fix')
  }
  if (limits.systemCaBundle && (goPinEnforcement[limits.systemCaBundle.transport] === 'refuse'
    || limits.systemCaBundle.transport === 'kubectl' && !limits.systemCaBundle.hostModule)
    && credentialTrust.some(certificate => certificate.mode !== 'ca')) {
    throw new RunnerError('INVALID_INPUT', 'Kubernetes hosted byte sessions require issuing CA trust; pins require the managed host transport.')
  }
  const trustPem = trustedCa || credentialTrust.length || limits.systemCaBundle
    ? [...getCACertificates('default'), ...(trustedCa ? [trustedCa.pem] : []),
      ...(limits.systemCaBundle ? credentialTrust.map(certificate => certificate.pem) : [])].join('\n') : ''
  return { credentialTrust, trustPem }
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
  const { credentialTrust, trustPem } = runtimeTrust(limits, trustedCa)
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
  const scanner = new SecretScanner(secrets, limits.privateOutput, limits.publicContent)
  const validationChunks: Buffer[] = []
  const started = performance.now()
  const directory = await (limits.directoryScope
    ? mkdir(join(root, 'artium-call-' + limits.directoryScope), { mode: 0o700 }).then(() => join(root, 'artium-call-' + limits.directoryScope))
    : mkdtemp(join(root, 'artium-call-'))).catch(() => {
    throw new RunnerError('TEMP_UNAVAILABLE')
  })
  const directories = {
    HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_DATA_HOME: join(directory, 'data'), XDG_STATE_HOME: join(directory, 'state'),
    XDG_RUNTIME_DIR: join(directory, 'runtime'),
  }
  let kubernetesProfile: string | undefined
  let relay: Awaited<ReturnType<typeof pinnedHttp>> | undefined
  const privateChunks: Buffer[] = []
  let result: RunnerResult | undefined
  let pending: Error | undefined
  try {
    try {
      if (limits.signal?.aborted) throw new RunnerError('CANCELLED')
      try {
        await Promise.all(Object.values(directories).map(path => mkdir(path, { mode: 0o700 })))
        if (limits.systemCaBundle && goPinEnforcement[limits.systemCaBundle.transport] !== 'refuse'
          && credentialTrust.some(certificate => certificate.mode === 'pin')) {
          const socketPath = join(directory, 'http.sock')
          relay = await pinnedHttp(socketPath, credentialTrust, trustedCa?.pem,
            limits.systemCaBundle.transport === 'kubectl' ? limits.systemCaBundle : undefined)
          if (limits.systemCaBundle.transport === 'github') {
            files = [...files, { name: 'gh/config.yml', content: `http_unix_socket: ${JSON.stringify(socketPath)}\n` }]
          } else {
            if (limits.systemCaBundle.clientIdentity) {
              files = [...files, { name: 'kubernetes-axi/client.key', content: limits.systemCaBundle.clientIdentity.privateKey }]
            }
            const transport = { socketPath, endpoint: limits.systemCaBundle.endpoint,
              ...(limits.systemCaBundle.clientIdentity ? { capabilities: { clientCertificate: true } } : {}) }
            files = [...files, { name: 'kubernetes-transport.mjs', content:
              `import { main } from ${JSON.stringify(limits.systemCaBundle.hostModule)};\nawait main(process.argv.slice(2), { transport: ${JSON.stringify(transport)} });\n` }]
            args = [join(directories.XDG_CONFIG_HOME, 'kubernetes-transport.mjs'), ...args.slice(1)]
          }
        }
        if (limits.kubernetesRequests) kubernetesProfile = await kubernetesRequestProfile(
          limits.kubernetesRequests.root, limits.kubernetesRequests.scope, basename(directory))
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
          const target = kubernetesProfile && file.name === 'kubernetes-axi/config.json' ? kubernetesProfile : join(directories.XDG_CONFIG_HOME, file.name)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await chmod(dirname(target), 0o700)
          const temporary = target === kubernetesProfile ? `${target}.tmp` : join(directories.TMPDIR, 'adapter-file')
          const handle = await open(temporary, 'wx', 0o600)
          try {
            let content = file.content
            if (relay && limits.systemCaBundle?.transport === 'kubectl' && limits.systemCaBundle.clientIdentity && file.name === 'kubernetes-axi/config.json') {
              const profile = JSON.parse(Buffer.from(content).toString('utf8'))
              const childEnvironment = { ...environment }
              delete childEnvironment[profile.profiles.artium.privateKey.env]
              environment = childEnvironment
              profile.profiles.artium.privateKey = { file: join(directories.XDG_CONFIG_HOME, 'kubernetes-axi/client.key') }
              content = JSON.stringify(profile)
            }
            if (limits.unifiScope && file.name === 'unifi-axi/config.json') {
              if (!/^[a-f0-9]{64}$/.test(limits.unifiScope)) throw new Error('Invalid UniFi identity scope')
              const profile = JSON.parse(Buffer.from(content).toString('utf8'))
              content = JSON.stringify({ ...profile, defaultProfile: limits.unifiScope,
                profiles: { [limits.unifiScope]: profile.profiles.artium } })
            }
            if (file.appendTrustedCaAt && trustPem) {
              const profile = JSON.parse(Buffer.from(content).toString('utf8')) as Record<string, unknown>
              let parent = profile
              for (const key of file.appendTrustedCaAt.slice(0, -1)) parent = parent[key] as Record<string, unknown>
              const key = file.appendTrustedCaAt.at(-1)!
              parent[key] = String(parent[key]) + '\n' + trustPem
              content = JSON.stringify(profile)
            }
            await handle.writeFile(file.appendTrustedCa && trustPem
              ? Buffer.concat([Buffer.from(content), Buffer.from('\n' + trustPem)]) : content)
            await handle.sync()
          }
          finally { await handle.close() }
          await rename(temporary, target)
        }
      } catch { throw new RunnerError('TEMP_UNAVAILABLE') }
      args = await writeInput(directories.TMPDIR, args, input)
      if (limits.protectedResult) {
        if (!inputFileSchema.shape.name.safeParse(limits.protectedResult.name).success) throw new RunnerError('INVALID_INPUT')
        args = [...args, limits.protectedResult.flag, join(directories.XDG_CONFIG_HOME, limits.protectedResult.name)]
      }
      if (limits.protectedPipe && 'flag' in limits.protectedPipe) {
        const { argumentIndex, flag } = limits.protectedPipe
        args = [...args.slice(0, argumentIndex), flag, '4', ...args.slice(argumentIndex)]
      }
      if (limits.signal?.aborted) throw new RunnerError('CANCELLED')
      result = await new Promise<RunnerResult>((resolve, reject) => {
        const streams = {
          stdout: { chunks: [] as Buffer[], retained: 0, observed: 0 },
          stderr: { chunks: [] as Buffer[], retained: 0, observed: 0 },
        }
        let secretDetected = false
        let spawnError: Error | undefined
        let processStarted = false
        let failure: RunnerError | undefined
        let killTimer: NodeJS.Timeout | undefined
        let cleanupDone = false
        let closed = false
        let finished = false
        let byteDone = !limits.bytePipe, privateDelivered = false
        const byteController = new AbortController()
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
            ...(limits.protectedPipe && 'environment' in limits.protectedPipe ? { [limits.protectedPipe.environment]: '4' } : {}),
            ...(limits.bytePipe ? { [limits.bytePipe.environment]: '5' } : {}),
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
            ...(environment.BEYONDTRUST_AXI_WRITE_LOG ? { XDG_STATE_HOME: dirname(environment.BEYONDTRUST_AXI_WRITE_LOG) } : {}),
            ...(limits.falconRtrDevice ? { XDG_STATE_HOME: join(root, 'falcon-rtr-state') } : {}),
            ...(kubernetesProfile ? { KUBERNETES_AXI_CONFIG: kubernetesProfile } : {}),
            NODE_OPTIONS: `--max-old-space-size=${limits.nodeHeapMiB ?? runnerLimits.nodeHeapMiB}${credentialTrust.length ? ` --require=${join(directories.XDG_CONFIG_HOME, 'artium-tls.cjs')}` : ''}`,
          },
          stdio: limits.bytePipe ? ['pipe', 'pipe', 'pipe', limits.trustedIpc === undefined ? 'ignore' : 'ipc', limits.protectedPipe ? 'pipe' : 'ignore', 'pipe']
            : limits.protectedPipe ? ['pipe', 'pipe', 'pipe', limits.trustedIpc === undefined ? 'ignore' : 'ipc', 'pipe']
            : limits.trustedIpc === undefined ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'ipc'],
        }) as ChildProcessWithoutNullStreams
        const privatePipe = limits.protectedPipe ? child.stdio[4] as Readable : undefined
        const bytePipe = limits.bytePipe ? child.stdio.at(5) as Duplex : undefined
        if (bytePipe) void Promise.resolve().then(() => limits.bytePipe!.connect(bytePipe,
          limits.signal ? AbortSignal.any([limits.signal, byteController.signal]) : byteController.signal))
          .catch(() => { failure ??= new RunnerError('TEMP_UNAVAILABLE'); terminate() })
          .finally(() => { byteDone = true; finish() })
        let privateBytes = 0
        privatePipe?.on('data', (chunk: Buffer) => {
          privateBytes += chunk.length
          if (privateBytes > protectedResultLimits.bytes) { failure ??= new RunnerError('OUTPUT_LIMIT'); terminate() }
          else {
            privateChunks.push(Buffer.from(chunk))
            if (limits.protectedPipe?.early) {
              const bytes = Buffer.concat(privateChunks)
              try {
                if (bytes.length > 65540 || bytes.length >= 4 && (bytes.readUInt32BE(0) > 65536 || bytes.length > bytes.readUInt32BE(0) + 4)) throw new Error('Frame bound')
                if (!privateDelivered && bytes.length >= 4 && bytes.length === bytes.readUInt32BE(0) + 4) {
                  scanner.registerSecrets(limits.protectedPipe.receive(bytes) ?? [])
                  privateDelivered = true
                }
              } catch { failure ??= new RunnerError('UNKNOWN_OUTCOME'); terminate() }
              finally { bytes.fill(0) }
            }
          }
        })
        privatePipe?.on('error', () => { failure ??= new RunnerError('TEMP_UNAVAILABLE'); terminate() })
        if (limits.trustedIpc !== undefined) child.once('spawn', () => {
          child.send!(limits.trustedIpc!, error => { if (error) child.kill('SIGTERM') })
        })
        // An upstream tool can finish without consuming stdin. Its exit status still owns the result.
        child.stdin.on('error', () => {})
        child.stdin.end(input.stdin, 'utf8')
        // Even a normally exited leader can leave descendants, with or without inherited pipes.
        const terminate = () => {
          if (failure) { byteController.abort(); bytePipe?.destroy() }
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
              privatePipe?.destroy()
              byteController.abort(); bytePipe?.destroy()
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
            if (limits.validateOutput && stream === 'stdout' && !failure && !secretDetected) validationChunks.push(Buffer.from(chunk))
            if (secretDetected) return
            const count = Math.min(chunk.length, cap - output.retained)
            if (count > 0) output.chunks.push(Buffer.from(chunk.subarray(0, count)))
            output.retained += count
          })
        }
        child.on('error', error => { spawnError = error })
        child.on('spawn', () => { processStarted = true })
        child.on('exit', () => {
          clearTimeout(timeout)
          terminate()
        })
        // close follows exit and stream drainage, including failed executable lookup.
        const finish = () => {
          if (!closed || !cleanupDone || !byteDone || finished) return
          finished = true
          clearTimeout(timeout)
          limits.signal?.removeEventListener('abort', cancel)
          if (limits.protectedPipe && 'environment' in limits.protectedPipe && !privateDelivered && (privateChunks.length || exitCode === 0)) {
            const bytes = Buffer.concat(privateChunks)
            try { scanner.registerSecrets(limits.protectedPipe.receive(bytes) ?? []) }
            catch { failure ??= new RunnerError('UNKNOWN_OUTCOME') }
            finally { bytes.fill(0) }
          }
          if (secretDetected || scanner.finish()) {
            failure = new RunnerError('SECRET_IN_OUTPUT')
          } else if (spawnError) {
            failure = new RunnerError('SPAWN_FAILED')
            failure.spawnError = spawnError
          } else if (!failure && exitCode === null) {
            failure = new RunnerError('PROCESS_SIGNAL')
          }
          if (!failure && exitCode === 0 && limits.validateOutput) {
            try {
              limits.validateOutput(Buffer.concat(validationChunks).toString('utf8'))
            } catch { failure = new RunnerError('SECRET_IN_OUTPUT') }
          }
          const truncated = {
            stdout: streams.stdout.observed > cap,
            stderr: streams.stderr.observed > cap,
          }
          if (failure) {
            failure.processStarted = processStarted
            failure.durationMs = performance.now() - started
            failure.outputBytes = { stdout: streams.stdout.observed, stderr: streams.stderr.observed }
            failure.truncated = truncated
            reject(failure)
          } else {
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
      if (!result.truncated.stdout && limits.mutationReceipt) {
        const execution = result
        await limits.mutationReceipt(execution.stdout, receipt => {
          execution.completedMutation = Object.freeze({ receipt, exitCode: execution.exitCode,
            durationMs: performance.now() - started, outputBytes: Object.freeze({ ...execution.outputBytes }),
            truncated: Object.freeze({ ...execution.truncated }) })
        })
      }
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
              durationMs: performance.now() - started, outputBytes: result.outputBytes, truncated: result.truncated })
          }
          result.stdout = ''
          result.stderr = decode(diagnostic.subarray(0, cap), diagnostic.length > cap)
          result.truncated = { stdout: false, stderr: diagnostic.length > cap }
          break
        }
      }
      if (result.exitCode === 0 && limits.protectedResult) {
        const { name, receive } = limits.protectedResult
        const file = await open(join(directories.XDG_CONFIG_HOME, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await file.stat()
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new RunnerError('TEMP_UNAVAILABLE')
          if (info.size > protectedResultLimits.bytes) throw new RunnerError('OUTPUT_LIMIT')
          receive(await file.readFile())
        } finally { await file.close() }
      }
      if (result.exitCode === 0 && limits.protectedPipe && 'flag' in limits.protectedPipe && privateChunks.length) {
        const bytes = Buffer.concat(privateChunks)
        try { limits.protectedPipe.receive(bytes) } finally { bytes.fill(0) }
      }
      result.durationMs = performance.now() - started
      return result
    } catch (error) {
      if (error instanceof Error) pending = error
      throw error
    } finally {
      for (const chunk of privateChunks) chunk.fill(0)
      const cleanup = await Promise.allSettled([
        ...(relay ? [relay.close()] : []),
        ...(kubernetesProfile ? [rm(kubernetesProfile, { force: true }), rm(`${kubernetesProfile}.tmp`, { force: true })] : []),
        rm(directory, { recursive: true, force: true }),
      ])
      const failures = cleanup.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) {
        const failure = new AggregateError(failures, 'Private call cleanup failed')
        if (pending) Object.defineProperty(pending, 'cleanupFailure', { value: failure })
        else throw failure
      }
    }
  } catch (error) {
    if (!result) throw error
    const failure = error instanceof RunnerError ? error : new RunnerError('TEMP_UNAVAILABLE')
    if (failure !== error) Object.defineProperty(failure, 'cause', { value: error })
    throw Object.assign(failure, {
      processStarted: true, durationMs: performance.now() - started,
      outputBytes: result.outputBytes, truncated: result.truncated, recovery: result.completedMutation,
    })
  }
}
