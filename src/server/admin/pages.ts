import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminToolRoutes, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Diagnostic } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { adminRead, apiForm, changed, revision, timestamp } from './forms.js'
import { credentialFields, editorProfile } from './credential-form.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import type { ToolName } from '../store/credential-store.js'
import type { TrustedCertificate } from '../trusted-ca.js'
import { credentialCertificates } from '../store/trusted-certificates.js'
import { healthEndpoints } from '../health/preflight.js'

const settingsGuide = {
  'ado-axi': 'Optional allowWrites (boolean), off by default. Artium classifies and journals every command; api is GET only. Use {} to turn writes off.',
  'ldap-axi': 'LDAP is read-only and has no editable native settings. Use {}.',
  'mg-axi': 'Optional preview (boolean) and writes: {"allowWrites": true, "operations": ["mg.entra.group.member.add"]}. Use {} to clear settings.',
  'falcon-axi': 'Optional allowWrites (boolean), saved for a future write-capable pin. The reviewed Falcon pin has no write commands and remains read-only even when this switch is true. Use {} to turn the switch off.',
  'vectra-axi': 'Optional writes: {"allowWrites": true, "operations": ["notes.set"]}. Use {} to clear settings.',
  'az-axi': 'Optional subscriptions (array of IDs), managementGroup (ID), workspaces (name-to-UUID object), description (text), allowWrites (boolean). Use {} to clear settings.',
}
const testGuide = {
  'ado-axi': 'Azure DevOps project list --limit 1',
  'falcon-axi': 'Falcon auth status', 'vectra-axi': 'Vectra health list', 'az-axi': 'Azure account list',
  'mg-axi': 'Graph entra user list --limit 1', 'ldap-axi': 'LDAP auth status',
}

function diagnosticText(detail?: Diagnostic): string {
  return detail ? [detail.stage, detail.host, detail.toolCode, detail.providerCode, detail.message, detail.hint, detail.issuer, detail.trust].filter(Boolean).join('\n') : ''
}

export function registerAdminPages(app: FastifyInstance, db: Database.Database,
  credentialProfiles: Partial<Record<ToolName, CredentialProfile>> = {}, trustedCertificates: readonly TrustedCertificate[] = []): void {
  app.get('/admin/credentials', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    return reply.redirect('/admin/tools')
  })
  for (const path of ['/admin/tools', '/admin/tools/:tool']) app.get(path, async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const name = (request.params as { tool?: string }).tool
    if (!name) {
      const rows = tools.map(tool => `<tr><td><a href="/admin/tools/${tool.name}">${escape(tool.name)}</a></td><td>${escape(tool.version)}</td><td>${tool.enabled ? 'Enabled' : 'Disabled'}</td><td>${tool.readOnly ? 'Read-only' : 'Writes enabled'}</td><td>${escape(tool.health.status)} ${escape(tool.health.errorCode ?? '')}<pre>${escape(diagnosticText(tool.health.diagnostic))}</pre></td><td>${timestamp(tool.health.checkedAt, 'Not checked')}</td></tr>`).join('')
      const trust = trustedCertificates.length
        ? `<div class="table-scroll"><table><caption>Server-wide trusted CA bundle</caption><thead><tr><th>Subject</th><th>Issuer</th><th>Expiry (UTC)</th><th>SHA-256 fingerprint</th></tr></thead><tbody>${trustedCertificates.map(certificate => `<tr><td>${escape(certificate.subject)}</td><td>${escape(certificate.issuer)}</td><td>${escape(certificate.expiresAt)}</td><td><code>${escape(certificate.fingerprint)}</code></td></tr>`).join('')}</tbody></table></div>`
        : '<p>No server-wide extra CA bundle is configured.</p>'
      return browserPage(reply, 'Tools', `<section><h2>Tools</h2><p>Open a tool to configure credentials, settings and access.</p><div class="table-scroll"><table><caption>Installed tools</caption><thead><tr><th>Tool</th><th>Version</th><th>Status</th><th>Writes</th><th>Health</th><th>Last checked</th></tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>Trusted upstream certificates</h2><p>Read-only startup configuration. An operator changes ARTIUM_AXI_EXTRA_CA_FILE and restarts the server to update trust.</p>${trust}</section>`, current)
    }
    const parsed = toolSchema.safeParse(name)
    if (!parsed.success) throw new ArtiumError('NOT_FOUND')
    const tool = tools.find(tool => tool.name === parsed.data)!
    const api = '/v1/admin/tools/' + tool.name
    const credential = await adminRead(app, request, api + '/credential', adminToolRoutes.credential.response)
    const csrf = reply.generateCsrf()
    const form = (action: string, method: string, label: string, fields: string, confirmation: string, attributes = '') =>
      apiForm(csrf, action, method, label, fields, confirmation, attributes)
    const roles = db.prepare(`SELECT roles.id, roles.name FROM roles JOIN role_tools ON role_tools.role_id = roles.id WHERE tool = ? ORDER BY roles.name`).all(tool.name) as Array<{ id: string, name: string }>
    const tested = db.prepare(`SELECT 1 FROM tool_health WHERE tool = ? AND credential_revision = ? AND status = 'ok'`).get(tool.name, credential.revision)
    let content = `<p><a href="/admin/tools">All tools</a></p><section><h2>${escape(tool.name)}</h2><p>Version ${escape(tool.version)} | ${tool.enabled ? 'Enabled' : 'Disabled'} | Status: <span id="status-${tool.name}">${escape(tool.health.status)}</span></p>
      <p>Write access: ${tool.readOnly ? 'Read-only' : 'Writes enabled'}. Writes default to off. Set allowWrites to true in native settings to enable writes for Azure, nested inside writes for Graph and Vectra with the operations allow-list. Falcon's current pin and LDAP remain read-only.</p>
      <p>Last checked: <span data-check-time>${timestamp(tool.health.checkedAt, 'Not checked')}</span>. <span data-check-error>${escape(tool.health.errorCode ?? '')}</span></p><pre data-check-diagnostic>${escape(diagnosticText(tool.health.diagnostic))}</pre>
      <details open><summary>Setup checklist</summary><ol>${[
        [credential.configured, 'Save a credential below'], [Boolean(tested), 'Pass Test credential below', 'data-test-checklist'],
        [tool.enabled, 'Enable this tool'], [roles.length > 0, 'Grant this tool to a role on Roles'],
      ].map(([done, label, attribute]) => `<li${attribute ? ' ' + attribute : ''}>${done ? 'Done' : 'To do'}: ${label}</li>`).join('')}</ol><p>Assign the role to people on Users to give them access.</p></details>${changed(db, tool)}`
    content += form(api, 'PATCH', tool.enabled ? 'Disable tool' : 'Enable tool', revision(tool.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${!tool.enabled}">`, tool.enabled ? 'Disable this tool and block new calls?' : 'Enable this tool for people whose roles grant access?')
    content += `<h3>Credential</h3><p>Credential: ${credential.configured ? 'Configured' : 'Not configured'}. Secrets are never displayed.</p>${changed(db, credential)}`
    content += form(api + '/credential', 'PATCH', 'Save credential', revision(credential.revision) +
      `<input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}">` +
      credentialFields(tool.name, editorProfile(tool.name, credentialProfiles[tool.name]), credential.metadata, credential.configured) +
      '<label><input type="checkbox" data-save-and-test> Test after saving</label>',
      'Save this credential, retaining unchanged stored secrets for the same identity and keeping native settings?', `data-save-tool="${tool.name}"`)
    content += `<p>Test runs one harmless read: ${escape(testGuide[tool.name])}. It does not enable the tool or grant access.</p>`
    content += form(api + '/test', 'POST', 'Test credential', '', 'Run one harmless read with this credential?', `data-test-tool="${tool.name}"`)
    content += '<p data-test-result role="status"></p></section>'
    if (credential.configured) {
      const reference = db.prepare('SELECT id FROM credentials WHERE tool = ?').get(tool.name) as { id: string }
      const pins = credentialCertificates(db, reference.id)
      let endpoints: URL[] = []
      // An invalid saved credential must remain editable after a profile upgrade.
      try { endpoints = healthEndpoints(tool.name, credential.metadata) } catch { /* Save a valid endpoint before inspecting. */ }
      content += `<section data-trusted-certificates><h2>Trusted certificates</h2><p>Trust is scoped to this tool’s saved credential. Inspect again when rotating a certificate.</p>`
      if (endpoints.length) content += form(api + '/certificates/inspect', 'POST', 'Inspect certificate',
        `<label>Saved TLS endpoint<select name="endpointIndex" data-type="number">${endpoints.map((endpoint, index) => `<option value="${index}">${escape(endpoint.host)}</option>`).join('')}</select></label>`, '',
        `data-inspect-certificate${tool.health.errorCode === 'UPSTREAM_TLS_FAILED' || pins.length ? '' : ' hidden'}`)
      content += pins.length ? `<ul>${pins.map(pin => `<li><strong>${escape(pin.endpoint)}</strong><p>${escape(pin.certificate.subject)}<br>SHA-256: <code>${escape(pin.certificate.fingerprint)}</code>${pin.leaf.fingerprint !== pin.certificate.fingerprint ? `<br>Endpoint SHA-256: <code>${escape(pin.leaf.fingerprint)}</code>` : ''}<br>Certificate expiry: ${escape(pin.certificate.expiresAt)}<br>Endpoint certificate expiry: ${escape(pin.leaf.expiresAt)}</p>${Date.parse(pin.leaf.expiresAt) <= Date.now() + 30 * 86400000 || Date.parse(pin.certificate.expiresAt) <= Date.now() + 30 * 86400000 ? '<p role="alert">A trusted certificate has expired or expires within 30 days. Re-inspect this endpoint for rotation.</p>' : ''}${form(api + '/certificates', 'DELETE', 'Remove trust', `<input type="hidden" name="id" value="${escape(pin.id)}">`, 'Remove this certificate from the tool credential’s trust?')}</li>`).join('')}</ul>` : '<p>No certificates trusted for this credential.</p>'
      content += `</section><dialog id="certificate-inspection" aria-labelledby="certificate-inspection-title"><h2 id="certificate-inspection-title">Inspect certificate</h2><div data-certificate-details></div><p role="alert">Trust is only as safe as the network path when this certificate was fetched. A certificate presented during interception would be trusted too. Compare the full SHA-256 fingerprint with the one shown by the appliance.</p><p data-certificate-error role="alert"></p>${form(api + '/certificates/trust', 'POST', 'Trust certificate for this tool', '<input type="hidden" name="inspectionId">', '', 'data-trust-certificate')}<button type="button" data-close-certificate>Close</button></dialog>`
    }
    content += `<section><h2>Native settings</h2><p>Saving settings keeps the credential. This replaces the settings object and clears cached health; {} clears settings. Write settings control what the tool may change.</p>` +
      form(api, 'PATCH', 'Save native settings', revision(tool.revision) + `<p>${escape(settingsGuide[tool.name])}</p><label>Native settings (JSON object)<textarea name="nativeSettings" data-type="json" rows="8" required spellcheck="false">${escape(JSON.stringify(tool.nativeSettings, null, 2))}</textarea></label>`, 'Replace native settings while keeping the credential?') + '</section>'
    content += `<section><h2>Access</h2><p>Roles granting this tool:</p>${roles.length ? `<ul>${roles.map(role => `<li><a href="/admin/roles/${escape(role.id)}">${escape(role.name)}</a></li>`).join('')}</ul>` : '<p>No roles grant this tool. Open a role and select this tool to give its members access.</p>'}<p><a href="/admin/roles">Manage role grants</a>. Assign roles on Users. Enabling alone does not grant access.</p></section>`
    return browserPage(reply, 'Tools', content, current)
  })
}
