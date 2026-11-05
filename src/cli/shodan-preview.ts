import { encode } from '@toon-format/toon'
import { shodanStreamStart } from '../shared/shodan-stream.js'
import { ArtiumError } from '../shared/errors.js'
import type { Client } from './http.js'

export async function shodanPreview(args: string[], createClient: () => Client, output: (text: string) => void) {
  if (args[0] !== 'stream' || args[1] !== 'session') return false
  if (args[2] === 'preview' && args.includes('--help')) {
    output('usage: artium-axi shodan-axi stream session preview --operation <id> --limit <count> --max-bytes <bytes> --timeout <ms> --idle-timeout <ms> --accept-unknown-cost [--selector <flag> --value <value>] [--events <count>] [--bytes <bytes>] [--retention <seconds>] [--lease <seconds>] [--json]\n')
    return true
  }
  if (args[2] !== 'preview') throw new ArtiumError('INVALID_INPUT')
  const names = ['--operation', '--selector', '--value', '--limit', '--max-bytes', '--timeout', '--idle-timeout', '--events', '--bytes', '--retention', '--lease']
  const values = new Map<string, string>(), switches = new Set<string>()
  for (let i = 3; i < args.length; i++) {
    const flag = args[i]
    if (['--json', '--accept-unknown-cost'].includes(flag) && !switches.has(flag)) switches.add(flag)
    else if (names.includes(flag) && !values.has(flag) && args[i + 1] && (flag === '--selector' || !args[i + 1].startsWith('--'))) values.set(flag, args[++i])
    else throw new ArtiumError('INVALID_INPUT')
  }
  const number = (name: string) => {
    const value = values.get(name)
    if (value === undefined) return undefined
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ArtiumError('INVALID_INPUT')
    return Number(value)
  }
  const parsed = shodanStreamStart.safeParse({ operation: values.get('--operation'), selector: { flag: values.get('--selector'), value: values.get('--value') },
    bounds: { limit: number('--limit'), maxBytes: number('--max-bytes'), timeout: number('--timeout'), idleTimeout: number('--idle-timeout') },
    limits: { events: number('--events'), bytes: number('--bytes'), retentionSeconds: number('--retention'), leaseSeconds: number('--lease') },
    acceptUnknownCost: switches.has('--accept-unknown-cost') })
  if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
  const result = await createClient().authenticated('/v1/tools/shodan-axi/sessions/preview', 'POST', parsed.data)
  output((switches.has('--json') ? JSON.stringify(result) : encode(result)) + '\n')
  return true
}
