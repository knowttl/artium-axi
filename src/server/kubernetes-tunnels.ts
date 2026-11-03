import { createConnection, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { KubernetesTunnelWire, type TunnelFrame } from '../shared/kubernetes-tunnel.js'

export function attachKubernetesTunnel(socket: Duplex, head: Buffer, session: string,
  ports: ReadonlyMap<number, number>, used: Set<string>, active: Set<string>, signal: AbortSignal, authorize: () => void): Promise<void> {
  const connections = new Map<string, { socket: Socket, port: number, ended: boolean }>()
  const draining = new Set<Promise<void>>()
  const close = () => { for (const connection of connections.values()) connection.socket.destroy(); socket.destroy() }
  signal.addEventListener('abort', close, { once: true })
  const monitor = setInterval(() => { try { authorize() } catch { close() } }, 1000)
  monitor.unref()
  const closed = new Promise<void>(resolve => socket.once('close', () => {
    clearInterval(monitor); signal.removeEventListener('abort', close); close()
    void Promise.all([...draining]).then(() => resolve())
  }))
  const wire = new KubernetesTunnelWire(socket, true, async frame => {
    if (socket.destroyed) throw new Error('Tunnel closed')
    authorize()
    if (frame.session !== session) throw new Error('Wrong session')
    const respond = (type: TunnelFrame['type'], message?: string) => wire.send({ session, connection: frame.connection, port: frame.port, type, ...(message ? { message } : {}) })
    if (frame.type === 'open') {
      const local = ports.get(frame.port)
      if (!local || used.has(frame.connection) || used.size >= 4096 || active.size >= 16) {
        await respond('error', 'The connection or port is outside the session limits.'); return
      }
      used.add(frame.connection)
      active.add(frame.connection)
      const upstream = createConnection({ host: '127.0.0.1', port: local, allowHalfOpen: true })
      const drained = new Promise<void>(resolve => upstream.once('close', () => resolve()))
      draining.add(drained)
      void drained.then(() => draining.delete(drained))
      const connection = { socket: upstream, port: frame.port, ended: false }
      connections.set(frame.connection, connection)
      upstream.on('error', () => { void respond('error', 'The forwarded connection failed.').catch(close); upstream.destroy() })
      let sending = Promise.resolve()
      upstream.once('close', () => { connections.delete(frame.connection); active.delete(frame.connection); void sending.then(() => respond('close')).catch(close) })
      upstream.once('end', () => {
        void sending.then(() => respond('half-close')).then(() => { if (connection.ended) upstream.destroy() }).catch(close)
      })
      upstream.on('data', (bytes: Buffer) => {
        upstream.pause()
        sending = sending.then(async () => {
          authorize()
          for (let index = 0; index < bytes.length; index += 32768) await wire.send({ session, connection: frame.connection,
            port: frame.port, type: 'data', dataBase64: bytes.subarray(index, index + 32768).toString('base64') })
          upstream.resume()
        })
        void sending.catch(close)
      })
      await new Promise<void>((resolve, reject) => { upstream.once('connect', resolve); upstream.once('error', reject) })
      authorize()
      await respond('open')
      return
    }
    const connection = connections.get(frame.connection)
    if (!connection || connection.port !== frame.port) { await respond('error', 'The connection is unavailable.'); return }
    if (frame.type === 'data') {
      if (connection.ended) throw new Error('Input already ended')
      const bytes = Buffer.from(frame.dataBase64!, 'base64')
      await new Promise<void>((resolve, reject) => connection.socket.write(bytes, error => error ? reject(error) : resolve()))
    } else if (frame.type === 'half-close') {
      connection.ended = true
      connection.socket.end()
      if (connection.socket.readableEnded) connection.socket.destroy()
    } else connection.socket.destroy()
  }, head)
  if (signal.aborted) close()
  return closed
}
