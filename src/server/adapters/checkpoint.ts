import inventory from '../../../tools/inventories/checkpoint-axi.json' with { type: 'json' }
import { toolAllowsWrites, transferTool } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { writePolicy } from './write-policy.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'

export const checkpointManifest = { ...inventory, ...inventory.adapterBoundary }
export const checkpointProfile = new CredentialProfile(inventory.credentialSchema, 'checkpoint-axi')
export const checkpointCredentialSchema = checkpointProfile.credentialSchema

// Event action names come from each event's available actions, not a fixed enum.
// Administrators still authorize each exact name; a wildcard never grants writes.
function policy(operations: readonly string[] = []) {
  return writePolicy({ supportedOperations: [...inventory.nativeWriteSettings.supportedOperations,
    ...operations.filter(operation => /^event\.action\.[a-z][A-Za-z0-9_-]{0,127}$/.test(operation))],
  unlocks: 'Selected email and exception writes with native preview, execute, exact confirmation and journal; exact event.action.<name> scopes can be added in native settings. Three downloads use authenticated CLI transfers with host-owned confirmation and verified bytes.',
  blocked: 'Unselected operations, ambiguous deletes, local configuration, origin overrides and ordinary tool-run downloads remain blocked. Live API contracts require owner commissioning.' })
}
export const checkpointWritePolicy = {
  read(settings: Record<string, unknown>) {
    return policy((settings.writes as { operations?: string[] } | undefined)?.operations).read(settings)
  },
  update(settings: Record<string, unknown>, input: Parameters<ReturnType<typeof policy>['update']>[1]) {
    return policy(input.operations ?? (settings.writes as { operations?: string[] } | undefined)?.operations).update(settings, input)
  },
}

function checkpointArguments(args: readonly string[], input: RunnerInput = {}) {
  const tokens = args.length ? [...args] : ['home']
  if (tokens.length === 1 && ['--version', '-v', '-V', '--help'].includes(tokens[0])) return {
    args: tokens, invocation: { command: tokens[0] === '--help' ? 'home' : 'version', help: tokens[0] === '--help' }, effect: 'read' as const }
  const route = inventory.commands.find(route => tokens.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!route) throw invalidCommand('checkpoint-axi', tokens, inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
  if (route.effect === 'blocked') throw new ArtiumError('FLAG_BLOCKED', `Command ${route.command} is unavailable through ordinary tool runs.`,
    checkpointManifest.downloadCommands.includes(route.command) ? 'Use artium-axi download --help for authenticated saving.' : undefined)
  if (route.command === 'exception remove' && ['malware', 'url', 'dlp'].includes(tokens[2])) {
    throw new ArtiumError('FLAG_BLOCKED', 'These delete endpoints remain unverified and unavailable.')
  }
  const normalized = tokens.slice(0, route.command.split(' ').length)
  const fileArguments: number[] = []
  const flags = new Set<string>()
  for (let index = normalized.length; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) { normalized.push(token); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token)
    const name = match?.[1] ?? ''
    if (checkpointManifest.unsafeOverrides.includes(name) || token === '--') throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(route.flags, name)) throw unknownFlag('checkpoint-axi', route.command, token,
      Object.keys(route.flags).filter(name => !checkpointManifest.unsafeOverrides.includes(name)))
    if (flags.has(name)) throw new ArtiumError('INVALID_INPUT')
    flags.add(name)
    if (['help', 'full', 'all', 'items', 'specific', 'execute', 'dry-run'].includes(name)) {
      if (match[2] !== undefined) throw new ArtiumError('INVALID_INPUT')
      normalized.push(token)
      continue
    }
    const value = match[2] ?? tokens[++index]
    if (value === undefined || value.startsWith('--')) throw new ArtiumError('INVALID_INPUT')
    normalized.push(`--${name}`, value)
    if (checkpointManifest.inputFileFlags.includes(name)) {
      if (!input.files?.some(file => file.name === value)) throw new ArtiumError('UNSUPPORTED_INPUT')
      fileArguments.push(normalized.length - 1)
    }
  }
  if (input.stdin !== undefined || input.files?.some(file => !fileArguments.some(index => normalized[index] === file.name))) {
    throw new ArtiumError('UNSUPPORTED_INPUT')
  }
  return { args: normalized, fileArguments, invocation: { command: route.command, help: flags.has('help') },
    effect: route.effect === 'write' && flags.has('execute') && !flags.has('help') ? 'write' as const : 'read' as const }
}

export function createCheckpointAdapter(source: SecretSource, writeLog: string): Adapter<unknown> {
  return {
    name: 'checkpoint-axi', executable: toolPaths['checkpoint-axi'], credentialProfile: checkpointProfile,
    credentialSchema: checkpointCredentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: checkpointManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { checkpointArguments(args, input) },
    async prepareArtifact(args, reference, scope) {
      if (reference.tool !== 'checkpoint-axi' || transferTool(scope.selection.operation) !== reference.tool
        || reference.revision !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
      const parsed = checkpointCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? parsed.data
      const state = checkpointWritePolicy.read(settings)
      if (!state.enabled || !state.allowedOperations.includes(scope.selection.operation)) throw new ArtiumError('FLAG_BLOCKED')
      const profile = checkpointProfile.prepare('checkpoint-axi', { ...parsed.data, downloads: { allow: true },
        writes: { allowWrites: false, operations: [] } }, writeLog, true)
      return { executable: toolPaths['checkpoint-axi'], args, ...profile, limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
    async prepare(args, reference, input) {
      const normalized = checkpointArguments(args, input)
      if (reference.tool !== 'checkpoint-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = checkpointCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const readOnly = !toolAllowsWrites('checkpoint-axi', parsed.data)
        || Boolean(source.getSettings && !toolAllowsWrites('checkpoint-axi', source.getSettings(reference)))
      const profile = checkpointProfile.prepare('checkpoint-axi', { ...parsed.data, downloads: { allow: false } }, writeLog, readOnly)
      // Native exception parsers require an absolute private JSON file. A cwd
      // spelling remains stable across preview and execute in isolated runners.
      const files = [...profile.files]
      for (const index of normalized.fileArguments ?? []) {
        const file = input!.files!.find(file => file.name === normalized.args[index])!
        const name = `checkpoint-axi/uploads/${file.name}`
        files.push({ name, content: Buffer.from(file.contentBase64, 'base64') })
        normalized.args[index] = `/proc/self/cwd/${name}`
      }
      return { executable: toolPaths['checkpoint-axi'], ...normalized, ...profile, files, fileArguments: [],
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
