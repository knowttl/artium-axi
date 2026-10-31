import { Socket } from 'node:net'
import { TLSSocket } from 'node:tls'

// Model the TLS transport's failure event, including peer metadata available on
// a failed handshake. The real preflight code must classify and redact it.
export function failedTlsSocket(code: string, issuer = 'Synthetic test CA'): TLSSocket {
  const socket = new TLSSocket(new Socket())
  socket.authorized = false
  if (code === 'CERT_HAS_EXPIRED') socket.authorizationError = new Error(code)
  socket.getPeerCertificate = (() => ({ issuer: { CN: issuer } })) as TLSSocket['getPeerCertificate']
  queueMicrotask(() => socket.emit('error', Object.assign(new Error('Synthetic TLS failure'), { code })))
  return socket
}
