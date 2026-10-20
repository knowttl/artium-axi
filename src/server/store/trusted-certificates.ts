import { X509Certificate } from 'node:crypto'
import type Database from 'better-sqlite3'
import { certificateDetails } from '../certificate-inspection.js'
import { certificateEndpoint } from '../certificate-endpoint.js'
import type { CredentialReference } from './credential-store.js'

export interface CredentialTrust {
  endpoint: string
  pem: string
  fingerprint: string
  leafFingerprint: string
  mode: 'ca' | 'pin' | 'intermediate'
}

export function readCredentialTrust(db: Database.Database, reference: CredentialReference): CredentialTrust[] {
  const rows = db.prepare(`SELECT endpoint, pem, leaf_pem AS leafPem, fingerprint, leaf_fingerprint AS leafFingerprint, mode
    FROM trusted_certificates WHERE credential_id = ?`).all(reference.id) as (CredentialTrust & { leafPem: string })[]
  const caEndpoints = new Set(rows.filter(row => row.mode === 'ca').map(row => certificateEndpoint(row.endpoint).href))
  return rows.map(({ leafPem, ...row }) => {
    if (row.mode === 'intermediate') return row
    const endpoint = certificateEndpoint(row.endpoint).href
    const pem = row.mode === 'pin' && caEndpoints.has(endpoint) ? leafPem : row.pem
    const intermediates = rows.filter(certificate => certificate.mode === 'intermediate'
      && certificateEndpoint(certificate.endpoint).href === endpoint).map(certificate => new X509Certificate(certificate.pem))
    const chain = [new X509Certificate(pem)]
    for (let index = 0; index < chain.length; index++) {
      for (const intermediate of intermediates) {
        if (!chain.some(certificate => certificate.fingerprint256 === intermediate.fingerprint256)
          && intermediate.checkIssued(chain[index]) && intermediate.verify(chain[index].publicKey)) chain.push(intermediate)
      }
    }
    return { ...row, pem: [pem, ...chain.slice(1).map(certificate => certificate.toString())].join('\n') }
  })
}

export function credentialCertificates(db: Database.Database, credentialId: string) {
  const rows = db.prepare('SELECT id, endpoint, pem, leaf_pem, mode, created_at FROM trusted_certificates WHERE credential_id = ? ORDER BY created_at, id')
    .all(credentialId) as { id: string, endpoint: string, pem: string, leaf_pem: string,
      mode: CredentialTrust['mode'], created_at: number }[]
  return rows.map(row => {
    const { hostname, href } = certificateEndpoint(row.endpoint)
    return { id: row.id, endpoint: href, mode: row.mode, createdAt: row.created_at,
      certificate: certificateDetails(new X509Certificate(row.pem), hostname),
      leaf: certificateDetails(new X509Certificate(row.leaf_pem), hostname) }
  })
}
