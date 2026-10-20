import { request } from 'node:https'
import { connect as connectTcp, isIP } from 'node:net'
import { checkServerIdentity, connect, getCACertificates } from 'node:tls'
import type { ConnectionOptions, TLSSocket } from 'node:tls'
import type { CredentialTrust } from './store/trusted-certificates.js'
import { certificateEndpoint } from './certificate-endpoint.js'
import { startLdapTls } from './ldap-starttls.js'

export const certificatePinMismatchMessage = 'The stored certificate fingerprint differs from the presented one. Ask an administrator to re-inspect the certificate on the tool page.'

export function certificatePinError(trust: readonly Pick<CredentialTrust, 'mode' | 'leafFingerprint'>[], fingerprint?: string): Error | undefined {
  const pins = trust.filter(certificate => certificate.mode === 'pin')
  if (fingerprint && !trust.some(certificate => certificate.mode === 'ca') && pins.length
    && !pins.some(pin => pin.leafFingerprint === fingerprint)) {
    return Object.assign(new Error(certificatePinMismatchMessage), { code: 'CERTIFICATE_PIN_MISMATCH' })
  }
}

export async function classifyCertificateFailure(error: Error,
  trust: readonly Pick<CredentialTrust, 'mode' | 'leafFingerprint'>[], fingerprint: string | undefined,
  observe?: () => Promise<string | undefined>): Promise<Error> {
  if (!trust.some(certificate => certificate.mode === 'pin') || trust.some(certificate => certificate.mode === 'ca')) return error
  if (!fingerprint && observe) {
    try { fingerprint = await observe() } catch { return error }
  }
  return certificatePinError(trust, fingerprint) ?? error
}

export function observeCertificate(connectTls: typeof connect, options: ConnectionOptions, protocol = 'https:'): Promise<string | undefined> {
  return new Promise(resolve => {
    let secure: TLSSocket | undefined
    const plain = protocol === 'ldap:' ? connectTcp({ host: options.host, port: options.port! }) : undefined
    const finish = (fingerprint?: string) => { clearTimeout(timer); secure?.destroy(); plain?.destroy(); resolve(fingerprint) }
    const timer = setTimeout(() => finish(), 3000)
    const handshake = () => {
      secure = connectTls({ host: options.host, port: options.port, servername: options.servername,
        minVersion: options.minVersion, maxVersion: options.maxVersion, rejectUnauthorized: false,
        ...(plain ? { socket: plain } : {}) })
      secure.once('secureConnect', () => finish(secure?.getPeerCertificate().fingerprint256))
      secure.once('error', () => finish())
      secure.once('close', () => finish())
    }
    if (plain) {
      plain.once('error', () => finish())
      plain.once('close', () => finish())
      plain.once('connect', () => {
        void startLdapTls(plain).then(() => { if (!plain.destroyed) handshake() }, () => finish())
      })
    } else handshake()
  })
}

export function credentialTlsOptions(trust: readonly CredentialTrust[], ca?: string): ConnectionOptions {
  return buildCredentialTlsOptions({ checkServerIdentity, getCACertificates }, trust,
    ca ? [...getCACertificates('default'), ca] : undefined)
}

// Serialized with its mismatch message so runner Node injection uses the server's TLS policy.
export function buildCredentialTlsOptions(tls: Pick<typeof import('node:tls'), 'checkServerIdentity' | 'getCACertificates'>,
  trust: readonly Pick<CredentialTrust, 'mode' | 'pem' | 'leafFingerprint'>[], ca?: ConnectionOptions['ca']): ConnectionOptions {
  const anchored = trust.length > 0
  const roots = anchored ? [] : ca === undefined ? tls.getCACertificates('default') : [ca].flat()
  return { rejectUnauthorized: true,
    ca: [...roots, ...trust.map(certificate => certificate.pem)],
    allowPartialTrustChain: anchored,
    checkServerIdentity: (hostname, certificate) => {
      const error = tls.checkServerIdentity(hostname, certificate)
      if (error) return error
      return certificatePinError(trust, certificate.fingerprint256)
    } }
}

// Server-side token acquisition uses the same credential trust as runner children.
// Requests never follow redirects or reuse TLS sessions across trust changes.
export function credentialFetch(url: string, init: { method: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal },
  trust: readonly CredentialTrust[]): Promise<Response> {
  const endpoint = new URL(url)
  if (endpoint.protocol !== 'https:') return Promise.reject(new Error('TLS is required'))
  const scoped = trust.filter(certificate => certificateEndpoint(certificate.endpoint).href === certificateEndpoint(endpoint).href)
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
    outgoing.once('error', error => {
      void classifyCertificateFailure(error, scoped, (outgoing.socket as TLSSocket | null)?.getPeerCertificate()?.fingerprint256, () => observeCertificate(connect, {
        host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port || 443),
        servername: isIP(endpoint.hostname.replace(/^\[|\]$/g, '')) ? undefined : endpoint.hostname,
      })).then(reject)
    })
    outgoing.end(init.body)
  })
}
