import inventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import { createHash } from 'node:crypto'
import { ArtiumError } from '../../shared/errors.js'
import { ghWriteOperations } from '../../shared/api.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter, PreparedCall } from './types.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'
import { GithubAppTokenCache } from './github-app-tokens.js'

export const ghManifest = { ...inventory, ...inventory.adapterBoundary }
export const ghWritePolicy = writePolicy({ supportedOperations: ghWriteOperations,
  unlocks: 'Exact collaboration and repository operations, each off by default. Preview first, then repeat the same request with its --confirm value.',
  blocked: 'Deletes, secret set, merge --admin, API non-GET, local git commands, downloads and local file inputs remain unavailable.' })
export const ghProfile = new CredentialProfile({ type: 'object', additionalProperties: false,
  required: ['origin', 'auth'], properties: {
    origin: { type: 'string', format: 'canonical-https-origin', default: 'https://github.com', title: 'GitHub origin',
      description: 'https://github.com or your GitHub Enterprise HTTPS origin.' },
    auth: { enum: ['token', 'github-app', 'device'], title: 'Authentication' },
    writes: { type: 'object', additionalProperties: false, required: ['allowWrites', 'operations'], properties: {
      allowWrites: { type: 'boolean' }, operations: { type: 'array', minItems: 1, maxItems: ghWriteOperations.length,
        items: { enum: ghWriteOperations } },
    } },
    accessToken: { type: 'string', 'x-secret': true, description: 'Managed by Connect with GitHub.' },
    accessTokenExpiresAt: { type: 'integer', minimum: 1 },
    login: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', maxLength: 100 },
    token: { type: 'string', 'x-secret': true, title: 'Personal access token',
      description: 'Classic or fine-grained PAT. Shared by everyone granted this tool. Classic repo scope permits writes outside Artium.' },
    appId: { type: 'string', pattern: '^[1-9][0-9]*$', title: 'GitHub App ID' },
    installationId: { type: 'string', pattern: '^[1-9][0-9]*$', title: 'Installation ID' },
    privateKey: { type: 'string', 'x-secret': true, title: 'App private key', description: 'PEM RSA private key, stored encrypted.' },
    repositories: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' },
      description: 'Optional repository names within the installation. Omit to retain the installation selection. Never widens access.' },
    permissions: { type: 'object', minProperties: 1, propertyNames: { pattern: '^[a-z][a-z_]*$' },
      additionalProperties: { enum: ['read', 'write'] }, description: 'Optional GitHub permission map to narrow the installation grant, for example {"contents":"read"}.' },
  }, oneOf: [
    { properties: { auth: { const: 'token' } }, required: ['token'],
      not: { anyOf: ['appId', 'installationId', 'privateKey', 'repositories', 'permissions', 'accessToken', 'accessTokenExpiresAt', 'login'].map(name => ({ required: [name] })) } },
    { properties: { auth: { const: 'github-app' } }, required: ['appId', 'installationId', 'privateKey'],
      not: { anyOf: ['token', 'accessToken', 'accessTokenExpiresAt', 'login'].map(name => ({ required: [name] })) } },
    { properties: { auth: { const: 'device' } }, required: ['accessToken', 'login'],
      not: { anyOf: ['token', 'appId', 'installationId', 'privateKey', 'repositories', 'permissions'].map(name => ({ required: [name] })) } },
  ] }, 'gh-axi')
export const ghCredentialSchema = ghProfile.credentialSchema

const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function parseGhArguments(args: readonly string[]) {
  const flags = new Map<string, string>()
  const fields: string[] = []
  const positionals: string[] = []
  const positionalIndices: number[] = []
  const allFlags: Record<string, string> = Object.assign({}, ...inventory.commands.map(route => route.flags))
  const hint = inventory.commands.find(route => {
    const words: string[] = []
    for (let index = 0; index < args.length; index++) {
      const token = args[index]
      if (!token.startsWith('-')) { words.push(token); continue }
      const name = ({ '-R': 'repo', '-h': 'help' } as Record<string, string>)[token.split('=')[0]]
        ?? token.split('=')[0].replace(/^--/, '')
      const type = (route.flags as Record<string, string>)[name]
      if (!type) return false
      if (!token.includes('=') && type === 'value') index++
      else if (!token.includes('=') && type === 'boolean-value' && ['true', 'false'].includes(args[index + 1])) index++
    }
    return words.slice(0, route.command.split(' ').length).join(' ') === route.command
  })
  Object.assign(allFlags, hint?.flags)
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); positionalIndices.push(index); continue }
    const match = /^(--[a-z][a-z-]*|-R|-h)(?:=(.*))?$/s.exec(token)
    if (!match) throw unknownFlag('gh-axi', positionals.join(' ') || 'home', token, Object.keys(allFlags))
    const name = ({ '-R': 'repo', '-h': 'help' } as Record<string, string>)[match[1]] ?? match[1].slice(2)
    if (ghManifest.unsafeOverrides.includes(name) || name === 'method' && hint?.command !== 'pr merge') throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(allFlags, name)) throw unknownFlag('gh-axi', positionals.join(' ') || 'home', token, Object.keys(allFlags))
    if (flags.has(name) && !(hint?.command === 'workflow run' && name === 'field')) throw new ArtiumError('INVALID_INPUT')
    if (allFlags[name] === 'boolean-value') {
      const value = match[2] ?? (['true', 'false'].includes(args[index + 1]) ? args[++index] : 'true')
      if (!['true', 'false'].includes(value)) throw new ArtiumError('INVALID_INPUT')
      flags.set(name, value)
    } else if (allFlags[name] === 'boolean') {
      if (match[2] !== undefined) throw new ArtiumError('INVALID_INPUT')
      flags.set(name, '')
    } else {
      const value = match[2] ?? args[++index]
      const text = ['body', 'notes', 'desc', 'description', 'title', 'comment', 'text', 'subject'].includes(name)
      const emptyContent = ['body', 'notes', 'desc', 'description', 'text'].includes(name)
      if (value === undefined || value === '' && !emptyContent || value.startsWith('-') && match[2] === undefined
        || (text ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new ArtiumError('INVALID_INPUT')
      flags.set(name, value)
      if (name === 'field') fields.push(value)
    }
  }
  const route = [...inventory.commands].sort((a, b) => b.command.length - a.command.length)
    .find(route => positionals.slice(0, route.command.split(' ').length).join(' ') === route.command)
  return { flags, fields, positionals, positionalIndices, allFlags, route }
}

function ghArguments(args: readonly string[], input: RunnerInput = {}) {
  if (input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (input.stdin !== undefined && !['gist create', 'gist edit'].includes(args.slice(0, 2).join(' '))) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    return { args: ['--version'], invocation: { command: 'version', help: false } }
  }
  const { flags, fields, positionals, allFlags, route } = parseGhArguments(args)
  if (positionals[0] === 'issue' && ['lock', 'unlock'].includes(positionals[1])) throw new ArtiumError('INVALID_INPUT',
    'Issue lock/unlock is unsupported: gh-axi 0.1.44 requests the locked issue field, which gh 2.101.0 does not export.',
    'A compatible published upstream release is required. Issue pin and transfer remain available.')
  if (flags.size === 1 && flags.has('help') && positionals.length === 0) {
    return { args: ['--help'], invocation: { command: 'help', help: true } }
  }
  if (positionals.length === 0 || positionals[0] === 'home') throw new ArtiumError('INVALID_INPUT',
    'The GitHub dashboard is unsupported and unverified: gh-axi 0.1.44 converts failed reads into successful empty results.',
    'Use artium-axi gh-axi issue list -R OWNER/NAME or artium-axi gh-axi pr list -R OWNER/NAME.')
  if (flags.size === 1 && flags.has('help') && positionals.length === 1
    && inventory.discovery.commands.includes(positionals[0])) {
    return { args: [...positionals, '--help'], invocation: { command: positionals[0], help: true } }
  }
  if (!route) throw invalidCommand('gh-axi', positionals, inventory.commands.map(route => route.command))
  const rest = positionals.slice(route.command.split(' ').length)
  if (route.positionals !== 'variadic' && rest.length > Number(route.positionals) || rest.some(value => /[\x00-\x1f\x7f]/.test(value))) throw new ArtiumError('INVALID_INPUT')
  for (const name of flags.keys()) if (!Object.hasOwn(route.flags, name)) {
    throw unknownFlag('gh-axi', route.command, `--${name}`, Object.keys(route.flags))
  }
  const help = flags.has('help')
  const stdin = ['gist create', 'gist edit'].includes(route.command) && flags.has('filename') && !help
  if (input.stdin !== undefined && !stdin || stdin && !input.stdin?.trim()) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (!help && route.effect === 'write' && rest.length !== Number(route.positionals)) throw new ArtiumError('INVALID_INPUT')
  if (route.command === 'repo create' && rest.some(value => !repositoryName.test(value))) throw new ArtiumError('FLAG_BLOCKED')
  if (!help && route.effect === 'write' && route.command.startsWith('project ')
    && !/^[A-Za-z0-9_-]+$/.test(flags.get('owner') ?? '')) throw new ArtiumError('INVALID_INPUT',
    'Project writes require an explicit owner login.', 'Pass --owner OWNER for the affected project and its recovery commands.')
  if (route.command === 'repo create' && !help && ['public', 'private', 'internal'].filter(name => flags.has(name)).length !== 1) throw new ArtiumError('INVALID_INPUT')
  if (route.command === 'gist create' && !help && (!stdin || ['public', 'secret'].filter(name => flags.has(name)).length !== 1)) throw new ArtiumError('INVALID_INPUT')
  if (route.command === 'gist edit' && !help && !stdin && !flags.has('desc')) throw new ArtiumError('INVALID_INPUT')
  if (route.command === 'pr create' && !help && (!flags.has('title') || !flags.has('body') || !flags.has('base') || !flags.has('head'))) throw new ArtiumError('INVALID_INPUT')
  if (!help && ['issue create', 'project item-create'].includes(route.command) && !flags.has('title')) throw new ArtiumError('INVALID_INPUT')
  if (!help && route.command === 'issue create' && !flags.has('body')) flags.set('body', '')
  if (!help && ['issue comment', 'pr comment', 'discussion comment'].includes(route.command) && !flags.get('body')?.trim()) throw new ArtiumError('INVALID_INPUT')
  if (!help && route.command === 'variable set' && !flags.has('body')) throw new ArtiumError('INVALID_INPUT')
  if (!help && (route.command === 'issue transfer' && !flags.has('to-repo')
    || route.command === 'project item-add' && !flags.has('url')
    || ['project item-edit', 'project item-archive'].includes(route.command) && !flags.has('id'))) throw new ArtiumError('INVALID_INPUT')
  if (flags.has('to-repo') && !repositoryName.test(flags.get('to-repo')!)) throw new ArtiumError('FLAG_BLOCKED')
  if (flags.has('template') && !repositoryName.test(flags.get('template')!)) throw new ArtiumError('FLAG_BLOCKED')
  if (route.command === 'workflow run' && fields.some(value => value.split('=').slice(1).join('=').startsWith('@'))) throw new ArtiumError('FLAG_BLOCKED')
  // A host-qualified repo or selector URL can override GH_HOST inside gh.
  if (flags.has('repo') && !repositoryName.test(flags.get('repo')!)) throw new ArtiumError('FLAG_BLOCKED')
  const selectors = ['issue', 'pr', 'discussion', 'gist', 'project', 'run'].includes(route.command.split(' ')[0])
    ? rest.slice(0, 1) : route.command.startsWith('repo ') ? rest : []
  if (selectors.some(value => value.includes(':') || value.startsWith('//'))) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  if (route.repository && !flags.has('help') && !flags.has('repo')) throw new ArtiumError('INVALID_INPUT',
    'Repository commands require -R OWNER/NAME.', 'Pass -R OWNER/NAME for the managed GitHub host.')
  if (route.command === 'api' && !flags.has('help')) {
    const method = rest.length === 2 ? rest[0].toUpperCase() : 'GET'
    const path = rest.at(-1)
    if (method !== 'GET' || !path || !/^\/?[A-Za-z0-9_]/.test(path) || /[\\:#\s{}]/.test(path)
      || path.startsWith('//')) throw new ArtiumError('FLAG_BLOCKED')
    let decoded: string
    try { decoded = decodeURIComponent(path.split('?')[0]) } catch { throw new ArtiumError('INVALID_INPUT') }
    if (decoded.replace(/^\//, '').split('/').some(part => ['graphql', '.', '..'].includes(part.toLowerCase()))) {
      throw new ArtiumError('FLAG_BLOCKED')
    }
  }
  const command = route.command.split(' ')
  const nativeGh = !help && (route.command === 'issue comment'
    || ['workflow enable', 'workflow disable'].includes(route.command) && /^\d+$/.test(rest[0])
    || flags.get('body') === '' && ['issue create', 'issue edit', 'pr create', 'pr edit', 'project item-create', 'project item-edit'].includes(route.command)
    || flags.get('description') === '' && ['label edit', 'repo edit'].includes(route.command))
  const nativeRepoEdit = nativeGh && route.command === 'repo edit'
  return { args: [...command, ...(nativeRepoEdit ? [flags.get('repo')!] : rest),
    ...[...flags].filter(([name]) => name !== 'confirm' && !(nativeRepoEdit && name === 'repo')
      && !(route.command === 'project item-edit' && name === 'owner')).flatMap(([name, value]) => name === 'field'
    ? fields.map(value => `--field=${value}`) : allFlags[name] === 'boolean'
    ? [nativeGh && route.command === 'issue edit' && name === 'no-type' ? '--remove-type' : `--${name}`] : route.command === 'run view' && ['job', 'conclusion'].includes(name)
      ? [`--${name}`, value] : [`--${name}=${value}`])], invocation: { command: route.command, help, nativeGh },
    mutation: route.effect === 'write' && !help ? { route: route.command, rest, flags, confirm: flags.get('confirm') } : undefined }
}

function readBack(call: ReturnType<typeof ghArguments>) {
  const { route, rest, flags } = call.mutation!
  const [group, action] = route.split(' ')
  const repo = flags.get('repo')
  let checkArgs: string[]
  if (group === 'project') checkArgs = ['project', ...(action === 'item-edit' ? ['list'] : ['item-list', ...rest]),
    '--owner', flags.get('owner')!, '--limit', '100']
  else if (group === 'label' || group === 'variable') checkArgs = [group, 'list']
  else if (group === 'workflow' && action === 'run') checkArgs = ['run', 'list', '--workflow', rest[0], '--limit', '100']
  else if (group === 'workflow') checkArgs = /^\d+$/.test(rest[0])
    ? ['api', `/repos/${repo}/actions/workflows/${rest[0]}`]
    : ['api', `/repos/${repo}/actions/workflows?per_page=100`, '--paginate']
  else if (route === 'pr revert') checkArgs = ['pr', 'list', '--state', 'all', '--limit', '100']
  else if (route === 'issue transfer') checkArgs = ['issue', 'list', '--state', 'all', '--limit', '100']
  else if (group === 'repo' && action === 'create') checkArgs = ['repo', 'list', rest[0].split('/')[0], '--limit', '100']
  else if (group === 'repo' && action === 'fork') checkArgs = ['api', `/repos/${repo}/forks?per_page=100`]
  else if (action === 'create') checkArgs = [group, 'list', '--limit', '100', ...(['issue', 'pr'].includes(group) ? ['--state', 'all'] : [])]
  else checkArgs = [group, 'view', ...(group === 'repo' ? [] : [rest[0]]), ...(['issue', 'pr', 'discussion'].includes(group) ? ['--comments'] : [])]
  if (repo && checkArgs[0] !== 'api') checkArgs.push('-R', route === 'issue transfer' ? flags.get('to-repo')! : repo)
  if (route === 'pr review') checkArgs.push('--reviews')
  return { operation: route, target: repo ?? 'managed GitHub resource', checkArgs,
    afterCheck: 'Inspect the affected resource, all relevant pages and GitHub audit evidence. A missing result does not prove failure; never blindly replay the write' }
}

export function createGhAdapter(source: SecretSource, tokens = new GithubAppTokenCache()): Adapter<unknown> {
  return { name: 'gh-axi', executable: toolPaths['gh-axi'], credentialSchema: ghCredentialSchema, credentialProfile: ghProfile,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: ghManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => {
      const flags = [...new Set(inventory.commands.flatMap(route => Object.keys(route.flags)))].filter(name => name !== 'repo').map(name => `--${name}`)
      if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) return { flags, positions: [] }
      const { positionals, positionalIndices, route } = parseGhArguments(args)
      const numericSelector = ['issue', 'pr', 'discussion', 'run', 'workflow', 'project'].includes(positionals[0])
      return { flags, positions: positionalIndices.slice(route?.command.split(' ').length ?? positionals.length)
        .filter((index, ordinal) => !(numericSelector && ordinal === 0 && /^\d+$/.test(args[index]))) }
    },
    validateArgs: (args, input) => { ghArguments(args, input) },
    invalidateCredential: reference => tokens.replace(reference.id, reference.revision ?? 0),
    async prepare(args, reference, input): Promise<PreparedCall> {
      const call = ghArguments(args, input)
      if (reference.tool !== 'gh-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const settings = source.getSettings?.(reference) ?? {}
      if (call.mutation) {
        const state = ghWritePolicy.read(settings)
        if (!state.enabled || !state.allowedOperations.includes(call.mutation.route)) throw new ArtiumError('FLAG_BLOCKED')
      }
      const parsed = ghCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const host = new URL(parsed.data.origin as string).host
      if (parsed.data.auth === 'device' && typeof parsed.data.accessTokenExpiresAt === 'number'
        && parsed.data.accessTokenExpiresAt <= Date.now()) throw new ArtiumError('CREDENTIAL_EXPIRED')
      const write = call.mutation ? readBack(call) : undefined
      if (call.mutation) {
        const confirm = createHash('sha256').update(JSON.stringify({ args: call.args, input, reference, settings, checkArgs: write!.checkArgs })).digest('hex')
        if (!call.mutation.confirm) return { executable: toolPaths['gh-axi'], args: [], environment: {}, files: [], secrets: [],
          effect: 'read', preview: { operation: write!.operation, target: write!.target, confirm }, limits: { timeoutMs: runnerLimits.timeoutMs } }
        if (call.mutation.confirm !== confirm) throw new ArtiumError('INVALID_INPUT', 'Confirmation does not match this request, input, credential revision and write policy.', 'Preview the exact request again without --confirm.')
      }
      const token = parsed.data.auth === 'github-app'
        ? await tokens.acquire(reference, parsed.data, source.getTrust?.(reference))
        : (parsed.data.auth === 'device' ? parsed.data.accessToken : parsed.data.token) as string
      return { ...call, executable: call.invocation.nativeGh ? '/usr/local/bin/gh' : toolPaths['gh-axi'],
        invocation: { ...call.invocation, ...(write ? { checkArgs: write.checkArgs } : {}), ...(parsed.data.auth === 'device' ? { credentialAuth: 'device' as const } : {}) }, environment: {
        [host === 'github.com' || host.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN']: token,
        GH_HOST: host, GH_BIN: '/usr/local/bin/gh', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', GH_TELEMETRY: '0', NO_COLOR: '1',
        GH_PAGER: 'cat', GOMEMLIMIT: '256MiB',
      }, files: [], secrets: [token, ...(parsed.data.auth === 'github-app' ? [parsed.data.privateKey as string] : [])],
      effect: write ? 'write' : 'read', ...(write ? { write } : {}), limits: { timeoutMs: runnerLimits.timeoutMs, systemCaBundle: true } }
    } }
}
