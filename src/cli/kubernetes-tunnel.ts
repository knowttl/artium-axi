import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createServer, type Server, type Socket } from 'node:net'
import { rootCertificates } from 'node:tls'
import type { Duplex } from 'node:stream'
import { encode } from '@toon-format/toon'
import { ArtiumError } from '../shared/errors.js'
import { KubernetesTunnelWire, type TunnelFrame } from '../shared/kubernetes-tunnel.js'
import { DEFAULT_REQUEST_DEADLINE_MS, type Client } from './http.js'
import { kubernetesSessionView } from '../shared/kubernetes.js'
import { cliVersion } from '../shared/version.js'
import { z } from 'zod'

export async function openKubernetesTunnel(options: { serverUrl: string, session: string, ports: number[],
  accessToken: string, caFile?: string, signal: AbortSignal }) {
  const url = new URL(`${options.serverUrl}/v1/tools/kubernetes-axi/sessions/${options.session}/tunnel`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new ArtiumError('CLIENT_CONFIG_INVALID')
  const key = randomBytes(16).toString('base64')
  const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  const { socket, head } = await new Promise<{ socket: Duplex, head: Buffer }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { authorization: `Bearer ${options.accessToken}`, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': key, 'x-artium-cli-version': cliVersion },
      signal: options.signal, rejectUnauthorized: true,
      ca: options.caFile ? [...rootCertificates, readFileSync(options.caFile, 'utf8')] : undefined,
    })
    const deadline = setTimeout(() => request.destroy(new ArtiumError('SERVER_UNAVAILABLE')), 10000)
    request.once('upgrade', (reply, socket, head) => {
      clearTimeout(deadline)
      if (reply.statusCode !== 101 || reply.headers['sec-websocket-accept'] !== expected) { socket.destroy(); reject(new ArtiumError('INVALID_RESPONSE')); return }
      const permitted = String(reply.headers['x-artium-remote-ports'] ?? '').split(',').map(Number)
      if (options.ports.some(port => !permitted.includes(port))) { socket.destroy(); reject(new ArtiumError('INVALID_INPUT', 'Select only the session-approved remote ports.')); return }
      resolve({ socket, head })
    })
    request.once('response', response => { clearTimeout(deadline); response.resume(); reject(new ArtiumError('TOOL_NOT_GRANTED')) })
    request.once('error', () => { clearTimeout(deadline); reject(new ArtiumError('SERVER_UNAVAILABLE')) })
    request.end()
  })
  const listeners: Server[] = []
  const connections = new Map<string, { socket: Socket, port: number }>()
  let finish!: () => void
  const closed = new Promise<void>(resolve => { finish = resolve })
  let closing: Promise<void> | undefined
  const listening = new AbortController()
  const close = () => closing ??= (async () => {
    listening.abort()
    socket.destroy()
    for (const connection of connections.values()) connection.socket.destroy()
    await Promise.all(listeners.map(listener => new Promise<void>(resolve => listener.close(() => resolve()))))
    finish()
  })()
  const wire = new KubernetesTunnelWire(socket, false, async frame => {
    if (frame.session !== options.session) throw new Error('Wrong session')
    const connection = connections.get(frame.connection)
    if (!connection && ['close', 'error'].includes(frame.type)) return
    if (!connection || connection.port !== frame.port) throw new Error('Wrong connection')
    if (frame.type === 'open') connection.socket.resume()
    else if (frame.type === 'data') await new Promise<void>((resolve, reject) => connection.socket.write(Buffer.from(frame.dataBase64!, 'base64'), error => error ? reject(error) : resolve()))
    else if (frame.type === 'half-close') await new Promise<void>(resolve => connection.socket.end(resolve))
    else connection.socket.destroy()
  }, head)
  socket.once('close', () => { void close() })
  const stop = () => { void close() }
  options.signal.addEventListener('abort', stop, { once: true })
  void closed.then(() => options.signal.removeEventListener('abort', stop))
  const ports: { remote: number, local: number }[] = []
  try {
    for (const port of options.ports) {
      if (options.signal.aborted || socket.destroyed) throw new ArtiumError('CANCELLED')
      const listener = createServer({ allowHalfOpen: true }, local => {
        if (connections.size >= 16) { local.destroy(); return }
        const id = randomUUID()
        const frame = (type: TunnelFrame['type'], dataBase64?: string): TunnelFrame => ({ session: options.session, connection: id, port, type, ...(dataBase64 === undefined ? {} : { dataBase64 }) })
        connections.set(id, { socket: local, port })
        let sending = Promise.resolve()
        local.pause()
        local.on('error', () => local.destroy())
        local.on('data', (bytes: Buffer) => {
          local.pause()
          sending = sending.then(async () => {
            for (let index = 0; index < bytes.length; index += 32768) await wire.send(frame('data', bytes.subarray(index, index + 32768).toString('base64')))
            local.resume()
          })
          void sending.catch(() => local.destroy())
        })
        local.once('end', () => { void sending.then(() => wire.send(frame('half-close'))).catch(() => local.destroy()) })
        local.once('close', () => { connections.delete(id); void wire.send(frame('close')).catch(() => {}) })
        void wire.send(frame('open')).catch(() => local.destroy())
      })
      listeners.push(listener)
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject)
        listener.once('close', () => reject(new ArtiumError('CANCELLED')))
        listener.listen({ port: 0, host: '127.0.0.1', signal: listening.signal }, resolve)
      })
      listener.on('error', stop)
      const address = listener.address()
      if (!address || typeof address === 'string') throw new ArtiumError('SERVER_UNAVAILABLE')
      ports.push({ remote: port, local: address.port })
    }
    if (options.signal.aborted || socket.destroyed) throw new ArtiumError('CANCELLED')
    return { ports, closed, close }
  } catch (error) { await close(); throw error }
}

export async function kubernetesTunnel(createClient: () => Client, supplied: string[], output: (text: string) => void): Promise<boolean> {
  const json = supplied.includes('--json'), args = supplied.filter(arg => arg !== '--json')
  if (args[0] !== 'tunnel') return false
  const print = (value: unknown) => output((json ? JSON.stringify(value) : encode(value)) + '\n')
  const usage = 'artium-axi kubernetes-axi tunnel <session-id> --port <remote-port> [--port <remote-port>]'
  if (args[1] === '--help' && args.length === 2) {
    print({ usage, description: 'Connect loopback listeners to an owned, confirmed port-forward session.',
      flags: ['--port <1-65535> (repeat for each approved remote port)', '--help'],
      examples: ['artium-axi kubernetes-axi tunnel <session-id> --port 8080', 'artium-axi kubernetes-axi tunnel <session-id> --port 8080 --port 9090'] })
    return true
  }
  const session = args[1] ?? ''
  const ports: number[] = []
  for (let index = 2; index < args.length; index += 2) {
    if (args[index] !== '--port' || !/^[1-9][0-9]{0,4}$/.test(args[index + 1] ?? '') || Number(args[index + 1]) > 65535) throw new ArtiumError('INVALID_INPUT', 'Use approved remote ports with --port.', usage)
    ports.push(Number(args[index + 1]))
  }
  if (!z.uuid().safeParse(session).success || !ports.length || ports.length > 8 || new Set(ports).size !== ports.length) throw new ArtiumError('INVALID_INPUT', 'Select one session and one to eight distinct remote ports.', usage)
  const client = createClient()
  const controller = new AbortController()
  const stop = () => { controller.abort(); client.cancel() }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    await client.authenticated('/v1/me', 'GET')
    const path = `/v1/tools/kubernetes-axi/sessions/${session}`
    const status = kubernetesSessionView.safeParse(await client.transferSession(token => client.request(path, 'GET', undefined, token)))
    if (!status.success) throw new ArtiumError('INVALID_RESPONSE')
    const ready = kubernetesSessionView.safeParse(await client.transferSession(token => client.request(path + '?wait=ready', 'GET', undefined, token,
      false, undefined, Math.max(0, status.data.expiresAt - Date.now()) + DEFAULT_REQUEST_DEADLINE_MS)))
    if (!ready.success) throw new ArtiumError('INVALID_RESPONSE')
    if (!ready.data.tunnelReady || ready.data.state !== 'running') throw new ArtiumError('INVALID_INPUT', 'The confirmed port-forward session is not running.')
    const tunnel = await client.transferSession(accessToken => openKubernetesTunnel({ serverUrl: client.serverUrl,
      session, ports, accessToken, caFile: client.caFile, signal: controller.signal }))
    try { print({ session, ports: tunnel.ports }); await tunnel.closed }
    finally { await tunnel.close() }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
  return true
}
