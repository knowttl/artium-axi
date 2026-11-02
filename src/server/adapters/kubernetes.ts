import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import inventory from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { writePolicy } from './write-policy.js'

export const kubernetesProfile = new CredentialProfile(inventory.credentialSchema, 'kubernetes-axi')
export const kubernetesReadPolicy = writePolicy({ reason: 'This adapter admits bounded Kubernetes reads and passive authorization reviews.',
  unlocks: 'No write actions.', blocked: 'Mutation workflows, local configuration, execution and streaming sessions are unavailable.' })

interface Invocation {
  native: boolean
  command: { path: string }
  flags: Map<string, string>
  positionals: string[]
  help: boolean
  home: boolean
  workflow?: unknown
}
type Parser = (args: string[]) => Invocation

// Use the pinned native parser for Cobra aliases, flags and raw-route classification.
export async function createKubernetesAdapter(source: SecretSource, executable: string = toolPaths['kubernetes-axi']): Promise<Adapter<unknown>> {
  const parser = existsSync(executable)
    ? (await import(new URL('../dist/grammar.js', pathToFileURL(executable)).href) as { parse: Parser }).parse : undefined
  function readArguments(args: readonly string[], input: RunnerInput = {}) {
    if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
    if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))
      || inventory.adapterBoundary.blockedCommands.includes(args[0] ?? '')
      || args.some((arg, index) => arg === '--' && !(index === 1 && args[0] === 'native'))) throw new ArtiumError('FLAG_BLOCKED')
    if (!parser) throw new ArtiumError('SPAWN_FAILED')
    let parsed: Invocation
    try { parsed = parser([...args]) } catch { throw new ArtiumError('INVALID_INPUT') }
    const command = (parsed.native ? 'native -- ' : '') + (parsed.home ? 'home' : parsed.command.path)
    const route = inventory.commands.find(route => route.command === command)
    if (!route || parsed.workflow) throw new ArtiumError('FLAG_BLOCKED')
    if (parsed.command.path === 'apply view-last-applied' && parsed.positionals.some(value => /^secrets?(?:$|[/.])/i.test(value))) throw new ArtiumError('FLAG_BLOCKED')
    for (const name of parsed.flags.keys()) if (!Object.hasOwn(route.flags, name)) throw new ArtiumError('FLAG_BLOCKED')
    return { args: [...args], invocation: { command, help: parsed.help } }
  }
  return { name: 'kubernetes-axi', executable, credentialProfile: kubernetesProfile,
    credentialSchema: kubernetesProfile.credentialSchema, timeoutMs: inventory.requirements.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { readArguments(args, input) },
    async prepare(args, reference, input) {
      const call = readArguments(args, input)
      if (reference.tool !== 'kubernetes-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const value = await source.getCredential(reference)
      const profile = kubernetesProfile.prepare('kubernetes-axi', value, undefined, true)
      return { ...call, executable: process.execPath, args: [executable, ...call.args], effect: 'read',
        ...profile, limits: { timeoutMs: inventory.requirements.timeoutMs, systemCaBundle: { endpoint: (value as { origin: string }).origin } } }
    } }
}
