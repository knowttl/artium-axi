import { parseArgs } from 'node:util'
import { isAbsolute } from 'node:path'
import inventory from '../../../tools/inventories/gitea-axi.json' with { type: 'json' }
import { classifyCommand } from './classify.js'
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { SecretSource } from '../store/secret-source.js'
import type { RunnerInput } from '../runner/input.js'
import type { Adapter } from './types.js'
import { CredentialProfile } from './credential-profile.js'
import { invalidCommand } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'
import { giteaWriteOperations } from '../../shared/gitea-writes.js'
import { normalizeGiteaFileArguments } from '../../shared/file-input.js'
import { transferTool } from '../../shared/api.js'

export const giteaProfile = new CredentialProfile(inventory.credentialSchema, 'gitea-axi')
export const giteaWritePolicy = writePolicy({ supportedOperations: giteaWriteOperations,
  unlocks: 'Exact native operations with preview, revision-bound confirmation and durable reconciliation receipts.',
  blocked: 'Ordinary downloads, server paths, local workflows and credential overrides remain unavailable. Use managed transfers for one exact attachment.' })

function giteaArguments(args: readonly string[], input: RunnerInput = {}) {
  if (args.some(arg => arg.startsWith('--') && inventory.adapterBoundary.unsafeOverrides.includes(arg.slice(2).split('=')[0]))) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  args = normalizeGiteaFileArguments(args)
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) return { args: [...args], invocation: { command: 'version', help: false } }
  if (args.length === 2 && args[1] === '--help' && inventory.commands.some(entry => entry.command.startsWith(args[0] + ' '))) {
    return { args: [...args], invocation: { command: args[0], help: true } }
  }
  const route = [...inventory.commands].sort((a, b) => b.command.length - a.command.length)
    .find(entry => entry.command ? entry.command.split(' ').every((word, index) => args[index] === word) : !args.length || args[0].startsWith('-'))
  if (!route) throw invalidCommand('gitea-axi', args, inventory.discovery.commands)
  const length = route.command ? route.command.split(' ').length : 0
  const flags: Record<string, string | undefined> = route.flags
  const shorts: Record<string, string | undefined> = route.shortFlags
  const repeatable: readonly string[] = route.repeatableFlags
  let parsed
  try {
    const options = Object.fromEntries(Object.entries(flags).map(([name, type]) => {
      const short = Object.entries(shorts).find(([, target]) => target === name)?.[0]
      return [name, { type: type === 'boolean' ? 'boolean' as const : 'string' as const,
        ...(repeatable.includes(name) ? { multiple: true } : {}), ...(short ? { short } : {}) }]
    }))
    parsed = parseArgs({ args: args.slice(length).map(arg => {
      const match = /^--([^=]+)=(true|false)$/.exec(arg)
      return match && flags[match[1]] === 'boolean' ? `--${match[1]}` : arg
    }), options, strict: true, allowPositionals: true, tokens: true })
  } catch { throw new ArtiumError('INVALID_INPUT') }
  for (const arg of args.slice(length)) {
    const match = /^--([^=]+)=(true|false)$/.exec(arg)
    if (match && flags[match[1]] === 'boolean') parsed.values[match[1]] = match[2] === 'true'
  }
  const names = parsed.tokens.flatMap(token => token.kind === 'option' && !repeatable.includes(token.name) ? [token.name] : [])
  if (new Set(names).size !== names.length) throw new ArtiumError('INVALID_INPUT')
  const help = parsed.values.help === true && !args.includes('--help=false')
  const positions = parsed.positionals
  const command = route.command || 'dashboard'
  let rawMutation = false
  let rawSecret = false
  if (!help) {
    if (route.effect === 'download') throw new ArtiumError('FLAG_BLOCKED', 'Use artium-axi download for an authenticated attachment transfer.')
    if (command === 'pr checks' && parsed.values.timeout !== undefined
      && (!/^\d+$/.test(String(parsed.values.timeout)) || Number(parsed.values.timeout) < 1
        || Number(parsed.values.timeout) > inventory.adapterBoundary.checksWatchTimeoutSeconds)) {
      throw new ArtiumError('INVALID_INPUT', `Checks watch timeout must be from 1 to ${inventory.adapterBoundary.checksWatchTimeoutSeconds} seconds.`)
    }
    if (/^(secret|variable) /.test(command)) {
      if (parsed.values.repo && parsed.values.org || (command.endsWith(' list') ? positions.length !== 0
        : positions.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(positions[0]))) throw new ArtiumError('INVALID_INPUT')
      if (command === 'secret set' && parsed.values.input === undefined
        || command === 'variable set' && (parsed.values.input !== undefined) === (parsed.values.body !== undefined)) throw new ArtiumError('INVALID_INPUT')
    } else if (command === 'write reconcile') {
      if (positions.length !== 1 || !/^[a-f0-9-]{36}$/.test(positions[0])) throw new ArtiumError('INVALID_INPUT')
    } else if (['issue view', 'pr view', 'pr checks', 'pr diff'].includes(command)
      || /^(issue|pr) /.test(command) && route.effect === 'write' && !command.endsWith(' create')) {
      if (positions.length !== 1 || !/^[1-9]\d*$/.test(positions[0])) throw new ArtiumError('INVALID_INPUT')
    } else if (command.startsWith('release ') && command !== 'release list'
      || ['label edit', 'label delete'].includes(command) || command.startsWith('search ') || command === 'org view') {
      if (positions.length !== 1 || !positions[0].trim()) throw new ArtiumError('INVALID_INPUT')
    } else if (command.startsWith('repo ') && route.effect === 'write') {
      if (positions.length > 1 || positions.length && parsed.values.repo || !positions.length && !parsed.values.repo) throw new ArtiumError('INVALID_INPUT')
    } else if (command === 'api') {
      if (positions.length !== 1 && positions.length !== 2 || parsed.values.method && positions.length === 2) throw new ArtiumError('INVALID_INPUT')
      const method = String(positions.length === 2 ? positions[0] : parsed.values.method ?? 'GET')
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ArtiumError('FLAG_BLOCKED')
      rawMutation = method !== 'GET'
      const raw = positions.at(-1)!
      const separator = raw.indexOf('?')
      const pathname = separator < 0 ? raw : raw.slice(0, separator)
      const query = separator < 0 ? '' : raw.slice(separator + 1)
      let decoded: string
      try { decoded = decodeURIComponent(pathname) } catch { throw new ArtiumError('INVALID_INPUT') }
      if (/^[a-z]+:/i.test(raw) || raw.startsWith('//') || raw.includes('#') || /[\\#\s%]/.test(decoded)
        || /%(?:2f|5c)/i.test(pathname) || decoded.split('/').some(part => part === '.' || part === '..')) throw new ArtiumError('INVALID_INPUT')
      if ([...new URLSearchParams(query).keys()].some(key => /token|secret|password|authorization|api.?key/i.test(key))) throw new ArtiumError('FLAG_BLOCKED')
      const path = pathname.startsWith('/api/v1/') || pathname === '/swagger.v1.json' ? pathname : '/api/v1/' + pathname.replace(/^\//, '')
      rawSecret = /\/actions\/secrets(?:\/|$)/.test(path)
      if (!rawMutation && ['input', 'field', 'raw-field'].some(name => parsed.values[name] !== undefined)
        || rawSecret && rawMutation && method !== 'DELETE' && parsed.values.input === undefined) throw new ArtiumError('INVALID_INPUT')
      const routes = [...inventory.apiRoutes].sort((a, b) => b.path.replace(/\{[^}]+\}/g, '').length - a.path.replace(/\{[^}]+\}/g, '').length)
      const match = routes.find(entry => entry.method === method && new RegExp('^' + entry.path.split(/(\{[^}]+\})/)
        .map(part => /^\{[^}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$').test(path))
      if (path === '/swagger.v1.json' && rawMutation) throw new ArtiumError('FLAG_BLOCKED')
      if (path !== '/swagger.v1.json' && (rawMutation
        ? match?.effect !== 'write' || !giteaWriteOperations.includes(match.operation) : match?.effect !== 'read')) throw new ArtiumError('FLAG_BLOCKED')
    } else if (positions.length) throw new ArtiumError('INVALID_INPUT')
  }
  const fileFlags = inventory.adapterBoundary.inputFileFlags
  const fileTokens = help ? [] : parsed.tokens.filter(token => token.kind === 'option' && fileFlags.includes(token.name))
  const stdinToken = (token: typeof fileTokens[number]) => token.kind === 'option' && token.value === '-'
    && ['input', 'body-file', 'notes-file'].includes(token.name)
  if (input.stdin !== undefined && !fileTokens.some(stdinToken)
    || fileTokens.some(token => token.kind === 'option' && (token.value === '-' ? !stdinToken(token) || input.stdin === undefined
      : !input.files?.some(file => file.name === token.value)))
    || input.files?.some(file => !fileTokens.some(token => token.kind === 'option' && token.value === file.name))) throw new ArtiumError('UNSUPPORTED_INPUT')
  const mutation = !help && (route.effect === 'write' || rawMutation)
  const operations = String(parsed.values['allow-write'] ?? '').split(',').filter(Boolean)
  if (mutation && (!operations.length || Boolean(parsed.values.preview) === Boolean(parsed.values.confirm))) throw new ArtiumError('INVALID_INPUT')
  if (operations.some(operation => !giteaWriteOperations.includes(operation))) throw new ArtiumError('FLAG_BLOCKED')
  for (const token of parsed.tokens) {
    if (token.kind === 'option' && ['field', 'raw-field'].includes(token.name)
      && (rawSecret || /secret|token|password|authorization|api.?key/i.test(String(token.value).split('=')[0]))) throw new ArtiumError('FLAG_BLOCKED')
  }
  const forwarded = [...args]
  const fileArguments: number[] = []
  let offset = 0
  for (const token of fileTokens) {
    if (token.kind !== 'option' || token.value === '-') continue
    const index = length + token.index + offset
    if (token.inlineValue) { forwarded.splice(index, 1, '--' + token.name, token.value!); offset++ }
    else forwarded[index] = '--' + token.name
    fileArguments.push(index + 1)
  }
  if (!route.command && forwarded[0]?.startsWith('-R')) forwarded[0] = '--repo' + (forwarded[0].length > 2 ? '=' + forwarded[0].slice(2) : '')
  return { args: forwarded, fileArguments, mutation, operations, secretInput: !help && (command === 'secret set' || rawSecret && rawMutation), confirmation: String(parsed.values.confirm ?? ''),
    effect: mutation && parsed.values.confirm ? 'write' as const : 'read' as const,
    invocation: { command: command === 'dashboard' ? 'home' : command, help } }
}

export function createGiteaAdapter(source: SecretSource, writeLog?: string): Adapter<unknown> {
  return { name: 'gitea-axi', executable: toolPaths['gitea-axi'], credentialProfile: giteaProfile,
    credentialSchema: giteaProfile.credentialSchema, timeoutMs: runnerLimits.timeoutMs,
    blockedFlags: inventory.adapterBoundary.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].map(name => `--${name}`),
      positions: args.map((_, index) => index) }),
    sensitiveInput: (args, input) => {
      const call = giteaArguments(args, input)
      return 'secretInput' in call && Boolean(call.secretInput)
    },
    validateArgs: (args, input) => { giteaArguments(args, input) },
    classify(args, input) {
      const result = classifyCommand(inventory.commands, (a, i) => giteaArguments(a, i).invocation.command, args, input)
      if (result.command !== 'api') return result
      const methodIndex = args.findIndex(arg => arg === '--method' || arg === '-X')
      const methodFlag = args.find(arg => arg.startsWith('--method=') || arg.startsWith('-X') && arg.length > 2)
      const method = methodIndex >= 0 ? args[methodIndex + 1] : methodFlag?.startsWith('--') ? methodFlag.slice(9) : methodFlag?.slice(2)
      const write = method !== undefined ? method.toUpperCase() !== 'GET' : /^(POST|PUT|PATCH|DELETE)$/i.test(args[1] ?? '')
      return write ? { ...result, effect: 'write' } : result
    },
    async prepareArtifact(args, reference, scope) {
      if (reference.tool !== 'gitea-axi' || transferTool(scope.selection.operation) !== 'gitea-axi'
        || reference.revision !== scope.credentialRevision) throw new ArtiumError('REVISION_CONFLICT')
      const state = giteaWritePolicy.read(source.getSettings?.(reference) ?? {})
      if (!state.enabled || !state.allowedOperations.includes(scope.selection.operation)) throw new ArtiumError('FLAG_BLOCKED')
      return { executable: process.execPath, args: [toolPaths['gitea-axi'], ...args],
        ...giteaProfile.prepare('gitea-axi', await source.getCredential(reference), writeLog, true), limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
    async prepare(args, reference, input) {
      const call = giteaArguments(args, input)
      if (reference.tool !== 'gitea-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? {}
      const state = giteaWritePolicy.read(settings)
      if ('mutation' in call && call.mutation && (!state.enabled || call.operations.some(operation => !state.allowedOperations.includes(operation)))) throw new ArtiumError('FLAG_BLOCKED')
      if (state.enabled && (!writeLog || !isAbsolute(writeLog))) throw new TypeError('Gitea writes require an absolute server-owned journal path')
      const profile = giteaProfile.prepare('gitea-axi', await source.getCredential(reference), writeLog, !state.enabled)
      const protectedInputs = 'secretInput' in call && call.secretInput
        ? [input?.stdin, ...(input?.files ?? []).map(file => Buffer.from(file.contentBase64, 'base64').toString('utf8'))]
          .filter((value): value is string => value !== undefined && value !== '') : []
      const secretValues = protectedInputs.flatMap(value => {
        try { const body: unknown = JSON.parse(value); return body && typeof body === 'object' && 'data' in body && typeof body.data === 'string' && body.data ? [body.data] : [] }
        catch { return [] }
      })
      return { ...call, executable: process.execPath, args: [toolPaths['gitea-axi'], ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 1) ?? [], effect: 'effect' in call ? call.effect : 'read',
        ...profile, secrets: [...profile.secrets, ...protectedInputs, ...secretValues], environment: { ...profile.environment,
          GITEA_AXI_HOST_WRITE_OPERATIONS: state.enabled ? state.allowedOperations.join(',') : '',
          GITEA_AXI_CREDENTIAL_REVISION: JSON.stringify({ reference, settings }) },
        ...('effect' in call && call.effect === 'write' ? { write: { operation: call.operations.join(','), target: 'explicit Gitea target', checkArgs: ['write', 'reconcile', call.confirmation] } } : {}),
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    } }
}
