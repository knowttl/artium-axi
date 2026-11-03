import { encode } from '@toon-format/toon'
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { parseArguments } from '../../tools/node_modules/@knowttl/ssh-axi/dist/arguments.js'
import { SshError } from '../../tools/node_modules/@knowttl/ssh-axi/dist/errors.js'
import { sshExecutionStatus, sshPreparation } from '../shared/ssh-execution.js'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'

function receipt(client: Client, value?: { requestKey: string, host: string }) {
  if (process.platform === 'win32') throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE', 'Native Windows SSH receipt custody is pending.')
  const directory = join(client.executionReceiptDirectory, 'ssh-executions')
  try {
    const missing: string[] = []
    for (let parent = directory; parent !== parse(parent).root; parent = dirname(parent)) {
      if (!existsSync(parent)) { missing.push(parent); continue }
      const info = lstatSync(parent)
      if (!info.isDirectory() || info.isSymbolicLink() || ![process.getuid!(), 0].includes(info.uid)
        || (info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0)) throw new Error()
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if ((lstatSync(directory).mode & 0o077) !== 0) throw new Error()
    for (const created of missing) {
      const parent = openSync(dirname(created), constants.O_RDONLY | constants.O_DIRECTORY)
      try { fsyncSync(parent) } finally { closeSync(parent) }
    }
    const latest = join(directory, 'latest.json')
    if (!value) {
      const info = lstatSync(latest)
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error()
      const { serverUrl, ...saved } = JSON.parse(readFileSync(latest, 'utf8')) as { serverUrl: string }
      if (serverUrl !== client.serverUrl) throw new ArtiumError('SESSION_SERVER_MISMATCH')
      return sshPreparation.parse(saved)
    }
    const name = createHash('sha256').update(value.requestKey).digest('hex')
    for (const target of [join(directory, `${name}.json`), latest]) {
      const temporary = join(directory, `${randomUUID()}.tmp`)
      try {
        const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(file, JSON.stringify({ ...value, serverUrl: client.serverUrl })); fsyncSync(file) } finally { closeSync(file) }
        renameSync(temporary, target)
        const folder = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY)
        try { fsyncSync(folder) } finally { closeSync(folder) }
      } finally { rmSync(temporary, { force: true }) }
    }
    return value
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE', 'Cannot retain a private SSH recovery receipt; no new submission was sent.')
  }
}

export async function sshExecution(args: string[], createClient: () => Client, write: (text: string) => void): Promise<boolean> {
  let prefix = 0
  while (['--json', '--help'].includes(args[prefix])) prefix++
  if (args.includes('--help') && prefix === args.length) {
    const value = { usage: 'artium-axi ssh-axi <command> [flags]', commands: ['host list', 'host show <host>', 'doctor <host>',
      'exec <host> --command <text> --confirm', 'execution show [<id> | --request-key <key>]'],
    help: ['Writes default off and require a writable host and caller grants. Use each command with --help.',
      'Recover with execution show after an interrupted submission. No automatic replay.'] }
    write((args.includes('--json') ? JSON.stringify(value) : encode(value)) + '\n')
    return true
  }
  const command = args[prefix] === 'exec' ? 'exec' : args.slice(prefix, prefix + 2).join(' ')
  if (!['exec', 'execution show'].includes(command)) return false
  const flags = command === 'exec' ? '--command, --confirm, --timeout 1s-600s (default 60s), --output-limit 0-1048576 (default 65536), --sudo, --detach, --request-key, --json, --help' : '--request-key, --json, --help'
  let parsed: ReturnType<typeof parseArguments>
  try { parsed = parseArguments(args) }
  catch (error) { if (error instanceof SshError) throw new ArtiumError('INVALID_INPUT', 'Invalid SSH execution arguments.', `Valid flags: ${flags}. Every exec requires <host> --command <text> --confirm.`); throw error }
  if (parsed.config !== undefined || command !== 'exec' && parsed.profile !== undefined || parsed.values.connection || parsed.values.full) throw new ArtiumError('FLAG_BLOCKED')
  const print = (value: Record<string, unknown>) => write((parsed.json ? JSON.stringify(value) : encode(value)) + '\n')
  if (parsed.help) {
    print({ usage: command === 'exec' ? 'artium-axi ssh-axi exec <host> --command <text> --confirm [flags]' : 'artium-axi ssh-axi execution show [<id> | --request-key <key>]',
      flags,
      help: ['Writes default off and require a writable host and caller grants. Every arbitrary command needs --confirm.',
        'Managed output samples retain at most 8192 bytes per stream. No automatic resubmission or replay.',
        'A private command-free receipt is saved before submission. execution show without an ID recovers it.',
        'Reusable connections and cancellation remain unavailable.'] })
    return true
  }
  if (command === 'exec' && (typeof parsed.values.command !== 'string' || parsed.values.confirm !== true)) throw new ArtiumError('INVALID_INPUT', 'Every arbitrary command requires --command <text> --confirm.')
  const client = createClient()
  if (command === 'execution show') {
    const requestKey = parsed.values['request-key'] ?? (!parsed.id ? receipt(client).requestKey : undefined)
    print(sshExecutionStatus.parse(await client.authenticated('/v1/ssh/show', 'POST', requestKey ? { requestKey } : { id: parsed.id })))
    return true
  }
  if (process.platform === 'win32') throw new ArtiumError('SESSION_STORAGE_UNAVAILABLE', 'Native Windows SSH receipt custody is pending.')
  const input = { host: parsed.id!, command: parsed.values.command, confirm: true,
    timeout: parsed.timeout, outputLimit: parsed.outputLimit, sudo: parsed.values.sudo === true }
  let interrupted = false
  const interrupt = () => { interrupted = true }
  process.on('SIGINT', interrupt)
  try {
    const prepared = parsed.values['request-key'] ? { requestKey: String(parsed.values['request-key']), host: input.host }
      : sshPreparation.parse(await client.authenticated('/v1/ssh/prepare', 'POST', input))
    receipt(client, prepared)
    if (interrupted) throw new ArtiumError('CANCELLED')
    let result
    try { result = sshExecutionStatus.parse(await client.transferSession(token => client.request('/v1/ssh/submit', 'POST', { requestKey: prepared.requestKey, input }, token))) }
    catch (error) {
      if (error instanceof ArtiumError) throw new ArtiumError(error.code, error.message, 'Recover with artium-axi ssh-axi execution show. No submission was retried.')
      throw error
    }
    while (!parsed.values.detach && !interrupted && result.outcome === 'running') {
      await setTimeout(200)
      result = sshExecutionStatus.parse(await client.authenticated('/v1/ssh/show', 'POST', { id: result.id }))
    }
    print(result)
    if (interrupted) process.exitCode = 130
    else if (!['running', 'completed'].includes(result.outcome)) process.exitCode = result.remoteExit && result.remoteExit > 0 && result.remoteExit <= 255 ? result.remoteExit : 1
  } finally { process.off('SIGINT', interrupt) }
  return true
}
