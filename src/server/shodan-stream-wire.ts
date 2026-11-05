import { z } from 'zod'
import { shodanWorkerBounds } from '../shared/shodan-stream.js'

const id = z.string().min(1).max(128)
const base = { version: z.literal(1), requestId: id }
const stableCode = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
const messageSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('ready') }),
  z.strictObject({ ...base, type: z.literal('event'), event: z.record(z.string(), z.unknown()) }),
  z.strictObject({ ...base, type: z.literal('loss'), discarded: z.number().int().nonnegative().safe(), reason: stableCode }),
  z.strictObject({ ...base, type: z.literal('closed'), stopReason: stableCode,
    count: z.number().int().nonnegative().safe(), bytes: z.number().int().nonnegative().safe(),
    partialRecordCount: z.number().int().nonnegative().safe(), debugDiscarded: z.number().int().nonnegative().safe(),
    bounds: shodanWorkerBounds, error: stableCode.optional() }),
])
export type ShodanWorkerMessage = z.infer<typeof messageSchema>

export class ShodanStreamWire {
  private pending = Buffer.alloc(0)
  private seen = new Set<string>()
  constructor(private readonly receive: (message: ShodanWorkerMessage) => void, private readonly maxMessages: number) {}

  push(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk])
    for (;;) {
      const end = this.pending.indexOf(10)
      if (end < 0) {
        if (this.pending.length > 2 * 1024 * 1024) throw new Error('Worker frame limit exceeded')
        return
      }
      if (end > 2 * 1024 * 1024) throw new Error('Worker frame limit exceeded')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.pending.subarray(0, end))
      this.pending = this.pending.subarray(end + 1)
      const message = messageSchema.parse(JSON.parse(text))
      if (this.seen.has(message.requestId)) throw new Error('Duplicate worker request')
      if (this.seen.size >= this.maxMessages) throw new Error('Worker message limit exceeded')
      this.seen.add(message.requestId)
      this.receive(message)
    }
  }

  finish() { if (this.pending.length) throw new Error('Incomplete worker frame') }
}
