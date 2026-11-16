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
import { adminRead, apiForm, changed, lastChange, revision } from './forms.js'
import { renderPage } from './render-page.js'
import { card, field, icon, initials, tabs, viewDialog } from './design/ui.js'
import { badge, status, toolProducts } from './design/status.js'

const signInQuery = z.object({ add: z.enum(['choose', 'entra', 'oidc']).optional(),
  tab: z.enum(['setup', 'credential', 'rules', 'settings']).optional(), rule: z.string().min(1).max(256).optional() })
const kindLabel = (kind: string) => kind === 'entra' ? 'Entra ID' : 'OpenID Connect'

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
  function checkCredential(id: string): void {
    const provider = read(id)
    if (provider.kind === 'entra') entraCredential(provider.issuer, store().read(id)?.value)
    else oidcCredential(store().read(id)?.value)
  }
  const breakGlassMissing = () => new ArtiumError('INVALID_INPUT', 'A usable break-glass local administrator is required.', 'Designate an enabled local administrator with a permanent password, unlock it if needed, and test its sign-in before enabling SSO.')
  function usableBreakGlass(): number {
    return (db.prepare(`SELECT count(*) AS count FROM users WHERE source = 'local' AND administrator = 1 AND break_glass = 1
      AND disabled = 0 AND archived_at IS NULL AND must_change = 0 AND password_hash LIKE '$argon2%'
      AND (locked_until IS NULL OR locked_until <= ?)`).get(Date.now()) as { count: number }).count
  }
  function activationReady(id: string): void {
    checkCredential(id)
    if (!usableBreakGlass()) throw breakGlassMissing()
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
    const query = signInQuery.safeParse(request.query)
    if (!query.success) throw new ArtiumError('INVALID_INPUT')
    const enabledCount = providers.filter(provider => provider.enabled).length
    if (!id) {
      const list = '/admin/settings/sign-in'
      const designated = (db.prepare(`SELECT count(*) AS count FROM users WHERE source = 'local' AND administrator = 1 AND break_glass = 1
        AND archived_at IS NULL`).get() as { count: number }).count
      const usable = usableBreakGlass()
      const pending = (db.prepare('SELECT count(*) AS count FROM invitations WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
        .get(Date.now()) as { count: number }).count
      const summaries = [
        { label: 'Current mode', value: enabledCount ? 'SSO, passwords for break-glass admins only' : 'Passwords for everyone',
          detail: enabledCount ? `${enabledCount} provider${enabledCount === 1 ? ' is' : 's are'} enabled. Disabling every provider restores passwords for everyone.` : 'No provider is enabled. Enabling one limits passwords to designated break-glass administrators.',
          warning: false, action: null },
        usable ? { label: 'Break-glass admins', value: `${usable} ready`, detail: 'A local administrator with a permanent password can still sign in if SSO fails. Every use is flagged in the audit log.', warning: false, action: null }
          : { label: 'Break-glass admins', value: designated ? 'None ready' : 'None designated', detail: designated ? 'A designated administrator must be enabled, unlocked and have a permanent password before SSO can be enabled.' : 'Choose a local administrator with a permanent password before enabling SSO.',
            warning: true, action: { href: '/admin/users?source=local', label: 'Choose admin' } },
        { label: 'Invitations', value: `${pending} pending`, detail: enabledCount ? 'Waiting to be claimed with an enabled provider.' : 'Claimable once a provider is enabled.',
          warning: false, action: { href: '/admin/invitations', label: 'Open invitations' } },
      ]
      const addHref = `${list}?add=choose`
      return renderPage(reply, 'Sign-in & SSO', 'signIn', { summaries, addHref, add: { open: query.data.add ?? null, closeHref: list, csrf },
        providers: providers.map(provider => ({ href: `${list}/${encodeURIComponent(provider.id)}`, name: provider.name, initials: initials(provider.name),
          kind: kindLabel(provider.kind), issuer: provider.issuer, configured: Boolean(credentials?.read(provider.id)), enabled: provider.enabled })) },
      current, 'How people sign in to Artium and the CLI.', [{ label: 'Add provider', href: addHref, variant: 'primary', icon: 'plus' }])
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
        return renderPage(reply, 'Sign-in & SSO', 'signInMatches', {
          people: matchingUsers(rule).map(user => ({ href: `/admin/users/${encodeURIComponent(user.id)}`, name: user.username, initials: initials(user.username),
            claimsAt: new Date(user.claims_at).toISOString() })),
          note: 'Matches come from the last successful sign-in of enabled, unarchived people. People who have never signed in with this provider can’t be counted yet. Grants synchronize on their next sign-in.' },
        current, 'From each enabled person’s last successful sign-in. Not a live directory lookup.', undefined, `Who matches “${rule.claim} contains ${rule.value}”`,
        { href: `/admin/settings/sign-in/${encodeURIComponent(id)}?tab=rules`, label: provider.name })
      }
      const api = adminProviderRoutes.list.path + '/' + id
      const page = `/admin/settings/sign-in/${encodeURIComponent(id)}`
      const tab = query.data.tab ?? 'setup'
      const credential = await adminRead(app, request, api + '/credential', adminProviderRoutes.credential.response)
      const { rules } = await adminRead(app, request, adminRoleRuleRoutes.list.path + '?providerId=' + encodeURIComponent(id), adminRoleRuleRoutes.list.response)
      const roles = db.prepare('SELECT id, name FROM roles ORDER BY name, id').all() as { id: string, name: string }[]
      const problems: string[] = []
      try { checkCredential(id) } catch (error) { problems.push(!credential.configured ? 'No credential saved.' : error instanceof ArtiumError ? error.message : 'Configuration is unavailable.') }
      const breakGlass = usableBreakGlass() > 0
      if (!breakGlass) problems.push(breakGlassMissing().message)
      const ready = !problems.length
      const disableConsequence = 'Disable this provider? Sign-in and confirmation for it stop. Existing Artium sessions remain active. Local passwords become available to ordinary local accounts only if every provider is disabled.'
      const enableConsequence = 'Enable SSO sign-in and restrict all local password use to designated break-glass administrators? Test the invitation claim and sign-in using a separate browser, keeping break-glass access available.'
      const sections = [{ id: 'setup', label: 'Setup' }, { id: 'credential', label: 'Credential', note: credential.configured ? undefined : 'Missing' },
        { id: 'rules', label: 'Role rules', note: String(rules.length) }, { id: 'settings', label: 'Settings' }]
      if (tab === 'setup' || tab === 'settings') {
        const origin = `${request.protocol}://${request.host}`
        return renderPage(reply, 'Sign-in & SSO', 'provider', { csrf, page, api, tab, initials: initials(provider.name), kind: provider.kind, kindLabel: kindLabel(provider.kind),
          tabs: sections.map(section => ({ label: section.label, href: `${page}?tab=${section.id}`, note: section.note ?? null, current: section.id === tab })),
          name: provider.name, issuer: provider.issuer, tenantId: provider.kind === 'entra' ? provider.tenantId : null, enabled: provider.enabled, revision: provider.revision, changed: lastChange(db, provider),
          credentialConfigured: credential.configured, breakGlass, problems, activationConsequence: provider.enabled ? disableConsequence : enableConsequence,
          redirectUri: origin + '/auth/sso/' + encodeURIComponent(id) + '/callback', logoutUri: origin + '/login' }, current, undefined, undefined, provider.name)
      }
      const activation = (label: string, enabled: boolean, confirmation: string, tone: string) => apiForm(csrf, api + '/activation', 'PATCH', label,
        revision(provider.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${enabled}">`, confirmation, '', tone)
      const actions = provider.enabled ? activation('Disable sign-in', false, disableConsequence, 'btn btn-secondary')
        : ready ? activation('Enable sign-in', true, enableConsequence, 'btn btn-primary')
          : '<button class="btn btn-primary" type="button" disabled>Enable sign-in</button>'
      let content = tabs(page, tab, sections)
      if (tab === 'credential') {
        content += card('App credential', credential.configured ? 'Saved. Secrets are never displayed.' : 'Not saved yet. Secrets are never displayed.', `<div class="card-body">${credential.configured ? changed(db, credential) : ''}
          <p class="hint">Certificate authentication is preferred. Upload one PEM containing the certificate and matching unencrypted private key; the SHA-256 fingerprint is calculated automatically. Client secrets are accepted but are less secure than certificates.</p>` +
          apiForm(csrf, api + '/credential', 'PATCH', 'Save credential', revision(credential.revision) +
            `<input type="hidden" name="expectedProviderRevision" data-type="number" value="${provider.revision}">` + credentialFields(undefined, profile(provider.kind), credential.metadata, credential.configured),
          'Save the encrypted provider credential and disable this provider, keeping omitted secrets only for the same identity? Review configuration and enable it again afterwards.', '', 'btn btn-primary') + '</div>', { actions: credential.configured ? badge('Saved', 'ok') : badge('Needs credential', 'warn') })
      } else {
        const fields = (value = '', roleId = '', claim = 'groups') => `<input type="hidden" name="providerId" value="${escape(id)}">${provider.kind === 'entra'
          ? '<input type="hidden" name="claim" value="roles"><p class="hint">Claim: <code>roles</code> (Entra app roles)</p>'
          : field('rule-claim', 'Claim name', describedBy => `<input ${describedBy} class="mono" name="claim" value="${escape(claim)}" maxlength="256" required>`, 'An exact top-level claim name, for example groups. Dots are literal, not nested paths. String values and strings in arrays match exactly; other values are ignored.')}` +
          field('rule-value', 'Claim value', describedBy => `<input ${describedBy} class="mono" name="value" value="${escape(value)}" maxlength="256" required>`, provider.kind === 'entra' ? 'The app role value, for example Artium.Readers, rather than its display name.' : 'The exact, case-sensitive value, for example Readers.') +
          field('rule-role', 'Artium role', describedBy => `<select ${describedBy} name="roleId" required><option value="">Choose a role</option>${roles.map(role => `<option value="${escape(role.id)}"${role.id === roleId ? ' selected' : ''}>${escape(role.name)}</option>`).join('')}</select>`, 'Tool access comes from this role. Rules never grant administrator capability.')
        const rows = rules.map(rule => {
          const role = roles.find(role => role.id === rule.roleId)!
          const tools = db.prepare('SELECT tool FROM role_tools WHERE role_id = ? ORDER BY tool').all(role.id) as { tool: keyof typeof toolProducts }[]
          const count = matchingUsers(rule).length
          const sentence = `<span class="mono">${escape(rule.claim)}</span> contains <span class="mono">${escape(rule.value)}</span>`
          return `<li class="list-row" data-rule="${escape(rule.id)}"><div class="grow"><p class="sentence">${sentence} ${icon('arrow')}<span class="sr-only">grants</span> <a href="/admin/roles/${escape(role.id)}">${escape(role.name)}</a></p><p>${tools.map(tool => escape(toolProducts[tool.tool].name)).join(', ') || 'No tools granted'} · synced at each sign-in</p></div>
            <a class="btn btn-ghost btn-sm" href="${page}/matches/${escape(encodeURIComponent(rule.id))}" data-who-matches>${count} ${count === 1 ? 'match' : 'matches'}</a>
            <details class="menu"><summary class="btn btn-ghost btn-icon btn-sm" aria-label="Rule actions">${icon('more')}</summary><div class="popover"><a href="${page}?tab=rules&amp;rule=${escape(encodeURIComponent(rule.id))}">${icon('pen')}Edit rule</a><hr>` +
            apiForm(csrf, adminRoleRuleRoutes.list.path + '/' + rule.id, 'DELETE', 'Remove rule', revision(rule.revision), 'Remove this mapping and immediately remove its rule-origin grants? Direct grants and grants from other rules are retained. This cannot be undone.',
              `data-confirm-name="${escape(rule.value)}"`, 'btn danger') + '</div></details></li>'
        }).join('')
        content += card('Role rules', provider.kind === 'entra' ? 'Map an exact, case-sensitive value in the Entra roles claim to an Artium role.' : 'Map an exact, case-sensitive value in any named claim to an Artium role.',
          (rules.length ? `<ul class="rows">${rows}</ul>` : `<div class="card-body"><p>No role rules yet. ${roles.length ? 'Add a mapping after granting the role its tools.' : '<a href="/admin/roles">Create an Artium role</a> before adding rules.'}</p></div>`) +
          '<div class="card-foot"><p>Rules synchronize at sign-in. Removing or retargeting a rule immediately removes its grants; direct and other-rule grants remain. Match counts use enabled people’s last successful sign-in claims, not a live directory.</p></div>',
          { actions: roles.length ? `<a class="btn btn-secondary btn-sm" href="${page}?tab=rules&amp;rule=new">${icon('plus')}Add rule</a>` : '' })
        const editing = query.data.rule
        if (editing && roles.length) {
          const rule = editing === 'new' ? undefined : rules.find(rule => rule.id === editing)
          if (editing !== 'new' && !rule) throw new ArtiumError('NOT_FOUND')
          const back = `${page}?tab=rules`
          content += rule
            ? viewDialog('Edit rule', 'Changes apply at each person’s next sign-in.', changed(db, rule) + apiForm(csrf, adminRoleRuleRoutes.list.path + '/' + rule.id, 'PATCH', 'Save rule', revision(rule.revision) + fields(rule.value, rule.roleId, rule.claim),
              'Save this mapping? Changing its claim name, value or target role immediately removes its existing rule-origin grants. Direct grants and grants from other rules are retained. Matching users receive grants at their next sign-in.', `data-success-url="${back}"`, 'btn btn-primary'), back)
            : viewDialog('Add rule', 'Matching people receive the role at their next sign-in.', apiForm(csrf, adminRoleRuleRoutes.create.path, 'POST', 'Add rule', fields(),
              'Add this mapping? Matching users receive its role at their next sign-in.', `data-success-url="${back}"`, 'btn btn-primary'), back)
        }
      }
      return browserPage(reply, provider.name, content, current, undefined, { helpTopic: 'Sign-in & SSO', parent: { href: '/admin/settings/sign-in', label: 'Sign-in & SSO' },
        lead: `<span class="tool-ico lg" aria-hidden="true">${escape(initials(provider.name))}</span>`,
        meta: `<span>${kindLabel(provider.kind)} · <span class="mono">${escape(provider.issuer)}</span></span>${provider.enabled ? status('Enabled', 'ok') : status('Disabled', 'off')}`, actions: `<div class="actions">${actions}</div>` })
    }
  })
}
