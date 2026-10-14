import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminRoleRoutes, adminToolRoutes, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { apiForm, changed, revision, timestamp } from './forms.js'
import { credentialFields } from './credential-form.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import type { ToolName } from '../store/credential-store.js'

const settingsGuide = {
  'mg-axi': 'Optional preview (boolean) and writes: {"allowWrites": true, "operations": ["mg.entra.group.member.add"]}. Use {} to clear settings.',
  'falcon-axi': 'Falcon has no editable native settings. Use {}.',
  'vectra-axi': 'Optional writes: {"allowWrites": true, "operations": ["notes.set"]}. Use {} to clear settings.',
  'az-axi': 'Optional subscriptions (array of IDs), managementGroup (ID), workspaces (name-to-UUID object), description (text), allowWrites (boolean). Use {} to clear settings.',
}
const credentialGuide = {
  'mg-axi': 'Required: tenantId and clientId (UUIDs), auth (secret or certificate). Secret auth requires clientSecret. Certificate auth requires privateKey and thumbprint (40 hexadecimal characters). Live Graph consent remains unverified.',
  'falcon-axi': 'Required: clientId, clientSecret, region. Optional: memberCid.',
  'vectra-axi': 'Required: origin (HTTPS origin), kind (qux or rux), apiVersion (2.5 for qux, 3.4 for rux), auth (token or oauth). Token auth requires token and qux. OAuth requires clientId and clientSecret. Optional: caBundle, applianceRelease (qux), writes (native settings).',
  'az-axi': 'Required: tenantId and clientId (UUIDs), auth (secret or certificate). Secret auth requires clientSecret. Certificate auth requires privateKey and thumbprintSha256 (64 hexadecimal characters). Optional native settings: subscriptions, managementGroup, workspaces, description, allowWrites.',
}

export function registerAdminPages(app: FastifyInstance, db: Database.Database,
  credentialProfiles: Partial<Record<ToolName, CredentialProfile>> = {}): void {
  for (const screen of ['Tools', 'Credentials', 'Roles'] as const) {
    const path = '/admin/' + screen.toLowerCase()
    app.get(path, async (request, reply) => {
      requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
      const current = readBrowserSession(db, request.cookies[browserCookie]!)
      const headers = { cookie: request.headers.cookie ?? '' }
      const csrf = reply.generateCsrf()
      const form = (action: string, method: string, label: string, fields: string, confirmation = '', attributes = '') =>
        apiForm(csrf, action, method, label, fields, confirmation, attributes)
      let content = ''
      if (screen === 'Roles') {
        const query = adminRoleRoutes.list.input.safeParse(request.query)
        if (!query.success) throw new ArtiumError('INVALID_INPUT')
        const response = await app.inject({ method: 'GET', url: '/v1/admin/roles?' + new URLSearchParams({
          limit: String(query.data.limit), ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        }), headers })
        const page = adminRoleRoutes.list.response.parse(response.json())
        content += `<section><h2>Create role</h2>${form('/v1/admin/roles', 'POST', 'Create role', '<label>Role name <input name="name" required></label>')}</section>`
        content += page.roles.map(role => {
          const api = '/v1/admin/roles/' + encodeURIComponent(role.id)
          return `<section><h2>${escape(role.name)}</h2>${changed(db, role)}
            ${form(api, 'PATCH', 'Rename role', revision(role.revision) + `<label>Role name <input name="name" value="${escape(role.name)}" required></label>`, 'Rename this role?')}
            ${form(api + '/tools', 'PUT', 'Save tool grants', revision(role.revision) + '<fieldset><legend>Granted tools</legend><input name="tools" type="hidden" disabled data-type="array">' +
              toolSchema.options.map(tool => `<label><input type="checkbox" name="tools" value="${tool}"${role.tools.includes(tool) ? ' checked' : ''}> ${tool}</label>`).join('') + '</fieldset>', 'Replace this role’s tool grants? Changes apply to the next call.')}</section>`
        }).join('')
        content += `<p><a href="${path}">First page</a>${page.nextCursor ? ` | <a href="${path}?cursor=${escape(encodeURIComponent(page.nextCursor))}&amp;limit=${escape(query.data.limit)}">Next page</a>` : ''}</p>`
      } else {
        const response = await app.inject({ method: 'GET', url: '/v1/admin/tools', headers })
        const { tools } = adminToolRoutes.list.response.parse(response.json())
        for (const tool of tools) {
          const api = '/v1/admin/tools/' + tool.name
          content += `<section><h2>${escape(tool.name)}</h2><p>Version ${escape(tool.version)} | ${tool.enabled ? 'Enabled' : 'Disabled'} | Status: <span id="status-${tool.name}">${escape(tool.health.status)}</span></p>
            <p>Last checked: <span data-check-time>${timestamp(tool.health.checkedAt, 'Not checked')}</span>. <span data-check-error>${escape(tool.health.errorCode ?? '')}</span></p>`
          if (screen === 'Tools') {
            const setup = db.prepare(`SELECT EXISTS(SELECT 1 FROM credentials WHERE tool = ?) AS configured,
              EXISTS(SELECT 1 FROM tool_health JOIN credentials ON credentials.tool = tool_health.tool
                AND credentials.revision = tool_health.credential_revision WHERE tool_health.tool = ? AND status = 'ok') AS tested,
              EXISTS(SELECT 1 FROM role_tools WHERE tool = ?) AS granted`).get(tool.name, tool.name, tool.name) as { configured: number, tested: number, granted: number }
            content += `<details><summary>Setup checklist</summary><ol>${[
              [setup.configured, 'Save a credential on Credentials'], [setup.tested, 'Pass Test credential on Credentials'],
              [tool.enabled, 'Enable this tool'], [setup.granted, 'Grant this tool to a role on Roles'],
            ].map(([done, label]) => `<li>${done ? 'Done' : 'To do'}: ${label}</li>`).join('')}</ol><p>Assign the role to people on Users to give them access.</p></details>`
            content += changed(db, tool)
            content += form(api, 'PATCH', tool.enabled ? 'Disable tool' : 'Enable tool',
              revision(tool.revision) + `<input type="hidden" name="enabled" data-type="boolean" value="${!tool.enabled}">`, tool.enabled ? 'Disable this tool?' : 'Enable this tool?')
            content += form(api, 'PATCH', 'Save native settings', revision(tool.revision) + `<p>${escape(settingsGuide[tool.name])}</p><label>Native settings (JSON object) <textarea name="nativeSettings" data-type="json" rows="8" required spellcheck="false">${escape(JSON.stringify(tool.nativeSettings, null, 2))}</textarea></label>`, 'Replace this tool’s native settings?')
          } else {
            const metadata = await app.inject({ method: 'GET', url: api + '/credential', headers })
            const credential = adminToolRoutes.credential.response.parse(metadata.json())
            const profile = credentialProfiles[tool.name]
            content += `<p>Credential: ${credential.configured ? 'Configured' : 'Not configured'}. Stored values are never displayed.</p>${changed(db, credential)}
              ${profile ? '' : `<p>${escape(credentialGuide[tool.name])}</p>`}<p>Provide the complete replacement, including any native settings to retain.</p>`
            content += form(api + '/credential', 'PUT', credential.configured ? 'Replace credential' : 'Set credential', revision(credential.revision) +
              `<input type="hidden" name="expectedToolRevision" data-type="number" value="${escape(tool.revision)}">` +
              (profile ? credentialFields(profile) : '<label>New credential (JSON object) <textarea name="value" data-type="json" rows="8" required autocomplete="off" spellcheck="false"></textarea></label>'), 'Replace the complete credential and its native settings?')
            content += form(api + '/test', 'POST', 'Test credential', '', 'Run one harmless read with this credential?', `data-test-tool="${tool.name}"`)
            content += '<p data-test-result role="status"></p>'
          }
          content += '</section>'
        }
      }
      return browserPage(reply, screen, content, current)
    })
  }
}
