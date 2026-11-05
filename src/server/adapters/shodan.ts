import inventory from '../../../tools/inventories/shodan-axi.json' with { type: 'json' }
import { isIP } from 'node:net'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { decode } from '@toon-format/toon'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'
import { verifyShodanPackage } from './shodan-package.js'
import { classifyCommand } from './classify.js'

export const shodanProfile = new CredentialProfile(inventory.credentialSchema, 'shodan-axi')
const keylessProfile = new CredentialProfile(inventory.credentialSchema)
const ajv = new Ajv2020()
const outputSchemas = new Map(inventory.commands.filter(entry => 'outputSchema' in entry)
  .map(entry => [entry.command || 'home', ajv.compile(entry.outputSchema!)]))
outputSchemas.set('myip --ipv6', ajv.compile(inventory.ipv6Schema))
outputSchemas.set('data list', ajv.compile(inventory.datasetSchemas[0]))
outputSchemas.set('data list --dataset', ajv.compile(inventory.datasetSchemas[1]))
export const shodanWritePolicy = writePolicy({ reason: 'Only reads are available.',
  unlocks: 'No write operations.', blocked: 'Writes and local configuration are unavailable.' })

function argumentsForRead(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['version', '--version', '-v', '-V'].includes(args[0])) {
    return { args: [...args], invocation: { command: 'version', help: false }, operation: undefined }
  }
  const kinds = Object.assign({}, ...inventory.commands.map(entry => entry.flags)) as Record<string, string>
  const words: string[] = []
  const normalized: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { words.push(token); normalized.push(token); continue }
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (match && inventory.adapterBoundary.unsafeOverrides.includes(match[1])) throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(kinds, match[1])) throw unknownFlag('shodan-axi', words.join(' '), token, Object.keys(kinds))
    const [, name, inline] = match
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    seen.add(name)
    normalized.push(`--${name}`)
    if (kinds[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
    } else {
      const value = inline ?? args[++index]
      if (!value || (value.startsWith('-') && !(name === 'limit' && value === '-1'))) throw new ArtiumError('INVALID_INPUT')
      if (name === 'output' && !['json', 'toon'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'format' && !['pretty', 'tsv'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'sort' && !['votes', 'timestamp'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'order' && !['asc', 'desc'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'minify' && !['true', 'false'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'expired' && !['true', 'false'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'dataset' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'limit' && value !== '-1' && (!/^[1-9]\d*$/.test(value) || Number(value) > 1000)) throw new ArtiumError('INVALID_INPUT')
      if (name === 'poll-interval-ms' && (!/^\d+$/.test(value) || Number(value) > 30000)) throw new ArtiumError('INVALID_INPUT')
      const ceiling = { 'max-requests': 1000, 'max-bytes': 10 * 1024 * 1024, timeout: 300000, page: 1000000, size: 1000,
        'poll-attempts': 100 }[name]
      if (ceiling !== undefined && (!/^[1-9]\d*$/.test(value) || Number(value) > ceiling)) throw new ArtiumError('INVALID_INPUT')
      normalized.push(value)
    }
  }
  const route = inventory.commands.filter(entry => {
    const parts = entry.command ? entry.command.split(' ') : []
    return parts.every((part, index) => words[index] === part)
      && (words.length === parts.length + entry.arguments.length || (seen.has('help') && words.length === parts.length))
  }).sort((a, b) => b.command.length - a.command.length)[0]
  if (!route) throw invalidCommand('shodan-axi', args, inventory.discovery.commands)
  const flags = route.flags
  for (const flag of seen) if (!Object.hasOwn(flags, flag)) throw unknownFlag('shodan-axi', route.command, `--${flag}`, Object.keys(flags))
  if (route.operation === 'OP-012') {
    const option = (name: string) => { const index = normalized.indexOf(`--${name}`); return index < 0 ? 1 : Number(normalized[index + 1]) }
    if (option('poll-attempts') > option('max-requests')) throw new ArtiumError('INVALID_INPUT')
  }
  if (route.operation === 'CLI-025') {
    const index = normalized.indexOf('--facets')
    if (index >= 0 && !normalized[index + 1].split(',').every(facet => {
      const [name, limit, extra] = facet.split(':')
      return inventory.publicFacets.includes(name) && extra === undefined && (limit === undefined || /^[1-9]\d*$/.test(limit) && Number(limit) <= 1000)
    })) throw new ArtiumError('INVALID_INPUT')
    const limit = normalized.indexOf('--limit')
    if (limit >= 0 && normalized[limit + 1] === '-1') throw new ArtiumError('INVALID_INPUT')
  }
  const selector = route.arguments.length && words.length > route.command.split(' ').length ? words.at(-1) : undefined
  const selectorKind = route.arguments[0]?.name
  const validDomain = (name: string) => name.length <= 253
    && name.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  if (selector !== undefined && (!selector || selector.length > 4096 || (selectorKind === 'ip' && !isIP(selector))
    || (selectorKind === 'id' && !/^[A-Za-z0-9_-]{1,128}$/.test(selector))
    || (selectorKind === 'ips' && !selector.split(',').every(ip => isIP(ip)))
    || (selectorKind === 'domain' && !validDomain(selector))
    || (selectorKind === 'names' && !selector.split(',').every(validDomain)))) throw new ArtiumError('INVALID_INPUT')
  return { args: normalized, invocation: { command: route.command || 'home', help: seen.has('help') },
    operation: route.operation === 'OP-034' && seen.has('dataset') ? 'OP-035' : route.operation }
}

export function createShodanAdapter(source: SecretSource): Adapter<unknown> {
  return { name: 'shodan-axi', executable: toolPaths['shodan-axi'], credentialProfile: shodanProfile,
    credentialSchema: shodanProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]), positions: args.map((_, index) => index) }),
    classify: (args, input) => classifyCommand(inventory.commands, (a, i) => argumentsForRead(a, i).invocation, args, input),
    validateArgs: (args, input) => { argumentsForRead(args, input) },
    async prepare(args, reference, input) {
      const call = argumentsForRead(args, input)
      if (reference.tool !== 'shodan-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      verifyShodanPackage()
      const profile = call.operation === 'OP-059'
        ? keylessProfile.prepare('shodan-axi', { auth: 'none', origin: 'https://api.shodan.io' }, undefined, true)
        : shodanProfile.prepare('shodan-axi', await source.getCredential(reference), undefined, true)
      const outputCommand = call.invocation.command === 'myip' && call.args.includes('--ipv6') ? 'myip --ipv6'
        : call.operation === 'OP-035' ? 'data list --dataset' : call.invocation.command
      const validateOutput = !call.invocation.help && outputSchemas.get(outputCommand)
      const publicContent = validateOutput ? (stdout: string, stderr: string) => {
        if (!stdout.trim()) return [stdout, stderr]
        const value: unknown = stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : decode(stdout)
        if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'error')) return [stdout, stderr]
        if (!validateOutput(value)) throw new Error('Invalid Shodan output')
        if (outputCommand === 'alert stats' && value !== null && typeof value === 'object' && Object.hasOwn(value, 'saved')) throw new Error('Unexpected file output')
        return [stdout, stderr]
      } : undefined
      return { executable: process.execPath, args: [toolPaths['shodan-axi'], ...call.args], invocation: call.invocation, publicContent,
        effect: 'read', ...profile,
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
