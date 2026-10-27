import inventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import { ArtiumError } from '../../shared/errors.js'
import { runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import type { Adapter } from './types.js'
import { invalidCommand, unknownFlag } from './input-diagnostics.js'
import { writePolicy } from './write-policy.js'
import { GithubAppTokenCache } from './github-app-tokens.js'

export const ghManifest = { ...inventory, ...inventory.adapterBoundary }
export const ghWritePolicy = writePolicy({ reason: 'This slice supports reads only.', unlocks: 'Read-only GitHub API access.',
  blocked: 'All writes, local git commands, downloads and arbitrary API methods are unavailable.' })
export const ghProfile = new CredentialProfile({ type: 'object', additionalProperties: false,
  required: ['origin', 'auth'], properties: {
    origin: { type: 'string', format: 'canonical-https-origin', default: 'https://github.com', title: 'GitHub origin',
      description: 'https://github.com or your GitHub Enterprise HTTPS origin.' },
    auth: { enum: ['token', 'github-app', 'device'], title: 'Authentication' },
    accessToken: { type: 'string', 'x-secret': true, description: 'Managed by Connect with GitHub.' },
    accessTokenExpiresAt: { type: 'integer', minimum: 1 },
    login: { type: 'string', pattern: '^[A-Za-z0-9-]+$', maxLength: 100 },
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

function ghArguments(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    return { args: ['--version'], invocation: { command: 'version', help: false } }
  }
  const flags = new Map<string, string>()
  const positionals: string[] = []
  const allFlags: Record<string, string> = Object.assign({}, ...inventory.commands.map(route => route.flags))
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); continue }
    const match = /^(--[a-z][a-z-]*|-R|-h|-X)(?:=(.*))?$/s.exec(token)
    if (!match) throw unknownFlag('gh-axi', positionals.join(' ') || 'home', token, Object.keys(allFlags))
    const name = ({ '-R': 'repo', '-h': 'help', '-X': 'method' } as Record<string, string>)[match[1]] ?? match[1].slice(2)
    if (ghManifest.unsafeOverrides.includes(name) || name === 'method') throw new ArtiumError('FLAG_BLOCKED')
    if (!Object.hasOwn(allFlags, name)) throw unknownFlag('gh-axi', positionals.join(' ') || 'home', token, Object.keys(allFlags))
    if (flags.has(name)) throw new ArtiumError('INVALID_INPUT')
    if (allFlags[name] === 'boolean') {
      if (match[2] !== undefined) throw new ArtiumError('INVALID_INPUT')
      flags.set(name, '')
    } else {
      const value = match[2] ?? args[++index]
      if (!value || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value)) throw new ArtiumError('INVALID_INPUT')
      flags.set(name, value)
    }
  }
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
  const route = [...inventory.commands].sort((a, b) => b.command.length - a.command.length)
    .find(route => positionals.slice(0, route.command.split(' ').length).join(' ') === route.command)
  if (!route) throw invalidCommand('gh-axi', positionals, inventory.commands.map(route => route.command))
  const rest = positionals.slice(route.command.split(' ').length)
  if (route.positionals !== 'variadic' && rest.length > Number(route.positionals) || rest.some(value => /[\x00-\x1f\x7f]/.test(value))) throw new ArtiumError('INVALID_INPUT')
  for (const name of flags.keys()) if (!Object.hasOwn(route.flags, name)) {
    throw unknownFlag('gh-axi', route.command, `--${name}`, Object.keys(route.flags))
  }
  // A host-qualified repo or selector URL can override GH_HOST inside gh.
  if (flags.has('repo') && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(flags.get('repo')!)) throw new ArtiumError('FLAG_BLOCKED')
  if (route.command !== 'api' && !route.command.startsWith('search ') && rest.some(value => value.includes(':') || value.startsWith('//'))) {
    throw new ArtiumError('FLAG_BLOCKED')
  }
  if (route.repository && !flags.has('help') && !flags.has('repo')) throw new ArtiumError('INVALID_INPUT',
    'Repository reads require -R OWNER/NAME.', 'Pass -R OWNER/NAME for the managed GitHub host.')
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
  return { args: [...command, ...rest, ...[...flags].flatMap(([name, value]) => allFlags[name] === 'boolean'
    ? [`--${name}`] : route.command === 'run view' && ['job', 'conclusion'].includes(name)
      ? [`--${name}`, value] : [`--${name}=${value}`])], invocation: { command: route.command, help: flags.has('help') } }
}

export function createGhAdapter(source: SecretSource, tokens = new GithubAppTokenCache()): Adapter<unknown> {
  return { name: 'gh-axi', executable: toolPaths['gh-axi'], credentialSchema: ghCredentialSchema, credentialProfile: ghProfile,
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: ghManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: ['--query'], positions: args.map((_, index) => index).filter(index => index > 1) }),
    validateArgs: (args, input) => { ghArguments(args, input) },
    invalidateCredential: reference => tokens.replace(reference.id, reference.revision ?? 0),
    async prepare(args, reference, input) {
      const call = ghArguments(args, input)
      if (reference.tool !== 'gh-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      const parsed = ghCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const host = new URL(parsed.data.origin as string).host
      if (parsed.data.auth === 'device' && typeof parsed.data.accessTokenExpiresAt === 'number'
        && parsed.data.accessTokenExpiresAt <= Date.now()) throw new ArtiumError('CREDENTIAL_EXPIRED')
      const token = parsed.data.auth === 'github-app'
        ? await tokens.acquire(reference, parsed.data, source.getTrust?.(reference))
        : (parsed.data.auth === 'device' ? parsed.data.accessToken : parsed.data.token) as string
      return { executable: toolPaths['gh-axi'], ...call,
        invocation: { ...call.invocation, ...(parsed.data.auth === 'device' ? { credentialAuth: 'device' as const } : {}) }, environment: {
        [host === 'github.com' || host.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN']: token,
        GH_HOST: host, GH_BIN: '/usr/local/bin/gh', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', GH_TELEMETRY: '0', NO_COLOR: '1',
        GH_PAGER: 'cat', GOMEMLIMIT: '256MiB',
      }, files: [], secrets: [token, ...(parsed.data.auth === 'github-app' ? [parsed.data.privateKey as string] : [])],
      effect: 'read', limits: { timeoutMs: runnerLimits.timeoutMs, systemCaBundle: true } }
    } }
}
