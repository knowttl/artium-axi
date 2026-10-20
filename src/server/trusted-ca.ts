import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { ArtiumError } from '../shared/errors.js'
import { certificateSubject } from './certificate-subject.js'

export interface TrustedCertificate {
  subject: string
  issuer: string
  expiresAt: string
  fingerprint: string
}

export interface TrustedCaBundle {
  pem: string
  certificates: readonly TrustedCertificate[]
}

export function loadTrustedCa(environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = message => process.stderr.write(message + '\n'), now = Date.now()): TrustedCaBundle | undefined {
  const file = environment.ARTIUM_AXI_EXTRA_CA_FILE
  if (file === undefined) return
  const refuse = (reason: string): never => {
    throw new ArtiumError('INVALID_INPUT', `ARTIUM_AXI_EXTRA_CA_FILE ${reason}.`,
      'Mount a readable PEM bundle containing only public certificates, then restart the server.')
  }
  let contents: string
  try { contents = readFileSync(file, 'utf8') }
  catch { return refuse('must be a readable PEM bundle') }
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(contents)) refuse('must not contain a private key')
  const blocks = contents.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
  if (!blocks?.length) return refuse('must contain at least one certificate')
  if (contents.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) {
    refuse('contains malformed PEM or non-certificate data')
  }
  const certificates = blocks.map(block => {
    let certificate: X509Certificate
    try { certificate = new X509Certificate(block) }
    catch { return refuse('contains a malformed certificate') }
    const expiry = Date.parse(certificate.validTo)
    if (expiry <= now + 30 * 24 * 60 * 60 * 1000) {
      warn(`ARTIUM_AXI_EXTRA_CA_FILE: certificate ${certificate.fingerprint256} ${expiry <= now ? 'has expired' : 'expires within 30 days'}.`)
    }
    return { subject: certificateSubject(certificate), issuer: certificate.issuer ?? '(no issuer)',
      expiresAt: new Date(expiry).toISOString(), fingerprint: certificate.fingerprint256 }
  })
  return { pem: blocks.join('\n') + '\n', certificates }
}

// Install before any outbound connection or fetch creates a cached TLS session.
export function installTrustedCa(bundle: TrustedCaBundle | undefined): void {
  if (bundle) setDefaultCACertificates([...getCACertificates('default'),
    ...bundle.pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!])
}
