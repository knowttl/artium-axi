import inventory from '../../../tools/inventories/beyondtrust-axi.json' with { type: 'json' }
import { toolAllowsWrites, transferTool } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { writePolicy } from './write-policy.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'

export const beyondtrustManifest = { ...inventory, ...inventory.adapterBoundary }
export const beyondtrustProfile = new CredentialProfile(inventory.credentialSchema, 'beyondtrust-axi')
export const beyondtrustCredentialSchema = beyondtrustProfile.credentialSchema
const mutationTimeoutMs = 75_000

export const beyondtrustWritePolicy = writePolicy({
  allowDeletes: true, supportedOperations: inventory.nativeWriteSettings.supportedOperations,
  unlocks: 'Selected Endpoint Privilege Management operations with native preview, execute, exact confirmation and durable journal. Deletes additionally require Allow deletes and exact --confirm-delete. Downloads use artium-axi download.',
  blocked: 'Unselected operations, local configuration, origin overrides and ordinary tool-run downloads.',
})

function beyondtrustArguments(args: readonly string[], input: RunnerInput = {}) {
  const tokens = args.length ? [...args] : ['home']
  if (tokens.length === 1 && ['--version', '-v', '-V', '--help'].includes(tokens[0])) return {
    args: tokens, invocation: { command: tokens[0] === '--help' ? 'home' : 'version', help: tokens[0] === '--help' }, effect: 'read' as const }
  const route = [...inventory.commands].sort((a, b) => b.command.length - a.command.length).find(route => tokens.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!route) throw invalidCommand('beyondtrust-axi', tokens, inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
  if (route.effect === 'blocked') throw new ArtiumError('FLAG_BLOCKED', `Command ${route.command} is unavailable through ordinary tool runs.`,
    beyondtrustManifest.downloadCommands.includes(route.command) ? 'Use artium-axi download --help for authenticated saving.' : undefined)
  const normalized = tokens.slice(0, route.command.split(' ').length)
  const fileArguments: number[] = []
  const flags = new Set<string>()
  for (let index = normalized.length; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token.startsWith('-')) { normalized.push(token); continue }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token)
    const name = match?.[1] ?? ''
    if (beyondtrustManifest.unsafeOverrides.includes(name) || token === '--') throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(route.flags, name)) throw unknownFlag('beyondtrust-axi', route.command, token,
      Object.keys(route.flags).filter(name => !beyondtrustManifest.unsafeOverrides.includes(name)))
    if (flags.has(name)) throw new ArtiumError('INVALID_INPUT')
    flags.add(name)
    if (['help', 'full', 'all', 'execute', 'force', 'auto-assign'].includes(name)
      || (name === 'default' && route.command === 'group create')) {
      if (match[2] !== undefined) throw new ArtiumError('INVALID_INPUT')
      normalized.push(token)
      continue
    }
    const value = match[2] ?? tokens[++index]
    if (value === undefined || value.startsWith('--')) throw new ArtiumError('INVALID_INPUT')
    normalized.push(`--${name}`, value)
    if (beyondtrustManifest.inputFileFlags.includes(name)) {
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

export function createBeyondtrustAdapter(source: SecretSource, writeLog: string): Adapter<unknown> {
  return {
    name: 'beyondtrust-axi', executable: toolPaths['beyondtrust-axi'], credentialProfile: beyondtrustProfile,
    credentialSchema: beyondtrustCredentialSchema, timeoutMs: mutationTimeoutMs,
    blockedFlags: beyondtrustManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { beyondtrustArguments(args, input) },
    async prepareArtifact(args, reference, scope) {
      if (reference.tool !== 'beyondtrust-axi' || transferTool(scope.selection.operation) !== reference.tool
        || reference.revision !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
      const parsed = beyondtrustCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? parsed.data
      const state = beyondtrustWritePolicy.read(settings)
      if (!state.enabled || !state.allowedOperations.includes(scope.selection.operation)) throw new ArtiumError('FLAG_BLOCKED')
      const profile = beyondtrustProfile.prepare('beyondtrust-axi', { ...parsed.data, downloads: { allow: true },
        writes: { allowWrites: false, allowDeletes: false, operations: [] } }, writeLog, true)
      return { executable: toolPaths['beyondtrust-axi'], args, ...profile, limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
    async prepare(args, reference, input) {
      const normalized = beyondtrustArguments(args, input)
      if (reference.tool !== 'beyondtrust-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = beyondtrustCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const readOnly = !toolAllowsWrites('beyondtrust-axi', parsed.data)
        || Boolean(source.getSettings && !toolAllowsWrites('beyondtrust-axi', source.getSettings(reference)))
      const settings = source.getSettings?.(reference) ?? parsed.data
      const profile = beyondtrustProfile.prepare('beyondtrust-axi', { ...parsed.data,
        writes: { allowWrites: !readOnly,
          operations: beyondtrustWritePolicy.read(parsed.data).allowedOperations.filter(operation => beyondtrustWritePolicy.read(settings).allowedOperations.includes(operation)),
          allowDeletes: (settings.writes as { allowDeletes?: boolean } | undefined)?.allowDeletes === true
            && (parsed.data.writes as { allowDeletes?: boolean } | undefined)?.allowDeletes === true },
        downloads: { allow: false } }, writeLog, readOnly)
      // A fixed private leaf keeps native file-bound confirmations stable across calls.
      const files = [...profile.files]
      for (const index of normalized.fileArguments ?? []) {
        const file = input!.files!.find(file => file.name === normalized.args[index])!
        const name = 'beyondtrust-axi/uploads/input'
        files.push({ name, content: Buffer.from(file.contentBase64, 'base64') })
        normalized.args[index] = `/proc/self/cwd/${name}`
      }
      return { executable: toolPaths['beyondtrust-axi'], ...normalized, ...profile, files, fileArguments: [],
        ...(normalized.effect === 'write' ? { write: { operation: normalized.invocation.command, target: 'managed resource',
          checkArgs: [normalized.args[0], '--help'], afterCheck: 'Reconcile the durable intent and affected remote state before retrying' } } : {}),
        limits: { timeoutMs: normalized.effect === 'write' ? mutationTimeoutMs : runnerLimits.timeoutMs } }
    },
  }
}

