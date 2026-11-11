import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { nativeSettingsSchemas } from '../../shared/api.js'
import inventory from '../../../tools/inventories/vectra-axi.json' with { type: 'json' }
import { classifyCommand } from './classify.js'
import { vectraReadCommands } from './reviewed-reads.js'
import { ArtiumError } from '../../shared/errors.js'
import { writePolicy } from './write-policy.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import type { Adapter } from './types.js'
import { isCanonicalHttpsOrigin, loadCredentialProfile, withCredentialProfile } from './credential-profile.js'

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
const common = {
  origin: z.string().refine(isCanonicalHttpsOrigin),
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

export const vectraWritePolicy = writePolicy({ supportedOperations: inventory.nativeWriteSettings.supportedOperations,
  unlocks: 'Selected detection, entity, tag, note, assignment, triage, group, proxy, threat-feed, network, export, notification and Match writes supported by the configured QUX or RUX deployment; native preview, --execute and exact --confirm gates still apply. Warning: host/account close closes all active detections with no single inverse; assignment resolve is permanent; group delete orphans triage rule references; syslog/Kafka redirects detection export (data egress); Match enablement changes cause a reboot.',
  blocked: 'Operations outside the allow-list, unsupported deployment or API operations, user, role, API-client and credential administration, raw API mutations and unsafe overrides remain blocked. Upstream permissions are still required.' })
export const vectraManifest = {
  ...inventory,
  ...inventory.adapterBoundary,
}

function vectraOperationAccepts(command: string, operation: string, args?: readonly string[]): boolean {
  const has = (flag: string) => !!args?.some(arg => arg === `--${flag}` || arg.startsWith(`--${flag}=`))
  const entity = !args ? '(?:host|account)' : has('account') ? 'account' : 'host'
  const verbs = !args ? 'create|reassign|unassign' : has('unassign') ? 'unassign' : 'create|reassign'
  if (command === 'assignment set') return new RegExp(`^${entity}\\.assignment\\.(?:${verbs})$`).test(operation)
  if (command === 'assignment resolve') return new RegExp(`^${entity}\\.assignment\\.resolve$`).test(operation)
  if (command === 'group member add' || command === 'group member remove') return operation === 'group.member.set'
  if (/^detection (?:close|open)$/.test(command)) return (!args || !has('ids')) && operation === command.replace(' ', '.')
    || (!args || has('ids')) && operation === `${command.replace(' ', '.')}-bulk`
  return operation === command.replace(/^(assignment outcome|triage rule|notification destination) /, (_, noun: string) => `${noun.replace(' ', '-')}.`).replaceAll(' ', '.')
}

// Normalize reviewed file flags so the runner can replace only uploaded leaf names.
function vectraArguments(args: readonly string[], input: RunnerInput = {}) {
  if (vectraManifest.blockedCommands.includes(args[0])) throw new ArtiumError('FLAG_BLOCKED')
  const normalized: string[] = []
  const fileArguments: number[] = []
  const command = !args.length || args[0].startsWith('-') ? 'home' : [...inventory.commands]
    .sort((a, b) => b.command.length - a.command.length)
    .find(route => route.command.split(' ').every((word, index) => args[index] === word))?.command ?? args[0]
  let help = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    const name = token.startsWith('--') ? token.slice(2).split('=')[0] : ''
    if (name === 'help') help = true
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
  return { args: normalized, fileArguments, invocation: { command, help },
    effect: !help && args.some(arg => arg === '--execute' || arg.startsWith('--execute=')) ? 'write' as const : 'read' as const }
}

export function createVectraAdapter(source: SecretSource, writeLog: string,
  profile = loadCredentialProfile('vectra-axi')): Adapter<unknown> {
  if (!isAbsolute(writeLog)) throw new TypeError('Native write log path must be absolute')
  return withCredentialProfile({
    name: 'vectra-axi', executable: toolPaths['vectra-axi'], credentialSchema: vectraCredentialSchema,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: vectraManifest.unsafeOverrides.map(name => `--${name}`),
    allowedFlagValues: {}, sensitiveArguments: () => ({ flags: ['--note'], positions: [] }),
    validateArgs: (args, input) => { vectraArguments(args, input) },
    executesWrite: (args, input) => vectraArguments(args, input).effect === 'write',
    authorizeOperation: (command, settings, args) => vectraWritePolicy.authorize(settings, allowed => vectraOperationAccepts(command, allowed.replace(/^(?:qux|rux)\./, ''), args)),
    rawApi: { commands: ['api get'], writes: false, help: (args, input) => vectraArguments(args, input).invocation.help },
    classify: (args: readonly string[], input?: RunnerInput) => classifyCommand(
      inventory.commands.map(route => ({ ...route, effect: vectraReadCommands.has(route.command) ? 'read' : 'write' })),
      (a, i) => {
        const call = vectraArguments(a, i)
        if (a.length === 1 && ['--version', '-v', '-V'].includes(a[0])) return { command: 'version' }
        const route = inventory.commands.find(route => route.command === call.invocation.command)
        if (!route) throw new ArtiumError('INVALID_INPUT')
        const schema: Record<string, string | undefined> = route.flags
        const seen = new Set<string>()
        const words = a.findIndex(token => token.startsWith('-'))
        const count = words === -1 ? a.length : words
        const commandWords = route.command === 'home' && count === 0 ? 0 : route.command.split(' ').length
        if (count !== commandWords && !(count === commandWords + 1 && route.command.endsWith(' show') && schema.id)) {
          throw new ArtiumError('INVALID_INPUT')
        }
        for (let index = count; index < a.length; index++) {
          const match = /^--([a-z-]+)(?:=(.*))?$/.exec(a[index])
          if (!match) throw new ArtiumError('INVALID_INPUT')
          const [, name, inline] = match
          if (!Object.hasOwn(schema, name) || seen.has(name)) throw new ArtiumError('INVALID_INPUT')
          seen.add(name)
          if (schema[name] === 'boolean') {
            if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
          } else {
            const value = inline ?? a[++index]
            if (!value || value.startsWith('-') && value !== '-') throw new ArtiumError('INVALID_INPUT')
          }
        }
        return call.invocation
      }, args, input),
    async prepare(args, reference, input) {
      const normalized = vectraArguments(args, input)
      if (reference.tool !== 'vectra-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = vectraCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const { caBundle, ...credential } = parsed.data
      const { token, ...tokenProfile } = credential.auth === 'token' ? credential : { token: undefined }
      const { clientSecret, ...oauthProfile } = credential.auth === 'oauth' ? credential : { clientSecret: undefined }
      const profile = credential.auth === 'token'
        ? { ...tokenProfile, tokenEnv: 'ARTIUM_SECRET_0' }
        : { ...oauthProfile, secretEnv: 'ARTIUM_SECRET_0' }
      return {
        executable: toolPaths['vectra-axi'], ...normalized,
        environment: { VECTRA_AXI_CONFIG: 'vectra-profile.json', VECTRA_AXI_WRITE_LOG: writeLog,
          VECTRA_AXI_READ_ONLY: String(credential.writes?.allowWrites !== true),
          ARTIUM_SECRET_0: credential.auth === 'token' ? token! : clientSecret! },
        files: [{ name: 'vectra-profile.json', content: JSON.stringify({ version: 1, defaultProfile: 'artium',
          profiles: { artium: { ...profile, ...(caBundle ? { caBundle: 'vectra-ca.pem' } : {}) } } }) },
        ...(caBundle ? [{ name: 'vectra-ca.pem', content: caBundle, appendTrustedCa: true }] : [])],
        secrets: credential.auth === 'token' ? [token!] : [clientSecret!, credential.clientId,
          Buffer.from(`${credential.clientId}:${clientSecret}`).toString('base64')],
        limits: { timeoutMs: runnerLimits.timeoutMs },
      }
    },
  }, source, writeLog, profile, vectraArguments)
}
