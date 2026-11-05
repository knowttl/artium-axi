import { z } from 'zod'
import { ArtiumError } from './errors.js'

export const kubernetesHostedCommands = [
  'workspace create <directory>', 'workspace show <id>', 'workspace download <id> <path> --output <absolute-file>', 'workspace delete <id>',
  'session list', 'session start <kind> [--workspace <id>] [--stdin-file <file>] -- <native arguments>',
  'session show <id> [--wait]', 'session output <id> [--after <sequence>] [--wait]',
  'session confirm <id> --digest <exact-digest>', 'session cancel <id> --confirm',
  'session artifact <id> <path> --output <absolute-file>',
  'tunnel <session-id> --port <remote-port> [--port <remote-port>]',
  'credential <result-id> --credential-fd <private-pipe-fd>',
] as const

export const kubernetesHostedRoutes = kubernetesHostedCommands.map(usage => {
  const command = usage.split(' ').slice(0, /^(tunnel|credential) /.test(usage) ? 1 : 2).join(' ')
  return { command, effect: ['workspace show', 'workspace download', 'session list', 'session show', 'session output', 'session artifact'].includes(command) ? 'read' : 'write' }
})

export function resolveKubernetesHostedCommand(args: readonly string[]): string | undefined {
  let prefix = 0
  while (args[prefix] === '--json') prefix++
  const [group, action, ...rest] = args.slice(prefix)
  if (['tunnel', 'credential'].includes(group)) return group
  if (!['workspace', 'session'].includes(group)) return undefined
  const { route: command, help } = kubernetesHostedArguments(rest, group, action)
  if (help && (action === undefined || action === '--help')) return group
  return kubernetesHostedRoutes.find(route => route.command === command)?.command
}

export function kubernetesHostedArguments(rest: readonly string[], group: string, action?: string) {
  const separator = rest.indexOf('--'), controls = separator === -1 ? rest : rest.slice(0, separator)
  const native = separator === -1 ? [] : rest.slice(separator + 1)
  const flags = new Map<string, string>(), positionals: string[] = []
  const booleans = ['--json', '--help', '--wait', '--ready', '--confirm']
  const values = ['--workspace', '--stdin-file', '--input-workspace', '--input-path', '--timeout', '--output-limit', '--digest', '--after', '--output']
  for (let index = 0; index < controls.length; index++) {
    const word = controls[index]
    if (booleans.includes(word)) { if (flags.has(word)) throw new ArtiumError('INVALID_INPUT'); flags.set(word, 'true') }
    else if (values.includes(word)) {
      if (flags.has(word) || controls[index + 1] === undefined || controls[index + 1].startsWith('--')) throw new ArtiumError('INVALID_INPUT')
      flags.set(word, controls[++index])
    } else if (word.startsWith('-')) throw new ArtiumError('INVALID_INPUT')
    else positionals.push(word)
  }
  const help = action === '--help' || flags.has('--help') || action === undefined
  const allowed: Record<string, string[]> = { 'workspace create': [], 'workspace show': [], 'workspace delete': [],
    'workspace download': ['--output'], 'session list': [], 'session start': values.filter(flag => !['--digest', '--after', '--output'].includes(flag)),
    'session show': ['--wait', '--ready'], 'session output': ['--after', '--wait'], 'session confirm': ['--digest'],
    'session cancel': ['--confirm'], 'session artifact': ['--output'] }
  const route = `${group} ${action}`
  if (!help && (!allowed[route] || [...flags.keys()].some(flag => flag !== '--json' && !allowed[route].includes(flag))
    || route !== 'session start' && separator !== -1 || flags.has('--wait') && flags.has('--ready'))) throw new ArtiumError('INVALID_INPUT')
  return { flags, positionals, native, help, route }
}

export const kubernetesSessionKind = z.enum(['watch', 'logs', 'exec', 'attach', 'apply', 'create', 'cp', 'port-forward'])
export const kubernetesSessionPolicy = z.strictObject({
  grants: z.record(z.string().min(1).max(128), z.array(kubernetesSessionKind).max(8)),
  lifetimeSeconds: z.number().int().min(1).max(1800).optional(),
  outputBytes: z.number().int().min(1).max(1048576).optional(),
})
export const kubernetesWorkspacePath = z.string().min(1).max(1024).refine(path =>
  !/[\\:\x00-\x1f\x7f]/.test(path) && path.split('/').every(part =>
    part.length > 0 && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
export const kubernetesFile = z.strictObject({ path: kubernetesWorkspacePath,
  bytes: z.number().int().min(0).max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
export const kubernetesSessionView = z.object({ id: z.uuid(), expiresAt: z.number(),
  state: z.enum(['starting', 'prepared', 'running', 'exited', 'failed', 'cancelled', 'expired']),
  artifacts: z.array(kubernetesFile).optional(), remotePorts: z.array(z.number().int().min(1).max(65535)).optional(),
  tunnelReady: z.boolean().optional(),
}).passthrough()
export const kubernetesWorkspaceManifest = z.strictObject({ files: z.array(kubernetesFile).min(1).max(100),
  lifetimeSeconds: z.number().int().min(1).max(1800).default(300) })
export const kubernetesSessionStart = z.strictObject({ kind: kubernetesSessionKind,
  argv: z.array(z.string().max(8192)).min(1).max(256), workspace: z.uuid().optional(),
  stdinBase64: z.string().max(4 * Math.ceil(512 * 1024 / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
  inputArtifact: z.strictObject({ workspace: z.uuid(), path: kubernetesWorkspacePath }).optional(),
  limits: z.strictObject({ lifetimeSeconds: z.number().int().min(1).max(1800).optional(),
    outputBytes: z.number().int().min(1).max(1048576).optional() }).default({}),
}).refine(input => input.stdinBase64 === undefined || input.inputArtifact === undefined)
