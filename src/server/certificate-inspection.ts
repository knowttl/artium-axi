import { X509Certificate } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { isIP } from 'node:net'
import { inspectEndpoint } from './health/preflight.js'
import { certificateEndpoint } from './certificate-endpoint.js'
import { certificateSubject } from './certificate-subject.js'

const issuerTimeoutMs = 3000
const issuerMaxBytes = 128 * 1024

export function certificateDetails(certificate: X509Certificate, hostname: string, now = Date.now()) {
  const key = certificate.publicKey
  const curveBits = key.asymmetricKeyDetails?.namedCurve?.match(/\d+/)?.[0]
  const bits = key.asymmetricKeyDetails?.modulusLength
    ?? (curveBits ? Number(curveBits) : key.asymmetricKeyType === 'ed25519' ? 256
      : key.asymmetricKeyType === 'ed448' ? 448 : null)
  const matchesHostname = Boolean(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname))
  const expired = Date.parse(certificate.validTo) <= now
  const notYetValid = Date.parse(certificate.validFrom) > now
  const weakKey = bits !== null && (['rsa', 'rsa-pss', 'dsa'].includes(key.asymmetricKeyType ?? '') ? bits < 2048 : bits < 224)
  return { subject: certificateSubject(certificate), issuer: certificate.issuer ?? '(no issuer)',
    subjectAlternativeNames: certificate.subjectAltName ?? '',
    validFrom: new Date(certificate.validFrom).toISOString(), expiresAt: new Date(certificate.validTo).toISOString(),
    fingerprint: certificate.fingerprint256, matchesHostname, expired, notYetValid, weakKey,
    keyType: key.asymmetricKeyType ?? 'unknown', keyBits: bits,
    signatureAlgorithm: (certificate as X509Certificate & { signatureAlgorithm: string }).signatureAlgorithm,
    selfSigned: Boolean(certificate.subject?.trim() && certificate.issuer?.trim()
      && certificate.subject === certificate.issuer && certificate.verify(key)), ca: certificate.ca }
}

// The only URL accepted here is extracted from the saved endpoint's leaf certificate.
// The total deadline includes DNS, connection setup and receipt of the entire body.
async function fetchIssuer(leaf: X509Certificate): Promise<X509Certificate | undefined> {
  const entry = leaf.infoAccess?.split('\n').find(line => line.startsWith('CA Issuers - URI:'))
  if (!entry) return
  try {
    const value = entry.slice('CA Issuers - URI:'.length)
    const url = new URL(value.startsWith('"') ? JSON.parse(value) : value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
    const contents = await new Promise<Buffer>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error('Issuer retrieval requires a direct successful response'))
          response.destroy()
          request.destroy()
          return
        }
        let bytes = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > issuerMaxBytes) {
            reject(new Error('Issuer certificate exceeds the size limit'))
            response.destroy()
            request.destroy()
          }
          else chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('aborted', () => reject(new Error('Issuer retrieval was interrupted')))
        response.once('end', () => resolve(Buffer.concat(chunks)))
      })
      const timer = setTimeout(() => request.destroy(new Error('Issuer retrieval timed out')), issuerTimeoutMs)
      request.once('error', reject)
      request.once('close', () => clearTimeout(timer))
    })
    if (contents.includes(Buffer.from('-----BEGIN'))) {
      const text = contents.toString('utf8')
      if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(text)) return
    }
    const issuer = new X509Certificate(contents)
    if (issuer.ca && leaf.checkIssued(issuer) && leaf.verify(issuer.publicKey)) return issuer
  } catch { /* An unavailable or invalid AIA issuer leaves the original trust failure visible. */ }
}

export async function inspectCertificate(endpoint: URL, ca?: string, maxVersion?: 'TLSv1.2') {
  const { hostname: host, href } = certificateEndpoint(endpoint)
  const presented = await inspectEndpoint(endpoint, ca, undefined, maxVersion)
  if (!presented.chain.length) throw new Error('The endpoint presented no certificate')
  const leaf = presented.chain[0]
  let intermediate: X509Certificate | undefined
  if (presented.chain.length === 1 && ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(presented.verificationError ?? '')) {
    intermediate = await fetchIssuer(leaf)
  }
  const chain = presented.chain.map(certificate => certificateDetails(certificate, host))
  if (intermediate) chain.push(certificateDetails(intermediate, host))
  const warnings: string[] = []
  if (!chain[0].matchesHostname) warnings.push('The hostname does not match the certificate names.')
  for (const certificate of chain) {
    if (certificate.expired) warnings.push('A certificate has expired.')
    if (certificate.notYetValid) warnings.push('A certificate is not yet valid.')
    if (certificate.weakKey) warnings.push('A certificate uses a weak public key.')
  }
  if (!chain[0].matchesHostname || chain.some(certificate => certificate.expired || certificate.notYetValid)) {
    warnings.push('Trust does not bypass hostname or validity checks. Renew the certificate or use its matching hostname to fix these failures.')
  }
  let reason = 'The certificate verifies with this server’s existing trust.'
  if (intermediate) reason = 'The server sent no intermediate. Its fetched issuer requires administrator confirmation for CA trust.'
  else if (chain[0].selfSigned) reason = 'The server presents a self-signed certificate.'
  else if (chain.some(certificate => certificate.expired)) reason = 'A certificate has expired.'
  else if (chain.some(certificate => certificate.notYetValid)) reason = 'A certificate is not yet valid.'
  else if (!chain[0].matchesHostname) reason = 'The hostname does not match the certificate names.'
  else if (presented.verificationError === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') reason = 'The server sent no intermediate and its issuer could not be verified.'
  else if (presented.verificationError) reason = 'The certificate was issued by a CA this server does not trust.'
  const anchor = intermediate ?? presented.chain.find((certificate, index) => index > 0 && certificate.ca) ?? leaf
  return { hostname: host, endpoint: href, chain, warnings, reason,
    verificationError: presented.verificationError ?? null,
    anchor: certificateDetails(anchor, host), pem: anchor.toString(), leafPem: leaf.toString() }
}
