import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:https'
import type { TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'
import { kubernetesSpdyEcho } from './kubernetes-spdy.js'

interface WorkspaceRuntime {
  readWorkspaceTar(bytes: Buffer): { path: string, bytes: Buffer }[]
  workspaceTar(root: string, name: string): Promise<Buffer>
}
const workspaceRuntime = '/opt/tools/node_modules/@knowttl/kubernetes-axi/dist/workspace-tar.js'

// The fake implements the external Kubernetes channel protocol, not the hosted worker.
export function kubernetesBytes(server: Server, record: (event: { method?: string, path: string, canaryReceived: boolean }) => void) {
  const peers = new Set<Duplex>()
  const evidence = { opened: 0, closed: 0, uploads: [] as { path: string, bytes: number, sha256: string }[],
    forwards: [] as ReturnType<typeof kubernetesSpdyEcho>['counts'][] }
  const frame = (bytes: Buffer) => {
    const head = bytes.length < 126 ? Buffer.from([0x82, bytes.length]) : Buffer.from([0x82, 126, bytes.length >> 8, bytes.length & 255])
    return Buffer.concat([head, bytes])
  }
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? '', 'https://synthetic.invalid')
      const tls = socket as TLSSocket
      const protocols = String(request.headers['sec-websocket-protocol']).split(/,\s*/)
      const forwarding = url.pathname.endsWith('/portforward') && protocols.includes('SPDY/3.1+portforward.k8s.io')
      const canaryReceived = request.headers.authorization === 'Bearer CANARY-kubernetes-token'
        || tls.authorized && tls.getPeerCertificate().subject?.CN === 'synthetic-kubernetes-client'
      if (!/^\/api\/v1\/namespaces\/synthetic\/pods\/synthetic-pod\/(exec|attach|portforward)$/.test(url.pathname) || !canaryReceived
        || !(forwarding || !url.pathname.endsWith('/portforward') && protocols.includes('v5.channel.k8s.io'))) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
      }
      record({ method: request.method, path: url.pathname, canaryReceived })
      evidence.opened++; peers.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => { peers.delete(socket); evidence.closed++ })
      const key = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: ${forwarding ? 'SPDY/3.1+portforward.k8s.io' : 'v5.channel.k8s.io'}\r\n\r\n`)
      const spdy = forwarding ? kubernetesSpdyEcho(bytes => socket.write(frame(bytes)), () => socket.destroy()) : undefined
      if (spdy && evidence.forwards.length < 8) evidence.forwards.push(spdy.counts)
      socket.once('close', () => spdy?.close())
      const output = (channel: number, bytes: string | Buffer) => socket.write(frame(Buffer.concat([Buffer.from([channel]), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])))
      const finish = (code = 0) => {
        output(3, JSON.stringify({ apiVersion: 'v1', kind: 'Status', status: code ? 'Failure' : 'Success',
          ...(code ? { reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: String(code) }] } } : {}) }))
        socket.end(Buffer.from([0x88, 2, 3, 232]))
      }
      const command = url.searchParams.getAll('command')
      let input = Buffer.alloc(0), pending = head
      let completed = false
      const receive = (bytes: Buffer) => {
        pending = Buffer.concat([pending, bytes])
        while (pending.length >= 2) {
          const opcode = pending[0] & 15, masked = Boolean(pending[1] & 128)
          let length = pending[1] & 127, offset = 2
          if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4 }
          else if (length === 127) { if (pending.length < 10) return; const size = pending.readBigUInt64BE(2); if (size > 16n * 1024n * 1024n) { socket.destroy(); return }; length = Number(size); offset = 10 }
          if (!masked || pending.length < offset + 4 + length) return
          const mask = pending.subarray(offset, offset + 4), payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length))
          pending = pending.subarray(offset + 4 + length)
          for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
          if (opcode === 8) { socket.end(); return }
          if (opcode !== 2 || completed) continue
          if (spdy) { spdy.receive(payload); continue }
          if (payload[0] === 0) input = Buffer.concat([input, payload.subarray(1)])
          if (payload[0] === 255 && payload[1] === 0) {
            completed = true
            void (async () => {
              if (command[0] === 'tar') {
                const { readWorkspaceTar } = await import(workspaceRuntime) as WorkspaceRuntime
                evidence.uploads.push(...readWorkspaceTar(input).map(file => ({ path: file.path, bytes: file.bytes.length,
                  sha256: createHash('sha256').update(file.bytes).digest('hex') })))
              } else for (let offset = 0; offset < input.length; offset += 32768) output(1, input.subarray(offset, offset + 32768))
              finish()
            })().catch(() => socket.destroy())
          }
        }
      }
      socket.on('data', receive)
      if (spdy) { receive(Buffer.alloc(0)); return }
      if (command[0] === 'synthetic-hold') { output(1, 'safe-before-EOF\n'); return }
      if (command[0] === 'synthetic-secret') {
        output(1, 'CANARY-kube')
        setImmediate(() => { output(1, 'rnetes-token'); finish() }); return
      }
      if (command[0] === 'tar' && command[1] === 'cf') {
        const { workspaceTar } = await import(workspaceRuntime) as WorkspaceRuntime
        const directory = await mkdtemp(join(tmpdir(), 'artium-kubernetes-peer-'))
        try {
          const name = command.at(-1)!
          await writeFile(join(directory, name), Buffer.from([0, 255, 13, 10, 128, 1]), { mode: 0o600 })
          const archive = await workspaceTar(directory, name)
          for (let index = 0; index < archive.length; index += 32768) output(1, archive.subarray(index, index + 32768))
          finish()
        } finally { await rm(directory, { recursive: true, force: true }) }
      } else if (url.searchParams.get('stdin') !== 'true') {
        output(1, 'synthetic-byte-result\n'); output(2, 'synthetic-stderr\n'); finish(command[0] === 'synthetic-exit' ? 7 : 0)
      }
    })().catch(() => socket.destroy())
  })
  return () => ({ ...evidence, active: peers.size })
}
