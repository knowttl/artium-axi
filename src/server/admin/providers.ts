import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminProviderRoutes, adminProviderSchema, adminUserParamsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { CredentialProfile } from '../adapters/credential-profile.js'
import type { Audit } from '../audit/audit.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import type { ProviderCredentials } from '../store/provider-credentials.js'
import { certificateFields } from './certificate.js'
import { credentialFields } from './credential-form.js'
import { escape } from './escape.js'
import { adminRead, apiForm, changed, revision } from './forms.js'

const text = { type: 'string', minLength: 1 }
const secret = { ...text, 'x-secret': true }
const profile = new CredentialProfile({ type: 'object', additionalProperties: false,
  required: ['tenantId', 'clientId', 'auth'], properties: {
    tenantId: { ...text, format: 'uuid' }, clientId: { ...text, format: 'uuid' },
    auth: { enum: ['certificate', 'secret'], title: 'Authentication' },
    privateKey: secret, thumbprintSha256: { ...text, pattern: '^[a-fA-F0-9]{64}$' }, clientSecret: secret,
  }, oneOf: [
    { properties: { auth: { const: 'certificate' } }, required: ['privateKey', 'thumbprintSha256'], not: { required: ['clientSecret'] } },
    { properties: { auth: { const: 'secret' } }, required: ['clientSecret'], not: { anyOf: [{ required: ['privateKey'] }, { required: ['thumbprintSha256'] }] } },
  ] })

export function registerProviderAdmin(app: FastifyInstance, db: Database.Database, audit: Audit,
  authorize: (request: FastifyRequest) => string, credentials?: ProviderCredentials): void {
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtiumError('INVALID_INPUT')
    return result.data
  }
  function idFor(request: FastifyRequest): string {
    const result = adminUserParamsSchema.safeParse(request.params)
    if (!result.success) throw new ArtiumError('NOT_FOUND')
    return result.data.id
  }
  function read(id: string): z.infer<typeof adminProviderSchema> {
    const row = db.prepare(`SELECT id, name, kind, issuer, enabled, revision, updated_at AS updatedAt,
      updated_by AS updatedBy FROM sso_providers WHERE id = ? AND kind = 'entra'`).get(id) as
      (Omit<z.infer<typeof adminProviderSchema>, 'tenantId' | 'enabled'> & { enabled: number }) | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    return adminProviderSchema.parse({ ...row, enabled: false, tenantId: row.issuer.split('/')[3] })
  }
  function store(): ProviderCredentials {
    if (!credentials) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
    return credentials
  }
  function readCredential(id: string) {
    const provider = read(id)
    const stored = store().read(id)
    const value = stored?.value ?? { tenantId: provider.tenantId, auth: 'certificate' }
    return adminProviderRoutes.credential.response.parse({ configured: Boolean(stored), revision: stored?.revision ?? 0,
      updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null,
      metadata: Object.fromEntries(['tenantId', 'clientId', 'auth', 'thumbprintSha256'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) })
  }
  app.get(adminProviderRoutes.list.path, async request => {
    authorize(request)
    parse(adminProviderRoutes.list.input, request.query)
    const rows = db.prepare("SELECT id FROM sso_providers WHERE kind = 'entra' ORDER BY name, id").all() as { id: string }[]
    return adminProviderRoutes.list.response.parse({ providers: rows.map(row => read(row.id)) })
  })
  for (const route of [adminProviderRoutes.create, adminProviderRoutes.patch]) app.route({ method: route.method, url: route.path, handler: async request => {
    const actor = authorize(request)
    const creating = route === adminProviderRoutes.create
    const input = parse(route.input, request.body)
    const id = creating ? randomUUID() : idFor(request)
    return audit.change({ event: 'admin-change', action: route.auditEvent, targetId: id, userId: actor, tool: null,
      outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      const issuer = `https://login.microsoftonline.com/${input.tenantId}/v2.0`
      const now = Date.now()
      if (creating) {
        db.prepare(`INSERT INTO sso_providers (id, name, kind, issuer, updated_at, updated_by)
          VALUES (?, ?, 'entra', ?, ?, ?)`).run(id, input.name, issuer, now, actor)
      } else {
        const current = read(id)
        if (current.revision !== parse(adminProviderRoutes.patch.input, request.body).expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
        if (current.issuer !== issuer) db.prepare('DELETE FROM provider_credentials WHERE id = ?').run(id)
        db.prepare(`UPDATE sso_providers SET name = ?, issuer = ?, enabled = 0, revision = revision + 1,
          updated_at = ?, updated_by = ? WHERE id = ?`).run(input.name, issuer, now, actor, id)
      }
      return read(id)
    }).value
  } })
  app.get(adminProviderRoutes.credential.path, async request => {
    authorize(request)
    parse(adminProviderRoutes.credential.input, request.query)
    return readCredential(idFor(request))
  })
  app.patch(adminProviderRoutes.save.path, async request => {
    const actor = authorize(request)
    const id = idFor(request)
    const input = parse(adminProviderRoutes.save.input, request.body)
    let value = input.value
    if (Object.hasOwn(value, 'certificatePem')) {
      if (value.auth !== 'certificate') throw new ArtiumError('INVALID_INPUT')
      const { certificatePem, ...fields } = value
      value = { ...fields, ...certificateFields(certificatePem, true) }
    }
    return audit.change({ event: 'admin-change', action: adminProviderRoutes.save.auditEvent, targetId: id,
      userId: actor, tool: null, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      const provider = read(id)
      if (provider.revision !== input.expectedProviderRevision) throw new ArtiumError('REVISION_CONFLICT')
      if (value.tenantId !== provider.tenantId) throw new ArtiumError('INVALID_INPUT', 'The credential tenant must match the provider tenant.', 'Update provider settings first, then enter a new credential.')
      const stored = store().read(id)
      if ((stored?.revision ?? 0) !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const sameIdentity = ['tenantId', 'clientId', 'auth'].every(key => stored?.value[key] === value[key])
      const retained = sameIdentity ? Object.fromEntries(['privateKey', 'clientSecret'].filter(key => stored?.value[key] !== undefined).map(key => [key, stored!.value[key]])) : {}
      const next = parse(profile.credentialSchema, { ...retained, ...value })
      const now = Date.now()
      store().replace(id, next, input.expectedRevision, actor, now)
      db.prepare('UPDATE sso_providers SET enabled = 0, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now, actor, id)
      return readCredential(id)
    }).value
  })

  for (const path of ['/admin/settings/sign-in', '/admin/settings/sign-in/:id']) app.get(path, async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const { providers } = await adminRead(app, request, adminProviderRoutes.list.path, adminProviderRoutes.list.response)
    const id = (request.params as { id?: string }).id
    const csrf = reply.generateCsrf()
    const settingsFields = (name = '', tenantId = '') => `<label>Provider name<input name="name" value="${escape(name)}" maxlength="256" required></label><label>Tenant ID<input name="tenantId" value="${escape(tenantId)}" required></label><p>Use the directory tenant UUID for a single-tenant application. Changing it removes the stored credential and requires a new one.</p>`
    let content = '<p>SSO sign-in is not available yet. Providers stay disabled. Local sign-in continues to work.</p>'
    if (!id) {
      content += `<section><h2>SSO providers</h2>${providers.length ? `<div class="table-scroll"><table><caption>Configured providers</caption><thead><tr><th>Name</th><th>Kind</th><th>Status</th></tr></thead><tbody>${providers.map(provider => `<tr><th><a href="/admin/settings/sign-in/${escape(provider.id)}">${escape(provider.name)}</a></th><td>Entra ID</td><td>Disabled</td></tr>`).join('')}</tbody></table></div>` : '<p>No providers configured. Add an Entra ID provider below, then save its credential.</p>'}</section><section><h2>Add Entra ID provider</h2>` +
        apiForm(csrf, adminProviderRoutes.create.path, 'POST', 'Add provider', settingsFields(), 'Create a disabled provider?') + '</section>'
    } else {
      const provider = providers.find(provider => provider.id === id)
      if (!provider) throw new ArtiumError('NOT_FOUND')
      const api = adminProviderRoutes.list.path + '/' + id
      const credential = await adminRead(app, request, api + '/credential', adminProviderRoutes.credential.response)
      content += `<p><a href="/admin/settings/sign-in">All providers</a></p><section><h2>${escape(provider.name)}</h2><p>Entra ID | Disabled</p><p>Issuer: ${escape(provider.issuer)}</p>${changed(db, provider)}` +
        apiForm(csrf, api, 'PATCH', 'Save provider settings', revision(provider.revision) + settingsFields(provider.name, provider.tenantId), 'Save provider settings? A changed tenant removes the stored credential. SSO stays disabled.') + '</section>'
      content += `<section><h2>Provider credential</h2><p>${credential.configured ? 'Configured' : 'Not configured'}. Secrets are never displayed.</p>${changed(db, credential)}<p>Certificate authentication is preferred. Upload one PEM containing the certificate and matching unencrypted private key; the SHA-256 fingerprint is calculated automatically. Client secrets are accepted but are less secure than certificates.</p>` +
        apiForm(csrf, api + '/credential', 'PATCH', 'Save credential', revision(credential.revision) +
          `<input type="hidden" name="expectedProviderRevision" data-type="number" value="${provider.revision}">` + credentialFields(undefined, profile, credential.metadata, credential.configured),
          'Save the encrypted provider credential, keeping omitted secrets only for the same identity? SSO stays disabled.') + '</section>'
    }
    return browserPage(reply, 'Sign-in settings', content, current)
  })
}
