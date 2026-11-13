import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import inventory from '../../../tools/inventories/tenable-axi.json' with { type: 'json' }
import { classifyCommand } from './classify.js'
import { toolAllowsWrites } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { writePolicy } from './write-policy.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'

export const tenableManifest = { ...inventory, ...inventory.adapterBoundary }
export const tenableBooleanFlags = ['help', 'full', 'all', 'include-resolved', 'execute', 'dry-run']
export const tenableProfile = new CredentialProfile(inventory.credentialSchema, 'tenable-axi')
export const tenableCredentialSchema = tenableProfile.credentialSchema
export const tenableWritePolicy = writePolicy({ supportedOperations: inventory.nativeWriteSettings.supportedOperations,
  unlocks: 'Selected business writes, export-job creation and raw write, with native preview, --execute, exact --confirm and journal gates. Raw API permission is separate.',
  blocked: 'Operations outside the allow-list, local configuration, output downloads, raw get --out and credential or origin overrides remain blocked.' })

const tenableOperations: Record<string, string> = {
  'combination create': 'combinations-create', 'combination update': 'combinations-update', 'combination delete': 'combinations-delete',
  'initiative create': 'initiatives-create', 'initiative update': 'initiatives-update', 'initiative delete': 'initiatives-delete',
  'export asset start': 'inventory-export-assets', 'export finding start': 'inventory-export-findings',
  'export attack-path start': 'apa-export-attack-path', 'export attack-technique start': 'apa-export-attack-technique',
  'export mitre-heatmap start': 'apa-export-mitre-heatmap', 'raw write': 'raw-write',
  'tag assignment add': 'tags-assign-asset-tags', 'tag assignment remove': 'tags-assign-asset-tags',
  'tag category create': 'tags-create-tag-category', 'tag category update': 'tags-edit-tag-category', 'tag category delete': 'tags-delete-tag-category',
  'tag value create': 'tags-create-tag-value', 'tag value update': 'tags-update-tag-value', 'tag value delete': 'tags-delete-tag-value',
  'tag value bulk-delete': 'tags-delete-tag-values-bulk',
}

function tenableArguments(args: readonly string[], input: RunnerInput = {}) {
  const tokens = args.length ? [...args] : ['home']
  const version = tokens.length === 1 && ['--version', '-v', '-V', '--help'].includes(tokens[0])
  const route = inventory.commands.find(route => tokens.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!version && !route) {
    if (tokens[0].startsWith('-')) throw unknownFlag('tenable-axi', 'home', tokens[0],
      Object.keys(inventory.commands.find(route => route.command === 'home')!.flags).filter(name => !tenableManifest.unsafeOverrides.includes(name)))
    throw invalidCommand('tenable-axi', tokens, inventory.commands.filter(route => route.effect !== 'blocked').map(route => route.command))
  }
  if (!version && route?.effect === 'blocked') throw new ArtiumError('FLAG_BLOCKED', `Command ${route.command} is unavailable through artium.`)
  const normalized: string[] = []
  const fileArguments: number[] = []
  let usesStdin = false
  let help = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const name = token.startsWith('--') ? token.slice(2).split('=')[0] : ''
    if (name === 'help') help = true
    if (token === '--' || tenableManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (route && token.startsWith('-') && !Object.hasOwn(route.flags, name)) {
      throw unknownFlag('tenable-axi', route.command, token,
        Object.keys(route.flags).filter(name => !tenableManifest.unsafeOverrides.includes(name)))
    }
    if (tenableManifest.inputFileFlags.includes(name)) {
      const equals = token.indexOf('=')
      const value = equals === -1 ? tokens[++index] : token.slice(equals + 1)
      if (!value || value !== '-' && !input.files?.some(file => file.name === value)) throw new ArtiumError('UNSUPPORTED_INPUT')
      if (value === '-') usesStdin = true
      normalized.push(`--${name}`, value)
      if (value !== '-') fileArguments.push(normalized.length - 1)
    } else {
      normalized.push(token)
      if (name && !tenableBooleanFlags.includes(name)
        && !token.includes('=') && tokens[index + 1] !== undefined && !tokens[index + 1].startsWith('--')) {
        normalized.push(tokens[++index])
      }
    }
  }
  if (input.stdin !== undefined && !usesStdin) throw new ArtiumError('UNSUPPORTED_INPUT')
  return { args: normalized, fileArguments, invocation: { command: route?.command ?? (help ? 'home' : 'version'), help },
    effect: !help && route?.effect === 'write' && tokens.some(token => token === '--execute' || token.startsWith('--execute='))
      ? 'write' as const : 'read' as const }
}

export function createTenableAdapter(source: SecretSource, writeLog: string): Adapter<unknown> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return {
    name: 'tenable-axi', executable: toolPaths['tenable-axi'], credentialProfile: tenableProfile, credentialSchema: tenableCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: tenableManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { tenableArguments(args, input) },
    executesWrite: (args, input) => tenableArguments(args, input).effect === 'write',
    authorizeOperation: (command, settings) => tenableWritePolicy.authorize(settings, allowed => allowed === tenableOperations[command]),
    rawApi: { commands: ['raw get', 'raw write'], writes: true, help: (args, input) => tenableArguments(args, input).invocation.help },
    classify: (args: readonly string[], input?: RunnerInput) => classifyCommand(inventory.commands, (a, i) => tenableArguments(a, i).invocation, args, input),
    async prepare(args, reference, input) {
      const normalized = tenableArguments(args, input)
      if (reference.tool !== 'tenable-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = tenableCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const rawWrite = normalized.invocation.command === 'raw write' && !normalized.invocation.help
      const readOnly = !toolAllowsWrites('tenable-axi', parsed.data)
        || Boolean(source.getSettings && !toolAllowsWrites('tenable-axi', source.getSettings(reference)))
      const allowed = (settings: Record<string, unknown>) => {
        const access = tenableWritePolicy.read(settings)
        return access.enabled && access.allowedOperations.includes('raw-write')
      }
      if (rawWrite && (!allowed(parsed.data) || source.getSettings && !allowed(source.getSettings(reference)))) throw new ArtiumError('FLAG_BLOCKED')
      const profile = tenableProfile.prepare('tenable-axi', parsed.data, writeLog, readOnly)
      const content = profile.files[0].content
      const identity = createHash('sha256').update(JSON.stringify([reference.id, reference.revision, content])).digest('hex')
      const directory = join(dirname(writeLog), 'profiles')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const config = join(directory, `${identity}.json`)
      const temporary = join(directory, `${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
        await rename(temporary, config)
      } finally { await rm(temporary, { force: true }) }
      return { executable: toolPaths['tenable-axi'], ...normalized,
        ...profile, files: [], environment: { ...profile.environment, TENABLE_AXI_CONFIG: config,
          TENABLE_AXI_CREDENTIAL_REVISION: `${reference.id}:${reference.revision}` },
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
