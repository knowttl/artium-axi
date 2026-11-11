import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { shodanExportInput } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import { artifactDestination } from './artifact-save.js'
import type { Client } from './http.js'

const prefix = '/v1/tools/shodan-axi/exports'
const help = `usage: artium-axi shodan-axi download <query> --output <absolute-new-path> [options]
       artium-axi shodan-axi alert download [--alert-id <id>] --output <absolute-new-path> [options]
Preview first with --limit, --max-bytes, --query-credit-budget and --max-requests; optional --fields <a,b> selects fields.
Repeat the same options with --execute --confirm <token> to run the retained export and save it.
The file is gzip JSONL. A complete export is saved at --output; an incomplete one is saved at --output.partial and exits 1.
Saving requires Linux and a new normalized absolute path in an existing directory owned by the current user with mode 0700 and no symlink components.
Neither the --output path nor the same path with a .partial suffix may exist. The file has mode 0600, its size and SHA-256 are verified, and it is never overwritten.
The server releases the export after one retrieval, so a failed save needs a new preview and confirmation.
Add --json for JSON output instead of the default TOON output.
`
const exportResult = z.object({ count: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(), complete: z.boolean(),
  bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), retainedUntil: z.number() })
const statusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('running') }),
  z.object({ state: z.literal('failed'), result: z.object({ error: z.string() }) }),
  z.object({ state: z.enum(['completed', 'partial']), result: exportResult }),
])

export async function shodanExport(args: string[], createClient: () => Client, output: (stream: 'stdout' | 'stderr', text: string) => void, instance?: string) {
  const alert = args[0] === 'alert' && args[1] === 'download'
  if (!alert && args[0] !== 'download') return false
  if (args.includes('--help')) {
    output('stdout', help)
    return true
  }
  const values = new Map<string, string>(), switches = new Set<string>(), positional: string[] = []
  const valueFlags = new Set(['--limit', '--max-bytes', '--query-credit-budget', '--max-requests', '--fields', '--output', '--confirm',
    ...(alert ? ['--alert-id'] : [])])
  for (let index = alert ? 2 : 1; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positional.push(token); continue }
    if (['--json', '--execute'].includes(token)) {
      if (switches.has(token)) throw new ArtiumError('INVALID_INPUT')
      switches.add(token)
    } else if (valueFlags.has(token) && !values.has(token) && args[index + 1] && !args[index + 1].startsWith('--')) values.set(token, args[++index])
    else throw new ArtiumError('INVALID_INPUT')
  }
  const number = (name: string) => {
    const value = values.get(name)
    if (value === undefined) return undefined
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ArtiumError('INVALID_INPUT')
    return Number(value)
  }
  const confirm = values.get('--confirm'), path = values.get('--output')
  if (positional.length !== (alert ? 0 : 1) || !path || switches.has('--execute') !== (confirm !== undefined)
    || confirm !== undefined && !z.uuid().safeParse(confirm).success) throw new ArtiumError('INVALID_INPUT')
  const bounds = { fields: values.get('--fields')?.split(','), limit: number('--limit'), maxBytes: number('--max-bytes'),
    queryCreditBudget: number('--query-credit-budget'), maxRequests: number('--max-requests') }
  const parsed = shodanExportInput.safeParse(alert ? { command: 'alert download', alertId: values.get('--alert-id'), ...bounds }
    : { command: 'download', query: positional[0], ...bounds })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  const format = (value: unknown) => (switches.has('--json') ? JSON.stringify(value) : encode(value)) + '\n'
  const destinations: Awaited<ReturnType<typeof artifactDestination>>[] = []
  const client = createClient()
  const interrupt = () => client.cancel()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    destinations.push(await artifactDestination(path))
    destinations.push(await artifactDestination(path + '.partial'))
    await client.authenticated('/v1/me', 'GET')
    const call = (route: string, body: object) => client.transferSession(token => client.request(prefix + route, 'POST', instance === undefined ? body : { ...body, instance }, token))
    if (!confirm) {
      output('stdout', format(await call('/preview', parsed.data)))
      return true
    }
    const started = z.object({ id: z.uuid() }).safeParse(await call('/start', { ...parsed.data, confirm }))
    if (!started.success) throw new ArtiumError('INVALID_RESPONSE')
    const id = started.data.id
    output('stderr', `export: ${id}\n`)
    let status: z.infer<typeof statusSchema>
    do {
      const next = statusSchema.safeParse(await client.authenticated(`${prefix}/${id}?waitMs=20000`, 'GET'))
      if (!next.success) throw new ArtiumError('INVALID_RESPONSE')
      status = next.data
    } while (status.state === 'running')
    if (status.state === 'failed') throw new ArtiumError('TOOL_FAILED', 'The Shodan export failed.', 'Start a fresh preview and confirmation.')
    const { result } = status
    if (result.complete !== (status.state === 'completed')) throw new ArtiumError('INVALID_RESPONSE')
    const [target, saved] = result.complete ? [destinations[0], path] : [destinations[1], path + '.partial']
    await client.transferSession(token => client.artifact(`${prefix}/${id}/retrieve`, {}, token, '', result.retainedUntil, (response, signal) => {
      if (response.headers['x-artium-export-complete'] !== String(result.complete)) throw new ArtiumError('INVALID_RESPONSE')
      return target.saveExport(response, result, signal)
    }))
    output('stdout', format({ saved, count: result.count, total: result.total, complete: result.complete, bytes: result.bytes, sha256: result.sha256 }))
    if (!result.complete) process.exitCode = 1
    return true
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await Promise.allSettled(destinations.map(destination => destination.close()))
  }
}
