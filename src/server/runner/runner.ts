import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runtimePath } from '../config.js'
import { SecretScanner } from './scan.js'

export interface RunnerLimits {
  outputBytesPerStream?: number
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
  constructor(readonly code: 'SECRET_IN_OUTPUT' | 'SPAWN_FAILED' | 'PROCESS_SIGNAL', message: string, readonly next: string) {
    super(message)
  }
}

// A byte cap must not introduce a replacement character from an incomplete UTF-8 suffix.
function decode(bytes: Buffer, truncated: boolean): string {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  return decoder.decode(bytes, { stream: truncated })
}

export async function run(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  secrets: readonly string[],
  limits: RunnerLimits = {},
): Promise<RunnerResult> {
  const cap = limits.outputBytesPerStream ?? 4 * 1024 * 1024
  if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('Output byte limit must be a non-negative integer')
  const scanner = new SecretScanner(secrets)
  const started = performance.now()
  const directory = await mkdtemp(join(tmpdir(), 'artium-call-'))
  try {
    return await new Promise<RunnerResult>((resolve, reject) => {
      const streams = {
        stdout: { chunks: [] as Buffer[], retained: 0, observed: 0 },
        stderr: { chunks: [] as Buffer[], retained: 0, observed: 0 },
      }
      let secretDetected = false
      let spawnFailed = false
      const child = spawn(executable, [...args], {
        shell: false,
        detached: true,
        cwd: directory,
        env: {
          ...environment,
          PATH: runtimePath,
          HOME: directory,
          TMPDIR: directory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on('data', (chunk: Buffer) => {
          const output = streams[stream]
          output.observed += chunk.length
          if (scanner.scan(stream, chunk)) {
            secretDetected = true
            streams.stdout.chunks = []
            streams.stderr.chunks = []
          }
          if (secretDetected) return
          const count = Math.min(chunk.length, cap - output.retained)
          if (count > 0) output.chunks.push(Buffer.from(chunk.subarray(0, count)))
          output.retained += count
        })
      }
      child.on('error', () => { spawnFailed = true })
      // close follows exit and stream drainage, including failed executable lookup.
      child.on('close', (exitCode) => {
        if (secretDetected) {
          reject(new RunnerError('SECRET_IN_OUTPUT', 'A known secret was detected in tool output.', 'Check upstream output redaction before retrying.'))
        } else if (spawnFailed) {
          reject(new RunnerError('SPAWN_FAILED', 'The upstream tool could not be started.', 'Check the configured executable and environment.'))
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
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
