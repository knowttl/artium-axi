import { createServer } from 'node:http'
import { request } from 'node:https'
import type { ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { certificateEndpoint } from '../certificate-endpoint.js'
import { credentialTlsOptions } from '../credential-tls.js'
import type { CredentialTrust } from '../store/trusted-certificates.js'

export async function pinnedHttp(socketPath: string, trust: readonly CredentialTrust[], ca?: string) {
  const outgoing = new Set<ClientRequest>()
  const sockets = new Set<Socket>()
  const server = createServer((incoming, response) => {
    if (!incoming.headers.host || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
      response.writeHead(400).end()
      return
    }
    const target = new URL(incoming.url, `https://${incoming.headers.host}`)
    const scoped = trust.filter(item => certificateEndpoint(item.endpoint).href === certificateEndpoint(target).href)
    const upstream = request(target, { method: incoming.method, headers: incoming.headers,
      ...credentialTlsOptions(scoped, ca), agent: false }, result => {
      response.writeHead(result.statusCode!, result.headers)
      result.pipe(response)
      result.once('error', () => response.destroy())
    })
    outgoing.add(upstream)
    upstream.once('close', () => outgoing.delete(upstream))
    upstream.on('error', error => {
      if (response.headersSent) response.destroy()
      else response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({
        message: (error as NodeJS.ErrnoException).code === 'CERTIFICATE_PIN_MISMATCH'
          ? 'CERTIFICATE_PIN_MISMATCH' : 'Upstream TLS connection failed',
      }))
    })
    response.once('close', () => upstream.destroy())
    response.on('error', () => upstream.destroy())
    incoming.once('error', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('connect', (_request, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    async close() {
      for (const request of outgoing) request.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
