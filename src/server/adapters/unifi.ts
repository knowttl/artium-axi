import { isAbsolute } from 'node:path'
import inventory from '../../../tools/inventories/unifi-axi.json' with { type: 'json' }
import { classifyCommand } from './classify.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'

export const unifiProfile = new CredentialProfile(inventory.credentialSchema, 'unifi-axi')
export const unifiWritePolicy = writePolicy({ supportedOperations: inventory.writeOperations,
  unlocks: 'Exact native operation and variant grants. Preview first, then execute with the matching confirmation and a stable request ID.',
  blocked: 'Local configuration, credential overrides, secret export and byte transports remain unavailable in hosted execution.' })

function authorizeOperation(command: string, settings: Record<string, unknown>) {
  unifiWritePolicy.authorize(settings, allowed => allowed === inventory.commands.find(route => route.command === command)?.operation)
}

function argumentsForCall(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))) throw new ArtiumError('FLAG_BLOCKED')
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    if (input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
    return { args: [...args], fileArguments: [], executing: false, operation: '', effect: 'read' as const,
      invocation: { command: 'version', help: false } }
  }
  const index = args.findIndex(arg => arg.startsWith('-'))
  const words = index < 0 ? args : args.slice(0, index), command = words.join(' ')
  const route = inventory.commands.find(route => route.command === command)
  const groupHelp = !route && args.at(-1) === '--help' && index === args.length - 1
    && inventory.commands.some(route => route.command.startsWith(command + ' '))
  if (!route && !groupHelp) throw invalidCommand('unifi-axi', args, inventory.discovery.commands)
  const flags: Record<string, string | undefined> = route?.flags ?? { help: 'boolean' }
  const seen = new Map<string, string>(), normalized = [...words], fileArguments: number[] = []
  for (let offset = index < 0 ? args.length : index; offset < args.length; offset++) {
    const token = args[offset], match = /^--([a-z][a-zA-Z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (!match || !Object.hasOwn(flags, match[1])) throw unknownFlag('unifi-axi', command, token, Object.keys(flags))
    const [, name, inline] = match
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    normalized.push('--' + name)
    if (flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      seen.set(name, 'true')
    } else {
      const value = inline ?? args[++offset]
      if (!value || value.startsWith('-')) throw new ArtiumError('INVALID_INPUT')
      seen.set(name, value); normalized.push(value)
      if (name === 'body-file') fileArguments.push(normalized.length - 1)
    }
  }
  const help = seen.has('help'), body = help ? undefined : seen.get('body-file')
  if (body && !input.files?.some(file => file.name === body)
    || input.files?.some(file => file.name !== body) || (input.files?.length ?? 0) > 1) throw new ArtiumError('UNSUPPORTED_INPUT')
  const executing = !help && route?.effect === 'write' && seen.has('execute')
  if (executing && (!/^[a-f0-9]{64}$/.test(seen.get('confirm') ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(seen.get('request-id') ?? ''))) throw new ArtiumError('INVALID_INPUT')
  return { args: normalized, fileArguments: help ? [] : fileArguments, executing,
    ...(executing ? { write: { operation: command, target: 'managed UniFi resource',
      checkArgs: ['write', 'reconcile', '--request-id', seen.get('request-id')!] } } : {}),
    operation: route && 'operation' in route ? route.operation ?? '' : '', effect: executing ? 'write' as const : 'read' as const,
    invocation: { command: command || 'home', help } }
}

function inputSecrets(input: RunnerInput | undefined): string[] {
  const secrets: string[] = []
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [name, item] of Object.entries(value)) {
      if (/^(?:api[-_]?key|authorization|password|passphrase|token|accessToken|refreshToken|clientSecret|privateKey)$/i.test(name)
        && typeof item === 'string' && item) secrets.push(item)
      else visit(item)
    }
  }
  for (const file of input?.files ?? []) {
    const text = Buffer.from(file.contentBase64, 'base64').toString('utf8')
    secrets.push(text)
    try { visit(JSON.parse(text)) } catch { /* Native validation reports malformed bodies without excerpts. */ }
  }
  return secrets
}

export function createUnifiAdapter(source: SecretSource, writeLog?: string): Adapter<unknown> {
  return { name: 'unifi-axi', executable: toolPaths['unifi-axi'], credentialProfile: unifiProfile,
    credentialSchema: unifiProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => '--' + name), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]),
      positions: args.map((_, index) => index) }),
    sensitiveInput: (_args, input) => Boolean(input?.files?.length),
    validateArgs: (args, input) => { argumentsForCall(args, input) },
    executesWrite: (args, input) => argumentsForCall(args, input).effect === 'write',
    authorizeOperation,
    classify: (args: readonly string[], input?: RunnerInput) => classifyCommand(inventory.commands, (a, i) => argumentsForCall(a, i).invocation, args, input),
    async prepare(args, reference, input) {
      const call = argumentsForCall(args, input)
      if (reference.tool !== 'unifi-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? {}
      const state = unifiWritePolicy.read(settings)
      if (call.executing) authorizeOperation(call.invocation.command, settings)
      if ((call.executing || call.invocation.command.startsWith('write ')) && (!writeLog || !isAbsolute(writeLog))) throw new ArtiumError('TEMP_UNAVAILABLE')
      const value = await source.getCredential(reference)
      const prepared = unifiProfile.prepare('unifi-axi', value, writeLog, !state.enabled)
      const credential = value as { origin: string, tls?: { connectAddress?: string } }
      const launcher: string[] = []
      if (credential.tls?.connectAddress) {
        const origin = new URL(credential.origin)
        const hostname = origin.hostname.replace(/^\[|\]$/g, '')
        prepared.files.push({ name: 'unifi-axi/connect.cjs', content: `
const tls = require('node:tls');
const { connect } = require('node:net');
const original = tls.connect;
const address = ${JSON.stringify(credential.tls.connectAddress)};
const hostname = ${JSON.stringify(hostname)};
const port = ${Number(origin.port || 443)};
tls.connect = function (options, ...args) {
  if (options.host === address && Number(options.port) === port) {
    options = { ...options, host: hostname, socket: connect({ host: address, port }) };
  }
  return original.call(this, options, ...args);
};
require('node:module').syncBuiltinESMExports();
` })
        launcher.push('--require', './unifi-axi/connect.cjs')
      }
      launcher.push(toolPaths['unifi-axi'])
      return { ...call, executable: process.execPath, args: [...launcher, ...call.args],
        fileArguments: call.fileArguments.map(index => index + launcher.length), ...prepared,
        secrets: [...prepared.secrets, ...inputSecrets(input)], environment: { ...prepared.environment,
          UNIFI_AXI_HOSTED: '1', UNIFI_AXI_CONFIG: '/proc/self/cwd/unifi-axi/config.json' },
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
