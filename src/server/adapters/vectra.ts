import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { nativeSettingsSchemas } from '../../shared/api.js'
import inventory from '../../../tools/inventories/vectra-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { loadCredentialProfile, withCredentialProfile } from './credential-profile.js'

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
const common = {
  origin: z.string().refine(value => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && value === url.origin && !url.username && !url.password
    } catch { return false }
  }),
  caBundle: nonempty.optional(),
  writes: nativeSettingsSchemas['vectra-axi'].shape.writes,
}
const clientId = nonempty.refine(value => !/[:\s]/.test(value))
export const vectraCredentialSchema = z.union([
  z.object({ ...common, kind: z.literal('qux'), apiVersion: z.literal('2.5'),
    applianceRelease: nonempty.optional(), auth: z.literal('token'), token: nonempty.refine(value => !/\s/.test(value)) }).strict(),
  z.object({ ...common, kind: z.literal('qux'), apiVersion: z.literal('2.5'),
    applianceRelease: nonempty.optional(), auth: z.literal('oauth'), clientId, clientSecret: nonempty }).strict(),
  z.object({ ...common, kind: z.literal('rux'), apiVersion: z.literal('3.4'),
    auth: z.literal('oauth'), clientId, clientSecret: nonempty }).strict(),
])
export type VectraCredential = z.infer<typeof vectraCredentialSchema>

export const vectraManifest = {
  ...inventory,
  ...inventory.adapterBoundary,
}

// Normalize reviewed file flags so the runner can replace only uploaded leaf names.
function vectraArguments(args: readonly string[], input: RunnerInput = {}) {
  if (vectraManifest.blockedCommands.includes(args[0])) throw new ArtiumError('FLAG_BLOCKED')
  const normalized: string[] = []
  const fileArguments: number[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    const name = token.startsWith('--') ? token.slice(2).split('=')[0] : ''
    if (token === '--' || vectraManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (vectraManifest.inputFileFlags.includes(name)) {
      const equals = token.indexOf('=')
      const value = equals === -1 ? args[++index] : token.slice(equals + 1)
      if (!value || (value !== '-' && !input.files?.some(file => file.name === value))) {
        throw new ArtiumError('UNSUPPORTED_INPUT')
      }
      normalized.push(`--${name}`, value)
      if (value !== '-') fileArguments.push(normalized.length - 1)
    } else normalized.push(token)
  }
  return { args: normalized, fileArguments }
}

export function createVectraAdapter(source: SecretSource, writeLog: string,
  profile = loadCredentialProfile('vectra-axi')): Adapter<unknown> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return withCredentialProfile({
    name: 'vectra-axi', executable: toolPaths['vectra-axi'], credentialSchema: vectraCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: vectraManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {}, sensitiveArguments: () => ({ flags: ['--note'], positions: [] }),
    validateArgs: (args, input) => { vectraArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = vectraArguments(args, input)
      if (reference.tool !== 'vectra-axi') throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const parsed = vectraCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const { caBundle, ...credential } = parsed.data
      const { token, ...tokenProfile } = credential.auth === 'token' ? credential : { token: undefined }
      const { clientSecret, ...oauthProfile } = credential.auth === 'oauth' ? credential : { clientSecret: undefined }
      const profile = credential.auth === 'token'
        ? { ...tokenProfile, tokenEnv: 'ARTIUM_SECRET_0' }
        : { ...oauthProfile, secretEnv: 'ARTIUM_SECRET_0' }
      return {
        executable: toolPaths['vectra-axi'], ...normalized,
        environment: { VECTRA_AXI_CONFIG: 'vectra-profile.json', VECTRA_AXI_WRITE_LOG: writeLog,
          ARTIUM_SECRET_0: credential.auth === 'token' ? token! : clientSecret! },
        files: [{ name: 'vectra-profile.json', content: JSON.stringify({ defaultProfile: 'artium',
          profiles: { artium: { ...profile, ...(caBundle ? { caBundle: 'vectra-ca.pem' } : {}) } } }) },
        ...(caBundle ? [{ name: 'vectra-ca.pem', content: caBundle }] : [])],
        secrets: credential.auth === 'token' ? [token!] : [clientSecret!, credential.clientId,
          Buffer.from(`${credential.clientId}:${clientSecret}`).toString('base64')],
        limits: { timeoutMs: runnerLimits.timeoutMs },
      }
    },
  }, source, writeLog, profile, vectraArguments)
}
