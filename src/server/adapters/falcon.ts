import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import inventory from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { falconRtrSettingsSchema } from '../../shared/api.js'
import { writePolicy } from './write-policy.js'
import { toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { loadCredentialProfile, withCredentialProfile } from './credential-profile.js'

export const falconManifest = inventory
const falconLimits = { runtime: 'python' as const, timeoutMs: inventory.requirements.timeoutMs, terminationGraceMs: 12_000 }
export const falconWritePolicy = writePolicy({
  unlocks: 'RTR read-only command execution',
  blocked: 'Host changes, scripts and file transfers remain unavailable. Profile RTR opt-in, command restrictions and exact execution confirmation still apply.' })
export const falconCredentialFiles = z.object({
  clientIdFile: z.string().min(1),
  clientSecretFile: z.string().min(1),
  region: z.string().min(1),
  memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredentialFiles = z.infer<typeof falconCredentialFiles>

export const falconCredentialSchema = z.object({
  allowWrites: z.boolean().optional(),
  rtr: falconRtrSettingsSchema.optional(),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  region: z.string().min(1),
  memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredential = z.infer<typeof falconCredentialSchema>

function prepareCredential(args: readonly string[], credential: FalconCredential) {
  const { clientId, clientSecret, region, memberCid } = credential
  const group = args.slice(0, -1).join(' ')
  // Group help must end at --help and never resolves connection settings upstream.
  const groupHelp = args.at(-1) === '--help' && inventory.commands.some(route => route.command.startsWith(group + ' '))
  const environment: Record<string, string> = credential.rtr
    ? { ARTIUM_SECRET_0: clientSecret }
    : { FALCON_AXI_CLIENT_ID: clientId, FALCON_AXI_CLIENT_SECRET: clientSecret }
  environment.FALCON_AXI_READ_ONLY = String(credential.allowWrites !== true)
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
  const adapter = withCredentialProfile({
    name: 'falcon-axi',
    executable: toolPaths['falcon-axi'],
    credentialSchema: falconCredentialSchema,
    timeoutMs: inventory.requirements.timeoutMs,
    blockedFlags: inventory.unsafeOverrides.map(flag => `--${flag}`),
    allowedFlagValues: {},
    sensitiveArguments: () => ({ flags: ['--client-id', '--client-secret'], positions: [] }),
    validateArgs: validateFalconArgs,
    async prepare(args, reference) {
      validateFalconArgs(args)
      if (reference.tool !== 'falcon-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = falconCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const { rtr, region, memberCid } = parsed.data
      const prepared = prepareCredential(args, parsed.data)
      return { ...prepared, environment: { ...prepared.environment, FALCON_AXI_WRITE_LOG: writeLog }, files: rtr ? [{ name: 'falcon-axi/config.json', content: JSON.stringify({
        version: 1, defaultProfile: 'artium', profiles: { artium: { clientId: parsed.data.clientId,
          clientSecret: { env: 'ARTIUM_SECRET_0' }, region, memberCid, rtr } },
      }) }] : [] }
    },
  }, source, writeLog, profile, args => ({ args: [...args] }),
  falconLimits)
  return { ...adapter, async prepare(...input) {
    const prepared = await adapter.prepare(...input)
    return { ...prepared, effect: input[0].some(token => token === '--execute' || token.startsWith('--execute=')) ? 'write' : 'read' }
  } }
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
