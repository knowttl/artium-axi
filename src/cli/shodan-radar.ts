import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ArtiumError } from '../shared/errors.js'
import { artifactDestination } from './artifact-save.js'
import type { Client } from './http.js'

const resultSchema = z.object({ items: z.array(z.object({ sequence: z.number().int().positive(), value: z.record(z.string(), z.unknown()) })),
  lost: z.array(z.object({ from: z.number(), to: z.number(), reason: z.string() })), upstreamLoss: z.record(z.string(), z.number()),
  continuation: z.string(), cleaned: z.boolean(), hasMore: z.boolean(),
  state: z.enum(['starting', 'running', 'stopping', 'closed', 'failed', 'expired']) })
const point = z.object({ location: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }) })

export async function shodanRadar(args: string[], createClient: () => Client, output: (stream: 'stdout' | 'stderr', text: string) => void) {
  if (args[0] !== 'radar') return false
  if (args.includes('--help') || args.includes('-h')) {
    output('stdout', 'usage: artium-axi shodan-axi radar --session <id> [--max-events <n>] [--output <absolute-new-path>]\nInteractive radar stops the session on q. Non-interactive output requires --max-events and --output.\n')
    return true
  }
  const options = new Map<string, string>()
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    if (!['--session', '--max-events', '--output'].includes(flag) || options.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new ArtiumError('INVALID_INPUT')
    options.set(flag, args[++index])
  }
  const session = options.get('--session'), rawLimit = options.get('--max-events')
  if (!z.uuid().safeParse(session).success || rawLimit && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 10000)
    || !process.stdin.isTTY && (!rawLimit || !options.has('--output'))) throw new ArtiumError('INVALID_INPUT')
  const limit = rawLimit ? Number(rawLimit) : 10000
  const destination = options.has('--output') ? await artifactDestination(options.get('--output')!) : undefined
  const client = createClient(), cells = new Set<number>(), lost: { from: number, to: number, reason: string }[] = []
  let upstreamLoss: Record<string, number> = {}, continuation: string | undefined, count = 0, plotted = 0, ignored = 0, quit = false
  let state: z.infer<typeof resultSchema>['state'] = 'starting'
  let failure: unknown
  const cancel = () => { quit = true; client.cancel() }
  const onInput = (chunk: Buffer) => { if (chunk.includes(0x71) || chunk.includes(0x03)) cancel() }
  const interactive = Boolean(process.stdin.isTTY)
  const base = `/v1/tools/shodan-axi/sessions/${session}`
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  try {
    if (interactive) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onInput) }
    try {
      while (!quit && count < limit) {
        let raw: unknown
        try {
          raw = await client.authenticated(base + '/read', 'POST',
            { continuation, limit: Math.min(100, limit - count), waitMs: 20000 })
        } catch (error) { if (quit) break; throw error }
        const parsed = resultSchema.safeParse(raw)
        if (!parsed.success) throw new ArtiumError('INVALID_RESPONSE')
        continuation = parsed.data.continuation
        state = parsed.data.state
        lost.push(...parsed.data.lost); upstreamLoss = parsed.data.upstreamLoss
        for (const item of parsed.data.items) {
          count++
          const location = point.safeParse(item.value)
          if (!location.success) { ignored++; continue }
          const { latitude, longitude } = location.data.location
          const x = Math.min(35, Math.floor((longitude + 180) / 10)), y = Math.min(17, Math.floor((90 - latitude) / 10))
          cells.add(y * 36 + x); plotted++
        }
        if (lost.length > 1024) throw new ArtiumError('OUTPUT_LIMIT')
        if (interactive) output('stdout', `\u001b[H\u001b[2J${rows(cells).join('\n')}\nPress q to stop\n`)
        if (parsed.data.cleaned && !parsed.data.hasMore) break
      }
    } catch (error) {
      failure = error
    }
    const result = { rows: rows(cells), plottedPoints: plotted, ignoredPoints: ignored, events: count, lost, upstreamLoss, state }
    if (destination) {
      const bytes = Buffer.from(JSON.stringify(result) + '\n')
      try {
        await destination.saveBytes(bytes)
        output('stdout', `saved: ${JSON.stringify(options.get('--output'))}\nbytes: ${bytes.length}\nsha256: ${createHash('sha256').update(bytes).digest('hex')}\n`)
      } finally { bytes.fill(0) }
    } else if (!interactive) output('stdout', JSON.stringify(result) + '\n')
    if (state === 'failed') throw new ArtiumError('TOOL_FAILED', 'The Shodan stream session failed.',
      'Inspect the session status; saved radar output contains only the events consumed before failure.')
  } catch (error) {
    failure ??= error
  } finally {
    try {
      if (interactive) { process.stdin.off('data', onInput); process.stdin.setRawMode(false); process.stdin.pause() }
      try { await destination?.close() }
      finally {
        const stop = createClient()
        await stop.authenticated(base, 'DELETE')
      }
    } catch (error) {
      failure ??= error
    } finally {
      process.off('SIGINT', cancel); process.off('SIGTERM', cancel)
    }
  }
  if (failure) throw failure
  return true
}

function rows(cells: Set<number>) {
  return Array.from({ length: 18 }, (_, y) => Array.from({ length: 36 }, (_, x) => cells.has(y * 36 + x) ? '*' : '.').join(''))
}
