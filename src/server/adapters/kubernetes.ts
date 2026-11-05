import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import inventory from '../../../tools/inventories/kubernetes-axi.json' with { type: 'json' }
import { classifyCommand } from './classify.js'
import { ArtiumError } from '../../shared/errors.js'
import { kubernetesHostedRoutes, resolveKubernetesHostedCommand } from '../../shared/kubernetes.js'
import { toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { writePolicy } from './write-policy.js'

export const kubernetesProfile = new CredentialProfile(inventory.credentialSchema, 'kubernetes-axi')
export const kubernetesWritePolicy = writePolicy({
  unlocks: 'Prepare resource mutations, inspect saved previews, confirm exact digests and explicitly request server dry run. Bounded byte operations additionally require explicit per-caller session-kind grants in advanced native settings.',
  blocked: 'Bulk deletion additionally requires collectionDelete=true; service-account token issuance requires acquireCredential=true and private-pipe delivery. Use owned workspaces for file input and explicitly granted sessions for bounded execution, copy and authenticated port forwarding. Direct mutations, local configuration and interactive execution remain unavailable.' })

interface Invocation {
  native: boolean
  command: { path: string }
  flags: Map<string, string>
  positionals: string[]
  help: boolean
  home: boolean
  workflow?: { kind: 'prepare' | 'preview' | 'confirm' | 'server-dry-run' }
}
type Parser = (args: string[]) => Invocation

// Use the pinned native parser for Cobra aliases, flags and raw-route classification.
export async function createKubernetesAdapter(source: SecretSource, executable: string = toolPaths['kubernetes-axi'], workflowRoot?: string): Promise<Adapter<unknown>> {
  const parser = existsSync(executable)
    ? (await import(new URL('../dist/grammar.js', pathToFileURL(executable)).href) as { parse: Parser }).parse : undefined
  function argumentsForCall(args: readonly string[], input: RunnerInput = {}) {
    if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
    if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))
      || inventory.adapterBoundary.blockedCommands.includes(args[0] ?? '')
      || args.some((arg, index) => arg === '--' && !(index === 1 && ['native', 'prepare', 'server-dry-run'].includes(args[0])))) throw new ArtiumError('FLAG_BLOCKED')
    if (!parser) throw new ArtiumError('SPAWN_FAILED')
    let parsed: Invocation
    // Native parsing consults this switch synchronously; dispatch uses its own child environment.
    const previous = process.env.KUBERNETES_AXI_READ_ONLY, previousAcquisition = process.env.KUBERNETES_AXI_ACQUIRE_CREDENTIAL
    try { process.env.KUBERNETES_AXI_READ_ONLY = 'false'; process.env.KUBERNETES_AXI_ACQUIRE_CREDENTIAL = 'true'; parsed = parser([...args]) }
    catch { throw new ArtiumError('INVALID_INPUT') }
    finally {
      if (previous === undefined) delete process.env.KUBERNETES_AXI_READ_ONLY
      else process.env.KUBERNETES_AXI_READ_ONLY = previous
      if (previousAcquisition === undefined) delete process.env.KUBERNETES_AXI_ACQUIRE_CREDENTIAL
      else process.env.KUBERNETES_AXI_ACQUIRE_CREDENTIAL = previousAcquisition
    }
    const command = (parsed.native ? 'native -- ' : '') + (parsed.home ? 'home' : parsed.command.path)
    const workflow = parsed.workflow?.kind
    const workflowHelp = parsed.help && inventory.workflows.some(workflow => workflow.command === parsed.command.path)
    const route = workflow === 'prepare' || workflow === 'server-dry-run'
      ? inventory.writeCommands.find(route => route.command === parsed.command.path)
      : workflow === 'confirm' ? { flags: { digest: 'value' } }
        : workflow || workflowHelp ? { flags: {} } : inventory.commands.find(route => route.command === command)
    if (!route) throw new ArtiumError('FLAG_BLOCKED')
    if ((parsed.command.path === 'describe' || parsed.command.path === 'apply view-last-applied' || parsed.native && parsed.command.path === 'get')
      && parsed.positionals.some((value, index) => value.split(',').some(resource => (index === 0 || resource.includes('/'))
        && /^secrets?(?:$|[/.])/i.test(resource)))) throw new ArtiumError('FLAG_BLOCKED')
    for (const name of parsed.flags.keys()) if (!Object.hasOwn(route.flags, name)) throw new ArtiumError('FLAG_BLOCKED')
    const invocation = { command: workflow === 'prepare' || workflow === 'server-dry-run'
      ? `${workflow} -- ${parsed.command.path}` : workflow ?? command, help: parsed.help }
    return { args: [...args], invocation, workflow: parsed.help ? undefined : workflow, acquisition: parsed.command.path === 'create token' && !parsed.help }
  }
  return { name: 'kubernetes-axi', executable, credentialProfile: kubernetesProfile,
    credentialSchema: kubernetesProfile.credentialSchema, timeoutMs: inventory.requirements.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    validateArgs: (args, input) => { argumentsForCall(args, input) },
    classify(args, input) {
      const routes = [...inventory.commands, ...inventory.writeCommands, ...inventory.workflows.map(route => ({ ...route, effect: 'write' })), ...kubernetesHostedRoutes]
      return classifyCommand(routes, (a, i) => {
        const command = resolveKubernetesHostedCommand(a)
        return command ? { command, help: ['workspace', 'session'].includes(command) } : argumentsForCall(a, i).invocation
      }, args, input)
    },
    async prepare(args, reference, input) {
      const { workflow, acquisition, ...call } = argumentsForCall(args, input)
      if (reference.tool !== 'kubernetes-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? {}
      const writable = workflow && workflow !== 'preview'
      if (writable && !kubernetesWritePolicy.read(settings).enabled) throw new ArtiumError('FLAG_BLOCKED')
      if (acquisition && settings.acquireCredential !== true) throw new ArtiumError('FLAG_BLOCKED')
      if (workflow && !workflowRoot) throw new ArtiumError('TEMP_UNAVAILABLE')
      const value = await source.getCredential(reference)
      const profile = kubernetesProfile.prepare('kubernetes-axi', value, undefined, !writable)
      return { ...call, executable: process.execPath, args: [executable, ...call.args],
        effect: workflow === 'confirm' || workflow === 'server-dry-run' ? 'write' : 'read',
        ...(workflow ? { kubernetesWorkflowRoot: workflowRoot } : {}),
        ...(workflow === 'confirm' && settings.acquireCredential === true ? { protectedResult: {
          source: 'pipe' as const, operation: 'token-create', flag: '--credential-fd', argumentIndex: 1,
        } } : {}),
        ...profile, environment: { ...profile.environment,
          KUBERNETES_AXI_ACQUIRE_CREDENTIAL: String(Boolean(writable && settings.acquireCredential === true)),
          KUBERNETES_AXI_COLLECTION_DELETE: String(Boolean(writable && settings.collectionDelete === true)) },
        limits: { timeoutMs: inventory.requirements.timeoutMs, systemCaBundle: { endpoint: (value as { origin: string }).origin } } }
    } }
}
