import inventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import { toolAllowsWrites } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'

export const awxManifest = { ...inventory, ...inventory.adapterBoundary }
export const awxProfile = new CredentialProfile(inventory.credentialSchema, 'awx-axi')
export const awxCredentialSchema = awxProfile.credentialSchema

function awxArguments(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--version', '-v', '-V', '--help'].includes(args[0])) return { args: [...args], effect: 'read' as const }
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  const knownFlags = Object.assign({}, ...inventory.commands.map(route => route.flags)) as Record<string, string>
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token)
    if (!match) throw new ArtiumError('INVALID_INPUT')
    const [, name, inline] = match
    if (awxManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(knownFlags, name) || flags.has(name)) throw new ArtiumError('INVALID_INPUT')
    const boolean = knownFlags[name] === 'boolean'
    if (boolean && inline !== undefined) throw new ArtiumError('INVALID_INPUT')
    const value = boolean ? true : inline ?? args[++index]
    if (value === undefined) throw new ArtiumError('INVALID_INPUT')
    // File inputs need explicit runner materialization; never read server paths.
    if (name.endsWith('-file') || typeof value === 'string' && value.startsWith('@')) throw new ArtiumError('UNSUPPORTED_INPUT')
    flags.set(name, value)
  }
  if (!positionals.length) positionals.push('home')
  if (positionals.length === 1 && flags.size === 1 && flags.has('help') && inventory.discovery.commands.includes(positionals[0])) {
    return { args: [positionals[0], '--help'], effect: 'read' as const }
  }
  const route = inventory.commands.find(route => positionals.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!route || route.effect === 'blocked') throw new ArtiumError('FLAG_BLOCKED')
  const schema: Record<string, string | undefined> = route.flags
  for (const name of flags.keys()) if (!Object.hasOwn(schema, name)) throw new ArtiumError('INVALID_INPUT',
    `Unknown flag --${name} for awx-axi ${route.command}.`,
    `Valid flags: ${Object.keys(schema).filter(name => !name.endsWith('-file')).map(name => `--${name}`).join(', ')}.`)
  const rest = positionals.slice(route.command.split(' ').length)
  if (rest.length > route.positionals.names.length || !flags.has('help') && rest.length < route.positionals.required) throw new ArtiumError('INVALID_INPUT')
  const effect = route.effect === 'write' && flags.has('confirm') && !flags.has('dry-run') && !flags.has('help') ? 'write' as const : 'read' as const
  const createsRun = positionals[1] === 'launch' || route.command === 'job relaunch'
  const readGroup = positionals[0] === 'inventory' ? 'inventory-source' : positionals[0]
  const checkArgs = createsRun ? ['job', 'list', '--type', 'all', '--limit', '100'] : effect === 'write' && rest.length
    ? [readGroup, 'show', rest[0], ...(readGroup === 'job' && flags.has('type') ? ['--type', String(flags.get('type'))] : [])]
    : [readGroup, 'list', '--limit', '100']
  return { args: [...(route.command === 'home' ? [] : positionals), ...[...flags].map(([name, value]) => value === true ? `--${name}` : `--${name}=${value}`)], effect,
    ...(effect === 'write' ? { write: { operation: route.command, target: 'managed resource', checkArgs,
      afterCheck: 'Inspect the affected resource and any additional pages before retrying; absence from this limited read does not prove failure' } } : {}) }
}

export function createAwxAdapter(source: SecretSource, writeLog: string): Adapter<unknown> {
  return {
    name: 'awx-axi', executable: toolPaths['awx-axi'], credentialProfile: awxProfile, credentialSchema: awxCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: awxManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: Object.keys(Object.assign({}, ...inventory.commands.map(route => route.flags))).map(name => `--${name}`),
      positions: args.map((_, index) => index).filter(index => index > 1) }),
    validateArgs: (args, input) => { awxArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = awxArguments(args, input)
      if (reference.tool !== 'awx-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      if (normalized.effect === 'write' && source.getSettings && !toolAllowsWrites('awx-axi', source.getSettings(reference))) throw new ArtiumError('FLAG_BLOCKED')
      const value = await source.getCredential(reference)
      const parsed = awxCredentialSchema.safeParse(value)
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const readOnly = !toolAllowsWrites('awx-axi', parsed.data)
      if (normalized.effect === 'write' && readOnly) throw new ArtiumError('FLAG_BLOCKED')
      return { executable: toolPaths['awx-axi'], ...normalized,
        ...awxProfile.prepare('awx-axi', parsed.data, writeLog, readOnly), limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
