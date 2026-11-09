import { encode } from '@toon-format/toon'
import { z } from 'zod'
import { shodanStreamStart } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'

const base = '/v1/tools/shodan-axi/sessions'
const help = `usage: artium-axi shodan-axi stream session <preview|start|status|read|extend|stop> [options]
Preview and start require --operation, --limit, --max-bytes, --timeout, --idle-timeout and --accept-unknown-cost.
--limit is an event count, --max-bytes is in bytes, and --timeout and --idle-timeout are in milliseconds.
Use --selector and --value together when a stream selector is needed. Start repeats the preview arguments and adds --confirm.
Preview and start accept --events <count>, --bytes <bytes>, --retention <seconds> and --lease <seconds> to lower administrator ceilings.
Events, bytes and retention default to administrator ceilings; lease defaults to the smaller of 900 seconds and the administrator ceiling.
Status, read, extend and stop take a session ID. Read accepts --continuation, --limit and --wait.
Extend previews with: artium-axi shodan-axi stream session extend <id> --seconds <seconds>
Apply with: artium-axi shodan-axi stream session extend <id> --confirm <token>
Stop cancels the session.
All actions accept --json for JSON output instead of the default TOON output.
`

export async function shodanSession(args: string[], createClient: () => Client, output: (stream: 'stdout' | 'stderr', text: string) => void, instance?: string) {
  if (args[0] !== 'stream' || args[1] !== 'session') return false
  if (args.includes('--help')) { output('stdout', help); return true }
  const action = args[2]
  const values = new Map<string, string>(), switches = new Set<string>(), positional: string[] = []
  const valueFlags = new Set(['--operation', '--selector', '--value', '--limit', '--max-bytes', '--timeout', '--idle-timeout',
    '--events', '--bytes', '--retention', '--lease', '--confirm', '--continuation', '--seconds'])
  for (let index = 3; index < args.length; index++) {
    const token = args[index]
    if (!token.startsWith('-')) { positional.push(token); continue }
    if (['--json', '--accept-unknown-cost', '--wait'].includes(token)) {
      if (switches.has(token)) throw new ArtiumError('INVALID_INPUT')
      switches.add(token)
    } else if (valueFlags.has(token) && !values.has(token) && args[index + 1]
      && (token === '--selector' || !args[index + 1].startsWith('--'))) values.set(token, args[++index])
    else throw new ArtiumError('INVALID_INPUT')
  }
  const permitted: Record<string, string[]> = {
    preview: ['--operation', '--selector', '--value', '--limit', '--max-bytes', '--timeout', '--idle-timeout', '--events', '--bytes', '--retention', '--lease'],
    start: ['--operation', '--selector', '--value', '--limit', '--max-bytes', '--timeout', '--idle-timeout', '--events', '--bytes', '--retention', '--lease', '--confirm'],
    status: [], read: ['--continuation', '--limit'], extend: ['--seconds', '--confirm'], stop: [],
  }
  if (!action || !permitted[action] || [...values.keys()].some(key => !permitted[action].includes(key))
    || switches.has('--accept-unknown-cost') && !['preview', 'start'].includes(action)
    || switches.has('--wait') && action !== 'read'
    || instance !== undefined && !['preview', 'start'].includes(action)) throw new ArtiumError('INVALID_INPUT', '--instance applies only to stream session preview and start.', 'Run the command without --instance.')
  const number = (name: string) => {
    const value = values.get(name)
    if (value === undefined) return undefined
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ArtiumError('INVALID_INPUT')
    return Number(value)
  }
  let path = base, method: 'GET' | 'POST' | 'DELETE' = 'POST', body: unknown
  if (action === 'preview' || action === 'start') {
    if (positional.length || !switches.has('--accept-unknown-cost')) throw new ArtiumError('INVALID_INPUT')
    const parsed = shodanStreamStart.safeParse({ operation: values.get('--operation'), selector: {
      flag: values.get('--selector'), value: values.get('--value') }, bounds: { limit: number('--limit'), maxBytes: number('--max-bytes'),
      timeout: number('--timeout'), idleTimeout: number('--idle-timeout') }, limits: { events: number('--events'), bytes: number('--bytes'),
      retentionSeconds: number('--retention'), leaseSeconds: number('--lease') }, acceptUnknownCost: true })
    if (!parsed.success || action === 'start' && !z.uuid().safeParse(values.get('--confirm')).success) throw new ArtiumError('INVALID_INPUT')
    path += `/${action}`; body = { ...parsed.data, ...(action === 'start' ? { confirm: values.get('--confirm') } : {}), ...(instance === undefined ? {} : { instance }) }
  } else {
    if (positional.length !== 1 || !z.uuid().safeParse(positional[0]).success) throw new ArtiumError('INVALID_INPUT')
    path += `/${positional[0]}`
    if (action === 'status') method = 'GET'
    else if (action === 'stop') method = 'DELETE'
    else if (action === 'read') { path += '/read'; body = { continuation: values.get('--continuation'), limit: number('--limit') ?? 100, waitMs: switches.has('--wait') ? 20000 : 0 } }
    else {
      if (values.has('--seconds') === values.has('--confirm')) throw new ArtiumError('INVALID_INPUT')
      if (values.has('--seconds')) { path += '/extend/preview'; body = { seconds: number('--seconds') } }
      else { path += '/extend'; body = { confirm: values.get('--confirm') } }
    }
  }
  const client = createClient()
  await client.authenticated('/v1/me', 'GET')
  const result = await client.transferSession(token => client.request(path, method, body, token))
  output('stdout', (switches.has('--json') ? JSON.stringify(result) : encode(result)) + '\n')
  return true
}
