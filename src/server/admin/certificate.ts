import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { ArtiumError } from '../../shared/errors.js'

export function certificateFields(pem: unknown, sha256: boolean): Record<string, string> {
  try {
    if (typeof pem !== 'string') throw new Error('Invalid PEM')
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    const keys = pem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g)
    if (certificates?.length !== 1 || keys?.length !== 1) throw new Error('Expected one certificate and key')
    const certificate = new X509Certificate(certificates[0])
    const key = createPrivateKey(keys[0])
    if (!certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(key).export({ type: 'spki', format: 'der' }))) throw new Error('Key mismatch')
    return { privateKey: keys[0] + '\n',
      [sha256 ? 'thumbprintSha256' : 'thumbprint']: (sha256 ? certificate.fingerprint256 : certificate.fingerprint).replaceAll(':', '').toLowerCase() }
  } catch { throw new ArtiumError('INVALID_INPUT', 'The PEM must contain one certificate and its matching unencrypted private key.', 'Choose a matching certificate and key, then save again.') }
}
