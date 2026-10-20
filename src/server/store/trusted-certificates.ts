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
  mode: 'ca' | 'pin'
}

export function readCredentialTrust(db: Database.Database, reference: CredentialReference): CredentialTrust[] {
  const rows = db.prepare(`SELECT endpoint, pem, leaf_pem AS leafPem, fingerprint, leaf_fingerprint AS leafFingerprint, mode
    FROM trusted_certificates WHERE credential_id = ?`).all(reference.id) as (CredentialTrust & { leafPem: string })[]
  const caEndpoints = new Set(rows.filter(row => row.mode === 'ca').map(row => certificateEndpoint(row.endpoint).href))
  return rows.map(({ leafPem, ...row }) => ({ ...row,
    pem: row.mode === 'pin' && caEndpoints.has(certificateEndpoint(row.endpoint).href) ? leafPem : row.pem }))
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
