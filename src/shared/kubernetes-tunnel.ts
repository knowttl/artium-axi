import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { z } from 'zod'

export const tunnelFrame = z.object({ session: z.uuid(), connection: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  port: z.number().int().min(1).max(65535), type: z.enum(['open', 'data', 'half-close', 'close', 'error']),
  dataBase64: z.string().max(43692).optional(), message: z.string().max(256).optional(),
}).strict().refine(frame => frame.type === 'data' ? typeof frame.dataBase64 === 'string' &&
  Buffer.from(frame.dataBase64, 'base64').toString('base64') === frame.dataBase64 && Buffer.from(frame.dataBase64, 'base64').length <= 32768 : frame.dataBase64 === undefined)
export type TunnelFrame = z.infer<typeof tunnelFrame>

// Every producer awaits socket writes; inbound parsing pauses while its consumer
// drains. Fixed caps also bound a peer that sends a single oversized frame.
export class KubernetesTunnelWire {
  private pending: Buffer = Buffer.alloc(0)
  private consuming = false
  private outgoing = Promise.resolve()
  private queued = 0
  constructor(readonly socket: Duplex, private readonly server: boolean,
    private readonly consume: (frame: TunnelFrame) => Promise<void>, head: Buffer = Buffer.alloc(0)) {
    socket.on('error', () => socket.destroy())
    socket.on('data', (bytes: Buffer) => {
      this.pending = Buffer.concat([this.pending, bytes])
      if (this.pending.length > 256 * 1024) { socket.destroy(); return }
      void this.pump().catch(() => socket.destroy())
    })
    socket.once('end', () => socket.destroy())
    if (head.length) { this.pending = head; queueMicrotask(() => { void this.pump().catch(() => socket.destroy()) }) }
  }
  private async pump(): Promise<void> {
    if (this.consuming) return
    this.consuming = true
    this.socket.pause()
    try {
      while (!this.socket.destroyed && this.pending.length >= 2) {
        const first = this.pending[0]!, second = this.pending[1]!
        if (!(first & 128) || first & 112 || Boolean(second & 128) !== this.server) throw new Error('Invalid frame')
        const marker = second & 127
        if (marker === 127) throw new Error('Frame limit')
        const header = marker === 126 ? 4 : 2
        const maskLength = this.server ? 4 : 0
        if (this.pending.length < header + maskLength) return
        const length = marker === 126 ? this.pending.readUInt16BE(2) : marker
        if (this.pending.length < header + maskLength + length) return
        const payload = Buffer.from(this.pending.subarray(header + maskLength, header + maskLength + length))
        if (this.server) for (let index = 0; index < payload.length; index++) payload[index] ^= this.pending[header + index % 4]
        this.pending = Buffer.from(this.pending.subarray(header + maskLength + length))
        const opcode = first & 15
        if (opcode === 8) { this.socket.end(); return }
        if (opcode === 9 && length <= 125) { await this.write(payload, 10); continue }
        if (opcode === 10 && length <= 125) continue
        if (opcode !== 1) throw new Error('Unsupported frame')
        await this.consume(tunnelFrame.parse(JSON.parse(payload.toString('utf8'))))
      }
    } finally { this.consuming = false; if (!this.socket.destroyed) this.socket.resume() }
  }
  private async write(payload: Buffer, opcode = 1): Promise<void> {
    if (this.socket.destroyed) throw new Error('Tunnel closed')
    if (payload.length > 65535 || this.queued + payload.length > 2 * 1024 * 1024) throw new Error('Tunnel buffer limit')
    this.queued += payload.length
    const maskLength = this.server ? 0 : 4
    const header = Buffer.alloc((payload.length < 126 ? 2 : 4) + maskLength)
    header[0] = 128 | opcode
    header[1] = (this.server ? 0 : 128) | (payload.length < 126 ? payload.length : 126)
    if (payload.length >= 126) header.writeUInt16BE(payload.length, 2)
    const encoded = Buffer.from(payload)
    if (!this.server) {
      const mask = randomBytes(4)
      mask.copy(header, header.length - 4)
      for (let index = 0; index < encoded.length; index++) encoded[index] ^= mask[index % 4]
    }
    const sending = this.outgoing.then(() => new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.concat([header, encoded]), error => error ? reject(error) : resolve())
    })).finally(() => { this.queued -= payload.length })
    this.outgoing = sending.catch(() => {})
    await sending
  }
  send(frame: TunnelFrame): Promise<void> { return this.write(Buffer.from(JSON.stringify(tunnelFrame.parse(frame)))) }
}
