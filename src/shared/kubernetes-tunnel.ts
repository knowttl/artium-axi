import type { Duplex } from 'node:stream'
import { z } from 'zod'
import { WebSocketWire } from './websocket.js'

export const tunnelFrame = z.object({ session: z.uuid(), connection: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  port: z.number().int().min(1).max(65535), type: z.enum(['open', 'data', 'half-close', 'close', 'error']),
  dataBase64: z.string().max(43692).optional(), message: z.string().max(256).optional(),
}).strict().refine(frame => frame.type === 'data' ? typeof frame.dataBase64 === 'string' &&
  Buffer.from(frame.dataBase64, 'base64').toString('base64') === frame.dataBase64 && Buffer.from(frame.dataBase64, 'base64').length <= 32768 : frame.dataBase64 === undefined)
export type TunnelFrame = z.infer<typeof tunnelFrame>

export class KubernetesTunnelWire extends WebSocketWire {
  constructor(socket: Duplex, server: boolean, consume: (frame: TunnelFrame) => Promise<void>, head: Buffer = Buffer.alloc(0)) {
    super(socket, server, 1, bytes => consume(tunnelFrame.parse(JSON.parse(bytes.toString('utf8')))), head)
  }
  send(frame: TunnelFrame): Promise<void> { return this.sendBytes(Buffer.from(JSON.stringify(tunnelFrame.parse(frame)))) }
}
