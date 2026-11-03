import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import inventory from '../../../tools/inventories/ssh-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { toolPaths } from '../config.js'
import { CredentialProfile } from './credential-profile.js'
import { writePolicy } from './write-policy.js'
import type { SshHosts } from '../store/ssh-hosts.js'
import type { Adapter } from './types.js'
import type { RunnerInput } from '../runner/input.js'

export const sshProfile = new CredentialProfile(inventory.credentialSchema, 'ssh-axi')
export function verifySshArtifact(executable: string): void {
  for (const source of inventory.sources) {
    const path = new URL('../' + source.path, pathToFileURL(executable))
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== source.sha256) throw new ArtiumError('CREDENTIAL_INVALID')
  }
}
export const sshWritePolicy = writePolicy({
  unlocks: 'Confirmed one-shot execution requires Allow writes, a writable host and current caller grants. Sudo additionally requires its distinct approved account and credential.',
  blocked: 'Credentials and host trust cannot be overridden in arguments. No automatic reconnection or replay; interactive SSH channels and forwarding are unavailable.' })

function invocation(args: readonly string[], input?: RunnerInput) {
  if (input?.stdin !== undefined || input?.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.some(arg => arg.startsWith('-') && !['--help', '--json', '--version', '-v', '-V'].includes(arg))) throw new ArtiumError('FLAG_BLOCKED')
  const words = args.filter(arg => !arg.startsWith('-'))
  const command = words[0] === 'doctor' ? 'doctor' : words.slice(0, 2).join(' ') || 'home'
  const route = inventory.commands.find(route => route.command === command)
  if (!route) throw new ArtiumError('FLAG_BLOCKED')
  const version = args.some(arg => ['--version', '-v', '-V'].includes(arg))
  if (version && args.length !== 1 || args.filter(arg => arg === '--json').length > 1 || args.filter(arg => arg === '--help').length > 1) throw new ArtiumError('INVALID_INPUT')
  const expected = command === 'home' ? 0 : command === 'doctor' ? 1 : 2
  if (words.length !== expected + route.arguments && !(args.includes('--help') && words.length === expected)) throw new ArtiumError('INVALID_INPUT')
  return { command, host: words[expected], help: args.includes('--help'), offline: args.includes('--help') || version }
}

export function createSshAdapter(hosts: SshHosts, writeLog: string, executable: string = toolPaths['ssh-axi']): Adapter<unknown> {
  if (inventory.credentialSchema['x-protocol-revision'] !== 1) throw new ArtiumError('CREDENTIAL_INVALID')
  return { name: 'ssh-axi', executable, credentialSchema: sshProfile.credentialSchema,
    timeoutMs: inventory.requirements.timeoutMs, blockedFlags: [], allowedFlagValues: {},
    sensitiveArguments: () => ({ flags: [], positions: [] }),
    validateArgs: (args, input) => { invocation(args, input) },
    async prepare() { throw new ArtiumError('TOOL_NOT_GRANTED') },
    async prepareForCaller(args, userId, input) {
      const call = invocation(args, input)
      verifySshArtifact(executable)
      const beforeSpawn = call.offline ? undefined : hosts.dispatchGuard(userId, call.host)
      const visible = call.offline ? [] : hosts.list(userId)
      const selected = call.host ? visible.filter(host => host.id === call.host) : visible
      if (call.host && !call.offline && !selected.length) throw new ArtiumError('NOT_FOUND')
      const credentials = call.command === 'doctor' && !call.offline
        ? sshProfile.prepare('ssh-axi', hosts.profile(userId, call.host!), writeLog, true)
        : { environment: {}, files: [], secrets: [] }
      return { executable: process.execPath, args: [executable, ...args], ...credentials,
        beforeSpawn,
        invocation: { command: call.command, help: call.help }, trustedIpc: { revision: 1, hosts: selected },
        effect: 'read', limits: { timeoutMs: inventory.requirements.timeoutMs, terminationGraceMs: 200 } }
    } }
}
