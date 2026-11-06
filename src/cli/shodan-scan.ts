import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { shodanScanInput } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'

const prefix = '/v1/tools/shodan-axi/scan-collections'
const statusSchema = z.object({ id: z.uuid(), state: z.enum(['running', 'completed', 'partial']),
  result: z.object({ events: z.array(z.record(z.string(), z.unknown())) }).passthrough().optional() })

export async function shodanScan(args: string[], createClient: () => Client, output: (stream: 'stdout' | 'stderr', text: string) => void) {
  if (args[0] !== 'scan' || args[1] !== 'submit') return false
  if (args.includes('--help')) {
    output('stdout', 'usage: artium-axi shodan-axi scan submit <targets> [options]\nUse exact --allow-operation grants, --scan-credit-budget and --max-requests. Collection also needs --wait, --limit, --max-bytes, --idle-timeout, --accept-unknown-cost and the OP-046 stream grant. Preview first, then repeat with --execute --confirm <token>.\n')
    return true
  }
  const values = new Map<string, string>(), switches = new Set<string>(), positional: string[] = []
  const valueFlags = new Set(['--allow-operation', '--scan-credit-budget', '--max-requests', '--wait',
    '--limit', '--max-bytes', '--idle-timeout', '--confirm'])
  for (let index = 2; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positional.push(token); continue }
    if (['--json', '--accept-unknown-cost', '--execute', '--force'].includes(token)) {
      if (switches.has(token)) throw new ArtiumError('INVALID_INPUT')
      switches.add(token)
    } else if (valueFlags.has(token) && !values.has(token) && args[index + 1] && !args[index + 1].startsWith('--')) values.set(token, args[++index])
    else throw new ArtiumError('INVALID_INPUT')
  }
  const number = (name: string, fallback?: number) => {
    const value = values.get(name)
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ArtiumError('INVALID_INPUT')
    return Number(value)
  }
  const waitSeconds = number('--wait', 0)!
  if (positional.length !== 1
    || switches.has('--execute') !== values.has('--confirm') || values.has('--confirm') && !z.uuid().safeParse(values.get('--confirm')).success) throw new ArtiumError('INVALID_INPUT')
  const required = waitSeconds ? ['OP-009', 'OP-046'] : ['OP-009']
  const grants = values.get('--allow-operation')?.split(',') ?? []
  if (grants.length !== required.length || new Set(grants).size !== grants.length || required.some(value => !grants.includes(value))) throw new ArtiumError('INVALID_INPUT')
  const parsed = shodanScanInput.safeParse({ scope: { kind: 'targets', targets: positional[0], force: switches.has('--force') },
    waitSeconds, limit: number('--limit', waitSeconds ? undefined : 1), maxBytes: number('--max-bytes', waitSeconds ? undefined : 1024),
    idleTimeout: number('--idle-timeout', waitSeconds ? undefined : 1000), scanCreditBudget: number('--scan-credit-budget'),
    maxRequests: number('--max-requests'), acceptUnknownCost: switches.has('--accept-unknown-cost') })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  const client = createClient()
  await client.authenticated('/v1/me', 'GET')
  const call = (path: string, body: unknown) => client.transferSession(token => client.request(path, 'POST', body, token))
  if (!switches.has('--execute')) {
    const result = await call(prefix + '/preview', parsed.data)
    output('stdout', (switches.has('--json') ? JSON.stringify(result) : encode(result)) + '\n')
    return true
  }
  const started = z.object({ id: z.uuid() }).safeParse(await call(prefix + '/start', { ...parsed.data, confirm: values.get('--confirm') }))
  if (!started.success) throw new ArtiumError('INVALID_RESPONSE')
  output('stderr', `collection: ${started.data.id}\n`)
  let result: z.infer<typeof statusSchema>
  for (;;) {
    const parsedStatus = statusSchema.safeParse(await client.authenticated(`${prefix}/${started.data.id}?waitMs=20000`, 'GET'))
    if (!parsedStatus.success) throw new ArtiumError('INVALID_RESPONSE')
    result = parsedStatus.data
    if (result.state !== 'running') break
  }
  if (!result.result) throw new ArtiumError('INVALID_RESPONSE')
  output('stdout', (switches.has('--json') ? JSON.stringify(result.result) : encode(result.result)) + '\n')
  if (result.state === 'partial') process.exitCode = 1
  return true
}
