import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminCertificateRoutes, adminInstanceRoutes, adminToolParamsSchema, certificateInspectionSchema, instanceNameSchema, nativeSettingsSchemas } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { certificateDetails, inspectCertificate } from '../certificate-inspection.js'
import { certificateEndpoint } from '../certificate-endpoint.js'
import { toolEndpoints } from '../tool-endpoints.js'
import type { CredentialReference, MutableCredentialStore } from '../store/credential-store.js'
import type { ToolHealth } from '../health/health.js'
import { credentialCertificates, readCredentialTrust } from '../store/trusted-certificates.js'
import { certificateNameChange, certificateTrustFields, savedCertificateTrust, useCertificateName } from '../credential-tls-settings.js'
import { certificatePinError } from '../credential-tls.js'

export function registerCertificateAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string, store?: MutableCredentialStore, health?: ToolHealth): void {
  const pending = new Map<string, { actor: string, reference: CredentialReference, expiresAt: number,
    inspection: Awaited<ReturnType<typeof inspectCertificate>>, caVerified: boolean }>()
  function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    return parsed.data
  }
  function credential(request: FastifyRequest) {
    const { tool, name } = parse(adminToolParamsSchema.extend({ name: instanceNameSchema.optional() }), request.params)
    const reference = name === undefined ? store?.findCredential(tool) : store?.findInstance(tool, name)
    if (!reference) throw new ArtiumError(name === undefined ? 'CREDENTIAL_NOT_CONFIGURED' : 'NOT_FOUND')
    return reference
  }
  function observed(reference: CredentialReference) {
    return store?.listInstances(reference.tool).find(instance => instance.id === reference.id)
  }
  function current(reference: CredentialReference) {
    if (observed(reference)?.revision !== reference.revision) throw new ArtiumError('REVISION_CONFLICT')
  }
  function endpointTrust(reference: CredentialReference, endpoint: string, leafPem: string) {
    const certificates = credentialCertificates(db, reference.id).filter(item => item.endpoint === certificateEndpoint(endpoint).href)
    const value = store!.readCredential(reference) as Record<string, unknown>
    const saved = savedCertificateTrust(reference.tool, value, leafPem, certificates)
    return { certificates, value, saved, mode: saved.mode }
  }
  function save(request: FastifyRequest, actor: string, reference: CredentialReference,
    inspection: Awaited<ReturnType<typeof inspectCertificate>>, mode: 'ca' | 'pin', fillFields: boolean, replace: boolean, caVerified: boolean) {
    audit.change({ event: 'admin-change', action: 'trust-certificate',
      targetId: inspection.anchor.fingerprint, subject: inspection.anchor.subject,
      userId: actor, tool: reference.tool, credentialId: reference.id, instance: observed(reference)?.name, outcome: 'success',
      requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      current(reference)
      const { certificates: existing, value, saved, mode: existingMode } = endpointTrust(reference, inspection.endpoint, inspection.leafPem)
      if (!replace && (existing.length || saved.pem || saved.fingerprint)) throw new ArtiumError('INVALID_INPUT', 'Existing trust must be replaced explicitly.')
      if (replace && existingMode !== mode) throw new ArtiumError('INVALID_INPUT', 'Certificate trust must retain the existing trust mode.')
      if (replace && mode === 'ca' && (!caVerified || !saved.fingerprint)) throw new ArtiumError('INVALID_INPUT', 'The issuing CA changed; update the CA manually.')
      if (!replace && fillFields || replace && (mode === 'ca' ? saved.fingerprint : saved.pem || saved.fingerprint)) {
        const next = certificateTrustFields(reference.tool, value, mode === 'pin' ? inspection.leafPem : inspection.pem,
          inspection.chain[0].fingerprint, mode, replace)
        const credentialValue = Object.fromEntries(Object.entries(next).filter(([key]) => !Object.hasOwn(nativeSettingsSchemas[reference.tool].shape, key)))
        const instance = observed(reference)!
        store!.replaceInstance(reference.tool, instance.name, credentialValue, reference.id, instance.revision, actor, Date.now())
      }
      if (!replace || mode === 'pin') {
        for (const certificate of existing) db.prepare('DELETE FROM trusted_certificates WHERE id = ?').run(certificate.id)
        db.prepare(`INSERT INTO trusted_certificates (id, credential_id, endpoint, fingerprint, leaf_fingerprint, pem, leaf_pem, mode, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(credential_id, endpoint, leaf_fingerprint) DO UPDATE SET fingerprint = excluded.fingerprint,
        pem = excluded.pem, leaf_pem = excluded.leaf_pem, mode = excluded.mode, created_at = excluded.created_at, created_by = excluded.created_by`)
        .run(randomUUID(), reference.id, inspection.endpoint, inspection.anchor.fingerprint, inspection.chain[0].fingerprint,
          inspection.pem, inspection.leafPem, mode, Date.now(), actor)
      }
      db.prepare('DELETE FROM tool_health WHERE credential_id = ?').run(reference.id)
    })
  }
  const handlers: Record<keyof typeof adminCertificateRoutes, (request: FastifyRequest) => Promise<unknown>> = {
  list: async request => {
    authorize(request)
    parse(adminCertificateRoutes.list.input, request.query)
    return { certificates: credentialCertificates(db, credential(request).id) }
  },
  inspect: async request => {
    const actor = authorize(request)
    const { endpointIndex } = parse(adminCertificateRoutes.inspect.input, request.body ?? {})
    const reference = credential(request)
    const value = store!.readCredential(reference) as Record<string, unknown> | undefined
    if (!value) throw new ArtiumError('REVISION_CONFLICT')
    const endpoint = toolEndpoints(reference.tool, value)[endpointIndex]
    if (!endpoint) throw new ArtiumError('INVALID_INPUT')
    const { pem: savedCa, isCa } = savedCertificateTrust(reference.tool, value)
    const endpointTrustRecords = readCredentialTrust(db, reference).filter(item => item.mode === 'ca' && certificateEndpoint(item.endpoint).href === certificateEndpoint(endpoint).href)
    const endpointCa = endpointTrustRecords[0]?.pem
    const maxVersion = reference.tool === 'ldap-axi' && value.tlsMaxVersion === '1.2' ? 'TLSv1.2' : undefined
    const connectAddress = reference.tool === 'unifi-axi' ? (value.tls as { connectAddress?: string } | undefined)?.connectAddress : undefined
    const serverName = reference.tool === 'technitium-axi' ? value.tlsServerName as string | undefined : undefined
    const savedCaTrust = isCa && savedCa ? [{ endpoint: certificateEndpoint(endpoint).href, pem: savedCa, fingerprint: '', leafFingerprint: '', mode: 'ca' as const }] : []
    const inspection = await inspectCertificate(endpoint, savedCa, maxVersion, connectAddress, serverName, endpointTrustRecords.length ? endpointTrustRecords : savedCaTrust)
    const savedInspection = savedCaTrust.length && endpointCa && endpointCa !== savedCa
      ? await inspectCertificate(endpoint, savedCa, maxVersion, connectAddress, serverName, savedCaTrust) : inspection
    authorize(request)
    current(reference)
    const { certificates, saved, mode: trustMode } = endpointTrust(reference, inspection.endpoint, inspection.leafPem)
    const chainError = inspection.verificationError
    const caVerified = !chainError && !savedInspection.verificationError && inspection.chain[0].fingerprint === savedInspection.chain[0].fingerprint
    if (saved.certificate && saved.isCa && caVerified) {
      inspection.anchor = certificateDetails(saved.certificate, inspection.hostname)
      inspection.pem = saved.pem!
    }
    const fingerprintMismatch = saved.fingerprint && saved.fingerprint.replaceAll(':', '').toLowerCase() !== inspection.chain[0].fingerprint.replaceAll(':', '').toLowerCase()
    if (fingerprintMismatch || certificatePinError(certificates.map(pin => ({ mode: pin.mode, leafFingerprint: pin.leaf.fingerprint })), inspection.chain[0].fingerprint)) {
      inspection.verificationError = 'CERTIFICATE_PIN_MISMATCH'
      inspection.reason = 'The saved SHA-256 fingerprint does not match the presented certificate.'
    }
    const previousFingerprints = certificates.filter(pin => pin.leaf.fingerprint !== inspection.chain[0].fingerprint).map(pin => pin.leaf.fingerprint)
    const savedMismatch = saved.certificate && (saved.isCa
      ? chainError && saved.certificate.fingerprint256 !== inspection.anchor.fingerprint
      : saved.certificate.fingerprint256 !== inspection.chain[0].fingerprint)
    const rotation = trustMode === 'ca' ? Boolean(caVerified && fingerprintMismatch)
      : Boolean(trustMode && (fingerprintMismatch || previousFingerprints.length || savedMismatch))
    if (trustMode === 'ca' && !caVerified) inspection.reason = 'The issuing CA changed; update the CA manually.'
    if (previousFingerprints.length) inspection.warnings.push('This endpoint was previously trusted with a different fingerprint. This may be rotation or interception.')
    for (const [id, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(id)
    if (pending.size >= 100) pending.delete(pending.keys().next().value!)
    const inspectionId = randomUUID()
    pending.set(inspectionId, { actor, reference, inspection, caVerified, expiresAt: Date.now() + 5 * 60 * 1000 })
    const { pem: _pem, leafPem: _leafPem, ...details } = inspection
    return certificateInspectionSchema.parse({ ...details, inspectionId, credentialRevision: reference.revision, previousFingerprints, trustMode, rotation,
      nameChange: certificateNameChange(reference.tool, value, endpoint, inspection.leafPem) })
  },
  useName: async request => {
    const actor = authorize(request)
    const { inspectionId } = parse(adminCertificateRoutes.useName.input, request.body)
    const reference = credential(request)
    const item = pending.get(inspectionId)
    if (!item || item.actor !== actor || item.reference.id !== reference.id || item.expiresAt <= Date.now()) throw new ArtiumError('INVALID_INPUT')
    current(item.reference)
    const value = store!.readCredential(item.reference) as Record<string, unknown> | undefined
    if (!value) throw new ArtiumError('REVISION_CONFLICT')
    const next = useCertificateName(reference.tool, value, new URL(item.inspection.endpoint), item.inspection.leafPem)
    const credentialValue = Object.fromEntries(Object.entries(next).filter(([key]) => !Object.hasOwn(nativeSettingsSchemas[reference.tool].shape, key)))
    audit.change({ event: 'admin-change', action: 'use-certificate-name', userId: actor, tool: reference.tool,
      credentialId: reference.id, targetId: reference.id, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      current(item.reference)
      const oldEndpoint = certificateEndpoint(item.inspection.endpoint).href
      const newEndpoint = certificateEndpoint(toolEndpoints(reference.tool, next)[0]!).href
      if (oldEndpoint !== newEndpoint) {
        const certificates = credentialCertificates(db, reference.id)
        const existing = certificates.filter(certificate => certificate.endpoint === oldEndpoint)
        if (existing.length && certificates.some(certificate => certificate.endpoint === newEndpoint)) {
          throw new ArtiumError('INVALID_INPUT', 'Cannot move certificate trust because the new endpoint already has trust records. Remove the conflicting records first.')
        }
        for (const certificate of existing) {
          db.prepare('UPDATE trusted_certificates SET endpoint = ? WHERE id = ?').run(newEndpoint, certificate.id)
        }
      }
      const instance = observed(item.reference)!
      store!.replaceInstance(reference.tool, instance.name, credentialValue, reference.id, instance.revision, actor, Date.now())
      db.prepare('DELETE FROM tool_health WHERE credential_id = ?').run(reference.id)
    })
    pending.delete(inspectionId)
    return { updated: true as const }
  },
  trust: async request => {
    const actor = authorize(request)
    const { inspectionId, mode, confirmedFingerprint, fillFields, replace } = parse(adminCertificateRoutes.trust.input, request.body)
    const reference = credential(request)
    const item = pending.get(inspectionId)
    if (!item || item.actor !== actor || item.reference.id !== reference.id || item.expiresAt <= Date.now()) throw new ArtiumError('INVALID_INPUT')
    current(item.reference)
    if (confirmedFingerprint !== item.inspection.chain[0].fingerprint) throw new ArtiumError('INVALID_INPUT',
      'Confirm the displayed SHA-256 fingerprint before trusting this certificate.')
    if (!item.inspection.verificationError && !replace) throw new ArtiumError('INVALID_INPUT', item.inspection.reason)
    const { anchor, chain } = item.inspection
    const existingMode = endpointTrust(reference, item.inspection.endpoint, item.inspection.leafPem).mode
    if (existingMode && existingMode !== mode) throw new ArtiumError('INVALID_INPUT', 'Certificate trust must retain the existing trust mode.')
    const hasCA = anchor.ca && anchor.fingerprint !== chain[0].fingerprint
    if (reference.tool === 'kubernetes-axi' && (mode !== 'ca' || !hasCA && !item.caVerified)) throw new ArtiumError('INVALID_INPUT',
      'This tool requires the issuing CA. Strict leaf pinning is unavailable; configure the trusted CA bundle instead.')
    if (mode === 'ca' && !hasCA && !(replace && item.caVerified) && !chain[0].selfSigned) throw new ArtiumError('INVALID_INPUT',
      'CA trust is unavailable because no issuing CA was obtained. Choose strict leaf pinning explicitly.')
    save(request, actor, item.reference, item.inspection,
      mode === 'ca' && chain[0].selfSigned ? 'pin' : mode, fillFields, replace, item.caVerified)
    pending.delete(inspectionId)
    return { trusted: true as const }
  },
  remove: async request => {
    const actor = authorize(request)
    const reference = credential(request)
    const { id } = parse(adminCertificateRoutes.remove.input, request.body)
    const pin = credentialCertificates(db, reference.id).find(pin => pin.id === id)
    if (!pin) throw new ArtiumError('NOT_FOUND')
    audit.change({ event: 'admin-change', action: 'remove-trusted-certificate', targetId: pin.certificate.fingerprint,
      subject: pin.certificate.subject, userId: actor, tool: reference.tool, credentialId: reference.id, instance: observed(reference)?.name,
      outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      current(reference)
      db.prepare('DELETE FROM trusted_certificates WHERE id = ? AND credential_id = ?').run(id, reference.id)
      db.prepare('DELETE FROM tool_health WHERE credential_id = ?').run(reference.id)
    })
    await health?.refresh(reference.tool, true, reference.id)
    return { removed: true as const }
  },
  }
  for (const routes of [adminCertificateRoutes, adminInstanceRoutes.certificates]) {
    for (const [name, handler] of Object.entries(handlers)) {
      const route = routes[name as keyof typeof routes]
      app.route({ method: route.method, url: route.path, handler })
    }
  }
}
