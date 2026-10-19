import inventory from '../../../tools/inventories/ado-axi.json' with { type: 'json' }
import { toolAllowsWrites } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { adoPathPrefix, runnerLimits, toolPaths } from '../config.js'
import type { RunnerInput } from '../runner/input.js'
import type { SecretSource } from '../store/secret-source.js'
import { CredentialProfile } from './credential-profile.js'
import { AzureTokenCache } from './azure-token-cache.js'
import type { Adapter, PreparedCall } from './types.js'

export const adoManifest = { ...inventory, ...inventory.adapterBoundary }
export const adoProfile = new CredentialProfile({ type: 'object', additionalProperties: false,
  required: ['org', 'auth'], properties: {
    org: { type: 'string', format: 'ado-org', title: 'Organization', description: 'Azure DevOps organization name or organization-root URL.' },
    project: { type: 'string', minLength: 1, title: 'Default project' },
    auth: { enum: ['pat', 'client-secret'], title: 'Authentication' },
    token: { type: 'string', 'x-secret': true, title: 'Personal access token' },
    tenantId: { type: 'string', format: 'uuid', title: 'Tenant ID' },
    clientId: { type: 'string', format: 'uuid', title: 'Client ID' },
    clientSecret: { type: 'string', 'x-secret': true, title: 'Client secret' },
    allowWrites: { type: 'boolean' },
  }, oneOf: [
    { properties: { auth: { const: 'pat' } }, required: ['token'],
      not: { anyOf: [{ required: ['tenantId'] }, { required: ['clientId'] }, { required: ['clientSecret'] }] } },
    { properties: { auth: { const: 'client-secret' } }, required: ['tenantId', 'clientId', 'clientSecret'],
      not: { required: ['token'] } },
  ] }, 'ado-axi')
export const adoCredentialSchema = adoProfile.credentialSchema

function adoArguments(args: readonly string[], input: RunnerInput = {}) {
  if (input.stdin !== undefined || input.files?.length) throw new ArtiumError('UNSUPPORTED_INPUT')
  if (args.some(token => /^--(?:org|profile|config)(?:=|$)/.test(token))) throw new ArtiumError('FLAG_BLOCKED')
  const flags = new Map<string, string>()
  const positionals: string[] = []
  const knownFlags = Object.assign({}, ...inventory.commands.map(route => route.flags)) as Record<string, string>
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positionals.push(token); continue }
    if (['-v', '--version'].includes(token) && args.length === 1) {
      return { args: ['--version'], command: 'home', effect: 'read' as const, positionals: [], flags }
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/s.exec(token)
    if (!match) throw new ArtiumError('INVALID_INPUT')
    const [, name, inline] = match
    if (!Object.hasOwn(knownFlags, name)) throw new ArtiumError('INVALID_INPUT', `Unknown flag --${name} for ado-axi.`,
      'Run artium-axi ado-axi --help for managed command guidance.')
    if (flags.has(name)) throw new ArtiumError('INVALID_INPUT')
    const boolean = knownFlags[name] === 'boolean'
    const value = inline ?? (boolean ? ['true', 'false'].includes(args[index + 1]) ? args[++index] : 'true' : args[++index])
    if (value === undefined || boolean && !['true', 'false'].includes(value)) throw new ArtiumError('INVALID_INPUT')
    flags.set(name, value)
  }
  const aliases: Record<string, string> = inventory.aliases
  positionals[0] = aliases[positionals[0]] ?? positionals[0] ?? 'home'
  if (['config', 'update'].includes(positionals[0])) throw new ArtiumError('FLAG_BLOCKED')
  if (['work-item', 'pr', 'pipeline', 'repo', 'ref', 'project'].includes(positionals[0]) && positionals.length === 1) positionals.push('list')
  if (positionals[0] === 'test' && (!positionals[1] || /^\d+$/.test(positionals[1]))) positionals.splice(1, 0, 'results')
  if (positionals[0] === 'work-item' && ['link', 'links'].includes(positionals[1]) || positionals[0] === 'pr' && positionals[1] === 'thread') {
    if (!positionals[2] || /^\d+$/.test(positionals[2])) positionals.splice(2, 0, 'list')
  }
  if (positionals[0] === 'pr' && positionals[1] === 'reviewer' && !positionals[2]) positionals.push('list')
  const candidates = inventory.commands.flatMap(route => [route.command, ...route.aliases].map(command => ({ route, command })))
    .sort((a, b) => b.command.length - a.command.length)
  const match = candidates.find(({ command }) => positionals.slice(0, command.split(' ').length).join(' ') === command)
  if (!match) throw new ArtiumError('FLAG_BLOCKED')
  const { route, command } = match
  const rest = positionals.slice(command.split(' ').length)
  const routeFlags: Record<string, string | undefined> = route.flags
  for (const name of flags.keys()) {
    if (!Object.hasOwn(routeFlags, name)) throw new ArtiumError('INVALID_INPUT', `Unknown flag --${name} for ado-axi ${command}.`,
      `Valid flags: ${Object.keys(routeFlags).filter(flag => !adoManifest.unsafeOverrides.includes(flag)).map(flag => `--${flag}`).join(', ')}.`)
  }
  if (rest.length > route.positionals) throw new ArtiumError('INVALID_INPUT')
  if (command === 'api') {
    const verb = /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)$/i.test(rest[0] ?? '') ? rest[0].toUpperCase() : undefined
    const path = rest[verb ? 1 : 0]
    if (verb && verb !== 'GET' || flags.has('method') && flags.get('method')!.toUpperCase() !== 'GET'
      || flags.has('body') || flags.has('content-type') || path && (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//'))) {
      throw new ArtiumError('FLAG_BLOCKED')
    }
    if (!flags.has('help') && (!path || rest.length !== (verb ? 2 : 1))) throw new ArtiumError('INVALID_INPUT')
  }
  // Put positionals before flags so upstream's greedy boolean parser cannot
  // consume a command or ID as a flag value. SDK help detection needs --help.
  const normalized = route.command === 'home' && flags.get('help') === 'true' ? ['--help'] : [...positionals, ...[...flags].flatMap(([name, value]) =>
    routeFlags[name] === 'boolean' || value.startsWith('--') ? [name === 'help' && value === 'true' ? '--help' : `--${name}=${value}`] : [`--${name}`, value])]
  return { args: normalized, command: route.command, effect: flags.get('help') === 'true' ? 'read' : route.effect,
    positionals: rest, flags }
}

function readBack(call: ReturnType<typeof adoArguments>): PreparedCall['write'] {
  const [group, operation] = call.command.split(' ')
  const id = call.positionals[0] ?? call.flags.get('id')
  const repo = call.flags.get('repo')
  let checkArgs: string[]
  let selectors: string[] = []
  let afterCheck: string | undefined
  if (group === 'work-item') {
    if (operation === 'create' || !id) {
      checkArgs = ['work-item', 'list', '--state', 'all', '--limit', '1000']
      if (call.flags.has('title')) checkArgs.push('--search', call.flags.get('title')!)
      selectors = ['type']
    } else if (operation === 'comment') {
      checkArgs = ['api', `_apis/wit/workItems/${encodeURIComponent(id)}/comments`, '--api-version', '7.1-preview.4',
        '--query', '$order=desc&$top=200', '--full']
      afterCheck = 'Inspect complete comment text and follow any continuation token before retrying'
    } else {
      checkArgs = ['api', `_apis/wit/workitems/${encodeURIComponent(id)}`, '--no-project', '--query', '$expand=all', '--full']
    }
  } else if (group === 'pr') {
    if (operation === 'create' || !id) {
      checkArgs = ['pr', 'list', '--status', 'all', '--limit', '1000']
      selectors = ['repo', 'source', 'target']
    } else if (['comment', 'thread'].includes(operation)) {
      checkArgs = ['pr', 'get', id, '--threads', '--full']
      selectors = ['repo']
    } else {
      checkArgs = ['api', repo ? `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${encodeURIComponent(id)}`
        : `_apis/git/pullrequests/${encodeURIComponent(id)}`, '--full']
      if (!repo) checkArgs.push('--no-project')
    }
  } else if (group === 'pipeline') {
    checkArgs = ['pipeline', 'runs', '--limit', '1000']
    const pipeline = call.flags.get('pipeline') ?? id
    if (pipeline) checkArgs.push('--pipeline', pipeline)
    selectors = ['branch']
  } else {
    checkArgs = ['ref', 'list', '--full']
    selectors = ['repo', 'name']
  }
  for (const name of [...selectors, 'project']) if (call.flags.has(name)) checkArgs.push(`--${name}`, call.flags.get(name)!)
  if (operation === 'create' || group === 'pipeline' || group === 'ref') {
    afterCheck = 'Results may be limited; absence from this read does not prove the write failed. Inspect matching resources and any further pages before retrying'
  }
  return { operation: call.command, target: id ?? call.flags.get('name') ?? 'new resource', checkArgs,
    ...(afterCheck ? { afterCheck } : {}) }
}

export function createAdoAdapter(source: SecretSource, cache = new AzureTokenCache()): Adapter<unknown> {
  return {
    name: 'ado-axi', executable: toolPaths['ado-axi'], credentialSchema: adoCredentialSchema, credentialProfile: adoProfile,
    invalidateCredential: reference => { cache.replace(reference.id, reference.revision!) },
    timeoutMs: runnerLimits.timeoutMs, blockedFlags: adoManifest.unsafeOverrides.map(name => `--${name}`), allowedFlagValues: {},
    sensitiveArguments: args => ({ flags: ['--body', '--description', '--title', '--set', '--query', '--comment'],
      positions: args.map((_, index) => index).filter(index => index > 0 && !args[index].startsWith('-')) }),
    validateArgs: (args, input) => { adoArguments(args, input) },
    async prepare(args, reference, input) {
      const call = adoArguments(args, input)
      if (reference.tool !== 'ado-axi') throw new ArtiumError('CREDENTIAL_INVALID')
      if (call.effect === 'write' && source.getSettings && !toolAllowsWrites('ado-axi', source.getSettings(reference))) {
        throw new ArtiumError('FLAG_BLOCKED')
      }
      const parsed = adoCredentialSchema.safeParse(await source.getCredential(reference))
      if (!parsed.success) throw new ArtiumError('CREDENTIAL_INVALID')
      const value = parsed.data
      if (call.effect === 'write' && !toolAllowsWrites('ado-axi', value)) throw new ArtiumError('FLAG_BLOCKED')
      const clientSecret = value.auth === 'client-secret'
      if (clientSecret && !reference.revision) throw new ArtiumError('CREDENTIAL_INVALID')
      const minted = clientSecret ? (await cache.acquire({ id: reference.id, revision: reference.revision!, credential: {
        auth: 'secret', tenantId: value.tenantId as string, clientId: value.clientId as string, clientSecret: value.clientSecret as string,
      }, trust: source.getTrust?.(reference) }, { required: ['devops'], optional: [] })).devops! : undefined
      const token = minted?.accessToken ?? value.token as string
      return { executable: toolPaths['ado-axi'], args: call.args,
        environment: { ADO_AXI_CONFIG: 'ado-profile.json', ARTIUM_SECRET_0: token,
          ...(minted ? { ARTIUM_ADO_EXPIRES_ON: new Date(minted.expiresAt).toISOString().replace('T', ' ').replace('Z', '') } : {}) },
        ...(minted ? { pathPrefix: adoPathPrefix } : {}),
        files: [{ name: 'ado-profile.json', content: JSON.stringify({ defaultProfile: 'artium', profiles: {
          artium: { org: value.org, ...(value.project ? { project: value.project } : {}),
            ...(minted ? { auth: 'az' } : { auth: 'pat', patEnv: 'ARTIUM_SECRET_0' }) },
        } }) }], secrets: minted ? [...new Set([value.clientSecret as string, ...minted.secrets])] : [token, Buffer.from(`:${token}`).toString('base64')],
        effect: call.effect as 'read' | 'write', ...(call.effect === 'write' ? { write: readBack(call) } : {}),
        limits: { timeoutMs: runnerLimits.timeoutMs } }
    },
  }
}
