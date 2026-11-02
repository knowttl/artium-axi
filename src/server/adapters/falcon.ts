import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import inventory from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter, PreparedCall } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { falconWriteOperations } from '../../shared/api.js'

export const falconManifest = inventory
export const falconProfile = new CredentialProfile(inventory.credentialSchema, 'falcon-axi')
export const falconCredentialSchema = falconProfile.credentialSchema
export type FalconCredential = z.infer<typeof falconCredentialSchema>
const falconLimits = { timeoutMs: inventory.requirements.timeoutMs, terminationGraceMs: 12_000 }
const defaultWriteLog = '/data/tool-logs/falcon-axi/writes.log'
const capabilityPolicy = writePolicy({
  supportedOperations: falconWriteOperations,
  unlocks: 'Exact search, search-backed and MalQuery commands; restricted RTR with native profile opt-in and execution confirmation.',
  blocked: 'Host changes, scripts and file transfers remain unavailable. RTR command restrictions and exact --execute/--confirm still apply.',
})
function capabilitySettings(settings: Record<string, unknown>) {
  return { writes: settings?.writes ?? { allowWrites: settings?.allowWrites === true,
    operations: typeof settings?.allowWrites === 'boolean' ? ['rtr run'] : [] } }
}
export const falconWritePolicy = {
  read: (settings: Record<string, unknown>) => capabilityPolicy.read(capabilitySettings(settings)),
  update(settings: Record<string, unknown>, input: Parameters<typeof capabilityPolicy.update>[1]) {
    const { allowWrites: _, writes: __, ...rest } = settings
    return { ...rest, ...capabilityPolicy.update(capabilitySettings(settings), input) }
  },
}
export const falconCredentialFiles = z.object({
  clientIdFile: z.string().min(1), clientSecretFile: z.string().min(1),
  region: z.string().min(1), memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredentialFiles = z.infer<typeof falconCredentialFiles>

function prepareCredential(args: readonly string[], invocation: NonNullable<PreparedCall['invocation']>,
  credential: unknown, writeLog: string, profile: CredentialProfile): PreparedCall {
  const prepared = profile.prepare('falcon-axi', credential, writeLog, true)
  return { executable: process.execPath, args: [toolPaths['falcon-axi'], ...args], invocation,
    effect: 'read', limits: falconLimits, ...prepared }
}

export function createFalconAdapter(source: SecretSource, writeLog = defaultWriteLog,
  profile = falconProfile): Adapter<unknown> {
  return {
    name: 'falcon-axi', executable: toolPaths['falcon-axi'],
    credentialSchema: profile.credentialSchema, credentialProfile: profile,
    timeoutMs: inventory.requirements.timeoutMs,
    blockedFlags: inventory.unsafeOverrides.map(flag => '--' + flag), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => '--' + name),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { validateFalconArgs(args, input) },
    async prepare(args, reference, input) {
      const call = parseFalconArgs(args, input)
      if (reference.tool !== 'falcon-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const access = falconWritePolicy.read(source.getSettings?.(reference) ?? {})
      if (call.executing && (!access.enabled || !access.allowedOperations.includes(call.operation!))) throw new ArtiumError('FLAG_BLOCKED')
      const prepared = profile.prepare('falcon-axi', await source.getCredential(reference), writeLog, !call.executing)
      return { executable: process.execPath, args: [toolPaths['falcon-axi'], ...args], invocation: call.invocation,
        effect: call.executing ? 'write' : 'read', ...prepared,
        limits: { ...falconLimits, ...(call.device ? { falconRtrDevice: call.device } : {}) } }
    },
  }
}

function parseFalconArgs(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (inventory.blockedCommands.includes(args[0]) || inventory.blockedCommands.includes(args.slice(0, 2).join(' '))) throw new ArtiumError('FLAG_BLOCKED')
  for (const token of args) {
    if (token === '--' || token.startsWith('--') && inventory.unsafeOverrides.includes(token.slice(2).split('=')[0])) throw new ArtiumError('FLAG_BLOCKED')
  }
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) return {
    invocation: { command: 'version', help: false }, operation: null, executing: false, device: undefined }
  const route = [...inventory.commands].sort((a, b) => b.command.length - a.command.length)
    .find(entry => entry.command !== 'home' && entry.command.split(' ').every((word, index) => args[index] === word))
  const group = args.slice(0, -1).join(' ')
  if (!route && args.at(-1) === '--help' && group && inventory.commands.some(entry => entry.command.startsWith(group + ' '))) {
    return { invocation: { command: group, help: true }, operation: null, executing: false, device: undefined }
  }
  const home = !args.length || args[0].startsWith('-')
  if (!route && !home) throw invalidCommand('falcon-axi', args, inventory.discovery.commands)
  const selected = route ?? inventory.commands.find(entry => entry.command === 'home')!
  const flags: Record<string, string | undefined> = selected.flags
  const values = new Map<string, string>()
  const positionals: string[] = []
  const length = selected.command === 'home' ? 0 : selected.command.split(' ').length
  for (let index = length; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); continue }
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (!match || !Object.hasOwn(flags, match[1])) throw unknownFlag('falcon-axi', selected.command, token,
      Object.keys(flags).filter(name => !inventory.unsafeOverrides.includes(name)))
    const [, name, inline] = match
    if (flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      values.set(name, 'true')
    } else {
      const value = inline ?? args[++index]
      if (value === undefined || value === '' || value.startsWith('--')) throw new ArtiumError('INVALID_INPUT')
      values.set(name, value)
    }
  }
  if (!values.has('help')) {
    const hostname = ['host logins', 'host network'].includes(selected.command) && values.has('hostname')
    if (positionals.length !== (selected.positional && !hostname ? 1 : 0)) throw new ArtiumError('INVALID_INPUT')
  }
  const operation = selected.effect === 'write' && !values.has('help') ? selected.command : null
  let executing = Boolean(operation && operation !== 'rtr run')
  let device: string | undefined
  if (operation === 'rtr run') {
    const command = values.get('command')
    executing = values.has('execute')
    if (!/^[a-fA-F0-9]{32}$/.test(positionals[0]) || !command || values.has('confirm') && !executing
      || executing && values.get('confirm') !== `${positionals[0]}:${command}`) throw new ArtiumError('INVALID_INPUT')
    if (executing) device = positionals[0].toLowerCase()
  }
  return { invocation: { command: selected.command, help: values.has('help') }, operation, executing, device }
}

export function validateFalconArgs(args: readonly string[], input: RunnerInput = {}): NonNullable<PreparedCall['invocation']> {
  return parseFalconArgs(args, input).invocation
}

export async function prepareFalcon(args: readonly string[], configuration: FalconCredentialFiles) {
  const invocation = validateFalconArgs(args)
  const parsed = falconCredentialFiles.safeParse(configuration)
  if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
  const { clientIdFile, clientSecretFile, region, memberCid } = parsed.data
  const [clientId, clientSecret] = await Promise.all([readFile(clientIdFile, 'utf8'), readFile(clientSecretFile, 'utf8')])
    .then(values => values.map(value => value.trim()))
    .catch(() => { throw new ArtiumError('CREDENTIAL_INVALID') })
  if (!clientId || !clientSecret) throw new ArtiumError('CREDENTIAL_INVALID')
  return prepareCredential(args, invocation, { clientId, clientSecret, region, ...(memberCid ? { memberCid } : {}) }, defaultWriteLog, falconProfile)
}
