import unifi from '../../../tools/inventories/unifi-axi.json' with { type: 'json' }
import proxmox from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'

const inventories = { 'unifi-axi': unifi, 'proxmox-axi': proxmox }
type NetworkTool = keyof typeof inventories
export const networkProfiles = {
  'unifi-axi': new CredentialProfile(unifi.credentialSchema, 'unifi-axi'),
  'proxmox-axi': new CredentialProfile(proxmox.credentialSchema, 'proxmox-axi'),
}
export const networkReadPolicy = writePolicy({ reason: 'This adapter admits ordinary reads only.',
  unlocks: 'No write actions.', blocked: 'Writes, byte transports, local configuration and identity overrides are unavailable.' })

function readArguments(tool: NetworkTool, args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  const inventory = inventories[tool]
  for (const token of args) {
    if (inventory.adapterBoundary.unsafeOverrides.includes(token.split('=')[0].replace(/^--/, '')) && token.startsWith('--')) {
      throw new ArtiumError('FLAG_BLOCKED')
    }
  }
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    return { args: [...args], invocation: { command: 'version', help: false } }
  }
  const index = args.findIndex(arg => arg.startsWith('-'))
  const words = index < 0 ? args : args.slice(0, index)
  const command = words.join(' ')
  const route = inventory.commands.find(entry => entry.command === command || !command && entry.command === 'home')
  if (!route) throw invalidCommand(tool, args, inventory.discovery.commands)
  const flags: Record<string, string | undefined> = route.flags
  const seen = new Set<string>()
  const normalized = [...words]
  for (let offset = index < 0 ? args.length : index; offset < args.length; offset++) {
    const token = args[offset]
    const match = /^--([a-z][a-zA-Z0-9-]*)(?:=(.*))?$/s.exec(token)
    if (!match || !Object.hasOwn(flags, match[1])) throw unknownFlag(tool, command, token, Object.keys(flags))
    const [, name, inline] = match
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    seen.add(name)
    normalized.push(`--${name}`)
    if (flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
    } else {
      const value = inline ?? args[++offset]
      if (!value || value.startsWith('-')) throw new ArtiumError('INVALID_INPUT')
      normalized.push(value)
    }
  }
  return { args: normalized, invocation: { command: command || 'home', help: seen.has('help') } }
}

export function createNetworkReadAdapter(tool: NetworkTool, source: SecretSource): Adapter<unknown> {
  const profile = networkProfiles[tool]
  return { name: tool, executable: toolPaths[tool], credentialProfile: profile,
    credentialSchema: profile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventories[tool].adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--') && arg !== '--help').map(arg => arg.split('=')[0]), positions: [] }),
    validateArgs: (args, input) => { readArguments(tool, args, input) },
    async prepare(args, reference, input) {
      const call = readArguments(tool, args, input)
      if (reference.tool !== tool) throw new ArtiumError('CREDENTIAL_INVALID')
      const credential = await source.getCredential(reference)
      const prepared = profile.prepare(tool, credential, undefined, true)
      const nodeArgs: string[] = []
      if (tool === 'unifi-axi') {
        const value = credential as { origin: string, tls?: { connectAddress?: string } }
        if (value.tls?.connectAddress) {
          const origin = new URL(value.origin)
          const hostname = origin.hostname.replace(/^\[|\]$/g, '')
          prepared.files.push({ name: 'unifi-axi/connect.cjs', content: `
const tls = require('node:tls');
const { connect } = require('node:net');
const original = tls.connect;
const address = ${JSON.stringify(value.tls.connectAddress)};
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
          nodeArgs.push('--require', './unifi-axi/connect.cjs')
        }
      }
      return { ...call, executable: process.execPath, args: [...nodeArgs, toolPaths[tool], ...call.args], effect: 'read',
        ...prepared, limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
