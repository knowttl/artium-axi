import { isAbsolute } from 'node:path'
import { z } from 'zod'
import inventory from '../../../tools/inventories/mg-axi.json' with { type: 'json' }
import { nativeSettingsSchemas } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { loadCredentialProfile, withCredentialProfile } from './credential-profile.js'

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
const guid = z.string().regex(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/)
const common = { tenantId: guid, clientId: guid, ...nativeSettingsSchemas['mg-axi'].shape }
export const mgCredentialSchema = z.discriminatedUnion('auth', [
  z.strictObject({ ...common, auth: z.literal('secret'), clientSecret: nonempty }),
  z.strictObject({ ...common, auth: z.literal('certificate'), privateKey: nonempty,
    thumbprint: z.string().regex(/^[a-fA-F0-9]{40}$/) }),
])
export type MgCredential = z.infer<typeof mgCredentialSchema>
export const mgManifest = { ...inventory, ...inventory.adapterBoundary }

function mgArguments(args: readonly string[], input: RunnerInput = {}): string[] {
  if (input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--help', '--version', '-v', '-V'].includes(args[0])) {
    if (input.stdin !== undefined) throw new ArtiumError('UNSUPPORTED_INPUT')
    return [...args]
  }
  const words = args.slice(0, args.findIndex(arg => arg.startsWith('-')) < 0
    ? args.length : args.findIndex(arg => arg.startsWith('-')))
  const route = inventory.commands.find(route => route.command === (words.join(' ') || 'home'))
    ?? (words.length === 3 && words[0] === 'api' && words[1] === 'get'
      ? inventory.commands.find(route => route.command === 'api get') : undefined)
  if (!route || !mgManifest.allowedCommands.some(command => route.command === command || route.command.startsWith(`${command} `))) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  const schema: Record<string, string | undefined> = route.flags
  const flags: Record<string, string | boolean> = Object.create(null)
  for (let index = words.length; index < args.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[index])
    if (!match) throw new ArtiumError('INVALID_INPUT')
    const [, name, inline] = match
    if (mgManifest.unsafeOverrides.includes(name)) throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(schema, name) || Object.hasOwn(flags, name)) throw new ArtiumError('INVALID_INPUT')
    if (schema[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      flags[name] = true
    } else {
      const value = inline ?? args[++index]
      if (!value?.trim() || value.startsWith('-') && !(name === 'cursor' && value === '-')) throw new ArtiumError('INVALID_INPUT')
      flags[name] = value
    }
  }
  if (input.stdin !== undefined && flags.cursor !== '-') throw new ArtiumError('UNSUPPORTED_INPUT')
  return [...args]
}

export function createMgAdapter(source: SecretSource, writeLog: string,
  profile = loadCredentialProfile('mg-axi')): Adapter<unknown> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return withCredentialProfile({
    name: 'mg-axi', executable: toolPaths['mg-axi'], credentialSchema: mgCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: mgManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {}, sensitiveArguments: () => ({ flags: mgManifest.sensitiveFlags.map(name => `--${name}`), positions: [] }),
    validateArgs: (args, input) => { mgArguments(args, input) },
    async prepare(args, reference, input) {
      const normalized = mgArguments(args, input)
      if (reference.tool !== 'mg-axi' || !reference.revision) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const parsed = mgCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
      const credential = parsed.data
      const { tenantId, clientId, preview = false, writes } = credential
      const secret = credential.auth === 'secret' ? credential.clientSecret : credential.privateKey
      const holder = 'ARTIUM_SECRET_0'
      const credentialRef = credential.auth === 'secret'
        ? { provider: 'client-secret', key: clientId, secretEnv: holder }
        : { provider: 'certificate', key: clientId, thumbprint: credential.thumbprint.toLowerCase(), keyEnv: holder }
      return {
        executable: toolPaths['mg-axi'], args: normalized,
        environment: { MG_AXI_CONFIG: 'mg-profile.json', MG_AXI_WRITE_LOG: writeLog, [holder]: secret },
        files: [{ name: 'mg-profile.json', content: JSON.stringify({ version: 1, defaultProfile: 'artium', profiles: {
          artium: { mode: 'application', tenantId, clientId, cloud: 'commercial', preview,
            allowDeviceCode: false, enabledPacks: ['entra'], sensitiveAreas: [], credentialRef,
            ...(writes === undefined ? {} : { writes }) },
        } }) }],
        secrets: [...new Set([secret, credential.auth === 'secret' ? secret.trim()
          : secret.includes('\n') ? secret : secret.replace(/\\n/g, '\n')])],
        limits: { timeoutMs: runnerLimits.timeoutMs, nodeHeapMiB: 512 },
      }
    },
  }, source, writeLog, profile, (args, input) => ({ args: mgArguments(args, input) }),
  { timeoutMs: runnerLimits.timeoutMs, nodeHeapMiB: 512 })
}
