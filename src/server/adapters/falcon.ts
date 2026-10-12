import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import inventory from '../../../tools/inventories/falcon-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { loadCredentialProfile, withCredentialProfile } from './credential-profile.js'

export const falconManifest = inventory
export const falconCredentialFiles = z.object({
  clientIdFile: z.string().min(1),
  clientSecretFile: z.string().min(1),
  region: z.string().min(1),
  memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredentialFiles = z.infer<typeof falconCredentialFiles>

export const falconCredentialSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  region: z.string().min(1),
  memberCid: z.string().min(1).optional(),
}).strict()
export type FalconCredential = z.infer<typeof falconCredentialSchema>

function prepareCredential(args: readonly string[], credential: FalconCredential) {
  const { clientId, clientSecret, region, memberCid } = credential
  return {
    executable: toolPaths['falcon-axi'],
    args: [...args, '--region', region, ...(memberCid ? ['--member-cid', memberCid] : [])],
    environment: { FALCON_CLIENT_ID: clientId, FALCON_CLIENT_SECRET: clientSecret },
    secrets: [clientId, clientSecret],
    limits: { runtime: 'python' as const, timeoutMs: inventory.requirements.timeoutMs },
  }
}

export function createFalconAdapter(source: SecretSource, writeLog = '/data/tool-logs/falcon-axi/writes.log',
  profile = loadCredentialProfile('falcon-axi')): Adapter<unknown> {
  return withCredentialProfile({
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
      if (reference.tool !== 'falcon-axi') throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const parsed = falconCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      return { ...prepareCredential(args, parsed.data), files: [] }
    },
  }, source, writeLog, profile, args => ({ args: [...args] }),
  { runtime: 'python', timeoutMs: inventory.requirements.timeoutMs })
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
  if (!parsed.success) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
  const { clientIdFile, clientSecretFile, region, memberCid } = parsed.data
  const [clientId, clientSecret] = await Promise.all([readFile(clientIdFile, 'utf8'), readFile(clientSecretFile, 'utf8')])
    .then(values => values.map(value => value.trim()))
    .catch(() => { throw new ArtiumError('CREDENTIAL_UNAVAILABLE') })
  if (!clientId || !clientSecret) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
  return prepareCredential(args, { clientId, clientSecret, region, memberCid })
}
