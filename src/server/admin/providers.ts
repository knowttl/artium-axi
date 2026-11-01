import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { adminProviderRoutes, adminProviderSchema, adminRoleRuleRoutes, adminUserParamsSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { CredentialProfile } from '../adapters/credential-profile.js'
import type { Audit } from '../audit/audit.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { entraCredential } from '../auth/entra-credential.js'
import { oidcCredential } from '../auth/oidc-credential.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import type { ProviderCredentials } from '../store/provider-credentials.js'
import { certificateFields } from './certificate.js'
import { credentialFields } from './credential-form.js'
import { escape } from './escape.js'
import { matchesClaim } from '../auth/role-claims.js'
import { adminRead, apiForm, changed, revision } from './forms.js'

const text = { type: 'string', minLength: 1 }
const secret = { ...text, 'x-secret': true }
const profile = (kind: 'entra' | 'oidc') => new CredentialProfile({ type: 'object', additionalProperties: false,
  required: [...(kind === 'entra' ? ['tenantId'] : []), 'clientId', 'auth'], properties: {
    ...(kind === 'entra' ? { tenantId: { ...text, format: 'uuid' } } : {}),
    clientId: kind === 'entra' ? { ...text, format: 'uuid' } : text,
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
      updated_by AS updatedBy FROM sso_providers WHERE id = ?`).get(id) as
      (Omit<z.infer<typeof adminProviderSchema>, 'tenantId' | 'enabled'> & { enabled: number }) | undefined
    if (!row) throw new ArtiumError('NOT_FOUND')
    return adminProviderSchema.parse({ ...row, enabled: Boolean(row.enabled),
      ...(row.kind === 'entra' ? { tenantId: row.issuer.split('/')[3] } : {}) })
  }
  function store(): ProviderCredentials {
    if (!credentials) throw new ArtiumError('CREDENTIAL_INVALID')
    return credentials
  }
  function readCredential(id: string) {
    const provider = read(id)
    const stored = store().read(id)
    const value: Record<string, unknown> = stored?.value ?? { auth: 'certificate',
      ...(provider.kind === 'entra' ? { tenantId: provider.tenantId } : {}) }
    return adminProviderRoutes.credential.response.parse({ configured: Boolean(stored), revision: stored?.revision ?? 0,
      updatedAt: stored?.updatedAt ?? null, updatedBy: stored?.updatedBy ?? null,
      metadata: Object.fromEntries(['tenantId', 'clientId', 'auth', 'thumbprintSha256'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) })
  }
  function activationReady(id: string): void {
    const provider = read(id)
    if (provider.kind === 'entra') entraCredential(provider.issuer, store().read(id)?.value)
    else oidcCredential(store().read(id)?.value)
    if (!db.prepare(`SELECT 1 FROM users WHERE source = 'local' AND administrator = 1 AND break_glass = 1
      AND disabled = 0 AND archived_at IS NULL AND must_change = 0 AND password_hash LIKE '$argon2%'
      AND (locked_until IS NULL OR locked_until <= ?)`).get(Date.now())) {
      throw new ArtiumError('INVALID_INPUT', 'A usable break-glass local administrator is required.', 'Designate an enabled local administrator with a permanent password, unlock it if needed, and test its sign-in before enabling SSO.')
    }
  }
  app.patch(adminProviderRoutes.activation.path, async request => {
    const actor = authorize(request)
    const id = idFor(request)
    const input = parse(adminProviderRoutes.activation.input, request.body)
    return audit.change({ event: 'admin-change', action: adminProviderRoutes.activation.auditEvent, targetId: id,
      userId: actor, tool: null, outcome: 'success', requestId: request.id, clientAddress: request.ip }, () => {
      authorize(request)
      if (read(id).revision !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      if (input.enabled) activationReady(id)
      db.prepare('UPDATE sso_providers SET enabled = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(Number(input.enabled), Date.now(), actor, id)
      return read(id)
    }).value
  })
  app.get(adminProviderRoutes.list.path, async request => {
    authorize(request)
    parse(adminProviderRoutes.list.input, request.query)
    const rows = db.prepare('SELECT id FROM sso_providers ORDER BY name, id').all() as { id: string }[]
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
      const issuer = input.kind === 'entra' ? `https://login.microsoftonline.com/${input.tenantId}/v2.0` : input.issuer
      const now = Date.now()
      if (creating) {
        db.prepare(`INSERT INTO sso_providers (id, name, kind, issuer, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.name, input.kind, issuer, now, actor)
      } else {
        const current = read(id)
        if (current.kind !== input.kind) throw new ArtiumError('INVALID_INPUT', 'Provider kind cannot be changed.', 'Create a separate provider for a different sign-in method.')
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
      if (provider.kind === 'entra' && value.tenantId !== provider.tenantId) throw new ArtiumError('INVALID_INPUT', 'The credential tenant must match the provider tenant.', 'Update provider settings first, then enter a new credential.')
      const stored = store().read(id)
      if ((stored?.revision ?? 0) !== input.expectedRevision) throw new ArtiumError('REVISION_CONFLICT')
      const sameIdentity = ['tenantId', 'clientId', 'auth'].every(key => stored?.value[key] === value[key])
      const retained = sameIdentity ? Object.fromEntries(['privateKey', 'clientSecret'].filter(key => stored?.value[key] !== undefined).map(key => [key, stored!.value[key]])) : {}
      const next = parse(profile(provider.kind).credentialSchema, { ...retained, ...value })
      if (provider.kind === 'oidc') oidcCredential(next)
      const now = Date.now()
      store().replace(id, next, input.expectedRevision, actor, now)
      db.prepare('UPDATE sso_providers SET enabled = 0, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(now, actor, id)
      return readCredential(id)
    }).value
  })

  for (const path of ['/admin/settings/sign-in', '/admin/settings/sign-in/:id', '/admin/settings/sign-in/:id/matches/:ruleId']) app.get(path, async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const { providers } = await adminRead(app, request, adminProviderRoutes.list.path, adminProviderRoutes.list.response)
    const id = (request.params as { id?: string }).id
    const csrf = reply.generateCsrf()
    const settingsFields = (name = '', tenantId = '') => `<label>Provider name<input name="name" value="${escape(name)}" maxlength="256" required></label><label>Tenant ID<input name="tenantId" value="${escape(tenantId)}" required></label><p>Use the directory tenant UUID for a single-tenant application. Changing it removes the stored credential and requires a new one.</p>`
    const oidcFields = (name = '', issuer = '') => `<input type="hidden" name="kind" value="oidc"><label>Provider name<input name="name" value="${escape(name)}" maxlength="256" required></label><label>Issuer URL<input name="issuer" type="url" value="${escape(issuer)}" required></label><p>Enter the exact HTTPS issuer, for example https://identity.example. Discovery reads its OpenID configuration over verified TLS and does not follow redirects. Changing the issuer removes the stored credential and requires a new one.</p>`
    let content = '<p>Enabling any provider limits password sign-in to designated break-glass administrators. New providers start disabled.</p>'
    if (!id) {
      content += `<section><h2>SSO providers</h2>${providers.length ? `<div class="table-scroll"><table><caption>Configured providers</caption><thead><tr><th>Name</th><th>Kind</th><th>Status</th></tr></thead><tbody>${providers.map(provider => `<tr><th><a href="/admin/settings/sign-in/${escape(provider.id)}">${escape(provider.name)}</a></th><td>${provider.kind === 'entra' ? 'Entra ID' : 'OpenID Connect'}</td><td>${provider.enabled ? 'Enabled' : 'Disabled'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No providers configured. Add a provider below, then save its credential.</p>'}</section><section><h2>Add Entra ID provider</h2>` +
        apiForm(csrf, adminProviderRoutes.create.path, 'POST', 'Add provider', settingsFields(), 'Create a disabled provider?') + '</section>'
      content += '<section><h2>Add OpenID Connect provider</h2>' +
        apiForm(csrf, adminProviderRoutes.create.path, 'POST', 'Add OIDC provider', oidcFields(), 'Create a disabled provider?') + '</section>'
    } else {
      const provider = providers.find(provider => provider.id === id)
      if (!provider) throw new ArtiumError('NOT_FOUND')
      const matchingUsers = (rule: { claim: string, value: string }) => {
        const identities = db.prepare(`SELECT users.id, users.username, identities.claim_values, identities.claims_at
          FROM identities JOIN users ON users.id = identities.user_id
          WHERE identities.provider_id = ? AND identities.issuer = ? AND identities.claims_at IS NOT NULL
          AND users.disabled = 0 AND users.archived_at IS NULL ORDER BY users.username, users.id`)
          .all(id, provider.issuer) as { id: string, username: string, claim_values: string, claims_at: number }[]
        return identities.filter(identity => matchesClaim(JSON.parse(identity.claim_values), rule))
      }
      const ruleId = (request.params as { ruleId?: string }).ruleId
      if (ruleId) {
        const { rules } = await adminRead(app, request, adminRoleRuleRoutes.list.path + '?providerId=' + encodeURIComponent(id), adminRoleRuleRoutes.list.response)
        const rule = rules.find(rule => rule.id === ruleId)
        if (!rule) throw new ArtiumError('NOT_FOUND')
        const users = matchingUsers(rule)
        return browserPage(reply, 'Who matches', `<p><a href="/admin/settings/sign-in/${escape(id)}">Back to provider</a></p><section><h2>${escape(rule.claim)} contains ${escape(rule.value)}</h2><p>Matches from the last successful sign-in of enabled, unarchived users. This is not a live directory query. Users who have never signed in are unknown. Grants synchronize on the next sign-in.</p>${users.length ? `<div class="table-scroll"><table><caption>${users.length} matching users</caption><thead><tr><th>User</th><th>Claims recorded</th></tr></thead><tbody>${users.map(user => `<tr><th><a href="/admin/users/${escape(user.id)}">${escape(user.username)}</a></th><td>${escape(new Date(user.claims_at).toISOString())}</td></tr>`).join('')}</tbody></table></div>` : '<p>No users match this rule in the saved sign-in claims.</p>'}</section>`, current)
      }
      const api = adminProviderRoutes.list.path + '/' + id
      const credential = await adminRead(app, request, api + '/credential', adminProviderRoutes.credential.response)
      content += `<p><a href="/admin/settings/sign-in">All providers</a></p><section><h2>${escape(provider.name)}</h2><p>${provider.kind === 'entra' ? 'Entra ID' : 'OpenID Connect'} | ${provider.enabled ? 'Enabled' : 'Disabled'}</p><p>Issuer: ${escape(provider.issuer)}</p>${changed(db, provider)}` +
        apiForm(csrf, api, 'PATCH', 'Save provider settings', revision(provider.revision) + (provider.kind === 'entra' ? settingsFields(provider.name, provider.tenantId) : oidcFields(provider.name, provider.issuer)), 'Save provider settings and disable this provider? A changed tenant or issuer removes the stored credential. Review configuration and enable it again afterwards.') + '</section>'
      const copy = (label: string, value: string) => `<label>${escape(label)}<input readonly value="${escape(value)}"><button type="button" data-copy>Copy ${escape(label.toLowerCase())}</button><span role="status" data-copy-status></span></label>`
      const origin = `${request.protocol}://${request.host}`
      content += provider.kind === 'oidc' ? `<section><h2>OpenID Connect setup guide</h2><ol>
        <li>Register a confidential web application with your provider. It must support authorization code with PKCE S256, RS256 ID tokens and scopes openid and profile. Save its exact HTTPS issuer above.</li>
        <li>Register this exact redirect URI.${copy('Redirect URI', origin + '/auth/sso/' + encodeURIComponent(id) + '/callback')}</li>
        <li>Configure private_key_jwt with an RSA certificate, or client_secret_post or client_secret_basic with a client secret, then save the matching credential below. Secret authentication follows the discovered methods, preferring client_secret_post when available. The client ID is the provider's application identifier.</li>
        <li>Configure preferred_username in ID tokens for invitation claims and auth_time for fresh CLI sign-in and identity confirmation. Invitations compare preferred_username exactly; account identity uses the immutable issuer and sub claims.</li>
        <li>Designate and test a separate local break-glass administrator before activation. Create invitations from <a href="/admin/invitations">Invitations</a> and assign direct artium roles or configure claim rules below to grant tools.</li>
        <li>Enable the provider, then test an invitation claim, browser sign-in and CLI approval in a separate browser while keeping break-glass access open. Discovery happens on sign-in, not while saving settings.</li>
        <li>If the provider supports end-session, register this post-logout return URI.${copy('Post-logout URI', origin + '/login')}</li>
      </ol></section>` : `<section><h2>Entra setup guide</h2><ol>
        <li>Register an application in Microsoft Entra ID. Choose accounts in this organizational directory only. Copy its Directory (tenant) ID and Application (client) ID into this provider and credential.</li>
        <li>Add a Web platform with this exact redirect URI. Use the public HTTPS address people use for artium; check it before copying.${copy('Redirect URI', origin + '/auth/sso/' + encodeURIComponent(id) + '/callback')}</li>
        <li>Upload the public certificate under Certificates &amp; secrets. Save its matching RSA private key and certificate as one PEM in artium below. A client secret is also accepted; keep the certificate private key private.</li>
        <li>Define app roles with allowed member types Users/Groups. Use exact role values, then map them to artium roles below.${copy('Example app role value', 'Artium.Readers')}</li>
        <li>In the enterprise application, set Assignment required to Yes. Assign people or groups to app roles. Group assignment requires Entra ID P1 or P2; otherwise assign people directly. Sign-in needs OpenID Connect scopes openid and profile; no Graph permission is needed.</li>
        <li>Create invitations from <a href="/admin/invitations">Invitations</a>, including a link invitation for an existing administrator who will use SSO. No account is created automatically from a matching role or email.</li>
        <li>On <a href="/admin/users">Users</a>, designate a separate enabled local administrator for break-glass access. Set a permanent password and test sign-in in a separate browser before activation. Every emergency password use is flagged in Audit. Keep offline recover-admin access available.</li>
        <li>Enable sign-in below, then test one invitation claim and one Microsoft sign-in in a separate browser. Keep the break-glass browser open until these succeed. Confirm the expected roles and tools. Disabling all providers restores ordinary local password sign-in.</li>
        <li>For optional Microsoft sign-out, register this post-logout return URI.${copy('Post-logout URI', origin + '/login')}artium sign-out always ends its own session first.</li>
      </ol></section>`
      let readiness = 'Ready: credential configuration and a usable break-glass administrator are present.'
      let ready = true
      try { activationReady(id) } catch (error) { ready = false; readiness = error instanceof ArtiumError ? error.message : 'Configuration is unavailable.' }
      content += `<section><h2>SSO activation</h2><p>${escape(readiness)}</p><p>These checks validate local configuration. They cannot verify provider application registration, credential acceptance or access policies. Saving provider settings or credentials disables this provider until you enable it again.</p>` +
        (provider.enabled || ready ? apiForm(csrf, api + '/activation', 'PATCH', provider.enabled ? 'Disable SSO sign-in' : 'Enable SSO sign-in', revision(provider.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${!provider.enabled}">`, provider.enabled ? 'Disable this provider? Sign-in and confirmation for it stop. Existing artium sessions remain active. Local passwords become available to ordinary local accounts only if every provider is disabled.' : 'Enable SSO sign-in and restrict all local password use to designated break-glass administrators? Test the invitation claim and sign-in using a separate browser, keeping break-glass access available.') : '<p>Complete the setup above, then reload to enable sign-in.</p>') + '</section>'
      content += `<section><h2>Provider credential</h2><p>${credential.configured ? 'Configured' : 'Not configured'}. Secrets are never displayed.</p>${changed(db, credential)}<p>Certificate authentication is preferred. Upload one PEM containing the certificate and matching unencrypted private key; the SHA-256 fingerprint is calculated automatically. Client secrets are accepted but are less secure than certificates.</p>` +
        apiForm(csrf, api + '/credential', 'PATCH', 'Save credential', revision(credential.revision) +
          `<input type="hidden" name="expectedProviderRevision" data-type="number" value="${provider.revision}">` + credentialFields(undefined, profile(provider.kind), credential.metadata, credential.configured),
          'Save the encrypted provider credential and disable this provider, keeping omitted secrets only for the same identity? Review configuration and enable it again afterwards.') + '</section>'
      const { rules } = await adminRead(app, request, adminRoleRuleRoutes.list.path + '?providerId=' + encodeURIComponent(id), adminRoleRuleRoutes.list.response)
      const roles = db.prepare('SELECT id, name FROM roles ORDER BY name, id').all() as { id: string, name: string }[]
      const fields = (value = '', roleId = '', claim = 'groups') => `<input type="hidden" name="providerId" value="${escape(id)}">${provider.kind === 'entra' ? '<input type="hidden" name="claim" value="roles"><p>Claim: roles (Entra app roles)</p>' : `<label>Claim name<input name="claim" value="${escape(claim)}" maxlength="256" required></label><p>Use an exact top-level claim name, for example groups. Dots are literal, not nested paths. String values and strings in arrays match exactly; other values are ignored.</p>`}<label>Claim value<input name="value" value="${escape(value)}" maxlength="256" required></label><p>${provider.kind === 'entra' ? 'Use the app role value, for example Artium.Readers, rather than its display name.' : 'Use the exact, case-sensitive value, for example Readers.'}</p><label>Artium role<select name="roleId" required><option value="">Choose a role</option>${roles.map(role => `<option value="${escape(role.id)}"${role.id === roleId ? ' selected' : ''}>${escape(role.name)}</option>`).join('')}</select></label>`
      content += `<section><h2>Role rules</h2><p>${provider.kind === 'entra' ? 'Map an exact, case-sensitive value in the Entra roles claim to an artium role. Define app roles in the application registration, then assign groups to them in the enterprise application.' : 'Map an exact, case-sensitive value in any named claim to an artium role.'} Tool access comes from the target artium role; rules never grant administrator capability.</p><p>Rules synchronize at sign-in. Removing or retargeting a rule immediately removes its grants. Direct and other-rule grants remain. Who matches counts enabled, unarchived users from their last successful sign-in claims, including users not yet granted a new rule. Reload for current counts. This is not a live directory query; users who have never signed in are unknown.</p>`
      content += rules.length ? rules.map(rule => {
        const role = roles.find(role => role.id === rule.roleId)!
        const tools = db.prepare('SELECT tool FROM role_tools WHERE role_id = ? ORDER BY tool').all(role.id) as { tool: string }[]
        const action = adminRoleRuleRoutes.list.path + '/' + rule.id
        const count = matchingUsers(rule).length
        return `<details><summary>${escape(rule.claim)} contains ${escape(rule.value)} → ${escape(role.name)} | Who matches: ${count}</summary><p><a href="/admin/settings/sign-in/${escape(id)}/matches/${escape(rule.id)}">Who matches</a></p><p>Target role: <a href="/admin/roles/${escape(role.id)}">${escape(role.name)}</a>. Tools: ${tools.map(tool => escape(tool.tool)).join(', ') || 'No tools granted'}.</p>${changed(db, rule)}` +
          apiForm(csrf, action, 'PATCH', 'Save rule', revision(rule.revision) + fields(rule.value, rule.roleId, rule.claim), 'Save this mapping? Changing its claim name, value or target role immediately removes its existing rule-origin grants. Direct grants and grants from other rules are retained. Matching users receive grants at their next sign-in.') +
          apiForm(csrf, action, 'DELETE', 'Remove rule', revision(rule.revision), 'Remove this mapping and immediately remove its rule-origin grants? Direct grants and grants from other rules are retained. This cannot be undone.') + '</details>'
      }).join('') : '<p>No role rules. Add a mapping below after creating a role and granting its tools.</p>'
      content += roles.length ? `<h3>Add rule</h3>${apiForm(csrf, adminRoleRuleRoutes.create.path, 'POST', 'Add rule', fields(), 'Add this mapping? Matching users receive its role at their next sign-in.')}</section>` : '<p><a href="/admin/roles">Create an artium role</a> before adding rules.</p></section>'
    }
    return browserPage(reply, 'Sign-in settings', content, current)
  })
}
