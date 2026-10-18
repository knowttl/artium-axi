import { X509Certificate } from 'node:crypto'
import type Database from 'better-sqlite3'
import { certificateDetails } from '../certificate-inspection.js'
import type { CredentialReference } from './credential-store.js'

export interface CredentialTrust {
  endpoint: string
  pem: string
  fingerprint: string
  leafFingerprint: string
  mode: 'pin' | 'intermediate'
}

export function readCredentialTrust(db: Database.Database, reference: CredentialReference): CredentialTrust[] {
  return db.prepare(`SELECT endpoint, pem, fingerprint, leaf_fingerprint AS leafFingerprint, mode
    FROM trusted_certificates WHERE credential_id = ?`).all(reference.id) as CredentialTrust[]
}

export function credentialCertificates(db: Database.Database, credentialId: string) {
  const rows = db.prepare('SELECT id, endpoint, pem, leaf_pem, mode, created_at FROM trusted_certificates WHERE credential_id = ? ORDER BY created_at, id')
    .all(credentialId) as { id: string, endpoint: string, pem: string, leaf_pem: string,
      mode: 'pin' | 'intermediate', created_at: number }[]
  return rows.map(row => {
    const hostname = new URL(row.endpoint).hostname.replace(/^\[|\]$/g, '')
    return { id: row.id, endpoint: row.endpoint, mode: row.mode, createdAt: row.created_at,
      certificate: certificateDetails(new X509Certificate(row.pem), hostname),
      leaf: certificateDetails(new X509Certificate(row.leaf_pem), hostname) }
  })
}
