import inventory from '../../../tools/inventories/technitium-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'

export const technitiumProfile = new CredentialProfile(inventory.credentialSchema, 'technitium-axi')
export const technitiumWritePolicy = writePolicy({ reason: 'Artium currently admits Technitium reads only.',
  unlocks: 'No host-admitted write operations.', blocked: 'Native mutations await separate admission; local configuration is unavailable.' })

function argumentsForRead(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    return { args: [...args], invocation: { command: 'version', help: false }, operation: undefined, resultSource: undefined }
  }
  const firstFlag = args.findIndex(arg => arg.startsWith('-'))
  const words = firstFlag < 0 ? args : args.slice(0, firstFlag)
  const command = words.join(' ')
  const route = inventory.commands.find(entry => entry.command === command)
  if (!route) throw invalidCommand('technitium-axi', args, inventory.discovery.commands)
  const flags = route.flags as Record<string, string | undefined>
  const seen = new Set<string>()
  const normalized = [...words]
  for (let index = firstFlag < 0 ? args.length : firstFlag; index < args.length; index++) {
    const token = args[index]
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (match && inventory.adapterBoundary.unsafeOverrides.includes(match[1])) throw new ArtiumError('FLAG_BLOCKED')
    if (!match || !Object.hasOwn(flags, match[1])) throw unknownFlag('technitium-axi', command, token, Object.keys(flags))
    const [, name, inline] = match
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    seen.add(name)
    normalized.push(`--${name}`)
    if (flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
    } else {
      const value = inline ?? args[++index]
      if (value === undefined || (value === '' && name !== 'include-zones') || value.startsWith('-')) throw new ArtiumError('INVALID_INPUT')
      normalized.push(value)
    }
  }
  return { args: normalized, invocation: { command: command || 'home', help: seen.has('help') },
    operation: seen.has('help') ? undefined : route.operation, resultSource: route.resultSource }
}

export function createTechnitiumAdapter(source: SecretSource): Adapter<unknown> {
  return { name: 'technitium-axi', executable: toolPaths['technitium-axi'], credentialProfile: technitiumProfile,
    credentialSchema: technitiumProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]), positions: [] }),
    validateArgs: (args, input) => { argumentsForRead(args, input) },
    async prepare(args, reference, input) {
      const call = argumentsForRead(args, input)
      if (reference.tool !== 'technitium-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      return { executable: process.execPath, args: [toolPaths['technitium-axi'], ...call.args], invocation: call.invocation,
        effect: 'read', protectedResult: call.operation && call.operation !== 'OP-001'
          ? call.resultSource === 'file'
            ? { source: 'file', name: 'technitium-result.bin', flag: '--result-file', operation: call.operation }
            : { source: 'projection', operation: call.operation } : undefined,
        ...technitiumProfile.prepare('technitium-axi', await source.getCredential(reference), undefined, true),
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
