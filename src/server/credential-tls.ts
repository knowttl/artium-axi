import { request } from 'node:https'
import { checkServerIdentity, getCACertificates } from 'node:tls'
import type { ConnectionOptions } from 'node:tls'
import type { CredentialTrust } from './store/trusted-certificates.js'

export function credentialTlsOptions(trust: readonly CredentialTrust[], ca?: string): ConnectionOptions {
  return { rejectUnauthorized: true,
    ...(ca || trust.length ? { ca: [...getCACertificates('default'), ...(ca ? [ca] : []), ...trust.map(certificate => certificate.pem)] } : {}),
    ...(trust.length ? { allowPartialTrustChain: trust.some(certificate => certificate.mode === 'pin'), checkServerIdentity: (hostname, certificate) => {
      const error = checkServerIdentity(hostname, certificate)
      if (error) return error
      const pins = trust.filter(certificate => certificate.mode === 'pin')
      if (pins.length && !pins.some(pin => pin.leafFingerprint === certificate.fingerprint256)) {
        return Object.assign(new Error('TLS certificate fingerprint changed'), { code: 'CERTIFICATE_PIN_MISMATCH' })
      }
    } } : {}) }
}

// Server-side token acquisition uses the same credential trust as runner children.
// Requests never follow redirects or reuse TLS sessions across trust changes.
export function credentialFetch(url: string, init: { method: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal },
  trust: readonly CredentialTrust[]): Promise<Response> {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'https:') return Promise.reject(new Error('TLS is required'))
  const scoped = trust.filter(certificate => new URL(certificate.endpoint).origin === endpoint.origin)
  return new Promise((resolve, reject) => {
    const outgoing = request(endpoint, { ...init, ...credentialTlsOptions(scoped), agent: false }, incoming => {
      const chunks: Buffer[] = []
      let bytes = 0
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) outgoing.destroy(new Error('Identity provider response is too large'))
        else chunks.push(chunk)
      })
      incoming.once('error', reject)
      incoming.once('end', () => {
        try {
          resolve(new Response(Buffer.concat(chunks).toString('utf8'), {
            status: incoming.statusCode,
            headers: Object.fromEntries(Object.entries(incoming.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          }))
        } catch (error) { reject(error) }
      })
    })
    outgoing.once('error', reject)
    outgoing.end(init.body)
  })
}
