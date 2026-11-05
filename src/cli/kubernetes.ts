import { encode } from '@toon-format/toon'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { kubernetesFile, kubernetesHostedCommands, kubernetesHostedArguments, kubernetesSessionStart, kubernetesWorkspaceManifest, kubernetesSessionView as sessionSchema } from '../shared/kubernetes.js'
import { kubernetesTunnel } from './kubernetes-tunnel.js'
import { kubernetesCredential } from './kubernetes-credential.js'
import { ArtiumError } from '../shared/errors.js'
import { artifactDestination } from './artifact-save.js'
import type { Client } from './http.js'
import { DEFAULT_REQUEST_DEADLINE_MS } from './http.js'
import inventory from '../../tools/inventories/kubernetes-axi.json' with { type: 'json' }

const workspaceSchema = z.object({ id: z.uuid(), expiresAt: z.number(),
  files: z.array(kubernetesFile.extend({ state: z.enum(['empty', 'uploading', 'ready']) })), ready: z.boolean() }).passthrough()
function validated<S extends z.ZodType>(schema: S, value: unknown, code: 'INVALID_INPUT' | 'INVALID_RESPONSE' = 'INVALID_INPUT'): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new ArtiumError(code)
  return result.data
}
async function fileBytes(path: string, limit = 100 * 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new ArtiumError('INVALID_INPUT') })
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new ArtiumError('INVALID_INPUT')
    const bytes = await file.readFile()
    if (bytes.length !== info.size) throw new ArtiumError('INVALID_INPUT')
    return bytes
  } finally { await file.close() }
}

export async function kubernetesHosted(args: string[], createClient: () => Client, write: (text: string, stream?: 'stdout' | 'stderr') => void): Promise<boolean> {
  let prefix = 0
  while (args[prefix] === '--json') prefix++
  if (args[prefix] === 'tunnel') return kubernetesTunnel(createClient, [...args.slice(prefix), ...(prefix ? ['--json'] : [])], text => write(text))
  if (args[prefix] === 'credential') return kubernetesCredential(createClient, [...args.slice(prefix), ...(prefix ? ['--json'] : [])], text => write(text))
  const [group, action, ...rest] = args.slice(prefix)
  if (!['workspace', 'session'].includes(group ?? '')) {
    if (args.includes('--help') && args.every(arg => ['--help', '--json'].includes(arg))) {
      const help = { command: 'artium-axi kubernetes-axi', usage: 'artium-axi kubernetes-axi <command> [flags]',
        commands: inventory.discovery.commands,
        flags: ['--namespace <name>', '--json', '--help'],
        help: ['Reads use managed credentials. Mutations require administrator Allow writes, off by default.',
          'Use prepare -- <mutation>, preview <request-key>, then confirm <request-key> --digest <exact-digest>.',
          'Byte sessions also require explicit caller/session-kind grants. Each session is one bounded operation.',
          'Use tunnel for an approved port-forward session. Credential issuance also requires administrator acquireCredential=true and private credential --credential-fd delivery.',
          'Use each command with --help. Interactive execution remains unavailable.'] }
      const text = (args.includes('--json') ? JSON.stringify(help) : encode(help)) + '\n'
      write(text); write(text, 'stderr'); return true
    }
    return false
  }
  const { flags, positionals, native, help, route } = kubernetesHostedArguments(rest, group, action)
  const print = (value: unknown) => write((prefix || flags.has('--json') ? JSON.stringify(value) : encode(value)) + '\n')
  if (help) {
    print({ usage: `artium-axi kubernetes-axi ${group} <command> [flags]`, commands: kubernetesHostedCommands.filter(command => command.startsWith(group)),
      flags: '--json, --help; start: --workspace <id>, --stdin-file <file> or --input-workspace <id> --input-path <path>, --timeout 1-1800, --output-limit 1-1048576',
      help: ['Native arguments follow --. Session start prepends prepare -- for mutation kinds; inspect its preview, then confirm the exact digest.',
        'Kinds: watch, logs, exec, attach, apply, create, cp, port-forward. Every kind needs its explicit caller grant; mutations additionally need Allow writes.',
        'Logs and watch start immediately as reads. Other kinds return a native preview for exact-digest confirmation.',
        'For port-forward use session show <id> --ready, then tunnel <id> --port <approved-remote-port>. Local listeners bind only 127.0.0.1.',
        'Workspace paths use workspace:<relative-path>; copy downloads use artifact:<relative-path>. Copy requires tar in the container.',
        'A session runs one bounded operation and never reconnects or replays automatically. Recover a lost start reply with session list.',
        'Inspect state after interrupted confirmation. Output is bounded and may be truncated; --wait on output waits up to 20 seconds for more bytes.',
        'Downloads need a new absolute file in an existing private (0700) directory. Bytes and SHA-256 are verified before publication.'] })
    return true
  }
  let client: Client | undefined
  const current = () => client ??= createClient()
  const base = `/v1/tools/kubernetes-axi/${group === 'workspace' ? 'workspaces' : 'sessions'}`
  // Refresh only a passive identity read; each effectful request is sent once.
  const call = async (path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', input?: unknown, deadlineMs?: number) => {
    const client = current()
    await client.authenticated('/v1/me', 'GET')
    return client.transferSession(token => client.request(path, method, input, token, false, undefined, deadlineMs))
  }
  if (route === 'workspace create') {
    if (positionals.length !== 1) throw new ArtiumError('INVALID_INPUT')
    const root = resolve(positionals[0]), files: { path: string, bytes: number, sha256: string }[] = []
    if (!(await lstat(root).catch(() => { throw new ArtiumError('INVALID_INPUT') })).isDirectory()) throw new ArtiumError('INVALID_INPUT')
    const visit = async (directory: string, relative = ''): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => { throw new ArtiumError('INVALID_INPUT') })) {
        const path = relative + entry.name, source = join(directory, entry.name)
        if (entry.isDirectory()) await visit(source, path + '/')
        else if (entry.isFile()) {
          const bytes = await fileBytes(source)
          files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
          if (files.length > 100 || files.reduce((sum, file) => sum + file.bytes, 0) > 250 * 1024 * 1024) throw new ArtiumError('INVALID_INPUT')
        } else throw new ArtiumError('INVALID_INPUT')
      }
    }
    await visit(root)
    const manifest = validated(kubernetesWorkspaceManifest, { files })
    const workspace = validated(workspaceSchema, await call(base, 'POST', manifest), 'INVALID_RESPONSE')
    try {
      for (const file of files) await call(`${base}/${workspace.id}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`, 'PUT', await fileBytes(join(root, file.path)))
      print(validated(workspaceSchema, await call(`${base}/${workspace.id}?operation=create`, 'GET'), 'INVALID_RESPONSE'))
    } catch (error) { try { await call(`${base}/${workspace.id}?operation=create`, 'DELETE') } catch { /* Expiry also removes staged files. */ }; throw error }
    return true
  }
  if (route === 'session list') {
    if (positionals.length) throw new ArtiumError('INVALID_INPUT')
    print(await call(base, 'GET')); return true
  }
  if (route === 'session start') {
    if (positionals.length !== 1 || !native.length) throw new ArtiumError('INVALID_INPUT')
    const kind = positionals[0]
    const input = validated(kubernetesSessionStart, { kind,
      argv: ['watch', 'logs'].includes(kind) ? native : ['prepare', '--', ...native], workspace: flags.get('--workspace'),
      ...(flags.has('--stdin-file') ? { stdinBase64: (await fileBytes(flags.get('--stdin-file')!, 512 * 1024)).toString('base64') } : {}),
      ...(flags.has('--input-workspace') || flags.has('--input-path') ? { inputArtifact: { workspace: flags.get('--input-workspace'), path: flags.get('--input-path') } } : {}),
      limits: { lifetimeSeconds: flags.has('--timeout') ? Number(flags.get('--timeout')) : undefined,
        outputBytes: flags.has('--output-limit') ? Number(flags.get('--output-limit')) : undefined },
    })
    print(validated(sessionSchema, await call(base, 'POST', input), 'INVALID_RESPONSE')); return true
  }
  const id = validated(z.uuid(), positionals[0]), path = `${base}/${id}`
  if (route === 'workspace download' || route === 'session artifact') {
    if (positionals.length !== 2 || !flags.has('--output')) throw new ArtiumError('INVALID_INPUT')
    const metadataPath = path + '?operation=' + action
    const status = group === 'workspace' ? validated(workspaceSchema, await call(metadataPath, 'GET'), 'INVALID_RESPONSE') : validated(sessionSchema, await call(metadataPath, 'GET'), 'INVALID_RESPONSE')
    const file = (group === 'workspace' ? (status as z.infer<typeof workspaceSchema>).files : (status as z.infer<typeof sessionSchema>).artifacts)?.find(file => file.path === positionals[1])
    if (!file) throw new ArtiumError('NOT_FOUND')
    const destination = await artifactDestination(flags.get('--output')!)
    const archive = { archiveBytes: file.bytes, archiveSha256: file.sha256 }
    try {
      await current().transferSession(token => current().artifact(`${path}/${group === 'workspace' ? 'files' : 'artifacts'}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        undefined, token, '', status.expiresAt, (response, signal) => destination.save(response, archive, signal), 'GET'))
      print({ ...file, saveOutcome: 'verified-save' })
    } finally { await destination.close() }
    return true
  }
  if (positionals.length !== 1) throw new ArtiumError('INVALID_INPUT')
  if (action === 'delete' || action === 'cancel') {
    if (action === 'cancel' && !flags.has('--confirm')) throw new ArtiumError('INVALID_INPUT')
    await call(path, 'DELETE'); print({ id, state: 'cancelled' }); return true
  }
  if (action === 'confirm') {
    const digest = validated(z.string().regex(/^[a-f0-9]{64}$/), flags.get('--digest'))
    print(await call(path + '/confirm', 'POST', { digest })); return true
  }
  if (route === 'session show' && (flags.has('--wait') || flags.has('--ready'))) {
    const session = validated(sessionSchema, await call(path, 'GET'), 'INVALID_RESPONSE')
    const deadlineMs = Math.max(0, session.expiresAt - Date.now()) + DEFAULT_REQUEST_DEADLINE_MS
    print(await call(path + '?wait=' + (flags.has('--ready') ? 'ready' : 'true'), 'GET', undefined, deadlineMs)); return true
  }
  const query = new URLSearchParams()
  if (flags.has('--wait')) query.set('wait', 'true')
  if (flags.has('--after')) query.set('after', String(validated(z.coerce.number().int().min(0), flags.get('--after'))))
  print(await call(path + (action === 'output' ? '/output' : '') + (query.size ? '?' + query : ''), 'GET'))
  return true
}
