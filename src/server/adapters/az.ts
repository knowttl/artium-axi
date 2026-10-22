import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { nativeSettingsSchemas, toolAllowsWrites } from '../../shared/api.js'
import inventory from '../../../tools/inventories/az-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { azureCredentialSchema } from './azure-tokens.js'
import { AzureTokenCache, azureCommandResources } from './azure-token-cache.js'
import type { AzureResourcePlan } from './azure-token-cache.js'
import { loadCredentialProfile } from './credential-profile.js'
import type { Adapter, PreparedCall } from './types.js'

const settings = nativeSettingsSchemas['az-axi'].shape
export const azCredentialSchema = z.discriminatedUnion('auth', [
  azureCredentialSchema.options[0].extend(settings), azureCredentialSchema.options[1].extend(settings),
])
export type AzCredential = z.infer<typeof azCredentialSchema>
export const azManifest = { ...inventory, ...inventory.adapterBoundary }
export const azWritePolicy = writePolicy({ unlocks: 'Reviewed Azure writes and ARM API mutations within configured subscriptions; --execute is still required.',
  blocked: 'Unscoped writes, unsupported commands, unsafe overrides and non-ARM API writes remain blocked.' })

// Follow the pinned leaf parser while retaining caller spelling for upstream execution.
function azArguments(args: readonly string[], input: RunnerInput = {}): {
  args: string[], fileArguments: number[], resources: AzureResourcePlan, write?: PreparedCall['write']
} {
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
  const positionals: string[] = []
  const schema: Record<string, string | undefined> = route.flags
  const aliases = route.flagAliases as Record<string, string>
  const shorts: Record<string, string | undefined> = route.shortFlags
  for (let index = args.length === 0 ? 0 : route.command.split(' ').length; index < args.length; index++) {
    const token = args[index]
    if (token === '--') { positionals.push(...args.slice(index + 1)); break }
    if (!token.startsWith('-') || token === '-') { positionals.push(token); continue }
    const equals = token.indexOf('=')
    const raw = token.slice(token.startsWith('--') ? 2 : 1, equals === -1 ? undefined : equals)
    const expanded = token.startsWith('--') ? raw : shorts[raw]
    const name = expanded === undefined ? raw : aliases[expanded] ?? expanded
    if (azManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    const kind = schema[name]
    if (!kind) throw new ArtiumError('INVALID_INPUT', `Unknown flag ${JSON.stringify(token.split('=')[0]).slice(1, -1)} for az-axi ${route.command}.`,
      `Valid flags: ${Object.keys(schema).filter(name => !azManifest.unsafeOverrides.includes(name)).map(name => `--${name}`).join(', ')}. Run artium-axi az-axi ${route.command} --help.`)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    let value: string
    if (kind === 'boolean') {
      value = inline ?? (['true', 'false'].includes(args[index + 1]) ? args[++index] : 'true')
      if (!['true', 'false'].includes(value)) throw new ArtiumError('INVALID_INPUT')
    } else {
      const values = inline === undefined ? [] : [inline]
      if (inline === undefined) {
        while (args[index + 1] !== undefined && (!args[index + 1].startsWith('-') || /^-\d/.test(args[index + 1]) ||
          (azManifest.inputFileFlags.includes(name) && input.files?.some(file => file.name === args[index + 1])))) {
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
  return { args: normalized, fileArguments, resources: azureCommandResources(route.command, flags),
    write: azWrite(route, flags, positionals) }
}

function azWrite(route: typeof inventory.commands[number], flags: Record<string, string>, positionals: string[]): PreparedCall['write'] {
  if (flags.execute !== 'true' || flags.help === 'true') return
  if (route.handlerCommand === 'api') {
    const method = positionals[0]?.toUpperCase()
    if (!['PUT', 'PATCH', 'POST', 'DELETE'].includes(method) || (flags.resource ?? 'arm') !== 'arm') return
    const target = positionals[1]
    if (!target) return
    let url: URL
    try { url = new URL(target, 'https://management.azure.com') } catch { return }
    const path = url.pathname.split('/').filter(Boolean).map(segment => {
      try { return decodeURIComponent(segment).toLowerCase() } catch { return segment.toLowerCase() }
    }).join('/')
    if (method === 'POST' && (
      path === 'providers/microsoft.resourcegraph/resources' ||
      /^subscriptions\/[^/]+\/(?:resourcegroups\/[^/]+\/)?providers\/microsoft.resources\/deployments\/[^/]+\/whatif$/.test(path) ||
      /microsoft.policyinsights\/.*policystates\/latest\/queryresults$/.test(path) ||
      /microsoft.securityinsights\/.*incidents\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(?:alerts|entities)$/.test(path)
    )) return
    if (method === 'POST') url.pathname = url.pathname.replace(/\/[^/]+\/?$/, '')
    const checkArgs = ['api', 'GET', target.startsWith('/') ? url.pathname + url.search : url.toString()]
    for (const name of ['api-version', 'query']) if (flags[name]) checkArgs.push(`--${name}`, flags[name])
    checkArgs.push('--full')
    return { operation: method, target: JSON.stringify(target), checkArgs }
  }
  if (!['write', 'destructive'].includes(route.effect)) return
  flags = Object.fromEntries(Object.entries(flags).map(([name, value]) => [name, value.trim()]))
  flags.subscription = (flags.subscription ?? '').split(',').map(value => value.trim()).filter(Boolean).join(',')
  if (route.handlerCommand === 'tag update') {
    const target = (flags['resource-id'] ?? '').replace(/\/+$/, '')
    return { operation: route.handlerCommand, target: JSON.stringify(target),
      checkArgs: ['api', 'GET', `${target}/providers/Microsoft.Resources/tags/default`, '--api-version', '2021-04-01', '--full'] }
  }
  if (route.handlerCommand === 'security alert update') {
    const group = flags['resource-group'] === undefined ? '' : `/resourceGroups/${encodeURIComponent(flags['resource-group'])}`
    const target = `/subscriptions/${flags.subscription}${group}/providers/Microsoft.Security/locations/${encodeURIComponent(flags.location)}/alerts/${encodeURIComponent(flags.name)}`
    return { operation: route.handlerCommand, target: JSON.stringify(target),
      checkArgs: ['api', 'GET', target, '--api-version', '2022-01-01', '--full'] }
  }
  if (route.handlerCommand === 'network nsg rule create') {
    const nsg = flags.ids ?? `/subscriptions/${flags.subscription}/resourceGroups/${encodeURIComponent(flags['resource-group'])}/providers/Microsoft.Network/networkSecurityGroups/${encodeURIComponent(flags['nsg-name'])}`
    const target = `${nsg}/securityRules/${encodeURIComponent(flags.name)}`
    return { operation: route.handlerCommand, target: JSON.stringify(target),
      checkArgs: ['api', 'GET', target, '--api-version', '2024-05-01', '--full'] }
  }
  const reads: Record<string, { command: string[], selectors: string[] }> = {
    'sentinel incident update': { command: ['sentinel', 'incident', 'show'], selectors: ['subscription', 'resource-group', 'workspace-name', 'workspace', 'name', 'incident-id', 'ids'] },
    'sentinel incident comment create': { command: ['sentinel', 'incident', 'show'], selectors: ['subscription', 'resource-group', 'workspace-name', 'workspace', 'incident-id', 'ids'] },
  }
  const read = reads[route.handlerCommand]
  if (!read) throw new ArtiumError('INVALID_INPUT')
  const checkArgs = [...read.command]
  for (const name of read.selectors) if (flags[name]) checkArgs.push(`--${name}`, flags[name])
  checkArgs.push('--full')
  const target = Object.fromEntries(['subscription', 'resource-group', 'workspace-name', 'workspace', 'name', 'incident-id', 'ids', 'nsg-name', 'location']
    .filter(name => flags[name] !== undefined).map(name => [name, flags[name]]))
  return { operation: route.handlerCommand, target: JSON.stringify(target), checkArgs,
    ...(route.handlerCommand === 'sentinel incident comment create' ? {
      afterCheck: "Use the returned incident id as <incident-ARM-id>, then inspect the comments before retrying: artium-axi az-axi api GET '<incident-ARM-id>/comments' --api-version 2025-09-01 --all --full",
    } : {
      afterCheck: "Use the returned incident id as <incident-ARM-id>, then inspect all incident fields before retrying: artium-axi az-axi api GET '<incident-ARM-id>' --api-version 2025-09-01 --full",
    }) }
}

export function createAzAdapter(source: SecretSource, writeLog: string, cache = new AzureTokenCache(),
  profile = loadCredentialProfile('az-axi')): Adapter<AzCredential> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return {
    name: 'az-axi', executable: toolPaths['az-axi'], credentialSchema: azCredentialSchema,
    invalidateCredential: reference => { cache.replace(reference.id, reference.revision!) },
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: azManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {}, sensitiveArguments: args => ({
      flags: [...azManifest.sensitiveFlags.map(name => `--${name}`), '-q'],
      positions: inventory.commands.filter(route => ['rg query', 'graph query', 'logs query', 'monitor log-analytics query'].includes(route.command))
        .flatMap(route => {
          const words = route.command.split(' ')
          const start = args.findIndex((_, index) => words.every((word, offset) => args[index + offset] === word))
          return start < 0 ? [] : args.map((_, index) => index).slice(start + words.length)
        }),
    }),
    validateArgs: (args, input) => { azArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = azArguments(args, input)
      if (reference.tool !== 'az-axi' || !reference.revision) throw new ArtiumError('CREDENTIAL_INVALID')
      if (normalized.write && source.getSettings && !toolAllowsWrites('az-axi', source.getSettings(reference))) {
        throw new ArtiumError('FLAG_BLOCKED')
      }
      const parsed = azCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const { tenantId, clientId, auth, subscriptions, managementGroup, workspaces, description, allowWrites } = parsed.data
      if (normalized.write && allowWrites !== true) throw new ArtiumError('FLAG_BLOCKED')
      const credential = auth === 'secret'
        ? { tenantId, clientId, auth, clientSecret: parsed.data.clientSecret }
        : { tenantId, clientId, auth, privateKey: parsed.data.privateKey, thumbprintSha256: parsed.data.thumbprintSha256 }
      const tokens = await cache.acquire({ id: reference.id, revision: reference.revision, credential,
        trust: source.getTrust?.(reference) }, normalized.resources)
      const holders = Object.fromEntries(Object.keys(tokens).map((resource, index) => [resource, `ARTIUM_SECRET_${index}`]))
      const injection = profile ? profile.prepare('az-axi', Object.fromEntries(Object.entries({
        subscriptions, managementGroup, workspaces, description, allowWrites, auth: 'token', tenantId,
        ...Object.fromEntries(Object.entries(tokens).map(([resource, token]) => [`${resource}Token`, token!.accessToken])),
      }).filter(([, value]) => value !== undefined)), writeLog, allowWrites !== true) : {
        environment: { AZ_AXI_CONFIG: 'az-profile.json', AZ_AXI_WRITE_LOG: writeLog,
          AZ_AXI_READ_ONLY: String(allowWrites !== true),
          ...Object.fromEntries(Object.entries(tokens).map(([resource, token]) => [holders[resource], token!.accessToken])) },
        files: [{ name: 'az-profile.json', content: JSON.stringify({ version: 1, defaultProfile: 'artium', profiles: {
          artium: { subscriptions, managementGroup, workspaces, description, allowWrites, auth: 'token', tenantId,
            ...Object.fromEntries(Object.keys(tokens).map(resource => [`${resource}Token`, { env: holders[resource] }])) },
        } }) }],
      }
      return {
        executable: toolPaths['az-axi'], args: normalized.args, fileArguments: normalized.fileArguments,
        write: normalized.write,
        ...injection,
        secrets: [...new Set([credential.auth === 'secret' ? credential.clientSecret : credential.privateKey,
          ...Object.values(tokens).flatMap(token => token.secrets)])],
        limits: { timeoutMs: runnerLimits.timeoutMs },
      }
    },
  }
}
