import inventory from '../../../tools/inventories/ldap-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { CredentialProfile, loadCredentialProfile } from './credential-profile.js'
import { invalidCommand } from './input-diagnostics.js'

export const ldapManifest = { ...inventory, ...inventory.adapterBoundary }
export const ldapWritePolicy = writePolicy({ reason: 'LDAP has no write path in this adapter.',
  unlocks: 'No write actions.', blocked: 'All write actions remain unavailable.' })
const bundledProfile = new CredentialProfile(inventory.credentialSchema, 'ldap-axi')
export const ldapCredentialSchema = bundledProfile.credentialSchema

function ldapArguments(args: readonly string[], input: RunnerInput = {}): string[] {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  const command = !args.length || args[0].startsWith('-') ? 'home' : args[0] === 'server' ? 'server' : args.slice(0, 2).join(' ')
  const route = inventory.commands.find(route => route.command === command)
  if (!route) {
    if (ldapManifest.blockedCommands.includes(args[0])) throw new ArtiumError('FLAG_BLOCKED', `Command ${args[0]} is unavailable through artium.`)
    throw invalidCommand('ldap-axi', args, inventory.commands.map(route => route.command))
  }
  const flags: Record<string, string | undefined> = route.flags
  const seen = new Set<string>()
  let positionals = 0
  let index = command === 'home' ? 0 : command.split(' ').length
  if (route.positionalInput && args[index] !== undefined && !args[index].startsWith('-')) {
    positionals++
    index++
  }
  const normalized = args.slice(0, index)
  for (; index < args.length; index++) {
    const token = args[index]
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token)
    if (!match) throw new ArtiumError('INVALID_INPUT')
    const [, name, inline] = match
    if (ldapManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(flags, name)) throw new ArtiumError('INVALID_INPUT', `Unknown flag --${name} for ldap-axi ${command}.`,
      `Valid flags: ${Object.keys(flags).filter(flag => !ldapManifest.unsafeOverrides.includes(flag)).map(flag => `--${flag}`).join(', ')}.`)
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    seen.add(name)
    if (flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      normalized.push(token)
    } else {
      const value = inline ?? args[++index]
      if (value === undefined || value.startsWith('-') || value === '' && name !== 'base') throw new ArtiumError('INVALID_INPUT')
      normalized.push(`--${name}`, value)
    }
  }
  if (positionals > Number(route.positionalInput) || route.positionalInput && !seen.has('help') && positionals !== 1) {
    throw new ArtiumError('INVALID_INPUT')
  }
  return normalized
}

export function createLdapAdapter(source: SecretSource,
  profile = loadCredentialProfile('ldap-axi') ?? bundledProfile): Adapter<unknown> {
  return {
    name: 'ldap-axi', executable: toolPaths['ldap-axi'], credentialSchema: profile.credentialSchema, credentialProfile: profile,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: ldapManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: ldapManifest.sensitiveFlags.map(name => `--${name}`),
      positions: /^(entry show|user (show|groups)|group (show|members)|computer show)$/.test(args.slice(0, 2).join(' ')) ? [2] : [] }),
    validateArgs: (args, input) => { ldapArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = ldapArguments(args, input)
      if (reference.tool !== 'ldap-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      return { executable: toolPaths['ldap-axi'], args: normalized,
        ...profile.prepare('ldap-axi', await source.getCredential(reference), undefined, true),
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
