import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminCertificateRoutes, adminToolParamsSchema, certificateInspectionSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { inspectCertificate } from '../certificate-inspection.js'
import { certificateEndpoint } from '../certificate-endpoint.js'
import { toolEndpoints } from '../tool-endpoints.js'
import type { CredentialReference, MutableCredentialStore } from '../store/credential-store.js'
import { credentialCertificates } from '../store/trusted-certificates.js'

export function registerCertificateAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string, store?: MutableCredentialStore): void {
  const pending = new Map<string, { actor: string, reference: CredentialReference, expiresAt: number,
    inspection: Awaited<ReturnType<typeof inspectCertificate>> }>()
  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    return parsed.data
  }
  function credential(request: FastifyRequest) {
    const { tool } = parse(adminToolParamsSchema, request.params)
    const reference = store?.findCredential(tool)
    if (!reference) throw new ArtiumError('CREDENTIAL_NOT_CONFIGURED')
    return reference
  }
  function current(reference: CredentialReference) {
    if (store?.findCredential(reference.tool)?.revision !== reference.revision) throw new ArtiumError('REVISION_CONFLICT')
  }
  function save(request: FastifyRequest, actor: string, reference: CredentialReference,
    inspection: Awaited<ReturnType<typeof inspectCertificate>>, mode: 'ca' | 'pin') {
    audit.change({ event: 'admin-change', action: 'trust-certificate',
      targetId: inspection.anchor.fingerprint, subject: inspection.anchor.subject,
      userId: actor, tool: reference.tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      current(reference)
      for (const certificate of credentialCertificates(db, reference.id).filter(item => item.endpoint === inspection.endpoint
        && item.mode !== mode)) {
        db.prepare('DELETE FROM trusted_certificates WHERE id = ?').run(certificate.id)
      }
      db.prepare(`INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(credential_id, endpoint, leaf_fingerprint) DO UPDATE SET fingerprint = excluded.fingerprint,
        pem = excluded.pem, leaf_pem = excluded.leaf_pem, mode = excluded.mode, created_at = excluded.created_at, created_by = excluded.created_by`)
        .run(randomUUID(), reference.id, inspection.endpoint, inspection.anchor.fingerprint, inspection.chain[0].fingerprint,
          inspection.pem, inspection.leafPem, mode, Date.now(), actor)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run(reference.tool)
    })
  }
  app.route({ method: adminCertificateRoutes.list.method, url: adminCertificateRoutes.list.path, handler: async request => {
    authorize(request)
    parse(adminCertificateRoutes.list.input, request.query)
    return { certificates: credentialCertificates(db, credential(request).id) }
  } })
  app.route({ method: adminCertificateRoutes.inspect.method, url: adminCertificateRoutes.inspect.path, handler: async request => {
    const actor = authorize(request)
    const { endpointIndex } = parse(adminCertificateRoutes.inspect.input, request.body ?? {})
    const reference = credential(request)
    const value = store!.readCredential(reference) as Record<string, unknown> | undefined
    if (!value) throw new ArtiumError('REVISION_CONFLICT')
    const endpoint = toolEndpoints(reference.tool, value)[endpointIndex]
    if (!endpoint) throw new ArtiumError('INVALID_INPUT')
    const ca = value.caBundle ?? value.caFile
    const inspection = await inspectCertificate(endpoint, typeof ca === 'string' ? ca : undefined,
      reference.tool === 'ldap-axi' && value.tlsMaxVersion === '1.2' ? 'TLSv1.2' : undefined)
    authorize(request)
    current(reference)
    const certificates = credentialCertificates(db, reference.id).filter(pin => pin.endpoint === certificateEndpoint(endpoint).href)
    const previousFingerprints = certificates.filter(pin => pin.leaf.fingerprint !== inspection.chain[0].fingerprint).map(pin => pin.leaf.fingerprint)
    if (previousFingerprints.length) inspection.warnings.push('This endpoint was previously trusted with a different fingerprint. This may be rotation or interception.')
    for (const [id, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(id)
    if (pending.size >= 100) pending.delete(pending.keys().next().value!)
    const inspectionId = randomUUID()
    pending.set(inspectionId, { actor, reference, inspection, expiresAt: Date.now() + 5 * 60 * 1000 })
    const { pem: _pem, leafPem: _leafPem, ...details } = inspection
    return certificateInspectionSchema.parse({ ...details, inspectionId, credentialRevision: reference.revision, previousFingerprints })
  } })
  app.route({ method: adminCertificateRoutes.trust.method, url: adminCertificateRoutes.trust.path, handler: async request => {
    const actor = authorize(request)
    const { inspectionId, mode } = parse(adminCertificateRoutes.trust.input, request.body)
    const reference = credential(request)
    const item = pending.get(inspectionId)
    if (!item || item.actor !== actor || item.reference.id !== reference.id || item.expiresAt <= Date.now()) throw new ArtiumError('INVALID_INPUT')
    current(item.reference)
    const { anchor, chain } = item.inspection
    const hasCA = anchor.ca && anchor.fingerprint !== chain[0].fingerprint
    if (mode === 'ca' && !hasCA && !chain[0].selfSigned) throw new ArtiumError('INVALID_INPUT',
      'CA trust is unavailable because no issuing CA was obtained. Choose strict leaf pinning explicitly.')
    save(request, actor, item.reference, item.inspection,
      mode === 'ca' && chain[0].selfSigned ? 'pin' : mode)
    pending.delete(inspectionId)
    return { trusted: true as const }
  } })
  app.route({ method: adminCertificateRoutes.remove.method, url: adminCertificateRoutes.remove.path, handler: async request => {
    const actor = authorize(request)
    const reference = credential(request)
    const { id } = parse(adminCertificateRoutes.remove.input, request.body)
    const pin = credentialCertificates(db, reference.id).find(pin => pin.id === id)
    if (!pin) throw new ArtiumError('NOT_FOUND')
    audit.change({ event: 'admin-change', action: 'remove-trusted-certificate', targetId: pin.certificate.fingerprint,
      subject: pin.certificate.subject, userId: actor, tool: reference.tool, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      current(reference)
      db.prepare('DELETE FROM trusted_certificates WHERE id = ? AND credential_id = ?').run(id, reference.id)
      db.prepare('DELETE FROM tool_health WHERE tool = ?').run(reference.tool)
    })
    return { removed: true as const }
  } })
}
