import { isAbsolute } from 'node:path'
import { decode } from '@toon-format/toon'
import inventory from '../../../tools/inventories/proxmox-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'

interface Command {
  command: string, effect: string, operationId?: string, method?: string, path?: string,
  sensitiveInputs: string[], privateResult?: boolean, flags: Record<string, string | undefined>
}
const commands: Command[] = inventory.commands
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const nativePolicy = writePolicy({ supportedOperations: inventory.writeOperations,
  unlocks: 'JSON writes with independent native profile and host grants, exact single-use confirmation, protected results and durable recovery.',
  blocked: 'Managed streams, caller credentials, separate PVE sign-in and host files remain unavailable.' })
export const proxmoxWritePolicy = {
  read: (settings: Record<string, unknown>) => nativePolicy.read({ ...settings, writes: settings.hostWrites }),
  update(settings: Record<string, unknown>, input: Parameters<typeof nativePolicy.update>[1]) {
    const { writes: profileWrites, ...rest } = settings
    const { writes, ...updated } = nativePolicy.update({ ...rest, writes: settings.hostWrites }, input)
    return { ...updated, ...(profileWrites ? { writes: profileWrites } : {}), hostWrites: writes ?? { allowWrites: false, operations: [] } }
  },
}
export const proxmoxProfile = new CredentialProfile(inventory.credentialSchema, 'proxmox-axi')

function protectedInput(text: string): { api: Record<string, unknown>, secrets: Record<string, string> } {
  if (Buffer.byteLength(text) > 65536) throw new ArtiumError('INVALID_INPUT')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new ArtiumError('INVALID_INPUT') }
  const body = value as { api: Record<string, unknown>, secrets: Record<string, string> }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['api', 'secrets'].includes(key))
    || !body.api || typeof body.api !== 'object' || Array.isArray(body.api)
    || !body.secrets || typeof body.secrets !== 'object' || Array.isArray(body.secrets)
    || Object.entries(body.secrets).some(([key, secret]) => !/^PVE_INPUT_[A-Z0-9_]+$/.test(key) || typeof secret !== 'string' || !secret)) {
    throw new ArtiumError('INVALID_INPUT')
  }
  return body
}

function requireOperations(route: Command, values: Record<string, unknown>, allowed: readonly string[],
  secrets: Record<string, string>, budget = { count: 0 }, depth = 0): boolean {
  if (!route.operationId || !allowed.includes(route.operationId) || ++budget.count > 64 || depth > 4) throw new ArtiumError('FLAG_BLOCKED')
  for (const name of route.sensitiveInputs) if (Object.hasOwn(values, name)) {
    const ref = values[name] as { env?: unknown }
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).join(',') !== 'env'
      || typeof ref.env !== 'string' || !/^PVE_INPUT_[A-Z0-9_]+$/.test(ref.env) || !Object.hasOwn(secrets, ref.env)) {
      throw new ArtiumError('FLAG_BLOCKED')
    }
  }
  let privateResult = route.privateResult === true
  if (route.path !== '/nodes/{node}/execute') return privateResult
  if (typeof values.commands !== 'string' || Buffer.byteLength(values.commands) > 32768) throw new ArtiumError('INVALID_INPUT')
  let children: unknown
  try { children = JSON.parse(values.commands) } catch { throw new ArtiumError('INVALID_INPUT') }
  if (!Array.isArray(children) || !children.length || typeof values.node !== 'string') throw new ArtiumError('INVALID_INPUT')
  for (const child of children) {
    if (!child || typeof child !== 'object' || Object.keys(child).some(key => !['method', 'path', 'args'].includes(key))
      || !['GET', 'POST', 'PUT', 'DELETE'].includes(child.method) || typeof child.path !== 'string'
      || !/^[A-Za-z0-9._~/-]+$/.test(child.path) || child.path.startsWith('/')
      || child.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || child.args !== undefined && (!child.args || typeof child.args !== 'object' || Array.isArray(child.args))) throw new ArtiumError('INVALID_INPUT')
    const literal = `/nodes/${values.node}/${child.path}`
    let pathValues: Record<string, string> = {}
    const target = commands.find(command => {
      if (command.method !== child.method || !command.path) return false
      const names: string[] = []
      const pattern = command.path.split('/').map(part => part.startsWith('{') ? (names.push(part.slice(1, -1)), '([^/]+)')
        : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
      const match = new RegExp(`^${pattern}$`).exec(literal)
      if (!match) return false
      pathValues = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]))
      return true
    })
    if (!target) throw new ArtiumError('FLAG_BLOCKED')
    if (Object.keys(child.args ?? {}).some(name => Object.hasOwn(pathValues, name))) throw new ArtiumError('INVALID_INPUT')
    privateResult = requireOperations(target, { ...pathValues, ...child.args }, allowed, secrets, budget, depth + 1) || privateResult
  }
  return privateResult
}

function argumentsForCall(args: readonly string[], input: RunnerInput = {}) {
  if (input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))) throw new ArtiumError('FLAG_BLOCKED')
  const version = args.length === 1 && ['--version', '-v', '-V'].includes(args[0])
  const index = args.findIndex(arg => arg.startsWith('-')), words = [...(index < 0 ? args : args.slice(0, index))]
  const journalId = words[0] === 'journal' && words.length === 3 ? words.pop() : undefined
  if (journalId && !uuid.test(journalId)) throw new ArtiumError('INVALID_INPUT')
  if (words[0] === 'post') words[0] = 'create'
  else if (words[0] === 'put') words[0] = 'set'
  if (words[0] === 'schema' && words[1] === 'create') words[1] = 'post'
  else if (words[0] === 'schema' && words[1] === 'set') words[1] = 'put'
  const command = words.join(' ') || 'home'
  const groupHelp = args.includes('--help') && commands.some(route => route.command.startsWith(command + ' '))
  const route = version ? { command: 'version', effect: 'read', sensitiveInputs: [], flags: {} } as Command
    : commands.find(route => route.command === command) ?? (groupHelp ? { command, effect: 'read', sensitiveInputs: [],
      flags: { help: 'boolean', format: 'value' } } : undefined)
  if (!route) throw invalidCommand('proxmox-axi', args, inventory.discovery.commands)
  const normalized = version ? [...args] : [...words, ...(journalId ? [journalId] : [])]
  const seen = new Map<string, string>()
  for (let offset = version || index < 0 ? args.length : index; offset < args.length; offset++) {
    const match = /^--([a-z][a-zA-Z0-9-]*)(?:=(.*))?$/s.exec(args[offset])
    if (!match || !Object.hasOwn(route.flags, match[1])) throw unknownFlag('proxmox-axi', command, args[offset], Object.keys(route.flags))
    const [, name, inline] = match
    if (seen.has(name)) throw new ArtiumError('INVALID_INPUT')
    if (route.flags[name] === 'boolean') {
      if (inline !== undefined) throw new ArtiumError('INVALID_INPUT')
      seen.set(name, 'true')
      if (name !== 'protected-input') normalized.push('--' + name)
    } else {
      const value = inline ?? args[++offset]
      if (!value || value.startsWith('--')) throw new ArtiumError('INVALID_INPUT')
      seen.set(name, value); normalized.push('--' + name, value)
    }
  }
  const help = seen.has('help'), write = route.effect === 'write' && !help
  if (seen.has('preview') && seen.has('confirm') && !help) throw new ArtiumError('INVALID_INPUT')
  const executing = write && !seen.has('preview'), confirmation = seen.get('confirm')
  if (executing && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[0-9a-f]{64}$/.test(confirmation ?? '')) throw new ArtiumError('INVALID_INPUT')
  if ((input.stdin !== undefined) !== (seen.has('protected-input') && !help)) throw new ArtiumError('UNSUPPORTED_INPUT')
  const body = input.stdin === undefined ? undefined : protectedInput(input.stdin)
  const values: Record<string, unknown> = { ...body?.api }
  for (const [name, value] of seen) if (name.startsWith('api-')) {
    if (Object.hasOwn(values, name.slice(4))) throw new ArtiumError('INVALID_INPUT')
    values[name.slice(4)] = value
  }
  if (seen.has('journal') && !uuid.test(seen.get('journal')!)) throw new ArtiumError('INVALID_INPUT')
  if (!help && command.startsWith('journal ') && !journalId) throw new ArtiumError('INVALID_INPUT')
  const privateResult = write && requireOperations(route, values, inventory.writeOperations, body?.secrets ?? {})
  return { args: normalized, body, route, values, write, executing, privateResult, id: confirmation?.split('.')[0],
    effect: executing ? 'write' as const : 'read' as const, invocation: { command: route.command, help } }
}

const generatedFields = new Set(['id', 'status', 'operation', 'confirmation', 'expiresInSeconds', 'reconciliation', 'children', 'help', 'usage', 'flags', 'examples', 'purpose', 'parameters', 'policy',
  'session', 'error', 'journal', 'credential', 'compatibility', 'bin', 'description', 'node', 'wait'])
function providerContent(stdout: string, stderr: string): string[] {
  if (!stdout.trim() || stdout.trim() === inventory.version) return [stderr]
  const output = (stdout.trimStart().startsWith('{') ? JSON.parse(stdout) : decode(stdout)) as Record<string, unknown>
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new ArtiumError('INVALID_RESPONSE')
  const content = [stderr]
  const collect = (value: unknown): void => {
    if (typeof value === 'string') content.push(value.replaceAll('[REDACTED]', ''))
    else if (Array.isArray(value)) for (const item of value) collect(item)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item)
  }
  const tasks = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) tasks(item)
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (key === 'upid') collect(item)
      else tasks(item)
    }
  }
  // The published S4 protocol excludes generated keys/metadata from value scanning.
  for (const [key, value] of Object.entries(output)) {
    if (!generatedFields.has(key)) collect(value)
    else if (key === 'children' || key === 'journal') tasks(value)
  }
  return content
}

export function createProxmoxAdapter(source: SecretSource, writeLog?: string): Adapter<unknown> {
  return { name: 'proxmox-axi', executable: toolPaths['proxmox-axi'], credentialProfile: proxmoxProfile,
    credentialSchema: proxmoxProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => '--' + name), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: args.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]), positions: args.map((_, index) => index) }),
    sensitiveInput: () => true,
    validateArgs: (args, input) => { argumentsForCall(args, input) },
    async prepare(args, reference, input) {
      const call = argumentsForCall(args, input)
      if (reference.tool !== 'proxmox-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const state = proxmoxWritePolicy.read(source.getSettings?.(reference) ?? {})
      if (call.write) {
        if (!state.enabled) throw new ArtiumError('FLAG_BLOCKED')
        requireOperations(call.route, call.values, state.allowedOperations, call.body?.secrets ?? {})
      }
      if ((call.write || !call.invocation.help && (call.invocation.command.startsWith('journal ') || call.args.includes('--journal')))
        && (!writeLog || !isAbsolute(writeLog))) throw new ArtiumError('TEMP_UNAVAILABLE')
      const value = await source.getCredential(reference)
      const prepared = proxmoxProfile.prepare('proxmox-axi', value, writeLog, !state.enabled)
      if (call.body) {
        prepared.files.push({ name: 'proxmox-input.json', content: JSON.stringify(call.body.api) })
        call.args.push('--body-file', '/proc/self/cwd/proxmox-input.json')
        Object.assign(prepared.environment, call.body.secrets)
        prepared.secrets.push(...Object.values(call.body.secrets))
      }
      // Native operation help can exceed its own output cap; hosted help uses the admitted inventory.
      const childArgs = call.invocation.help ? ['--help', ...(call.args.includes('json') ? ['--format', 'json'] : [])] : call.args
      return { ...prepared, args: [toolPaths['proxmox-axi'], ...childArgs], executable: process.execPath,
        effect: call.effect, invocation: call.invocation, publicContent: providerContent,
        proxmox: { origin: String((value as Record<string, unknown>).origin),
          identity: String((value as Record<string, unknown>).tokenId ?? (value as Record<string, unknown>).userId),
          password: (value as Record<string, unknown>).auth === 'password',
          authenticate: !call.invocation.help && call.route.command !== 'version'
            && call.route.command !== 'inventory' && !call.route.command.startsWith('schema ') },
        ...(call.executing && call.privateResult ? { protectedResult: { source: 'proxmox' as const, operation: call.route.operationId! } } : {}),
        ...(call.executing ? { write: { operation: call.route.operationId!, target: call.route.path!, checkArgs: ['journal', 'reconcile', call.id!] } } : {}),
        environment: { ...prepared.environment, PROXMOX_AXI_CONFIG: '/proc/self/cwd/proxmox-axi/config.json',
          PROXMOX_AXI_HOST_OPERATIONS: JSON.stringify(state.allowedOperations) }, limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
