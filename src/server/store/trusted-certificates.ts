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

export interface ConfirmedLeaf {
  fingerprint: string
  pem: string | null
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
  const confirmed = new Map(readConfirmedLeaves(db, credentialId).map(item => [item.endpoint, item.leaf] as const))
  return rows.map(row => {
    const { hostname, href } = certificateEndpoint(row.endpoint)
    const state = row.mode === 'ca' ? confirmed.get(href) : undefined
    const leafPem = state === undefined ? row.leaf_pem : state?.pem ?? null
    const leaf = leafPem === null ? null : certificateDetails(new X509Certificate(leafPem), hostname)
    return { id: row.id, endpoint: href, mode: row.mode, createdAt: row.created_at,
      certificate: certificateDetails(new X509Certificate(row.pem), hostname),
      leaf, leafFingerprint: state === undefined ? leaf!.fingerprint : state?.fingerprint ?? null }
  })
}

function readConfirmedLeaves(db: Database.Database, credentialId: string) {
  return (db.prepare(`SELECT endpoint, confirmed_leaf_pem AS pem, confirmed_leaf_fingerprint AS fingerprint
    FROM certificate_endpoint_state WHERE credential_id = ? AND (confirmed_leaf_fingerprint IS NOT NULL OR confirmed_leaf_pem IS NOT NULL)`).all(credentialId) as
    { endpoint: string, pem: string | null, fingerprint: string | null }[])
    .map(row => ({ endpoint: certificateEndpoint(row.endpoint).href, leaf: row.fingerprint === '' ? null :
      { fingerprint: row.fingerprint ?? new X509Certificate(row.pem!).fingerprint256, pem: row.pem } }))
}

export function readConfirmedLeaf(db: Database.Database, credentialId: string, endpoint: string) {
  return readConfirmedLeaves(db, credentialId).find(item => item.endpoint === certificateEndpoint(endpoint).href)?.leaf
}

export function endpointRevision(db: Database.Database, credentialId: string, endpoint: string) {
  return (db.prepare('SELECT revision FROM certificate_endpoint_state WHERE credential_id = ? AND endpoint = ?')
    .get(credentialId, certificateEndpoint(endpoint).href) as { revision: number } | undefined)?.revision ?? 0
}

export function writeConfirmedLeaf(db: Database.Database, credentialId: string, endpoint: string, leaf: ConfirmedLeaf | null | undefined) {
  db.prepare(`INSERT INTO certificate_endpoint_state (credential_id, endpoint, revision, confirmed_leaf_pem, confirmed_leaf_fingerprint) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(credential_id, endpoint) DO UPDATE SET revision = revision + 1,
    confirmed_leaf_pem = excluded.confirmed_leaf_pem, confirmed_leaf_fingerprint = excluded.confirmed_leaf_fingerprint`)
    .run(credentialId, certificateEndpoint(endpoint).href, leaf?.pem ?? null, leaf === null ? '' : leaf?.fingerprint ?? null)
}

export function syncConfirmedLeaves(db: Database.Database, credentialId: string, savedFingerprint: string | undefined, endpoints: string[]) {
  const records = db.prepare('SELECT endpoint, leaf_pem FROM trusted_certificates WHERE credential_id = ? AND mode = ?')
    .all(credentialId, 'ca') as { endpoint: string, leaf_pem: string }[]
  const normalized = savedFingerprint?.replaceAll(':', '').toLowerCase()
  for (const endpoint of endpoints) {
    const href = certificateEndpoint(endpoint).href
    const endpointRecords = records.filter(record => certificateEndpoint(record.endpoint).href === href)
    if (!endpointRecords.length || !normalized) {
      writeConfirmedLeaf(db, credentialId, href, null)
      continue
    }
    const known = [readConfirmedLeaf(db, credentialId, href)?.pem, ...endpointRecords.map(record => record.leaf_pem)]
      .filter((pem): pem is string => pem !== null && pem !== undefined)
    const pem = known.find(candidate => new X509Certificate(candidate).fingerprint256.replaceAll(':', '').toLowerCase() === normalized)
    writeConfirmedLeaf(db, credentialId, href, { fingerprint: normalized.replace(/(..)(?=.)/g, '$1:').toUpperCase(), pem: pem ?? null })
  }
}
