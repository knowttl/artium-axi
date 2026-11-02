import { parseArgs } from 'node:util'
import inventory from '../../../tools/inventories/gitea-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'

export const giteaProfile = new CredentialProfile(inventory.credentialSchema, 'gitea-axi')
export const giteaReadPolicy = writePolicy({ reason: 'This adapter admits classified Gitea reads only.',
  unlocks: 'No write actions.', blocked: 'Writes, local workflows, credential overrides and attachment transfers are unavailable.' })

function readArguments(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) return { args: [...args], invocation: { command: 'version', help: false } }
  const route = [...inventory.commands].sort((a, b) => b.command.length - a.command.length)
    .find(entry => entry.command ? entry.command.split(' ').every((word, index) => args[index] === word) : !args.length || args[0].startsWith('--'))
  if (!route) throw invalidCommand('gitea-axi', args, inventory.discovery.commands)
  const length = route.command ? route.command.split(' ').length : 0
  const flags: Record<string, string | undefined> = route.flags
  const shorts: Record<string, string | undefined> = route.shortFlags
  let parsed
  try {
    const options = Object.fromEntries(Object.entries(flags).map(([name, type]) => {
      const short = Object.entries(shorts).find(([, target]) => target === name)?.[0]
      return [name, { type: type === 'boolean' ? 'boolean' as const : 'string' as const, ...(short ? { short } : {}) }]
    }))
    parsed = parseArgs({ args: args.slice(length).map(arg => {
      const match = /^--([^=]+)=(true|false)$/.exec(arg)
      return match && flags[match[1]] === 'boolean' ? `--${match[1]}` : arg
    }), options, strict: true, allowPositionals: true, tokens: true })
  } catch { throw new ArtiumError('INVALID_INPUT') }
  const names = parsed.tokens.flatMap(token => token.kind === 'option' ? [token.name] : [])
  if (new Set(names).size !== names.length) throw new ArtiumError('INVALID_INPUT')
  const help = parsed.values.help === true && !args.includes('--help=false')
  const positions = parsed.positionals
  const command = route.command || 'dashboard'
  if (!help) {
    if (['issue view', 'pr view', 'pr checks', 'pr diff'].includes(command)) {
      if (positions.length !== 1 || !/^[1-9]\d*$/.test(positions[0])) throw new ArtiumError('INVALID_INPUT')
    } else if (command === 'release view' || command.startsWith('search ') || command === 'org view') {
      if (positions.length !== 1 || !positions[0].trim()) throw new ArtiumError('INVALID_INPUT')
    } else if (command === 'api') {
      if (positions.length !== 1 && !(positions.length === 2 && positions[0] === 'GET')
        || parsed.values.method && (parsed.values.method !== 'GET' || positions.length === 2)) throw new ArtiumError('FLAG_BLOCKED')
      const raw = positions.at(-1)!
      let decoded: string
      try { decoded = decodeURIComponent(raw) } catch { throw new ArtiumError('INVALID_INPUT') }
      if (/^[a-z]+:/i.test(raw) || raw.startsWith('//') || /[\\#\s%]/.test(decoded)
        || /%(?:2f|5c)/i.test(raw.split('?')[0]) || decoded.split(/[/?]/).some(part => part === '.' || part === '..')) throw new ArtiumError('INVALID_INPUT')
      const [pathname, query = ''] = raw.split('?')
      if ([...new URLSearchParams(query).keys()].some(key => /token|secret|password|authorization|api.?key/i.test(key))) throw new ArtiumError('FLAG_BLOCKED')
      const path = pathname.startsWith('/api/v1/') || pathname === '/swagger.v1.json' ? pathname : '/api/v1/' + pathname.replace(/^\//, '')
      const routes = [...inventory.apiRoutes].sort((a, b) => b.path.replace(/\{[^}]+\}/g, '').length - a.path.replace(/\{[^}]+\}/g, '').length)
      const match = routes.find(entry => entry.method === 'GET' && new RegExp('^' + entry.path.split(/(\{[^}]+\})/)
        .map(part => /^\{[^}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$').test(path))
      if (path !== '/swagger.v1.json' && match?.effect !== 'read') throw new ArtiumError('FLAG_BLOCKED')
    } else if (positions.length) throw new ArtiumError('INVALID_INPUT')
  }
  return { args: [...args], invocation: { command: command === 'dashboard' ? 'home' : command, help } }
}

export function createGiteaAdapter(source: SecretSource): Adapter<unknown> {
  return { name: 'gitea-axi', executable: toolPaths['gitea-axi'], credentialProfile: giteaProfile,
    credentialSchema: giteaProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { readArguments(args, input) },
    async prepare(args, reference, input) {
      const call = readArguments(args, input)
      if (reference.tool !== 'gitea-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      return { ...call, executable: process.execPath, args: [toolPaths['gitea-axi'], ...call.args], effect: 'read',
        ...giteaProfile.prepare('gitea-axi', await source.getCredential(reference), undefined, true), limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
