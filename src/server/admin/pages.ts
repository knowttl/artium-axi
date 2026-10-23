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
import { toolEndpoints } from '../tool-endpoints.js'

const settingsGuide = {
  'tenable-axi': 'Optional writes: {"allowWrites": true, "operations": ["tags-create-tag-category"]}. Writes and export jobs require native preview, execute and exact confirmation. Use {} to turn writes off.',
  'awx-axi': 'Optional allowWrites (boolean), off by default, enables operational actions only (launch, cancel, sync, approval and notification tests). Configuration, deletion and security writes are always blocked. Use {} to turn writes off.',
  'ado-axi': 'Optional allowWrites (boolean), off by default. Artium classifies and journals every command; api is GET only. Use {} to turn writes off.',
  'ldap-axi': 'LDAP is read-only and has no editable native settings. Use {}.',
  'mg-axi': 'Optional preview (boolean) and writes: {"allowWrites": true, "operations": ["mg.entra.group.member.add"]}. Use {} to clear settings.',
  'falcon-axi': 'Optional allowWrites (boolean), saved for a future write-capable pin. The reviewed Falcon pin has no write commands and remains read-only even when this switch is true. Use {} to turn the switch off.',
  'vectra-axi': 'Optional writes: {"allowWrites": true, "operations": ["notes.set"]}. Use {} to clear settings.',
  'az-axi': 'Optional subscriptions (array of IDs), managementGroup (ID), workspaces (name-to-UUID object), description (text), allowWrites (boolean), tlsDestinations: {"storageAccounts": ["synthetic"], "keyVaults": ["synthetic"], "registries": ["synthetic"]} (service names for certificate inspection, without domains). Use {} to clear settings.',
}
const testGuide = {
  'tenable-axi': 'Tenable card list --limit 1',
  'awx-axi': 'AWX job list --limit 1',
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
      const rows = tools.map(tool => `<tr><td><a href="/admin/tools/${tool.name}">${escape(tool.name)}</a></td><td>${escape(tool.version)}</td><td>${tool.enabled ? 'Enabled' : 'Disabled'}</td><td>${tool.writeAccess.capable ? 'Read and write capable' : 'Fixed read-only'}${tool.writeAccess.reason ? `<p>${escape(tool.writeAccess.reason)}</p>` : ''}</td><td>${tool.writeAccess.enabled ? 'Writes enabled' : 'Writes off'}</td><td>${escape(tool.health.status)} ${escape(tool.health.errorCode ?? '')}<pre>${escape(diagnosticText(tool.health.diagnostic))}</pre></td><td>${timestamp(tool.health.checkedAt, 'Not checked')}</td></tr>`).join('')
      const trust = trustedCertificates.length
        ? `<div class="table-scroll"><table><caption>Server-wide trusted CA bundle</caption><thead><tr><th>Subject</th><th>Issuer</th><th>Expiry (UTC)</th><th>SHA-256 fingerprint</th></tr></thead><tbody>${trustedCertificates.map(certificate => `<tr><td>${escape(certificate.subject)}</td><td>${escape(certificate.issuer)}</td><td>${escape(certificate.expiresAt)}</td><td><code>${escape(certificate.fingerprint)}</code></td></tr>`).join('')}</tbody></table></div>`
        : '<p>No server-wide extra CA bundle is configured.</p>'
      return browserPage(reply, 'Tools', `<section><h2>Tools</h2><p>Open a tool to configure credentials, settings and access.</p><div class="table-scroll"><table class="tools-table"><caption>Installed tools</caption><thead><tr><th>Tool</th><th>Version</th><th>Status</th><th>Capability</th><th>Writes</th><th>Health</th><th>Last checked</th></tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>Trusted upstream certificates</h2><p>Read-only startup configuration. An operator changes ARTIUM_AXI_EXTRA_CA_FILE and restarts the server to update trust.</p>${trust}</section>`, current)
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
      <p>Write access: ${tool.readOnly ? 'Read-only' : 'Writes enabled'}. ${tool.writeAccess.capable ? 'Read and write capable.' : 'Fixed read-only. ' + escape(tool.writeAccess.reason)}</p>
      <p>Last checked: <span data-check-time>${timestamp(tool.health.checkedAt, 'Not checked')}</span>. <span data-check-error>${escape(tool.health.errorCode ?? '')}</span></p><pre data-check-diagnostic>${escape(diagnosticText(tool.health.diagnostic))}</pre>
      <details open><summary>Setup checklist</summary><ol>${[
        [credential.configured, 'Save a credential below'], [Boolean(tested), 'Pass Test credential below', 'data-test-checklist'],
        [tool.enabled, 'Enable this tool'], [roles.length > 0, 'Grant this tool to a role on Roles'],
      ].map(([done, label, attribute]) => `<li${attribute ? ' ' + attribute : ''}>${done ? 'Done' : 'To do'}: ${label}</li>`).join('')}</ol><p>Assign the role to people on Users to give them access.</p></details>${changed(db, tool)}`
    content += form(api, 'PATCH', tool.enabled ? 'Disable tool' : 'Enable tool', revision(tool.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${!tool.enabled}">`, tool.enabled ? 'Disable this tool and block new calls?' : 'Enable this tool for people whose roles grant access?')
    content += `<h3>Credential</h3><p>Credential: ${credential.configured ? 'Configured' : 'Not configured'}. Secrets are never displayed.</p>${changed(db, credential)}`
    if (tool.name === 'awx-axi') {
      content += '<p>For password sign-in, save the controller address first. Inspect its certificate below and approve it if needed, then enter the username and password and save the credential. Changing the saved address removes the previous token and certificate trust.</p>'
      content += form(api + '/origin', 'PUT', 'Save controller address', revision(credential.revision) +
        `<input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}"><label>Controller HTTPS origin<input name="origin" type="url" required value="${escape(credential.metadata.origin ?? '')}"></label>`,
        'Save this controller address without sending credentials? A changed address removes the previous token and certificate trust.')
    }
    content += form(api + '/credential', 'PATCH', 'Save credential', revision(credential.revision) +
      `<input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}">` +
      credentialFields(tool.name, editorProfile(tool.name, credentialProfiles[tool.name]), credential.metadata, credential.configured) +
      '<label><input type="checkbox" data-save-and-test> Test after saving</label>',
      'Save this credential, retaining unchanged stored secrets for the same identity and keeping native settings?', `data-save-tool="${tool.name}"`)
    content += `<p>Test runs one harmless read: ${escape(testGuide[tool.name])}. It does not enable the tool or grant access.</p>`
    content += form(api + '/test', 'POST', 'Test credential', '', 'Run one harmless read with this credential?', `data-test-tool="${tool.name}"`)
    content += '<p data-test-result role="status"></p></section>'
    const writes = tool.writeAccess
    content += `<section data-write-access><h2>Write access</h2><p>${writes.capable ? 'Read and write capable' : 'Fixed read-only'}. ${writes.enabled ? 'Writes enabled' : 'Writes off'}. Writes default to off.</p>`
    if (writes.reason) content += `<p>${escape(writes.reason)}</p>`
    content += `<h3>Current grant</h3><p>${writes.enabled ? escape(writes.unlocks) : 'No write actions are currently granted.'}</p>`
    if (writes.supportedOperations) {
      content += `<p>Currently allowed operations${writes.enabled ? '' : ' (inactive while writes are off)'}:</p>${writes.allowedOperations.length ? `<ul>${writes.allowedOperations.map(operation => `<li><code>${escape(operation)}</code></li>`).join('')}</ul>` : '<p>None selected.</p>'}`
    }
    content += `<p>Always blocked: ${escape(writes.blocked)}</p>`
    if (writes.capable) {
      let fields = revision(tool.revision) + `<label><input type="checkbox" role="switch" name="enabled" data-type="boolean"${writes.enabled ? ' checked' : ''}> Allow write access</label><p>Turning this on allows: ${escape(writes.unlocks)}</p>`
      if (writes.supportedOperations) {
        fields += `<fieldset><legend>Allowed write operations</legend><p>Select the operations to allow from the pinned catalogue. At least one is required to turn writes on. Unselected operations stay blocked.</p>${writes.supportedOperations.map(operation => `<label><input type="checkbox" name="operations" data-type="array" value="${escape(operation)}"${writes.allowedOperations.includes(operation) ? ' checked' : ''}> <code>${escape(operation)}</code></label>`).join('')}</fieldset>`
        if (writes.allowedOperations.some(operation => !writes.supportedOperations!.includes(operation))) fields += '<p role="alert">The saved allow-list contains operations outside the pinned catalogue. Saving write access removes those unsupported entries.</p>'
      }
      content += form(api + '/write-access', 'PATCH', 'Save write access', fields,
        'Save write access and the selected operations for this tool? Other native settings stay unchanged. Turning writes on allows the actions described above; turning writes off blocks them. This change is audited.')
    }
    content += '</section>'
    if (credential.configured || (tool.name === 'awx-axi' && credential.metadata.origin)) {
      const reference = db.prepare('SELECT id FROM credentials WHERE tool = ?').get(tool.name) as { id: string }
      const pins = credentialCertificates(db, reference.id)
      let endpoints: URL[] = []
      // An invalid saved credential must remain editable after a profile upgrade.
      try { endpoints = toolEndpoints(tool.name, { ...credential.metadata, ...tool.nativeSettings }) } catch { /* Save a valid endpoint before inspecting. */ }
      content += `<section data-trusted-certificates><h2>Trusted certificates</h2><p>Trust is scoped to this tool’s saved credential. CA trust allows leaf renewal. Strict pinning requires confirmation after rotation.</p>`
      if (endpoints.length) content += form(api + '/certificates/inspect', 'POST', 'Inspect certificate',
        `<label>Saved TLS endpoint<select name="endpointIndex" data-type="number">${endpoints.map((endpoint, index) => `<option value="${index}">${escape(endpoint.host)}</option>`).join('')}</select></label>`, '',
        `data-inspect-certificate${tool.name === 'awx-axi' || tool.health.errorCode === 'UPSTREAM_TLS_FAILED' || pins.length ? '' : ' hidden'}`)
      content += pins.length ? `<ul>${pins.map(pin => `<li><strong>${escape(pin.endpoint)}</strong><p>${escape(pin.certificate.subject)}<br>SHA-256: <code>${escape(pin.certificate.fingerprint)}</code>${pin.leaf.fingerprint !== pin.certificate.fingerprint ? `<br>Endpoint SHA-256: <code>${escape(pin.leaf.fingerprint)}</code>` : ''}<br>Certificate expiry: ${escape(pin.certificate.expiresAt)}<br>Endpoint certificate expiry: ${escape(pin.leaf.expiresAt)}</p>${Date.parse(pin.leaf.expiresAt) <= Date.now() + 30 * 86400000 || Date.parse(pin.certificate.expiresAt) <= Date.now() + 30 * 86400000 ? '<p role="alert">A trusted certificate has expired or expires within 30 days. Re-inspect this endpoint for rotation.</p>' : ''}${form(api + '/certificates', 'DELETE', 'Remove trust', `<input type="hidden" name="id" value="${escape(pin.id)}">`, 'Remove this certificate from the tool credential’s trust?')}</li>`).join('')}</ul>` : '<p>No certificates trusted for this credential.</p>'
      content += `</section><dialog id="certificate-inspection" aria-labelledby="certificate-inspection-title"><h2 id="certificate-inspection-title">Inspect certificate</h2><div data-certificate-details></div><p role="alert">Trust is only as safe as the network path when this certificate was fetched. A certificate presented during interception would be trusted too. Compare the full SHA-256 fingerprint with the one shown by the appliance.</p><p data-certificate-error role="alert"></p>${form(api + '/certificates/trust', 'POST', 'Trust certificate for this tool', '<input type="hidden" name="inspectionId"><label>Trust mode<select name="mode"><option value="ca">Trust the CA (allows leaf renewal)</option><option value="pin">Strict leaf pinning (requires confirmation after rotation)</option></select></label><p>Self-signed endpoints keep a leaf pin. Hostname and date verification always apply.</p>', '', 'data-trust-certificate')}<button type="button" data-close-certificate>Close</button></dialog>`
    }
    content += `<section><h2>Native settings</h2><p>Current write state: ${writes.enabled ? 'Writes enabled' : 'Writes off'}.</p><p>Saving settings keeps the credential. This replaces the whole settings object and clears cached health; {} clears settings. Omitting write settings turns writes off. Use Write access above to change writes while preserving other settings.</p>` +
      form(api, 'PATCH', 'Save native settings', revision(tool.revision) + `<p>${escape(settingsGuide[tool.name])}</p><label>Native settings (JSON object)<textarea name="nativeSettings" data-type="json" rows="8" required spellcheck="false">${escape(JSON.stringify(tool.nativeSettings, null, 2))}</textarea></label>`, 'Replace native settings while keeping the credential?') + '</section>'
    content += `<section><h2>Access</h2><p>Roles granting this tool:</p>${roles.length ? `<ul>${roles.map(role => `<li><a href="/admin/roles/${escape(role.id)}">${escape(role.name)}</a></li>`).join('')}</ul>` : '<p>No roles grant this tool. Open a role and select this tool to give its members access.</p>'}<p><a href="/admin/roles">Manage role grants</a>. Assign roles on Users. Enabling alone does not grant access.</p></section>`
    return browserPage(reply, 'Tools', content, current)
  })
}
