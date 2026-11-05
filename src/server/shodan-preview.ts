import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import type { PreparedCall } from './adapters/types.js'
import { runtimePath, toolPaths } from './config.js'
import { SecretScanner } from './runner/scan.js'

const previewSchema = z.object({ status: z.literal('preview'), token: z.uuid(), operation: z.string(),
  limit: z.number(), maxBytes: z.number(), timeoutMs: z.number(), idleTimeoutMs: z.number(), cost: z.literal('unknown') }).passthrough()

export async function runShodanNative(directory: string, args: string[],
  profile: Pick<PreparedCall, 'environment' | 'files' | 'secrets'>, signal: AbortSignal, authorize: () => void, configuredCaPem?: string) {
  const root = join(directory, 'preview'), state = join(directory, 'state')
  const directories = Object.fromEntries(Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp' }).map(([key, leaf]) => [key, join(root, leaf)]))
  const scanner = new SecretScanner(profile.secrets)
  try {
    for (const path of [...Object.values(directories), state]) await mkdir(path, { recursive: true, mode: 0o700 })
    for (const file of profile.files) {
      const path = join(directories.XDG_CONFIG_HOME, file.name)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, file.content, { flag: 'wx', mode: 0o600 })
    }
    const caFile = join(directories.XDG_CONFIG_HOME, 'artium-trusted-ca.pem')
    if (configuredCaPem) await writeFile(caFile, configuredCaPem, { flag: 'wx', mode: 0o600 })
    if (scanner.scan('stdout', Buffer.from(JSON.stringify(args)))) throw new ArtiumError('INVALID_INPUT')
    authorize()
    if (signal.aborted) throw new ArtiumError('CANCELLED')
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [toolPaths['shodan-axi'], ...args], { cwd: directories.HOME, detached: true,
        env: { ...profile.environment, ...directories, XDG_STATE_HOME: state, PATH: runtimePath, NODE_OPTIONS: '--max-old-space-size=256',
          ...(configuredCaPem ? { NODE_EXTRA_CA_CERTS: caFile } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      let bytes = 0, failed = false
      const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ } }
      const cancel = () => { failed = true; kill() }
      const timer = setTimeout(cancel, 30000).unref()
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 65536 || scanner.scan(stream === child.stdout ? 'stdout' : 'stderr', chunk)) { failed = true; kill(); return }
        if (stream === child.stdout) stdout.push(Buffer.from(chunk))
      })
      child.once('error', () => { failed = true })
      child.once('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (failed || code !== 0) reject(new ArtiumError('TOOL_FAILED'))
        else {
          try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout))) }
          catch { reject(new ArtiumError('INVALID_RESPONSE')) }
        }
      })
    })
    authorize()
    return JSON.parse(output) as unknown
  } finally {
    profile.secrets.fill(''); profile.files.length = 0
    for (const key of Object.keys(profile.environment)) delete profile.environment[key]
    await rm(root, { recursive: true, force: true })
  }
}

export async function shodanNativePreview(directory: string, args: string[], operation: string,
  bounds: { limit: number, maxBytes: number, timeout: number, idleTimeout: number },
  profile: Pick<PreparedCall, 'environment' | 'files' | 'secrets'>, signal: AbortSignal, authorize: () => void, configuredCaPem?: string) {
  const value = await runShodanNative(directory, args, profile, signal, authorize, configuredCaPem)
  const preview = previewSchema.safeParse(value)
  if (!preview.success || preview.data.operation !== operation || preview.data.limit !== bounds.limit
    || preview.data.maxBytes !== bounds.maxBytes || preview.data.timeoutMs !== bounds.timeout
    || preview.data.idleTimeoutMs !== bounds.idleTimeout) throw new ArtiumError('INVALID_RESPONSE')
  return preview.data.token
}
