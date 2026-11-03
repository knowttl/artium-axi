import { z } from 'zod'
import type { Duplex } from 'node:stream'
import { WebSocketWire } from './websocket.js'
import { createHash } from 'node:crypto'

export const proxmoxStreamStart = z.strictObject({ args: z.array(z.string().max(8192)).min(3).max(64)
  .refine(args => args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) <= 65536),
  stdin: z.string().max(65536).optional(), source: z.strictObject({ bytes: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional() })
export const proxmoxStreamControl = z.discriminatedUnion('event', [
  z.strictObject({ event: z.literal('running') }),
  z.strictObject({ event: z.literal('delivered') }),
  z.strictObject({ event: z.literal('setup'), result: z.strictObject({ id: z.uuid(), operation: z.string(), path: z.string(),
    bytes: z.number().int().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }) }),
  z.strictObject({ event: z.literal('result'), stdout: z.string().max(32768), stderr: z.string().max(32768), exitCode: z.number().int() }),
  z.strictObject({ event: z.literal('failed'), code: z.string().regex(/^[A-Z_]{1,64}$/) }),
])
export type ProxmoxStreamPacket = { type: 'data', bytes: Buffer } | { type: 'eof' }
  | { type: 'control', value: z.infer<typeof proxmoxStreamControl> }

export class ProxmoxStreamWire extends WebSocketWire {
  constructor(socket: Duplex, server: boolean, consume: (packet: ProxmoxStreamPacket) => Promise<void>, head: Buffer = Buffer.alloc(0)) {
    super(socket, server, 2, async bytes => {
      if (!bytes.length) throw new Error('Empty packet')
      if (bytes[0] === 1 && bytes.length <= 32769) await consume({ type: 'data', bytes: bytes.subarray(1) })
      else if (bytes[0] === 2 && bytes.length === 1) await consume({ type: 'eof' })
      else if (bytes[0] === 0) await consume({ type: 'control', value: proxmoxStreamControl.parse(JSON.parse(bytes.subarray(1).toString('utf8'))) })
      else throw new Error('Invalid packet')
    }, head)
  }
  send(packet: ProxmoxStreamPacket): Promise<void> {
    return this.sendBytes(packet.type === 'eof' ? Buffer.from([2]) : packet.type === 'data'
      ? Buffer.concat([Buffer.from([1]), packet.bytes]) : Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(proxmoxStreamControl.parse(packet.value)))]))
  }
}

// Meter payloads without buffering a native message, preserving split headers
// and exact S5 hashes independently of transport packet boundaries.
export class ProxmoxFrameMeter {
  private readonly header = Buffer.alloc(4)
  private offset = 0
  private remaining = 0
  private bytes = 0
  private frames = 0
  private readonly hash = createHash('sha256')
  private result?: { bytes: number, frames: number, sha256: string }
  constructor(private readonly limit: number) {}
  add(chunk: Buffer): void {
    if (this.result) throw new Error('Native input already ended')
    let index = 0
    while (index < chunk.length) {
      if (this.remaining) {
        const length = Math.min(this.remaining, chunk.length - index)
        this.hash.update(chunk.subarray(index, index + length))
        this.remaining -= length; this.bytes += length; index += length
        if (!this.remaining) this.frames++
      } else {
        const length = Math.min(4 - this.offset, chunk.length - index)
        chunk.copy(this.header, this.offset, index, index + length)
        this.offset += length; index += length
        if (this.offset === 4) {
          this.remaining = this.header.readUInt32BE(0); this.offset = 0
          if (this.remaining > 1048576 || this.bytes + this.remaining > this.limit) throw new Error('Native frame quota')
          if (!this.remaining) this.frames++
        }
      }
    }
  }
  finish(): { bytes: number, frames: number, sha256: string } {
    if (this.offset || this.remaining) throw new Error('Truncated native frame')
    return this.result ??= { bytes: this.bytes, frames: this.frames, sha256: this.hash.digest('hex') }
  }
}
