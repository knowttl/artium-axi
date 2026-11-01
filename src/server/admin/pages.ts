import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import { adminToolRoutes, toolSchema, githubDeviceRoutes } from '../../shared/api.js'
import { ArtiumError, errors } from '../../shared/errors.js'
import type { Diagnostic } from '../../shared/errors.js'
import operationCatalogue from '../../../tools/inventories/write-operations.json' with { type: 'json' }
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { adminRead, changed, timestamp } from './forms.js'
import { credentialFields, editorProfile } from './credential-form.js'
import { setupBadge, toolIcon, toolProducts, toolSetupState, writes as writesState } from './design/status.js'
import { callout, card, icon, noteCard, steps, tabs } from './design/ui.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import type { ToolName } from '../store/credential-store.js'
import type { TrustedCertificate } from '../trusted-ca.js'
import { credentialCertificates } from '../store/trusted-certificates.js'
import { toolEndpoints } from '../tool-endpoints.js'

const settingsGuide = {
  'gh-axi': 'Writes default off. Select exact collaboration or repository operations with writes: { allowWrites: true, operations: ["issue comment"] }. Preview each write, then repeat with the returned --confirm. Deletes, secret set, merge --admin and API non-GET stay blocked.',
  'hybrid-axi': 'Optional writes: {"allowWrites": true, "operations": ["submitUrl"]}. Submissions, YARA mutations, consuming matches and four reviewed archive downloads are off by default and selected independently; native preview, execute, exact confirmation and journal gates remain required. Use artium-axi download for CLI verified saving after artifact-mount and operator prerequisites pass. Use {} to turn writes off.',
  'tenable-axi': 'Optional writes: {"allowWrites": true, "operations": ["tags-create-tag-category"]}. Writes and export jobs require native preview, execute and exact confirmation. Use {} to turn writes off.',
  'beyondtrust-axi': 'Writes require selected exact operations, native preview, execute and exact confirmation. Deletes additionally require Allow deletes and exact confirm-delete. Downloads use artium-axi download.',
  'checkpoint-axi': 'Optional writes: {"allowWrites": true, "operations": ["email.quarantine"]}. Exact event.action.<name> entries can be added here using an available event action name. Writes require native preview, execute and exact confirmation. Downloads require separately selected operations and artium-axi download with host-owned confirmation. Ambiguous deletes remain blocked. Use {} to turn writes off.',
  'awx-axi': 'Optional allowWrites (boolean), off by default, enables operational actions only (launch, cancel, sync, approval and notification tests). Separate allowConfigurationWrites (boolean), off by default, enables ordinary create/edit/copy and additive associations for inventories, hosts, groups, sources, templates, projects, schedules and workflows/nodes. Each write requires --confirm and AWX resource permission. Credentials, secret input, files/stdin, deletes, removals, bulk, organizations, users, teams, roles and tokens remain blocked. Use {} to turn both controls off.',
  'ado-axi': 'Optional allowWrites (boolean), off by default. Permits reviewed work-item delete/destroy, link removal, pipeline, repository, policy, PR and ref writes. Release creation may deploy. Raw API writes require server-listed paths. Artium classifies and journals every command. Use {} to turn writes off.',
  'ldap-axi': 'LDAP is read-only and has no editable native settings. Use {}.',
  'mg-axi': 'Optional enabledPacks: ["entra", "security"] enables read-only hunting; default ["entra"]. Optional preview (boolean) and writes: {"allowWrites": true, "operations": ["mg.entra.group.member.add"]}. Use {} to clear settings.',
  'falcon-axi': 'Select rtr run and/or malquery search in the audited write switch; both are off by default. MalQuery search requires MalQuery:write and supports exact/fuzzy patterns only. RTR also requires rtr: {"enabled": true, "commands": ["ps"]} for profile opt-in and optional command narrowing. Native preview, --execute and exact --confirm still apply. History reads remain available while execution is off.',
  'vectra-axi': 'Optional writes: {"allowWrites": true, "operations": ["notes.set"]}. Use {} to clear settings.',
  'az-axi': 'Optional subscriptions (array of IDs), managementGroup (ID), workspaces (name-to-UUID object), description (text), allowWrites (boolean), tlsDestinations: {"storageAccounts": ["synthetic"], "keyVaults": ["synthetic"], "registries": ["synthetic"]} (service names for certificate inspection, without domains). Use {} to clear settings.',
}
const testGuide = {
  'gh-axi': 'GitHub api /rate_limit',
  'hybrid-axi': 'Hybrid Analysis quota',
  'tenable-axi': 'Tenable card list --limit 1',
  'beyondtrust-axi': 'BeyondTrust doctor (authentication and bounded About read)',
  'checkpoint-axi': 'Check Point doctor (authentication and bounded email search)',
  'awx-axi': 'AWX job list --limit 1',
  'ado-axi': 'Azure DevOps project list --limit 1',
  'falcon-axi': 'Falcon auth status', 'vectra-axi': 'Vectra health list', 'az-axi': 'Azure account list',
  'mg-axi': 'Graph entra user list --limit 1', 'ldap-axi': 'LDAP auth status',
}

type Tool = z.infer<typeof adminToolRoutes.list.response>['tools'][number]
type Credential = z.infer<typeof adminToolRoutes.credential.response>
type Risk = 'delete' | 'bulk'
interface Operation { name: string, label: string, risk: readonly Risk[] }
interface OperationGroup { title: string, family?: string, operations: Operation[] }

// Labels and risk tags come only from the reviewed map beside the tool inventories.
const catalogue: Partial<Record<ToolName, { groups: { title: string, family?: string,
  operations: Record<string, { label: string, risk?: Risk[] }> }[] }>> = operationCatalogue as never

function operationGroups(tool: ToolName, supported: readonly string[], family: unknown): OperationGroup[] {
  const listed = new Set<string>()
  const groups: OperationGroup[] = (catalogue[tool]?.groups ?? []).map(group => ({ title: group.title, family: group.family,
    operations: Object.entries(group.operations).filter(([name]) => supported.includes(name)).map(([name, operation]) => {
      listed.add(name)
      return { name, label: operation.label, risk: operation.risk ?? [] }
    }) })).filter(group => group.operations.length)
  // Exact names an administrator added outside the reviewed catalogue, such as Check Point event actions.
  const other = supported.filter(name => !listed.has(name))
  if (other.length) groups.push({ title: 'Other operations', operations: other.map(name => ({ name, label: name, risk: [] })) })
  const configured = (group: OperationGroup) => !group.family || group.family === family
  return [...groups.filter(configured), ...groups.filter(group => !configured(group))]
}

function diagnosticText(detail?: Diagnostic): string {
  return detail ? [detail.stage, detail.host, detail.toolCode, detail.providerCode, detail.message, detail.hint, detail.issuer, detail.trust].filter(Boolean).join('\n') : ''
}

const tabNames = ['connection', 'writes', 'certificates', 'access', 'advanced'] as const
type Tab = typeof tabNames[number]

export function registerAdminPages(app: FastifyInstance, db: Database.Database,
  credentialProfiles: Partial<Record<ToolName, CredentialProfile>> = {}, trustedCertificates: readonly TrustedCertificate[] = []): void {
  const roleCounts = () => new Map((db.prepare('SELECT tool, COUNT(*) AS count FROM role_tools GROUP BY tool').all() as { tool: string, count: number }[])
    .map(row => [row.tool, row.count]))
  app.get('/admin/credentials', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    return reply.redirect('/admin/tools')
  })
  app.get('/admin/tools', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const { tools } = await adminRead(app, request, '/v1/admin/tools', adminToolRoutes.list.response)
    const credentials = await Promise.all(tools.map(tool => adminRead(app, request, `/v1/admin/tools/${tool.name}/credential`, adminToolRoutes.credential.response)))
    const roles = roleCounts()
    const query = request.query as { show?: string, q?: string }
    const show = query.show === 'enabled' || query.show === 'attention' ? query.show : 'all'
    const search = typeof query.q === 'string' ? query.q.trim() : ''
    const rows = tools.map((tool, index) => ({ tool, state: toolSetupState({ enabled: tool.enabled, configured: credentials[index]!.configured, health: tool.health }) }))
    const attention = (row: typeof rows[number]) => row.state === 'failing' || row.state === 'needsCredential'
    const counts = { all: rows.length, enabled: rows.filter(row => row.tool.enabled).length, attention: rows.filter(attention).length }
    const visible = rows.filter(row => (show === 'all' || (show === 'enabled' ? row.tool.enabled : attention(row)))
      && (!search || `${toolProducts[row.tool.name].name} ${row.tool.name}`.toLowerCase().includes(search.toLowerCase())))
    const link = (value: string) => '/admin/tools' + (value === 'all' ? '' : '?show=' + value) + (search ? `${value === 'all' ? '?' : '&'}q=${encodeURIComponent(search)}` : '')
    const filters = `<form class="filters" method="get" action="/admin/tools" data-filters><div class="seg" role="group" aria-label="Show">${(['all', 'enabled', 'attention'] as const).map(value =>
      `<a href="${escape(link(value))}"${show === value ? ' aria-current="page"' : ''}>${{ all: 'All', enabled: 'Enabled', attention: 'Needs attention' }[value]} ${counts[value]}</a>`).join('')}</div>${show === 'all' ? '' : `<input type="hidden" name="show" value="${show}">`}<label class="search narrow"><span class="sr-only">Filter tools</span>${icon('search')}<input type="search" name="q" value="${escape(search)}" placeholder="Filter tools"></label></form>`
    const body = visible.map(({ tool, state }) => `<tr><td><div class="cell-main">${toolIcon(tool.name)}<div><a href="/admin/tools/${tool.name}">${escape(toolProducts[tool.name].name)}</a><span>${escape(tool.name)} · ${escape(tool.version)}</span></div></div></td>
      <td data-label="State">${setupBadge(state)}</td><td data-label="Enabled" class="muted"><span class="row"><span class="switch${tool.enabled ? ' on' : ''}" aria-hidden="true"></span>${tool.enabled ? 'On' : 'Off'}</span></td>
      <td data-label="Writes">${writesState({ capable: tool.writeAccess.capable, enabled: !tool.readOnly, operations: tool.writeAccess.supportedOperations ? tool.writeAccess.allowedOperations.length : null }, 'status')}</td>
      <td data-label="Roles" class="muted">${roles.get(tool.name) ?? 0}</td><td data-label="Last checked" class="num faint">${timestamp(tool.health.checkedAt, 'Never')}</td></tr>`).join('')
    const table = `<section class="card"><table class="tbl stack-sm"><caption class="sr-only">Tools</caption><thead><tr><th scope="col">Tool</th><th scope="col">State</th><th scope="col">Enabled</th><th scope="col">Writes</th><th scope="col">Roles</th><th scope="col" class="num">Last checked</th></tr></thead><tbody>${body}</tbody></table>${visible.length ? '' : '<p class="empty">No tools match these filters. <a href="/admin/tools">Show all tools</a>.</p>'}</section>`
    const trust = trustedCertificates.length
      ? `<table class="tbl stack-sm"><caption class="sr-only">Server-wide trusted CA bundle</caption><thead><tr><th scope="col">Subject</th><th scope="col">Issuer</th><th scope="col">Expires (UTC)</th><th scope="col">SHA-256 fingerprint</th></tr></thead><tbody>${trustedCertificates.map(certificate => `<tr><td>${escape(certificate.subject)}</td><td data-label="Issuer">${escape(certificate.issuer)}</td><td data-label="Expires">${escape(certificate.expiresAt)}</td><td data-label="SHA-256"><code>${escape(certificate.fingerprint)}</code></td></tr>`).join('')}</tbody></table>`
      : ''
    const footer = `<section class="card"><div class="list-row">${icon('cert')}<div class="grow"><strong>Server-wide trusted CA bundle</strong><p>${trustedCertificates.length ? `${trustedCertificates.length} certificate${trustedCertificates.length === 1 ? '' : 's'}.` : 'None configured.'} An operator sets ARTIUM_AXI_EXTRA_CA_FILE and restarts the server to change it. Per-tool trust is on each tool's Certificates tab.</p></div><span class="badge">Read-only</span></div>${trust}</section>`
    return browserPage(reply, 'Tools', filters + table + footer, current, 'Each tool starts off. Connect it, test it, enable it, then grant it to a role.')
  })
  app.get('/admin/tools/:tool', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const parsed = toolSchema.safeParse((request.params as { tool: string }).tool)
    if (!parsed.success) throw new ArtiumError('NOT_FOUND')
    const query = request.query as { tab?: string, q?: string, show?: string }
    const tab: Tab = tabNames.find(name => name === query.tab) ?? 'connection'
    const api = '/v1/admin/tools/' + parsed.data
    const tool = await adminRead(app, request, api, adminToolRoutes.get.response)
    const credential = await adminRead(app, request, api + '/credential', adminToolRoutes.credential.response)
    const csrf = reply.generateCsrf()
    const product = toolProducts[tool.name].name
    // Forms keep today's API, CSRF token, revision and confirmation; buttons sit wherever the card needs them.
    const formStart = (action: string, method: string, confirmation: string, attributes = '', className = '') =>
      `<form${className ? ` class="${className}"` : ''} data-api data-method="${method}" data-confirm="${escape(confirmation)}"${attributes ? ' ' + attributes : ''} action="${escape(action)}" method="post"><input type="hidden" name="_csrf" value="${escape(csrf)}">`
    const revisionInputs = (credentialRevision: number) => `<input type="hidden" name="expectedRevision" data-type="number" value="${credentialRevision}"><input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}">`
    const roles = db.prepare(`SELECT roles.id, roles.name, (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE user_roles.role_id = roles.id) AS members
      FROM roles JOIN role_tools ON role_tools.role_id = roles.id WHERE tool = ? ORDER BY roles.name`).all(tool.name) as { id: string, name: string, members: number }[]
    const state = toolSetupState({ enabled: tool.enabled, configured: credential.configured, health: tool.health })
    const tested = state === 'healthy'
    const failing = state === 'failing'
    const writes = tool.writeAccess
    const awx = tool.name === 'awx-axi'
    const configurationWrites = awx && tool.nativeSettings.allowConfigurationWrites === true

    const test = formStart(api + '/test', 'POST', '', `data-test-tool="${tool.name}"`) + `<button class="btn btn-secondary">${icon('test')}Test connection</button></form>`
    const enable = formStart(api, 'PATCH', tool.enabled ? 'Disable this tool and block new calls?' : 'Enable this tool for people whose roles grant access?') +
      `<input type="hidden" name="expectedRevision" data-type="number" value="${tool.revision}"><input type="hidden" name="enabled" data-type="boolean" value="${!tool.enabled}"><button class="toggle" role="switch" aria-checked="${tool.enabled}"><span class="switch${tool.enabled ? ' on' : ''}" aria-hidden="true"></span>Enabled</button></form>`
    const meta = `<span class="mono">${escape(tool.name)} · ${escape(tool.version)}</span><span data-tool-state>${setupBadge(state)}</span>${writesState({ capable: writes.capable, enabled: !tool.readOnly, operations: writes.supportedOperations ? writes.allowedOperations.length : null }, 'badge')}<span>Checked <span data-check-time>${timestamp(tool.health.checkedAt, 'never')}</span></span>`
    const stateTemplates = `<template data-state="ok">${setupBadge('healthy')}</template><template data-state="error">${setupBadge('failing')}</template>`

    const definition = tool.health.errorCode && tool.health.errorCode in errors ? errors[tool.health.errorCode as keyof typeof errors] : undefined
    const failure = callout('err', 'Last test failed', `<span data-check-summary>${escape(tool.health.diagnostic?.message ?? definition?.message ?? '')} ${escape(tool.health.diagnostic?.hint ?? definition?.next ?? '')}</span>`, '',
      { attributes: `data-check-failure${failing ? '' : ' hidden'}`, more: `<p>Agents calling this tool get <code data-check-error>${escape(tool.health.errorCode ?? '')}</code>.${tool.health.errorCode === 'UPSTREAM_TLS_FAILED' ? ` Review the endpoint on <a href="?tab=certificates">Certificates</a>.` : ''}</p><details><summary>Show diagnostic</summary><pre data-check-diagnostic>${escape(diagnosticText(tool.health.diagnostic))}</pre></details>` })
    const grants = roles.map(role => role.name).join(', ')
    const setup = steps([
      { title: 'Credential saved', detail: credential.configured ? timestamp(credential.updatedAt) : 'Not saved yet', state: credential.configured ? 'done' : 'todo' },
      { title: 'Test passes', detail: tested ? 'Passed' : failing ? `Failing: ${escape(tool.health.errorCode ?? 'error')}` : 'Not run', state: tested ? 'done' : failing ? 'fail' : 'todo', attributes: 'data-test-checklist' },
      { title: 'Enabled', detail: tool.enabled ? 'On' : 'Off', state: tool.enabled ? 'done' : 'todo' },
      { title: 'Granted to a role', detail: roles.length ? escape(grants) : 'No roles yet', state: roles.length ? 'done' : 'todo' },
    ])
    const writesNote = !writes.capable ? 'Read-only' : tool.readOnly ? 'Off' : writes.supportedOperations ? `${writes.allowedOperations.length} on` : 'On'
    const navigation = tabs(`/admin/tools/${tool.name}`, tab, [
      { id: 'connection', label: 'Connection', icon: 'globe' },
      { id: 'writes', label: 'Write permissions', icon: 'zap', note: writesNote },
      { id: 'certificates', label: 'Certificates', icon: 'cert' },
      { id: 'access', label: 'Access', icon: 'users', note: String(roles.length) },
      { id: 'advanced', label: 'Advanced', icon: 'sliders' },
    ], 'Tool sections')
    const result = '<p class="note" data-test-result role="status"></p>'

    let panel: string
    if (tab === 'connection') {
      let main = ''
      if (tool.name === 'gh-axi') {
        const device = credential.metadata.auth === 'device'
        main += `<section class="card" data-github-device><div class="card-head"><div><h2>${device ? 'Reconnect' : 'Connect'} with GitHub</h2><p>One shared machine identity for this deployment.</p></div></div><div class="card-body">
          <p>Use a dedicated machine account. This reuses the GitHub CLI OAuth client ID and requests repo, read:org, gist, workflow and project. These broad scopes permit writes outside Artium even while Artium writes are off.</p>
          <p>The non-expiring OAuth token appears as GitHub CLI in GitHub Settings, Applications, Authorized OAuth Apps. Revoke it there. Store and rotate it like every other secret. No automatic refresh is performed. Connecting replaces the shared credential only after approval.</p>
          ${device ? `<p>Connected account: <strong>${escape(credential.metadata.login)}</strong>. ${credential.metadata.accessTokenExpiresAt ? 'Provider expiry: ' + timestamp(Number(credential.metadata.accessTokenExpiresAt)) : 'No scheduled expiry.'}</p>` : ''}
          ${tool.health.errorCode === 'CREDENTIAL_EXPIRED' ? callout('err', 'The credential expired or was revoked', 'Reconnect below.', '', { role: 'alert' }) : ''}
          ${formStart(githubDeviceRoutes.start.path, 'POST', 'Connect a shared GitHub account with repo, read:org, gist, workflow and project scopes? This replaces the deployment credential after authorization.', 'data-connect-github')}${revisionInputs(credential.revision)}<label>GitHub HTTPS origin<input name="origin" type="url" required value="${escape(credential.metadata.origin ?? 'https://github.com')}"></label><button class="btn btn-secondary">${icon('link')}${device ? 'Reconnect with GitHub' : 'Connect with GitHub'}</button></form>
          <div class="column" data-github-authorization hidden><p>Open <a data-github-link target="_blank" rel="noopener noreferrer"></a> and enter:</p><div class="bigcode" data-github-code></div><p data-github-status role="status"></p><div><button type="button" class="btn btn-ghost btn-sm" data-cancel-github>Cancel connection</button></div></div>
          <p>Alternatively, choose token or github-app below to replace the credential using another method.</p></div></section>`
      }
      if (awx) {
        main += formStart(api + '/origin', 'PUT', 'Save this controller address without sending credentials? A changed address removes the previous token and certificate trust.', '', 'card') +
          `<div class="card-head"><div><h2>Controller address</h2><p>For password sign-in, save the address first, then check its certificate and sign in below.</p></div></div><div class="card-body">${revisionInputs(credential.revision)}<label>Controller HTTPS origin<input name="origin" type="url" required value="${escape(credential.metadata.origin ?? '')}"></label><p>Changing the saved address removes the previous token and certificate trust.</p></div><div class="card-foot"><span>Sends no credentials.</span><div class="actions"><button class="btn btn-secondary btn-sm">Save controller address</button></div></div></form>`
      }
      main += formStart(api + '/credential', 'PATCH', 'Save this credential, retaining unchanged stored secrets for the same identity and keeping native settings?', `data-save-tool="${tool.name}"`, 'card') +
        `<div class="card-head"><div><h2>Connection</h2><p>How Artium signs in to ${escape(product)}. Secrets are encrypted and never shown again.</p></div></div><div class="card-body">${revisionInputs(credential.revision)}${credentialFields(tool.name, editorProfile(tool.name, credentialProfiles[tool.name]), credential.metadata, credential.configured)}</div>
        <div class="card-foot"><label class="check"><input type="checkbox" data-save-and-test checked> Test after saving</label><div class="actions"><button class="btn btn-primary btn-sm">Save connection</button></div></div></form>`
      const aside = noteCard('What the test does', `<p>Runs one harmless read: <code>${escape(testGuide[tool.name])}</code>. It does not enable the tool or grant access.</p>`) +
        noteCard('Keeping secrets', '<p>Leave a stored secret blank to keep it. Changing authentication, mode, kind, tenant, client or URL needs new secrets.</p>') + (credential.configured ? changed(db, credential) : '')
      panel = `<div class="split has-aside"><div class="column">${main}</div><div class="column">${aside}</div></div>`
    } else if (tab === 'writes') {
      panel = writesPanel()
    } else if (tab === 'certificates') {
      panel = certificatesPanel()
    } else if (tab === 'access') {
      const rows = roles.map(role => `<div class="list-row">${icon('shield')}<div class="grow"><a href="/admin/roles/${escape(role.id)}">${escape(role.name)}</a><p>${role.members} ${role.members === 1 ? 'person' : 'people'}</p></div>${icon('chev')}</div>`).join('')
      panel = card(`Roles that grant ${product}`, 'Enabling alone gives nobody access. Assign these roles to people on People.',
        rows || '<p class="empty">No roles grant this tool. Open a role and select this tool to give its members access.</p>',
        { actions: '<a class="btn btn-secondary btn-sm" href="/admin/roles">Manage roles</a>' })
    } else {
      const writeState = `${awx ? 'operational writes' : 'writes'} ${writes.enabled ? 'on' : 'off'}${awx ? `; configuration changes ${configurationWrites ? 'on' : 'off'}` : ''}`
      panel = callout('warn', 'This replaces all native settings', 'Saving keeps the credential and clears cached health. Omitting write settings turns writes off. Use Write permissions for everyday changes.', '') +
        formStart(api, 'PATCH', 'Replace native settings while keeping the credential?', '', 'card') +
        `<div class="card-head"><div><h2>Native settings (JSON)</h2><p>Current: ${escape(writeState)}.</p></div></div><div class="card-body"><input type="hidden" name="expectedRevision" data-type="number" value="${tool.revision}"><p>${escape(settingsGuide[tool.name])}</p><label>Native settings (JSON object)<textarea name="nativeSettings" data-type="json" data-json-check rows="10" required spellcheck="false">${escape(JSON.stringify(tool.nativeSettings, null, 2))}</textarea></label><p class="note" data-json-status aria-live="polite"></p></div>
        <div class="card-foot"><span>{} clears settings.</span><div class="actions"><button class="btn btn-secondary btn-sm">Replace settings</button></div></div></form>`
    }
    // The filter form sits outside the write form; its controls join it through the form attribute.
    const filterForm = tab === 'writes' && writes.capable && writes.supportedOperations ? `<form id="ops-filter" method="get" action="/admin/tools/${tool.name}" hidden><input type="hidden" name="tab" value="writes"></form>` : ''
    return browserPage(reply, product, stateTemplates + failure + setup + result + navigation + panel + filterForm, current, undefined, { lead: toolIcon(tool.name, 'lg'), heading: product, meta, actions: `<div class="actions">${test}${enable}</div>`, helpTopic: 'Tools' })

    function writesPanel(): string {
      const blocked = noteCard('Always blocked', `<p>${escape(writes.blocked)}</p>`)
      if (!writes.capable) {
        return `<div class="split has-aside" data-write-access><div class="column">${card('Always read-only', `${product} cannot change data through Artium.`, `<div class="card-body"><p>${escape(writes.reason ?? 'No write actions.')}</p><p>No write actions are currently granted.</p></div>`)}</div><div class="column">${blocked}</div></div>`
      }
      const deletes = (tool.nativeSettings.writes as { allowDeletes?: boolean } | undefined)?.allowDeletes === true
      let switches = `<label class="switch-row"><input type="checkbox" class="switch" role="switch" name="enabled" data-type="boolean"${writes.enabled ? ' checked' : ''}><div><b>${awx ? 'Operational actions' : 'Allow writes'}</b><span>${writes.enabled ? 'On.' : 'Off.'} ${awx ? 'Launch, relaunch, cancel, sync, approvals and notification tests.' : `Agents can only read from ${escape(product)} while this is off.${writes.supportedOperations ? ' Turning it on allows only the operations you select below.' : ''}`}</span></div></label>`
      if (awx) switches += `<label class="switch-row"><input type="checkbox" class="switch" role="switch" name="allowConfigurationWrites" data-type="boolean"${configurationWrites ? ' checked' : ''}><div><b>Configuration changes</b><span>${configurationWrites ? 'On.' : 'Off.'} Create, edit and copy, plus additive associations, for inventories, hosts, groups, sources, templates, projects, schedules and workflows. Requires AWX resource permission.</span></div></label>`
      if (tool.name === 'beyondtrust-axi') switches += `<label class="switch-row"><input type="checkbox" class="switch" role="switch" name="allowDeletes" data-type="boolean"${deletes ? ' checked' : ''}><div><b>Allow deletes</b><span>${deletes ? 'On.' : 'Off.'} Deletes also need their exact operation selected below and both native confirmations.</span></div></label>`
      const grant = `<p class="note">${writes.enabled ? `Current grant: ${escape(writes.unlocks)}` : awx ? 'No operational actions are currently granted.' : 'No write actions are currently granted.'}</p>`
      const confirmation = 'Save write access and the selected operations for this tool? Other native settings stay unchanged. Turning writes on allows the actions described on this page; turning writes off blocks them. This change is audited.'
      const unsupported = writes.supportedOperations && writes.allowedOperations.some(operation => !writes.supportedOperations!.includes(operation))
        ? callout('err', 'Unsupported operations saved', 'The saved allow-list contains operations outside the pinned catalogue. Saving write permissions removes them.', '', { role: 'alert' }) : ''
      const save = '<div class="actions"><button class="btn btn-primary btn-sm">Save write permissions</button></div>'
      let form: string
      if (writes.supportedOperations) {
        form = formStart(api + '/write-access', 'PATCH', confirmation, '', 'column') + `<input type="hidden" name="expectedRevision" data-type="number" value="${tool.revision}">` +
          `<section class="card"><div class="card-body">${switches}</div></section>` + operationsCard(writes.supportedOperations, save) + '</form>'
      } else {
        form = formStart(api + '/write-access', 'PATCH', confirmation, '', 'card') + `<input type="hidden" name="expectedRevision" data-type="number" value="${tool.revision}">` +
          `<div class="card-body">${switches}</div><div class="card-foot"><span>Saving keeps the credential and other settings. Audited.</span>${save}</div></form>`
      }
      const warning = callout('warn', 'Read before enabling', escape(writes.unlocks), '')
      return `<div class="split has-aside" data-write-access><div class="column">${unsupported}${form}${grant}</div><div class="column">${blocked}${warning}</div></div>`
    }

    function operationsCard(supported: readonly string[], save: string): string {
      const selected = new Set(writes.allowedOperations)
      const groups = operationGroups(tool.name, supported, credential.metadata.kind)
      const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
      const show = query.show === 'selected' || query.show === 'deletes' ? query.show : 'all'
      const filtered = Boolean(search) || show !== 'all'
      const matches = (operation: Operation) => (!search || `${operation.label} ${operation.name}`.toLowerCase().includes(search))
        && (show === 'all' || (show === 'selected' ? selected.has(operation.name) : operation.risk.includes('delete')))
      const deleteCount = groups.reduce((total, group) => total + group.operations.filter(operation => operation.risk.includes('delete')).length, 0)
      const families = new Set(groups.map(group => group.family).filter(Boolean))
      const family = typeof credential.metadata.kind === 'string' && families.has(credential.metadata.kind) ? credential.metadata.kind : undefined
      const familyNote = family ? ` Operations for your ${escape(family.toUpperCase())} deployment are listed first.` : ''
      const filters = `<div class="filters" data-ops-filter><label class="search"><span class="sr-only">Filter operations</span>${icon('search')}<input type="search" name="q" form="ops-filter" value="${escape(query.q ?? '')}" placeholder="Filter operations, for example note or close"></label>
        <div class="seg" role="radiogroup" aria-label="Show">${(['all', 'selected', 'deletes'] as const).map(value => `<label><input class="sr-only" type="radio" name="show" value="${value}" form="ops-filter"${show === value ? ' checked' : ''}>${{ all: 'All', selected: 'Selected', deletes: `Deletes ${deleteCount}` }[value]}</label>`).join('')}</div>
        <button class="btn btn-secondary btn-sm" form="ops-filter" data-ops-apply>Apply</button></div>`
      const body = groups.map((group, index) => {
        const visible = group.operations.filter(matches)
        const picked = group.operations.filter(operation => selected.has(operation.name)).length
        const groupDeletes = group.operations.filter(operation => operation.risk.includes('delete')).length
        const other = group.family && group.family !== family && family
        return `<details class="ops-group" data-ops-group${filtered ? (visible.length ? ' open' : ' hidden') : picked || index === 0 ? ' open' : ''}><summary>${icon('chev')}<b>${escape(group.title)}</b><span class="muted">${group.family ? `${escape(group.family.toUpperCase())} · ` : ''}${group.operations.length} operation${group.operations.length === 1 ? '' : 's'}${picked ? ` · ${picked} selected` : ''}${other ? ' · not used by this deployment' : ''}</span>${groupDeletes ? `<span class="end"><span class="badge err">${groupDeletes} delete${groupDeletes === 1 ? '' : 's'}</span></span>` : ''}</summary>
          <div class="ops-body">${group.operations.map(operation => `<label class="op" data-op="${escape(`${operation.label} ${operation.name}`.toLowerCase())}"${operation.risk.includes('delete') ? ' data-delete' : ''}${matches(operation) ? '' : ' hidden'}><input type="checkbox" name="operations" data-type="array" value="${escape(operation.name)}"${selected.has(operation.name) ? ' checked' : ''}><span>${escape(operation.label)}</span>${operation.label === operation.name ? '' : `<code>${escape(operation.name)}</code>`}${operation.risk.includes('delete') ? '<span class="badge err">Delete</span>' : ''}${operation.risk.includes('bulk') ? '<span class="badge warn">Bulk</span>' : ''}</label>`).join('')}</div></details>`
      }).join('')
      return `<section class="card"><div class="card-head"><div><h2>Allowed operations</h2><p>${selected.size} of ${supported.length} selected. Unselected operations stay blocked. At least one is required to turn writes on.${familyNote}</p></div></div>
        <div class="card-body column">${filters}<div class="ops">${body}</div><p class="ops-empty" data-ops-empty${groups.some(group => group.operations.some(matches)) ? ' hidden' : ''}>No operations match this filter.</p></div>
        <div class="card-foot"><span>Saving keeps the credential and other settings. Audited.</span>${save}</div></section>`
    }

    function certificatesPanel(): string {
      if (!credential.configured && !(awx && credential.metadata.origin)) {
        return card('Trusted certificates', 'Trust applies only to this tool\'s saved endpoints.', `<p class="empty">Save a connection first. Certificates are inspected at the saved endpoints.</p>`)
      }
      const reference = db.prepare('SELECT id FROM credentials WHERE tool = ?').get(tool.name) as { id: string }
      const pins = credentialCertificates(db, reference.id)
      let endpoints: URL[] = []
      // An invalid saved credential must remain editable after a profile upgrade.
      try { endpoints = toolEndpoints(tool.name, { ...credential.metadata, ...tool.nativeSettings }) } catch { /* Save a valid endpoint before inspecting. */ }
      const soon = Date.now() + 30 * 86400000
      const expiring = pins.some(pin => Date.parse(pin.leaf.expiresAt) <= soon || Date.parse(pin.certificate.expiresAt) <= soon)
      const rows = pins.map(pin => `<tr><td class="mono">${escape(pin.endpoint)}</td><td data-label="Trust"><span class="badge">${pin.mode === 'pin' ? 'Pinned certificate' : 'Issuing CA'}</span></td>
        <td data-label="SHA-256"><p class="mono">${escape(pin.certificate.fingerprint)}</p>${pin.leaf.fingerprint !== pin.certificate.fingerprint ? `<p class="faint">Endpoint: <span class="mono">${escape(pin.leaf.fingerprint)}</span></p>` : ''}<p class="faint">${escape(pin.certificate.subject)}</p></td>
        <td data-label="Expires">${escape(pin.certificate.expiresAt)}${pin.leaf.expiresAt !== pin.certificate.expiresAt ? `<p class="faint">Endpoint: ${escape(pin.leaf.expiresAt)}</p>` : ''}</td>
        <td class="num">${formStart(api + '/certificates', 'DELETE', 'Remove this certificate from the tool credential’s trust?')}<input type="hidden" name="id" value="${escape(pin.id)}"><button class="btn btn-secondary btn-sm">Remove trust</button></form></td></tr>`).join('')
      const table = pins.length
        ? `<table class="tbl stack-sm"><caption class="sr-only">Trusted certificates</caption><thead><tr><th scope="col">Endpoint</th><th scope="col">Trust</th><th scope="col">Fingerprint (SHA-256)</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="empty">No certificates trusted for this credential. Hostname and expiry checks always apply.</p>'
      const offered = awx || tool.health.errorCode === 'UPSTREAM_TLS_FAILED' || pins.length > 0
      const inspect = endpoints.length ? formStart(api + '/certificates/inspect', 'POST', '', `class="row" data-inspect-certificate${offered ? '' : ' hidden'}`) +
        `${endpoints.length > 1 ? `<label class="sr-only" for="endpoint-index">Saved TLS endpoint</label><select id="endpoint-index" name="endpointIndex" data-type="number">${endpoints.map((endpoint, index) => `<option value="${index}">${escape(endpoint.host)}</option>`).join('')}</select>` : `<input type="hidden" name="endpointIndex" data-type="number" value="0"><span class="mono">${escape(endpoints[0]!.host)}</span>`}<button class="btn btn-secondary btn-sm">${icon('cert')}Inspect certificate</button></form>` : ''
      const foot = `<span>${offered ? 'Compare the fingerprint with the one the appliance shows before trusting.' : 'Inspection is offered after a connection test fails with a certificate error.'}</span><div class="actions">${inspect}</div>`
      const trustModes = tool.name === 'gh-axi'
        ? '<option value="ca">Trust the issuing CA</option></select></label><p>GitHub CLI requires an issuing CA. Leaf pinning is unavailable. Use the server trusted CA bundle for self-signed endpoints.</p>'
        : '<option value="ca">Trust the issuing CA (recommended, renewed certificates keep working)</option><option value="pin">Strict leaf pinning (re-trust after every rotation)</option></select></label><p>Self-signed endpoints keep a leaf pin. Hostname and date verification always apply.</p>'
      const dialog = `<dialog id="certificate-inspection" class="modal" aria-labelledby="certificate-inspection-title"><div class="modal-body"><h2 id="certificate-inspection-title">Trust this certificate for ${escape(product)}?</h2>
        ${callout('warn', 'Compare the fingerprint before trusting', 'Trust is only as safe as the network path when this certificate was fetched. A certificate presented during interception would be trusted too. Compare the full SHA-256 fingerprint with the one shown by the appliance.', '', { role: 'alert' })}
        <div data-certificate-details></div><p data-certificate-error role="alert"></p>${formStart(api + '/certificates/trust', 'POST', '', 'data-trust-certificate')}<input type="hidden" name="inspectionId"><label>Trust mode<select name="mode">${trustModes}<button class="btn btn-primary">Trust certificate</button></form></div>
        <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close-certificate>Close</button></div></dialog>`
      return `<section class="card" data-trusted-certificates><div class="card-head"><div><h2>Trusted certificates</h2><p>Trust applies only to this tool's saved credential. CA trust allows leaf renewal; strict pinning needs re-trust after rotation.</p></div></div>
        ${expiring ? `<div class="card-body">${callout('warn', 'A trusted certificate expires soon', 'A trusted certificate has expired or expires within 30 days. Re-inspect this endpoint for rotation.', '', { role: 'alert' })}</div>` : ''}${table}<div class="card-foot">${foot}</div></section>${dialog}`
    }
  })
}
