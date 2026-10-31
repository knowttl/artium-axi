import inventory from '../../../tools/inventories/hybrid-axi.json' with { type: 'json' }
import { toolAllowsWrites, transferWarning } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { writePolicy } from './write-policy.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'

export const hybridManifest = { ...inventory, ...inventory.adapterBoundary }
export const hybridProfile = new CredentialProfile(inventory.credentialSchema, 'hybrid-axi')
export const hybridCredentialSchema = hybridProfile.credentialSchema
export const hybridWritePolicy = writePolicy({ supportedOperations: inventory.nativeWriteSettings.supportedOperations,
  unlocks: 'Sandbox submissions, YARA create/update/delete, consuming hunting matches and four reviewed sample, dropped-file and memory downloads selected independently, with native preview, --execute, exact --confirm and durable journal. Use artium-axi download for authenticated one-shot CLI verified saving.',
  blocked: 'Unselected writes, ordinary tool-run downloads, browser artifact saving, local configuration and origin overrides are blocked. Downloads require the dedicated artifact mount and current user permission; administrator selection cannot grant upstream entitlement.' })

function hybridArguments(args: readonly string[], input: RunnerInput = {}) {
  const tokens = args.length ? [...args] : ['home']
  if (tokens.length === 1 && ['--version', '-v', '-V', '--help'].includes(tokens[0])) return {
    args: tokens, invocation: { command: tokens[0] === '--help' ? 'home' : 'version', help: tokens[0] === '--help' }, effect: 'read' as const }
  const route = [...inventory.commands].reverse().find(route => tokens.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (route?.command === 'hash file' || route?.command === 'report file') throw new ArtiumError('FLAG_BLOCKED',
    'Use artium-axi download for authenticated archive saving.',
    `Run artium-axi download --help for native preview, execute and exact confirmation. ${transferWarning}`)
  if (!route) {
    if (hybridManifest.blockedCommands.some(command => tokens.join(' ') === command || tokens.join(' ').startsWith(command + ' '))) {
      throw new ArtiumError('FLAG_BLOCKED', `Command ${tokens[0]} is unavailable through artium.`)
    }
    if (tokens[0].startsWith('-')) throw unknownFlag('hybrid-axi', 'home', tokens[0],
      Object.keys(inventory.commands.find(route => route.command === 'home')!.flags).filter(name => !hybridManifest.unsafeOverrides.includes(name)))
    throw invalidCommand('hybrid-axi', tokens, inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
  }
  if (route.effect === 'blocked') throw new ArtiumError('FLAG_BLOCKED', `Command ${route.command} is unavailable through artium.`)
  const normalized = tokens.slice(0, route.command.split(' ').length)
  const fileArguments: number[] = []
  const flags = new Set<string>()
  let usesStdin = false
  for (let index = normalized.length; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) { normalized.push(token); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token)
    if (!match) throw unknownFlag('hybrid-axi', route.command, token, Object.keys(route.flags).filter(name => !hybridManifest.unsafeOverrides.includes(name)))
    const [, name, inline] = match
    if (hybridManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(route.flags, name)) throw unknownFlag('hybrid-axi', route.command, token, Object.keys(route.flags).filter(name => !hybridManifest.unsafeOverrides.includes(name)))
    if (flags.has(name)) throw new ArtiumError('INVALID_INPUT')
    flags.add(name)
    if (['help', 'full', 'labs', 'offline', 'execute', 'dry-run'].includes(name)) {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      normalized.push(token)
      continue
    }
    const value = inline ?? tokens[++index]
    if (value === undefined) throw new ArtiumError('INVALID_INPUT')
    const isFile = hybridManifest.inputFileFlags.includes(name)
    if (inline !== undefined && !isFile && ['submit', 'quick-scan', 'hunting'].includes(tokens[0])) normalized.push(token)
    else normalized.push(`--${name}`, value)
    if (isFile) {
      if (value === '-' && name === 'body-file') usesStdin = true
      else {
        if (!input.files?.some(file => file.name === value)) throw new ArtiumError('UNSUPPORTED_INPUT')
        fileArguments.push(normalized.length - 1)
      }
    }
  }
  if (input.stdin !== undefined && !usesStdin) throw new ArtiumError('UNSUPPORTED_INPUT')
  return { args: normalized, fileArguments, invocation: { command: route.command, help: flags.has('help') },
    effect: route.effect === 'write' && flags.has('execute') && !flags.has('help') ? 'write' as const : 'read' as const }
}

export function createHybridAdapter(source: SecretSource, writeLog: string): Adapter<unknown> {
  return {
    name: 'hybrid-axi', executable: toolPaths['hybrid-axi'], credentialProfile: hybridProfile, credentialSchema: hybridCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: hybridManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { hybridArguments(args, input) },
    async prepareArtifact(args, reference, scope) {
      if (reference.tool !== 'hybrid-axi' || reference.revision !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
      const parsed = hybridCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      // Only the authenticated transfer owner calls this internal handoff after
      // current policy checks. Ordinary T13 arguments still refuse downloads.
      const profile = hybridProfile.prepare('hybrid-axi', { ...parsed.data,
        writes: { allowWrites: true, operations: [scope.selection.operation] } }, writeLog, false)
      return { executable: toolPaths['hybrid-axi'], args, ...profile,
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
    async prepare(args, reference, input) {
      const normalized = hybridArguments(args, input)
      if (reference.tool !== 'hybrid-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = hybridCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const readOnly = !toolAllowsWrites('hybrid-axi', parsed.data)
        || Boolean(source.getSettings && !toolAllowsWrites('hybrid-axi', source.getSettings(reference)))
      const profile = hybridProfile.prepare('hybrid-axi', parsed.data, writeLog, readOnly)
      // Native confirmation includes the absolute upload path. Linux's per-process
      // cwd link gives each isolated runner the same spelling without retaining bytes.
      const files = [...profile.files]
      for (const index of normalized.fileArguments ?? []) {
        const file = input!.files!.find(file => file.name === normalized.args[index])!
        const name = `hybrid-axi/uploads/${file.name}`
        files.push({ name, content: Buffer.from(file.contentBase64, 'base64') })
        normalized.args[index] = `/proc/self/cwd/${name}`
      }
      return { executable: toolPaths['hybrid-axi'], ...normalized,
        ...profile, files, fileArguments: [], limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
