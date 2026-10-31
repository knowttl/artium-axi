import inventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'

export const awxManifest = { ...inventory, ...inventory.adapterBoundary }
export const awxWritePolicy = writePolicy({ allowConfigurationWrites: true, unlocks: 'Operational launch, relaunch, cancel, sync, approval and notification tests with explicit confirmation.',
  blocked: 'Credentials, secret input, deletion, removals, bulk and security administration, server file inputs and unsafe overrides remain blocked.' })
export const awxProfile = new CredentialProfile(inventory.credentialSchema, 'awx-axi')
export const awxCredentialSchema = awxProfile.credentialSchema

function awxArguments(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--version', '-v', '-V', '--help'].includes(args[0])) return {
    args: [...args], invocation: { command: args[0] === '--help' ? 'home' : 'version', help: args[0] === '--help' }, effect: 'read' as const, configuration: false }
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  const knownFlags = Object.assign({}, ...inventory.commands.map(route => route.flags)) as Record<string, string>
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token)
    if (match && awxManifest.unsafeOverrides.includes(match[1])) throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(knownFlags, match[1])) {
      const route = inventory.commands.find(route => positionals.slice(0, route.command.split(' ').length).join(' ') === route.command)
      throw unknownFlag('awx-axi', route?.command ?? 'home', token, Object.keys(route?.flags ?? {}).filter(name => !awxManifest.unsafeOverrides.includes(name)))
    }
    const [, name, inline] = match
    if (flags.has(name)) throw new ArtiumError('INVALID_INPUT')
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
    return { args: [positionals[0], '--help'], invocation: { command: positionals[0], help: true }, effect: 'read' as const, configuration: false }
  }
  const route = inventory.commands.find(route => positionals.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!route) throw invalidCommand('awx-axi', positionals, inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
  if (route.effect === 'blocked') throw new ArtiumError('FLAG_BLOCKED', `Command ${route.command} is unavailable through artium.`)
  const schema: Record<string, string | undefined> = route.flags
  for (const name of flags.keys()) if (!Object.hasOwn(schema, name)) throw new ArtiumError('INVALID_INPUT',
    `Unknown flag --${name} for awx-axi ${route.command}.`,
    `Valid flags: ${Object.keys(schema).filter(name => !name.endsWith('-file')).map(name => `--${name}`).join(', ')}.`)
  const rest = positionals.slice(route.command.split(' ').length)
  if (rest.length > route.positionals.names.length || !flags.has('help') && rest.length < route.positionals.required) throw new ArtiumError('INVALID_INPUT')
  const configuration = route.effect === 'configuration-write'
  if (configuration && !flags.has('help') && !flags.has('dry-run') && !flags.has('confirm')) {
    throw new ArtiumError('FLAG_BLOCKED', 'Configuration writes require --confirm.', 'Preview with --dry-run, then repeat with --confirm.')
  }
  const effect = ['write', 'configuration-write'].includes(route.effect) && flags.has('confirm') && !flags.has('dry-run') && !flags.has('help') ? 'write' as const : 'read' as const
  const createsRun = positionals[1] === 'launch' || route.command === 'job relaunch'
  const readGroup = positionals[0] === 'inventory' ? route.command.includes('host-') ? 'host' : route.command.includes('group-') ? 'group'
    : route.command.includes('source-') || route.command === 'inventory sync' ? 'inventory-source' : 'inventory' : positionals[0]
  let checkArgs = [readGroup, 'list', '--limit', '100']
  if (createsRun) checkArgs = ['job', 'list', '--type', 'all', '--limit', '100']
  else if (configuration && route.command.startsWith('workflow node-')) {
    checkArgs = ['workflow', route.command === 'workflow node-create' ? 'template-nodes' : 'template-node', rest[0]]
  } else if (effect === 'write' && rest.length && !(configuration
    && (/(?:create|copy)$/.test(route.command) || /edit$/.test(route.command) && flags.has('name')))) {
    checkArgs = [readGroup, 'show', rest[0], ...(readGroup === 'job' && flags.has('type') ? ['--type', String(flags.get('type'))] : [])]
  }
  return { args: [...(route.command === 'home' ? [] : positionals), ...[...flags].map(([name, value]) => value === true ? `--${name}` : `--${name}=${value}`)], effect, configuration,
    invocation: { command: route.command, help: flags.has('help') },
    ...(effect === 'write' ? { write: { operation: route.command, target: 'managed resource', checkArgs,
      afterCheck: 'Inspect the affected resource and any additional pages before retrying; absence from this limited read does not prove failure' } } : {}) }
}

export function createAwxAdapter(source: SecretSource): Adapter<unknown> {
  return {
    name: 'awx-axi', executable: toolPaths['awx-axi'], credentialProfile: awxProfile, credentialSchema: awxCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: awxManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: Object.keys(Object.assign({}, ...inventory.commands.map(route => route.flags))).map(name => `--${name}`),
      positions: args.map((_, index) => index).filter(index => index > 1) }),
    validateArgs: (args, input) => { awxArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = awxArguments(args, input)
      if (reference.tool !== 'awx-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const allowed = (settings: Record<string, unknown>) => normalized.configuration
        ? settings.allowConfigurationWrites === true : settings.allowWrites === true
      const requiresWriteAccess = normalized.effect === 'write' || normalized.configuration && !normalized.invocation.help
      if (requiresWriteAccess && source.getSettings && !allowed(source.getSettings(reference))) throw new ArtiumError('FLAG_BLOCKED')
      const value = await source.getCredential(reference)
      const parsed = awxCredentialSchema.safeParse(value)
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const readOnly = !allowed(parsed.data)
      if (requiresWriteAccess && readOnly) throw new ArtiumError('FLAG_BLOCKED')
      const profile = awxProfile.prepare('awx-axi', parsed.data, undefined, readOnly)
      if (normalized.configuration && !readOnly) profile.environment.AWX_AXI_ALLOW_CONFIG_WRITES = '1'
      return { executable: toolPaths['awx-axi'], ...normalized,
        ...profile, limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
