import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { nativeSettingsSchemas } from '../../shared/api.js'
import inventory from '../../../tools/inventories/az-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { azureCredentialSchema } from './azure-tokens.js'
import { AzureTokenCache, azureCommandResources } from './azure-token-cache.js'
import type { Adapter } from './types.js'

const settings = nativeSettingsSchemas['az-axi'].shape
export const azCredentialSchema = z.discriminatedUnion('auth', [
  azureCredentialSchema.options[0].extend(settings), azureCredentialSchema.options[1].extend(settings),
])
export type AzCredential = z.infer<typeof azCredentialSchema>
export const azManifest = { ...inventory, ...inventory.adapterBoundary }

// Follow the pinned leaf parser while retaining caller spelling for upstream execution.
function azArguments(args: readonly string[], input: RunnerInput = {}) {
  if (args.length === 1 && ['--help', '-h', '--version', '-v', '-V'].includes(args[0])) {
    return { args: [...args], fileArguments: [], resources: { required: [], optional: [] } }
  }
  let leading = 0
  while (args[leading]?.startsWith('-')) {
    const token = args[leading]
    const name = token.split('=')[0] === '-s' ? 'subscription' : token.slice(2).split('=')[0]
    const flag = azManifest.globalFlags.find(flag => flag.name === name)
    if (flag?.disposition === 'unsafe override') throw new ArtiumError('FLAG_BLOCKED')
    if (!flag || ['help'].includes(name)) break
    leading++
    if (!token.includes('=') && (name !== 'full' || ['true', 'false'].includes(args[leading]))) leading++
  }
  if (leading) {
    const command = args.length > leading ? args.slice(leading) : ['home']
    const separator = command.indexOf('--')
    command.splice(separator === -1 ? command.length : separator, 0, ...args.slice(0, leading))
    return azArguments(command, input)
  }
  const route = inventory.commands.filter(route => route.tokenResources !== null &&
    (route.command === 'home' && args.length === 0 || route.command.split(' ').every((word, index) => args[index] === word)))
    .sort((a, b) => b.command.length - a.command.length)[0]
  if (!route) throw new ArtiumError('FLAG_BLOCKED')
  const flags: Record<string, string> = Object.create(null)
  const normalized = [...args]
  const fileArguments: number[] = []
  const schema: Record<string, string | undefined> = route.flags
  const aliases = route.flagAliases as Record<string, string>
  const shorts: Record<string, string | undefined> = route.shortFlags
  for (let index = args.length === 0 ? 0 : route.command.split(' ').length; index < args.length; index++) {
    const token = args[index]
    if (token === '--') break
    if (!token.startsWith('-') || token === '-') continue
    const equals = token.indexOf('=')
    const raw = token.slice(token.startsWith('--') ? 2 : 1, equals === -1 ? undefined : equals)
    const expanded = token.startsWith('--') ? raw : shorts[raw]
    const name = expanded === undefined ? raw : aliases[expanded] ?? expanded
    if (azManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    const kind = schema[name]
    if (!kind) throw new ArtiumError('INVALID_INPUT')
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    let value: string
    if (kind === 'boolean') {
      value = inline ?? (['true', 'false'].includes(args[index + 1]) ? args[++index] : 'true')
      if (!['true', 'false'].includes(value)) throw new ArtiumError('INVALID_INPUT')
    } else {
      const values = inline === undefined ? [] : [inline]
      if (inline === undefined) {
        while (args[index + 1] !== undefined && (!args[index + 1].startsWith('-') || /^-\d/.test(args[index + 1]))) {
          values.push(args[++index])
          if (!['list', 'literal-list'].includes(kind) || route.positionalInput) break
        }
      }
      if (!values.length || values.some(value => !value.trim())) throw new ArtiumError('INVALID_INPUT')
      value = values.join(',')
      if (azManifest.inputFileFlags.includes(name)) {
        if (!input.files?.some(file => file.name === value)) throw new ArtiumError('UNSUPPORTED_INPUT')
        if (inline !== undefined) {
          normalized.splice(index, 1, `--${name}`, value)
          // Normalize equals forms once, then collect stable argument positions.
          return azArguments(normalized, input)
        }
        fileArguments.push(index)
      }
    }
    if (Object.hasOwn(flags, name)) {
      if (['list', 'literal-list'].includes(kind)) value = `${flags[name]},${value}`
      else if (flags[name] !== value) throw new ArtiumError('INVALID_INPUT')
    }
    flags[name] = value
  }
  return { args: normalized, fileArguments, resources: azureCommandResources(route.command, flags) }
}

export function createAzAdapter(source: SecretSource, writeLog: string, cache = new AzureTokenCache()): Adapter<AzCredential> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return {
    name: 'az-axi', executable: toolPaths['az-axi'], credentialSchema: azCredentialSchema,
    invalidateCredential: reference => { cache.replace(reference.id, reference.revision!) },
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: azManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {}, sensitiveArguments: args => ({
      flags: [...azManifest.sensitiveFlags.map(name => `--${name}`), '-q'],
      positions: ['logs', 'rg'].includes(args[0]) && args[1] === 'query'
        ? args.map((_, index) => index).slice(2) : [],
    }),
    validateArgs: (args, input) => { azArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = azArguments(args, input)
      if (reference.tool !== 'az-axi' || !reference.revision) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const parsed = azCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const { tenantId, clientId, auth, subscriptions, managementGroup, workspaces, description, allowWrites } = parsed.data
      const credential = auth === 'secret'
        ? { tenantId, clientId, auth, clientSecret: parsed.data.clientSecret }
        : { tenantId, clientId, auth, privateKey: parsed.data.privateKey, thumbprintSha256: parsed.data.thumbprintSha256 }
      const tokens = await cache.acquire({ id: reference.id, revision: reference.revision, credential }, normalized.resources)
      const holders = Object.fromEntries(Object.keys(tokens).map((resource, index) => [resource, `ARTIUM_SECRET_${index}`]))
      return {
        executable: toolPaths['az-axi'], args: normalized.args, fileArguments: normalized.fileArguments,
        environment: { AZ_AXI_CONFIG: 'az-profile.json', AZ_AXI_WRITE_LOG: writeLog,
          ...Object.fromEntries(Object.entries(tokens).map(([resource, token]) => [holders[resource], token!.accessToken])) },
        files: [{ name: 'az-profile.json', content: JSON.stringify({ defaultProfile: 'artium', profiles: {
          artium: { subscriptions, managementGroup, workspaces, description, allowWrites, auth: 'token', tenant: tenantId, tokenEnv: holders },
        } }) }],
        secrets: [...new Set([credential.auth === 'secret' ? credential.clientSecret : credential.privateKey,
          ...Object.values(tokens).flatMap(token => token.secrets)])],
        limits: { timeoutMs: runnerLimits.timeoutMs },
      }
    },
  }
}
