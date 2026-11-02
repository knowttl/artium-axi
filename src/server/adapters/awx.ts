import inventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { validateFileInput } from '../../shared/file-input.js'
import { awxInputBridge, awxPrivateOutput } from './awx-input.js'

export const awxManifest = { ...inventory, ...inventory.adapterBoundary }
export const awxWritePolicy = writePolicy({ unlocks: 'All AWX writes for this tenant, including configuration, deletion, removals and security administration, support preview and require explicit confirmation and AWX resource permission.',
  blocked: 'Unsafe overrides remain blocked. File flags upload local bytes privately; structured flags and SCM URLs accept inline text or @local-file. Use protected local files for sensitive URLs. Credential inputs-file and password-file accept stdin (-). Server file paths are refused.' })
export const awxProfile = new CredentialProfile(inventory.credentialSchema, 'awx-axi')
export const awxCredentialSchema = awxProfile.credentialSchema

function awxArguments(args: readonly string[], input: RunnerInput = {}) {
  validateFileInput('awx-axi', args, input)
  if (input.stdin !== undefined && args.some(arg => ['--help', '--version', '-v', '-V'].includes(arg))) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--version', '-v', '-V', '--help'].includes(args[0])) return {
    args: [...args], fileArguments: [], structured: [] as [number, string][], invocation: { command: args[0] === '--help' ? 'home' : 'version', help: args[0] === '--help' }, effect: 'read' as const, configuration: false, mutation: false }
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
    flags.set(name, value)
  }
  if (!positionals.length) positionals.push('home')
  if (positionals.length === 1 && flags.has('help') && inventory.discovery.commands.includes(positionals[0])) {
    return { args: [positionals[0], '--help'], fileArguments: [], structured: [] as [number, string][], invocation: { command: positionals[0], help: true }, effect: 'read' as const, configuration: false, mutation: false }
  }
  const route = inventory.commands.find(route => positionals.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!route) throw invalidCommand('awx-axi', positionals, inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
  if (route.effect === 'blocked' && !flags.has('help')) throw new ArtiumError('INVALID_INPUT', `Command ${route.command} is not yet supported through Artium.`)
  const schema: Record<string, string | undefined> = route.flags
  for (const name of flags.keys()) if (!Object.hasOwn(schema, name)) throw new ArtiumError('INVALID_INPUT',
    `Unknown flag --${name} for awx-axi ${route.command}.`,
    `Valid flags: ${Object.keys(schema).filter(name => !name.endsWith('-file')).map(name => `--${name}`).join(', ')}.`)
  if (flags.has('help')) return { args: [...route.command.split(' '), '--help'], fileArguments: [], structured: [] as [number, string][],
    invocation: { command: route.command, help: true }, effect: 'read' as const, configuration: false, mutation: false }
  for (const [name, value] of flags) {
    if (typeof value === 'string' && value.startsWith('@')) throw new ArtiumError('UNSUPPORTED_INPUT')
    if (name.endsWith('-file') && !(value === '-' && (name === 'password-file' || name === 'inputs-file' && positionals[0] === 'credential')
      && input.stdin !== undefined) && !input.files?.some(file => file.name === value)) throw new ArtiumError('UNSUPPORTED_INPUT')
  }
  const rest = positionals.slice(route.command.split(' ').length)
  const stdinFlags = [...flags].filter(([, value]) => value === '-').map(([name]) => name)
  if (input.stdin !== undefined && (stdinFlags.length !== 1 || !(stdinFlags[0] === 'password-file'
    || stdinFlags[0] === 'inputs-file' && positionals[0] === 'credential'))) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (rest.length > route.positionals.names.length || rest.length < route.positionals.required) throw new ArtiumError('INVALID_INPUT')
  const configuration = route.effect === 'configuration-write'
  if (configuration && !flags.has('dry-run') && !flags.has('confirm')) {
    throw new ArtiumError('FLAG_BLOCKED', 'Configuration writes require --confirm.', 'Preview with --dry-run, then repeat with --confirm.')
  }
  const effect = ['write', 'configuration-write'].includes(route.effect) && flags.has('confirm') && !flags.has('dry-run') ? 'write' as const : 'read' as const
  const createsRun = positionals[1] === 'launch' || route.command === 'job relaunch'
  const readGroup = positionals[0] === 'inventory' ? route.command.includes('host-') ? 'host' : route.command.includes('group-') ? 'group'
    : route.command.includes('source-') || route.command === 'inventory sync' ? 'inventory-source' : 'inventory'
    : route.command === 'team credential-create' ? 'credential' : positionals[0]
  let checkArgs = [readGroup, 'list', '--limit', '100']
  if (createsRun) checkArgs = ['job', 'list', '--type', 'all', '--limit', '100']
  else if (configuration && route.command.startsWith('workflow node-')) {
    checkArgs = ['workflow', route.command === 'workflow node-create' ? 'template-nodes' : 'template-node', rest[0]]
  } else if (effect === 'write' && rest.length && !(configuration
    && (/(?:create|copy)$/.test(route.command) || /edit$/.test(route.command) && (flags.has('name') || flags.has('username'))))) {
    checkArgs = [readGroup, 'show', rest[0], ...(readGroup === 'job' && flags.has('type') ? ['--type', String(flags.get('type'))] : [])]
  }
  if (route.command === 'user token-revoke') checkArgs = ['user', 'list', '--limit', '100']
  const normalized = [...(route.command === 'home' ? [] : positionals)]
  const fileArguments: number[] = []
  const structured: [number, string][] = []
  for (const [name, value] of flags) {
    if (typeof value === 'string' && awxManifest.structuredInputFlags.includes(name)) {
      const file = input.files?.find(file => file.name === value)
      const content = file ? Buffer.from(file.contentBase64, 'base64').toString('utf8') : value
      if (content.startsWith('@')) throw new ArtiumError('UNSUPPORTED_INPUT')
      normalized.push(`--${name}=private-input`)
      structured.push([normalized.length - 1, content])
    } else if (name.endsWith('-file')) {
      normalized.push(`--${name}`, String(value))
      if (value !== '-') fileArguments.push(normalized.length - 1)
    } else normalized.push(value === true ? `--${name}` : `--${name}=${value}`)
  }
  return { args: normalized, fileArguments, structured, effect, configuration,
    mutation: ['write', 'configuration-write'].includes(route.effect),
    invocation: { command: route.command, help: false },
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
      const allowed = (settings: Record<string, unknown>) => settings.allowWrites === true
      const requiresWriteAccess = normalized.mutation && !normalized.invocation.help
      if (requiresWriteAccess && source.getSettings && !allowed(source.getSettings(reference))) throw new ArtiumError('FLAG_BLOCKED')
      const value = await source.getCredential(reference)
      const parsed = awxCredentialSchema.safeParse(value)
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const readOnly = !allowed(parsed.data)
      if (requiresWriteAccess && readOnly) throw new ArtiumError('FLAG_BLOCKED')
      const profile = awxProfile.prepare('awx-axi', parsed.data, undefined, readOnly)
      if (normalized.mutation && !readOnly) Object.assign(profile.environment, {
        AWX_AXI_ALLOW_CONFIG_WRITES: '1', AWX_AXI_ALLOW_DELETES: '1', AWX_AXI_ALLOW_SECURITY_WRITES: '1',
        AWX_AXI_ALLOW_CREDENTIAL_PASSWORDS: '1',
      })
      const { structured, ...call } = normalized
      const prefix = ['--input-type=module', '-e', awxInputBridge, toolPaths['awx-axi']]
      const privateInput = structured.length || input?.files?.length || input?.stdin !== undefined
      const rawRead = !call.invocation.help && ['job stdout', 'ad-hoc stdout'].includes(call.invocation.command)
      const privateRead = !call.invocation.help && ['inventory show', 'inventory constructed-show', 'project show', 'activity-stream show'].includes(call.invocation.command)
      const bridge = privateInput || privateRead || rawRead
      const output = bridge ? awxPrivateOutput(input ?? {}, structured, call.args) : undefined
      if (output) profile.files.push({ name: 'awx-input.json', content: JSON.stringify({ values: structured, output }) })
      return { executable: bridge ? process.execPath : toolPaths['awx-axi'], ...call,
        ...(bridge ? { args: [...prefix, ...call.args], fileArguments: call.fileArguments.map(index => index + prefix.length) } : {}),
        ...profile, limits: { timeoutMs: runnerLimits.timeoutMs, ...(output && !rawRead ? { privateOutput: output } : {}) } }
    },
  }
}
