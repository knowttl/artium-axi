import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { connect, isIP } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type { ToolName } from '../store/credential-store.js'
import { certificateErrorCodePattern, diagnosticError } from './diagnostic.js'

// Destinations for the inventory health reads, in connection order.
// Configured origins are validated by the adapter schema before this boundary.
export function healthEndpoints(tool: ToolName, credential: Record<string, unknown>): URL[] {
  if (tool === 'vectra-axi') return [new URL(String(credential.origin))]
  if (tool === 'ldap-axi') return [new URL(String(credential.url))]
  if (tool === 'az-axi') return ['https://login.microsoftonline.com', 'https://management.azure.com'].map(url => new URL(url))
  if (tool === 'mg-axi') return ['https://login.microsoftonline.com', 'https://graph.microsoft.com'].map(url => new URL(url))
  const regions: Record<string, string> = { 'us-1': 'api.crowdstrike.com', 'us-2': 'api.us-2.crowdstrike.com',
    'eu-1': 'api.eu-1.crowdstrike.com', 'us-gov-1': 'api.laggar.gcw.crowdstrike.com',
    'us-gov-2': 'api.us-gov-2.crowdstrike.mil' }
  const region = String(credential.region)
  const host = Object.entries(regions).find(([name, host]) => region === name || region === `https://${host}` || region === `https://${host}/`)?.[1]
  if (!host) throw diagnosticError('CREDENTIAL_INVALID', { stage: 'configuration', message: 'Invalid credential field: region.' })
  return [new URL(`https://${host}`)]
}

function verificationCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONNECTION_FAILED'
}

// The handshake sends no application data or credentials. Each stage has a deadline.
export async function preflightEndpoint(endpoint: URL, ca?: string, timeoutMs = 5000): Promise<void> {
  const host = endpoint.hostname.replace(/^\[|\]$/g, '')
  const port = Number(endpoint.port || (endpoint.protocol === 'ldaps:' ? 636 : endpoint.protocol === 'ldap:' ? 389 : 443))
  let addresses: LookupAddress[]
  let timer: NodeJS.Timeout | undefined
  try {
    addresses = await Promise.race([lookup(host, { all: true }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'ETIMEDOUT' })), timeoutMs)
    })])
  } catch (error) {
    throw diagnosticError('UPSTREAM_NETWORK_FAILED', { stage: 'DNS', host, message: `DNS lookup failed for ${host}: ${verificationCode(error)}.` })
  } finally { clearTimeout(timer) }
  const socket = connect({ host, port, autoSelectFamily: true,
    lookup: (_hostname, _options, callback) => callback(null, addresses) })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(timeoutMs, () => socket.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })))
      socket.once('connect', resolve)
      socket.once('error', reject)
      socket.once('close', () => reject(Object.assign(new Error(), { code: 'ECONNRESET' })))
    })
  } catch (error) {
    socket.destroy()
    throw diagnosticError('UPSTREAM_NETWORK_FAILED', { stage: 'TCP', host, message: `TCP connection failed for ${host}:${port}: ${verificationCode(error)}.` })
  }
  if (endpoint.protocol === 'ldap:') {
    try {
      // LDAP StartTLS extended request, message id 1. This contains no bind identity.
      await new Promise<void>((resolve, reject) => {
        let received = Buffer.alloc(0)
        const onData = (chunk: Buffer) => {
          received = Buffer.concat([received, chunk])
          if (received.length < 2) return
          const lengthBytes = received[1] < 128 ? 0 : received[1] & 127
          if (received[0] !== 0x30 || lengthBytes > 2 || received.length > 4096 || received[1] === 128) {
            cleanup(); reject(new Error('Invalid StartTLS response')); return
          }
          if (received.length < 2 + lengthBytes) return
          const length = lengthBytes ? received.readUIntBE(2, lengthBytes) : received[1]
          const offset = 2 + lengthBytes
          if (length > 4096) { cleanup(); reject(new Error('Invalid StartTLS response')); return }
          if (received.length < offset + length) return
          cleanup()
          const applicationLengthBytes = received[offset + 4] < 128 ? 0 : received[offset + 4] & 127
          const result = offset + 5 + applicationLengthBytes
          if (received.subarray(offset, offset + 4).equals(Buffer.from([2, 1, 1, 0x78])) && applicationLengthBytes <= 2
            && received.subarray(result, result + 3).equals(Buffer.from([0x0a, 1, 0]))) resolve()
          else reject(new Error('StartTLS was rejected'))
        }
        const onError = (error: Error) => { cleanup(); reject(error) }
        const onClose = () => onError(new Error('StartTLS connection closed'))
        const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose) }
        socket.on('data', onData).once('error', onError).once('close', onClose)
        socket.write(Buffer.from('301d02010177188016312e332e362e312e342e312e313436362e3230303337', 'hex'))
      })
    } catch {
      socket.destroy()
      throw diagnosticError('UPSTREAM_TLS_FAILED', { stage: 'TLS', host, message: `LDAP StartTLS negotiation failed for ${host}.`, hint: 'Check that the directory supports StartTLS on this port.' })
    }
  }
  // Node verifies chain and hostname even with rejectUnauthorized=false. Retain the
  // peer certificate for the diagnostic, then require authorized before success.
  // No application bytes or credentials are sent on this socket.
  const secure = connectTls({ socket, host, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ...(ca ? { ca } : {}) })
  try {
    await new Promise<void>((resolve, reject) => {
      secure.setTimeout(timeoutMs, () => secure.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })))
      secure.once('secureConnect', resolve)
      secure.once('error', reject)
      secure.once('close', () => reject(Object.assign(new Error(), { code: 'ECONNRESET' })))
    })
    if (!secure.authorized) throw Object.assign(new Error(), { code: secure.authorizationError })
  } catch (error) {
    const code = verificationCode(error)
    const certificate = secure.getPeerCertificate()
    if (!certificateErrorCodePattern.test(code)) {
      throw diagnosticError('UPSTREAM_NETWORK_FAILED', { stage: 'TLS', host, message: `TLS connection failed for ${host}: ${code}.` })
    }
    const issuer = certificate?.issuer ? Object.entries(certificate.issuer).map(([key, value]) => `${key}=${value}`).join(', ') : undefined
    throw diagnosticError('UPSTREAM_TLS_FAILED', { stage: 'TLS', host,
      message: `TLS verification failed for ${host}: ${code}.`, toolCode: code,
      ...(issuer ? { issuer } : {}), trust: /SELF_SIGNED/.test(code) ? 'self-signed' : 'untrusted',
      hint: 'Check the presented chain and the upstream trusted-CA configuration (see docs/runbook.md; trusted-CA support is tracked in issue #99).' })
  } finally { secure.destroy(); socket.destroy() }
}

export async function preflight(tool: ToolName, credential: Record<string, unknown>): Promise<void> {
  const ca = credential.caBundle ?? credential.caFile
  for (const endpoint of healthEndpoints(tool, credential)) {
    await preflightEndpoint(endpoint, typeof ca === 'string' ? ca : undefined)
  }
}
