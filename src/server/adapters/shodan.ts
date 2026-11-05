import inventory from '../../../tools/inventories/shodan-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'
import { classifyCommand } from './classify.js'
import { verifyShodanPackage } from './shodan-package.js'

export const shodanProfile = new CredentialProfile(inventory.credentialSchema, 'shodan-axi')
export const shodanWritePolicy = writePolicy({ reason: 'Only account reads are available.',
  unlocks: 'No write operations.', blocked: 'Writes and local configuration are unavailable.' })

function argumentsForRead(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['version', '--version', '-v', '-V'].includes(args[0])) {
    return { args: [...args], invocation: { command: 'version', help: false } }
  }
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  const words = firstFlag < 0 ? args : args.slice(0, firstFlag)
  const command = words.join(' ')
  const route = inventory.commands.find(entry => entry.command === command)
  if (!route) throw invalidCommand('shodan-axi', args, inventory.discovery.commands)
  const flags = route.flags as Record<string, string>
  const seen = new Set<string>()
  for (const token of args.slice(firstFlag < 0 ? args.length : firstFlag)) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (match && inventory.adapterBoundary.unsafeOverrides.includes(match[1])) throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(flags, match[1])) throw unknownFlag('shodan-axi', command, token, Object.keys(flags))
    if (seen.has(match[1]) || match[2] !== undefined) throw new ArtiumError('INVALID_INPUT')
    seen.add(match[1])
  }
  return { args: [...args], invocation: { command: command || 'home', help: seen.has('help') } }
}

export function createShodanAdapter(source: SecretSource): Adapter<unknown> {
  return { name: 'shodan-axi', executable: toolPaths['shodan-axi'], credentialProfile: shodanProfile,
    credentialSchema: shodanProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]), positions: [] }),
    classify: (args, input) => classifyCommand(inventory.commands, (a, i) => argumentsForRead(a, i).invocation, args, input),
    validateArgs: (args, input) => { argumentsForRead(args, input) },
    async prepare(args, reference, input) {
      const call = argumentsForRead(args, input)
      if (reference.tool !== 'shodan-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      verifyShodanPackage()
      return { executable: process.execPath, args: [toolPaths['shodan-axi'], ...call.args], invocation: call.invocation,
        effect: 'read', ...shodanProfile.prepare('shodan-axi', await source.getCredential(reference), undefined, true),
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
