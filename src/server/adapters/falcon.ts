import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import inventory from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { falconRtrSettingsSchema } from '../../shared/api.js'
import { writePolicy } from './write-policy.js'
import { toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { loadCredentialProfile } from './credential-profile.js'

export const falconManifest = inventory
const falconLimits = { runtime: 'python' as const, timeoutMs: inventory.requirements.timeoutMs, terminationGraceMs: 12_000 }
const capabilityPolicy = writePolicy({
  supportedOperations: ['rtr run', 'malquery search'],
  unlocks: 'RTR read-only command execution and MalQuery exact/fuzzy search (MalQuery:write)',
  blocked: 'Host changes, scripts, hunt and file transfers remain unavailable. Profile RTR opt-in, command restrictions and exact execution confirmation still apply.' })
function capabilitySettings(settings: Record<string, unknown>) {
  return settings?.writes ? settings : { writes: { allowWrites: settings?.allowWrites === true,
    operations: typeof settings?.allowWrites === 'boolean' ? ['rtr run'] : [] } }
}
export const falconWritePolicy = {
  read: (settings: Record<string, unknown>) => capabilityPolicy.read(capabilitySettings(settings)),
  update(settings: Record<string, unknown>, input: Parameters<typeof capabilityPolicy.update>[1]) {
    const { allowWrites: _, ...updated } = { ...settings, ...capabilityPolicy.update(capabilitySettings(settings), input) }
    return updated
  },
}
export const falconCredentialFiles = z.object({
  clientIdFile: z.string().min(1),
  clientSecretFile: z.string().min(1),
  region: z.string().min(1),
  memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredentialFiles = z.infer<typeof falconCredentialFiles>

export const falconCredentialSchema = z.object({
  allowWrites: z.boolean().optional(),
  writes: z.strictObject({ allowWrites: z.boolean(), operations: z.array(z.enum(['rtr run', 'malquery search'])).min(1) }).optional(),
  rtr: falconRtrSettingsSchema.optional(),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  region: z.string().min(1),
  memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredential = z.infer<typeof falconCredentialSchema>

function allowsCall(args: readonly string[], credential: Record<string, unknown>) {
  const access = falconWritePolicy.read(credential)
  return access.enabled && access.allowedOperations.includes(args[0] === 'malquery' && args[1] === 'search' ? 'malquery search' : 'rtr run')
}

function prepareCredential(args: readonly string[], credential: FalconCredential) {
  const { clientId, clientSecret, region, memberCid } = credential
  const group = args.slice(0, -1).join(' ')
  // Group help must end at --help and never resolves connection settings upstream.
  const groupHelp = args.at(-1) === '--help' && inventory.commands.some(route => route.command.startsWith(group + ' '))
  const environment: Record<string, string> = credential.rtr
    ? { ARTIUM_SECRET_0: clientSecret }
    : { FALCON_AXI_CLIENT_ID: clientId, FALCON_AXI_CLIENT_SECRET: clientSecret }
  environment.FALCON_AXI_READ_ONLY = String(!allowsCall(args, credential))
  return {
    executable: toolPaths['falcon-axi'],
    args: groupHelp ? [...args] : [...args, '--region', region, ...(memberCid ? ['--member-cid', memberCid] : [])],
    environment,
    secrets: [clientId, clientSecret],
    limits: falconLimits,
  }
}

export function createFalconAdapter(source: SecretSource, writeLog = '/data/tool-logs/falcon-axi/writes.log',
  profile = loadCredentialProfile('falcon-axi')): Adapter<unknown> {
  return {
    name: 'falcon-axi',
    executable: toolPaths['falcon-axi'],
    credentialSchema: profile?.credentialSchema ?? falconCredentialSchema,
    credentialProfile: profile,
    timeoutMs: inventory.requirements.timeoutMs,
    blockedFlags: inventory.unsafeOverrides.map(flag => `--${flag}`),
    allowedFlagValues: {},
    sensitiveArguments: () => ({ flags: ['--client-id', '--client-secret'], positions: [] }),
    validateArgs: validateFalconArgs,
    async prepare(args, reference) {
      validateFalconArgs(args)
      if (reference.tool !== 'falcon-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const value = await source.getCredential(reference)
      const effect = args[0] === 'malquery' && args[1] === 'search' || args.some(token => token === '--execute' || token.startsWith('--execute=')) ? 'write' : 'read'
      if (profile) {
        return { executable: toolPaths['falcon-axi'], args: [...args], limits: falconLimits, effect,
          ...profile.prepare('falcon-axi', value, writeLog, !allowsCall(args, value as Record<string, unknown>)) }
      }
      const parsed = falconCredentialSchema.safeParse(value)
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const { rtr, region, memberCid } = parsed.data
      const prepared = prepareCredential(args, parsed.data)
      return { ...prepared, effect, environment: { ...prepared.environment, FALCON_AXI_WRITE_LOG: writeLog }, files: rtr ? [{ name: 'falcon-axi/config.json', content: JSON.stringify({
        version: 1, defaultProfile: 'artium', profiles: { artium: { clientId: parsed.data.clientId,
          clientSecret: { env: 'ARTIUM_SECRET_0' }, region, memberCid, rtr } },
      }) }] : [] }
    },
  }
}

export function validateFalconArgs(args: readonly string[]): void {
  const command = args.slice(0, 2).join(' ')
  if (inventory.blockedCommands.includes(args[0]) || inventory.blockedCommands.includes(command)) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  // The pinned parser has no aliases and no double-dash delimiter. Repeats cannot clear a refusal.
  for (const token of args) {
    if (token === '--' || (token.startsWith('--') && inventory.unsafeOverrides.includes(token.slice(2).split('=')[0]))) {
      throw new ArtiumError('FLAG_BLOCKED')
    }
  }
}

export async function prepareFalcon(args: readonly string[], configuration: FalconCredentialFiles) {
  validateFalconArgs(args)
  const parsed = falconCredentialFiles.safeParse(configuration)
  if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
  const { clientIdFile, clientSecretFile, region, memberCid } = parsed.data
  const [clientId, clientSecret] = await Promise.all([readFile(clientIdFile, 'utf8'), readFile(clientSecretFile, 'utf8')])
    .then(values => values.map(value => value.trim()))
    .catch(() => { throw new ArtiumError('CREDENTIAL_INVALID') })
  if (!clientId || !clientSecret) throw new ArtiumError('CREDENTIAL_INVALID')
  return prepareCredential(args, { clientId, clientSecret, region, memberCid })
}
