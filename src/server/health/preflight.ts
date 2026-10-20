import type { LookupAddress } from 'node:dns'
import { X509Certificate } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { connect, isIP } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type { CredentialTrust } from '../store/trusted-certificates.js'
import { certificatePinMismatchMessage, classifyCertificateFailure, credentialTlsOptions } from '../credential-tls.js'
import { certificateEndpoint } from '../certificate-endpoint.js'
import { startLdapTls } from '../ldap-starttls.js'
import type { ToolName } from '../store/credential-store.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { certificateErrorCodePattern, diagnosticError } from './diagnostic.js'

function verificationCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONNECTION_FAILED'
}

// The handshake sends no application data or credentials. Each stage has a deadline.
export async function inspectEndpoint(endpoint: URL, ca?: string, timeoutMs = 5000, maxVersion?: 'TLSv1.2',
  trust: readonly CredentialTrust[] = []):
Promise<{ chain: X509Certificate[], verificationError?: string }> {
  const { hostname: host, port } = certificateEndpoint(endpoint)
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
      await startLdapTls(socket)
    } catch (error) {
      socket.destroy()
      const code = verificationCode(error)
      if (code !== 'CONNECTION_FAILED') throw diagnosticError('UPSTREAM_NETWORK_FAILED', {
        stage: 'TLS', host, message: `LDAP StartTLS connection failed for ${host}: ${code}.` })
      throw diagnosticError('UPSTREAM_TLS_FAILED', { stage: 'TLS', host, message: `LDAP StartTLS negotiation failed for ${host}.`, hint: 'Check that the directory supports StartTLS on this port.' })
    }
  }
  // Node verifies chain and hostname even with rejectUnauthorized=false. Retain the
  // peer certificate for the diagnostic, then require authorized before success.
  // No application bytes or credentials are sent on this socket.
  const secure = connectTls({ ...credentialTlsOptions(trust, ca), socket, host,
    servername: isIP(host) ? undefined : host, rejectUnauthorized: false, ...(maxVersion ? { maxVersion } : {}) })
  try {
    await new Promise<void>((resolve, reject) => {
      secure.setTimeout(timeoutMs, () => secure.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })))
      secure.once('secureConnect', resolve)
      secure.once('error', reject)
      secure.once('close', () => reject(Object.assign(new Error(), { code: 'ECONNRESET' })))
    })
    const chain: X509Certificate[] = []
    let peer = secure.getPeerCertificate(true)
    const seen = new Set<string>()
    while (peer?.raw && !seen.has(peer.fingerprint256)) {
      seen.add(peer.fingerprint256)
      chain.push(new X509Certificate(peer.raw))
      peer = peer.issuerCertificate
    }
    const failure = !secure.authorized ? await classifyCertificateFailure(
      Object.assign(new Error(), { code: String(secure.authorizationError) }), trust, chain[0]?.fingerprint256) : undefined
    return { chain, ...(failure ? { verificationError: (failure as NodeJS.ErrnoException).code } : {}) }
  } catch (error) {
    const certificate = secure.getPeerCertificate()
    const code = verificationCode(await classifyCertificateFailure(error as Error, trust, certificate?.fingerprint256))
    if (!secure.authorizationError && !certificateErrorCodePattern.test(code)) {
      throw diagnosticError('UPSTREAM_NETWORK_FAILED', { stage: 'TLS', host, message: `TLS connection failed for ${host}: ${code}.` })
    }
    const issuer = certificate?.issuer ? Object.entries(certificate.issuer).map(([key, value]) => `${key}=${value}`).join(', ') : undefined
    throw diagnosticError('UPSTREAM_TLS_FAILED', { stage: 'TLS', host,
      message: code === 'CERTIFICATE_PIN_MISMATCH' ? certificatePinMismatchMessage : `TLS verification failed for ${host}: ${code}.`, toolCode: code,
      ...(issuer && code !== 'CERTIFICATE_PIN_MISMATCH' ? { issuer } : {}), trust: /SELF_SIGNED/.test(code) ? 'self-signed' : 'untrusted',
      hint: 'Check the presented chain and the upstream trusted-CA configuration (see docs/runbook.md; trusted-CA support is tracked in issue #99).' })
  } finally { secure.destroy(); socket.destroy() }
}

export async function preflightEndpoint(endpoint: URL, ca?: string, timeoutMs = 5000, maxVersion?: 'TLSv1.2',
  trust: readonly CredentialTrust[] = []): Promise<void> {
  const result = await inspectEndpoint(endpoint, ca, timeoutMs, maxVersion, trust)
  if (!result.verificationError) return
  const host = endpoint.hostname.replace(/^\[|\]$/g, '')
  const code = result.verificationError
  throw diagnosticError('UPSTREAM_TLS_FAILED', { stage: 'TLS', host,
    message: code === 'CERTIFICATE_PIN_MISMATCH' ? certificatePinMismatchMessage : `TLS verification failed for ${host}: ${code}.`, toolCode: code,
    ...(result.chain[0] && code !== 'CERTIFICATE_PIN_MISMATCH' ? { issuer: result.chain[0].issuer.replaceAll('\n', ', ') } : {}),
    trust: /SELF_SIGNED/.test(code) ? 'self-signed' : 'untrusted',
    hint: 'Ask an administrator to inspect the presented certificate on the tool page.' })
}

export async function preflight(tool: ToolName, credential: Record<string, unknown>, trust: readonly CredentialTrust[] = []): Promise<void> {
  const ca = credential.caBundle ?? credential.caFile
  for (const endpoint of toolEndpoints(tool, credential)) {
    await preflightEndpoint(endpoint, typeof ca === 'string' ? ca : undefined, undefined,
      tool === 'ldap-axi' && credential.tlsMaxVersion === '1.2' ? 'TLSv1.2' : undefined,
      trust.filter(certificate => certificateEndpoint(certificate.endpoint).href === certificateEndpoint(endpoint).href))
  }
}
