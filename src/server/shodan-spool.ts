import { randomBytes } from 'node:crypto'
import { ArtiumError } from '../shared/errors.js'

interface Event { sequence: number, expiresAt: number, bytes: Buffer }
interface Range { from: number, to: number, reason: 'evicted' | 'expired' }

// Events enter only after the worker output scanner has accepted them.
export class ShodanSpool {
  private events: Event[] = []
  private losses: Range[] = []
  private sequence = 0
  private cursor = 0
  private token: string | undefined
  private started = false
  private bytes = 0
  private hadLoss = false
  private upstream: Record<string, number> = {}
  private lossVersion = 0
  private reportedLossVersion = 0

  constructor(private readonly maxEvents: number, private readonly maxBytes: number,
    private readonly retentionMs: number, private readonly now = Date.now) {}

  private lost(from: number, to: number, reason: Range['reason']) {
    this.hadLoss = true
    const last = this.losses.at(-1)
    if (last && last.reason === reason && last.to + 1 === from) last.to = to
    else {
      if (this.losses.length >= 1024) throw new ArtiumError('OUTPUT_LIMIT')
      this.losses.push({ from, to, reason })
    }
  }

  private remove(reason: 'expired' | 'evicted') {
    const event = this.events.shift()!
    this.bytes -= event.bytes.length
    event.bytes.fill(0)
    if (event.sequence > this.cursor) this.lost(event.sequence, event.sequence, reason)
  }

  private expire() {
    while (this.events.length && this.events[0].expiresAt <= this.now()) this.remove('expired')
  }

  append(value: unknown) {
    this.expire()
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new ArtiumError('OUTPUT_LIMIT')
    const bytes = Buffer.from(JSON.stringify(value))
    const sequence = ++this.sequence
    if (bytes.length > this.maxBytes) { bytes.fill(0); this.lost(sequence, sequence, 'evicted'); return }
    this.events.push({ sequence, expiresAt: this.now() + this.retentionMs, bytes })
    this.bytes += bytes.length
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) this.remove('evicted')
  }

  upstreamLoss(count: number, reason: string) {
    if (!Number.isSafeInteger(count) || count < 0 || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(reason)) throw new ArtiumError('INVALID_INPUT')
    const total = (this.upstream[reason] ?? 0) + count
    if (!Number.isSafeInteger(total)) throw new ArtiumError('OUTPUT_LIMIT')
    if (count) { this.hadLoss = true; this.lossVersion++ }
    this.upstream[reason] = total
  }

  available(token: string | undefined) {
    if ((!this.started && token !== undefined) || (this.started && (!token || token !== this.token))) throw new ArtiumError('INVALID_INPUT')
    this.expire()
    return this.sequence > this.cursor || this.lossVersion > this.reportedLossVersion
  }

  read(token: string | undefined, limit: number, ended: boolean) {
    this.available(token)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ArtiumError('INVALID_INPUT')
    const events = this.events.filter(event => event.sequence > this.cursor).slice(0, limit)
    const end = events.length ? events.at(-1)!.sequence : this.sequence
    const lost = this.losses.filter(range => range.to > this.cursor && range.from <= end)
      .map(range => ({ ...range, from: Math.max(range.from, this.cursor + 1), to: Math.min(range.to, end) }))
    const items = events.map(event => ({ sequence: event.sequence, value: JSON.parse(event.bytes.toString('utf8')) as unknown }))
    this.cursor = end
    while (this.events.length && this.events[0].sequence <= end) this.remove('evicted')
    this.reportedLossVersion = this.lossVersion
    this.losses = this.losses.filter(range => range.to > end)
    this.token = randomBytes(32).toString('base64url')
    this.started = true
    return { items, lost, upstreamLoss: { ...this.upstream }, continuation: this.token, complete: ended && end === this.sequence && !this.hadLoss }
  }

  clear() {
    for (const event of this.events) event.bytes.fill(0)
    this.events = []; this.losses = []; this.upstream = {}; this.bytes = 0; this.token = undefined
  }
}
