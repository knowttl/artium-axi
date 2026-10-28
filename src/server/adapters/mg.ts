import { isAbsolute } from 'node:path'
import { z } from 'zod'
import inventory from '../../../tools/inventories/mg-axi.json' with { type: 'json' }
import { inputFileSchema, nativeSettingsSchemas } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { loadCredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import applicationMode from '../../shared/mg-application-mode.json' with { type: 'json' }

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
const guid = z.string().regex(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/)
const common = { tenantId: guid, clientId: guid, ...nativeSettingsSchemas['mg-axi'].shape }
export const mgCredentialSchema = z.discriminatedUnion('auth', [
  z.strictObject({ ...common, auth: z.literal('secret'), clientSecret: nonempty }),
  z.strictObject({ ...common, auth: z.literal('certificate'), privateKey: nonempty,
    thumbprint: z.string().regex(/^[a-fA-F0-9]{40}$/) }),
])
export type MgCredential = z.infer<typeof mgCredentialSchema>
export const mgManifest = { ...inventory, ...inventory.adapterBoundary }
export const mgWritePolicy = writePolicy({ supportedOperations: inventory.nativeWriteSettings.supportedOperations,
  unlocks: 'Selected Graph group membership, user account state, session revocation, risk dismissal, conditional-access policy and mail operations; native execution and confirmation gates still apply.',
  blocked: 'Operations outside the allow-list, raw API mutations, beta writes, unsupported targets and unsafe overrides remain blocked. Graph permissions and roles are still required.' })

function mgArguments(args: readonly string[], input: RunnerInput = {}, artifact = false) {
  const hunting = args.slice(0, 3).join(' ') === 'security hunting query'
  const rule = ['mail rule create', 'mail rule update'].includes(args.slice(0, 3).join(' '))
  const upload = hunting || rule
  const uploadName = hunting ? 'query.kql' : 'rule.json'
  if (input.files?.length && !upload) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--help', '--version', '-v', '-V'].includes(args[0])) {
    if (input.stdin !== undefined) throw new ArtiumError('UNSUPPORTED_INPUT')
    return { args: [...args], invocation: { command: args[0] === '--help' ? 'home' : 'version', help: args[0] === '--help' } }
  }
  const words = args.slice(0, args.findIndex(arg => arg.startsWith('-')) < 0
    ? args.length : args.findIndex(arg => arg.startsWith('-')))
  const route = inventory.commands.find(route => route.command === (words.join(' ') || 'home'))
    ?? inventory.commands.find(route => route.positionalInput && route.command === words.slice(0, -1).join(' '))
    ?? (words.length === 3 && words[0] === 'api' && words[1] === 'get'
      ? inventory.commands.find(route => route.command === 'api get') : undefined)
  if (!route) {
    if (words[0] === 'update' || words[0] === 'api' && /^(post|put|patch|delete|head|options)$/i.test(words[1] ?? '')) {
      throw new ArtiumError('FLAG_BLOCKED', `Command ${words.join(' ')} is unavailable through artium.`)
    }
    throw invalidCommand('mg-axi', words, inventory.commands.filter(route => mgManifest.allowedCommands.some(command => route.command === command || route.command.startsWith(command + ' '))).map(route => route.command))
  }
  const download = mgManifest.downloadCommands.includes(route.command)
  if (download && !artifact) throw new ArtiumError('FLAG_BLOCKED', 'Use artium-axi download --help for authenticated mail saving.')
  if (!(artifact && download) && !mgManifest.allowedCommands.some(command => route.command === command || route.command.startsWith(`${command} `))) {
    throw new ArtiumError('FLAG_BLOCKED', `Command ${route.command} is unavailable through artium.`)
  }
  const schema: Record<string, string | undefined> = route.flags
  const flags: Record<string, string | boolean> = Object.create(null)
  const normalized = [...words]
  const fileArguments: number[] = []
  for (let index = words.length; index < args.length; index++) {
    if (upload && (!args[index].startsWith('--') || !Object.hasOwn(schema, args[index].slice(2).split('=')[0]))) {
      throw new ArtiumError('INVALID_INPUT')
    }
    if (!args[index].startsWith('-')) throw new ArtiumError('INVALID_INPUT', `Unexpected argument ${JSON.stringify(args[index])} for mg-axi ${route.command}.`)
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[index])
    if (!match && upload) throw new ArtiumError('INVALID_INPUT')
    if (!match) throw unknownFlag('mg-axi', route.command, args[index], Object.keys(schema).filter(name => !mgManifest.unsafeOverrides.includes(name)))
    const [, name, inline] = match
    if (mgManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(schema, name)) throw unknownFlag('mg-axi', route.command, args[index], Object.keys(schema).filter(name => !mgManifest.unsafeOverrides.includes(name)))
    if (Object.hasOwn(flags, name)) throw new ArtiumError('INVALID_INPUT')
    if (schema[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      flags[name] = true
      normalized.push(`--${name}`)
    } else {
      const value = inline ?? args[++index]
      if (!value?.trim() || value.startsWith('-') && !(['cursor', 'file'].includes(name) && value === '-')) throw new ArtiumError('INVALID_INPUT')
      flags[name] = value
      normalized.push(`--${name}`, value)
      if (upload && name === 'file') fileArguments.push(normalized.length - 1)
    }
  }
  if (input.stdin !== undefined && flags.cursor !== '-') throw new ArtiumError('UNSUPPORTED_INPUT')
  if (upload && (flags.help !== true || input.files?.length)) {
    const file = input.files?.[0]
    if (flags.file !== uploadName || input.files?.length !== 1 || file?.name !== uploadName
      || !inputFileSchema.safeParse(file).success || file.contentBase64.length > 4 * Math.ceil(65536 / 3)) {
      throw new ArtiumError('UNSUPPORTED_INPUT', `Command requires exactly one UTF-8 ${uploadName} upload of at most 64 KiB.`)
    }
    const bytes = Buffer.from(file.contentBase64, 'base64')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new ArtiumError('UNSUPPORTED_INPUT') }
    if (bytes.length > 65536 || !text.trim() || /\p{Cc}/u.test(text.replace(/[\t\r\n]/g, ''))) throw new ArtiumError('UNSUPPORTED_INPUT')
  }
  return { args: upload && flags.help !== true ? normalized : [...args], fileArguments: flags.help === true ? [] : fileArguments,
    invocation: { command: route.command, help: flags.help === true } }
}

export function createMgAdapter(source: SecretSource, writeLog: string,
  profile = loadCredentialProfile('mg-axi')): Adapter<unknown> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return {
    name: 'mg-axi', executable: toolPaths['mg-axi'], credentialSchema: profile?.credentialSchema ?? mgCredentialSchema,
    credentialProfile: profile,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: mgManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {}, sensitiveArguments: args => ({ flags: mgManifest.sensitiveFlags.map(name => `--${name}`),
      positions: args.slice(0, 3).join(' ') === 'security hunting query' ? args.map((_, index) => index) : [] }),
    validateArgs: (args, input) => { mgArguments(args, input) },
    prepare,
    async prepareArtifact(args, reference, scope) {
      if (reference.tool !== 'mg-axi' || !scope.selection.operation.startsWith('mail.')
        || reference.revision !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
      const prepared = await prepare(args, reference, undefined, true)
      prepared.environment.MG_AXI_WRITE_LOG = `${writeLog}.${scope.transferId}`
      return prepared
    },
  }

  async function prepare(args: readonly string[], reference: Parameters<Adapter<unknown>['prepare']>[1], input?: RunnerInput, artifact = false) {
    const normalized = mgArguments(args, input, artifact)
    if (reference.tool !== 'mg-axi' || !profile && !reference.revision) throw new ArtiumError('CREDENTIAL_INVALID')
    const value = await source.getCredential(reference)
    const packs: Record<string, string> = mgManifest.commandPacks
    const pack = packs[normalized.invocation.command]
    if (profile && pack === 'mail' && (!value || typeof value !== 'object'
      || !('mode' in value) || value.mode !== applicationMode.properties.mode.const)) {
      throw new ArtiumError('CREDENTIAL_INVALID', 'Hosted mail requires an application-mode credential profile.')
    }
    const parsed = (profile?.credentialSchema ?? mgCredentialSchema).safeParse(value)
    if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
    const settings = source.getSettings?.(reference) ?? parsed.data
    if (pack && !(settings.enabledPacks as string[] | undefined)?.includes(pack)) {
      throw new ArtiumError('FLAG_BLOCKED', `Command requires the administrator enabledPacks: ["entra", "${pack}"] opt-in.`)
    }
    if (artifact) {
      const state = mgWritePolicy.read(settings)
      if (!state.enabled || !state.allowedOperations.includes(normalized.invocation.command.replaceAll(' ', '.'))) throw new ArtiumError('FLAG_BLOCKED')
    }
    const query = normalized.invocation.command === 'security hunting query' && input?.files?.[0]
      ? Buffer.from(input.files[0].contentBase64, 'base64').toString('utf8').trim() : undefined
    if (profile) {
      const prepared = profile.prepare('mg-axi', parsed.data, writeLog,
        (parsed.data.writes as { allowWrites?: boolean } | undefined)?.allowWrites !== true)
      return { executable: toolPaths['mg-axi'], ...normalized, ...prepared,
        secrets: [...prepared.secrets, ...(query ? [query] : [])],
        limits: { timeoutMs: runnerLimits.timeoutMs, nodeHeapMiB: 512 },
      }
    }
    const credential = mgCredentialSchema.parse(parsed.data)
    const { tenantId, clientId, preview = false, writes } = credential
    const secret = credential.auth === 'secret' ? credential.clientSecret : credential.privateKey
    const holder = 'ARTIUM_SECRET_0'
    const credentialRef = credential.auth === 'secret'
      ? { provider: 'client-secret', key: clientId, secretEnv: holder }
      : { provider: 'certificate', key: clientId, thumbprint: credential.thumbprint.toLowerCase(), keyEnv: holder }
    return {
      executable: toolPaths['mg-axi'], ...normalized,
      environment: { MG_AXI_CONFIG: 'mg-profile.json', MG_AXI_WRITE_LOG: writeLog,
        MG_AXI_READ_ONLY: String(writes?.allowWrites !== true), [holder]: secret },
      files: [{ name: 'mg-profile.json', content: JSON.stringify({ version: 1, defaultProfile: 'artium', profiles: {
        artium: { mode: 'application', tenantId, clientId, cloud: 'commercial', preview,
          allowDeviceCode: false, enabledPacks: credential.enabledPacks ?? ['entra'], sensitiveAreas: [], credentialRef,
          ...(writes === undefined ? {} : { writes }) },
      } }) }],
      secrets: [...new Set([secret, credential.auth === 'secret' ? secret.trim()
        : secret.includes('\n') ? secret : secret.replace(/\\n/g, '\n'), ...(query ? [query] : [])])],
      limits: { timeoutMs: runnerLimits.timeoutMs, nodeHeapMiB: 512 },
    }
  }
}
