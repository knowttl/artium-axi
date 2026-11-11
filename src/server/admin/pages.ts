import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import { adminToolRoutes, nativeSettingsSchemas, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { userGrantPolicies } from '../../shared/user-grants.js'
import operationCatalogue from '../../../tools/inventories/write-operations.json' with { type: 'json' }
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { actionForm, adminRead, revision, timestamp } from './forms.js'
import { editorProfile } from './credential-form.js'
import { instancesPanel, readInstanceRows, registerInstancePages } from './instances.js'
import { rawApiModeWords, setupBadge, toolIcon, toolProducts, toolSetupState, writes as writesState } from './design/status.js'
import { callout, card, checkOption, field, icon, noteCard, sheet, sheetLink, steps, tabs } from './design/ui.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import type { ToolName } from '../store/credential-store.js'
import type { TrustedCertificate } from '../trusted-ca.js'
import { hasSshConfiguration } from '../store/ssh-hosts.js'

const settingsGuide = {
  'ssh-axi': 'Writes default off. Confirmed execution additionally requires a writable host and current caller grants; sudo needs its distinct approved account and credential. Receipts prevent replay and execution show recovers a result. Reusable connections belong to one user and session. Audit reads and metadata exports are available at /admin/ssh/audit.',
  'technitium-axi': 'Host Write permission for the exact operation, native writes.allowWrites: true and the exact operation in native writes.operations are required. The host and native gates are independent and default off. Native previews require both grants. Use private input files and exact confirmation. Protected results expire after five minutes and require the same user, current tool grant and credential revision.',
  'shodan-axi': 'Optional sessions, scans, writes and exports each have independent ceilings and are off until saved. Pick people and exact operations on the Access tab once the ceilings of a policy are saved here. Scans need OP-009 and collection also needs a banner stream session grant for OP-046. Writes use confirmed-write operation IDs; exports use CLI-005 and CLI-020. Scans, writes and exports require an owner session, a writable instance and a preview with single-use confirmation. Use {} to clear settings.',
  'gitea-axi': 'Writes default off. Use Allow writes and select exact native operation IDs, then require caller preview and confirmation. Secret values use protected --input; opaque attachments use --file or --attach and managed download grants. Local workflows remain unavailable.',
  'kubernetes-axi': 'Writes default off. Use {"allowWrites": true} for native prepare, offline preview, exact-digest confirmation and explicit server-dry-run. Bulk deletion additionally requires {"collectionDelete": true}. Saving write settings invalidates earlier prepared requests. Caller-owned workspaces support file inputs. Bounded watch, logs, exec, attach, apply, create, cp and port-forward sessions require explicit per-user grants; no sessions are granted by default. Mutating sessions additionally require Allow writes and native exact-digest confirmation; watch and logs remain reads. Port forwarding uses authenticated tunnels with loopback-only client listeners. Service-account token issuance additionally requires {"acquireCredential": true}; tokens are delivered once through credential --credential-fd to a private pipe. Interactive/editor/helper execution remains unavailable. Pick people and session kinds on the Access tab.',
  'unifi-axi': 'writes.allowWrites defaults off. Select exact vendor operation IDs in writes.operations, including the required management/action variant grants. Writes preview first; execution requires --execute, the matching --confirm and a stable --request-id. Use write show/reconcile after uncertainty; never resend a claimed request.',
  'proxmox-axi': 'Set exact native grants in writes.operations. Write permissions controls the independent hostWrites gate, off by default; both must permit every operation and batch child. Preview first, then exact --confirm. Protected results, memory authentication and streams remain pending in separate capability slices.',
  'gh-axi': 'Writes default off. Select exact collaboration or repository operations with writes: { allowWrites: true, operations: ["issue comment"] }. Preview each write, then repeat with the returned --confirm. Deletes, secret set, merge --admin and API non-GET stay blocked.',
  'hybrid-axi': 'Optional writes: {"allowWrites": true, "operations": ["submitUrl"]}. Submissions, YARA mutations, consuming matches and four reviewed archive downloads are off by default and selected independently; native preview, execute, exact confirmation and journal gates remain required. Use artium-axi download for CLI verified saving after artifact-mount and operator prerequisites pass. Use {} to turn writes off.',
  'tenable-axi': 'Optional writes: {"allowWrites": true, "operations": ["tags-create-tag-category"]}. Writes and export jobs require native preview, execute and exact confirmation. Use {} to turn writes off.',
  'beyondtrust-axi': 'Writes require selected exact operations, native preview, execute and exact confirmation. Deletes additionally require Allow deletes and exact confirm-delete. Downloads use artium-axi download.',
  'checkpoint-axi': 'Optional writes: {"allowWrites": true, "operations": ["email.quarantine"]}. Exact event.action.<name> entries can be added here using an available event action name. Writes require native preview, execute and exact confirmation. Downloads require separately selected operations and artium-axi download with host-owned confirmation. Ambiguous deletes remain blocked. Use {} to turn writes off.',
  'awx-axi': 'Optional allowWrites (boolean), off by default, is the single tenant switch for all writes, including configuration, deletes, removals and security administration. Preview and execution require write access; execution requires --confirm and AWX resource permission. Secret and structured inputs, SCM URLs, files/stdin and bulk host operations are not yet supported: requires secure input. Credential references are supported. Legacy allowConfigurationWrites is ignored. Use {} to turn writes off.',
  'ado-axi': 'Optional allowWrites (boolean), off by default. Permits reviewed work-item delete/destroy, link removal, pipeline, repository, policy, PR and ref writes. Release creation may deploy. Raw API writes require server-listed paths. Artium classifies and journals every command. Use {} to turn writes off.',
  'ldap-axi': 'LDAP is read-only and has no editable native settings. Use {}.',
  'mg-axi': 'Optional enabledPacks: ["entra", "security"] enables read-only hunting; default ["entra"]. Optional preview (boolean) and writes: {"allowWrites": true, "operations": ["mg.entra.group.member.add"]}. Use {} to clear settings.',
  'falcon-axi': 'Select exact search start/stop, host usb, identity activity, malquery search or rtr run operations in the audited write switch, all off by default. Search and MalQuery dispatch immediately. RTR also requires rtr: {"enabled": true, "commands": ["ps"]}, native preview, --execute and exact --confirm. History reads remain available while execution is off.',
  'vectra-axi': 'Optional writes: {"allowWrites": true, "operations": ["notes.set"]}. Use {} to clear settings.',
  'az-axi': 'Optional subscriptions (array of IDs), managementGroup (ID), workspaces (name-to-UUID object), description (text), allowWrites (boolean), tlsDestinations: {"storageAccounts": ["synthetic"], "keyVaults": ["synthetic"], "registries": ["synthetic"]} (service names for certificate inspection, without domains). Use {} to clear settings.',
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

const tabNames = ['instances', 'writes', 'raw-api', 'access', 'advanced'] as const
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
    const instances = await Promise.all(tools.map(tool => readInstanceRows(app, request, db, tool)))
    const roles = roleCounts()
    const query = request.query as { show?: string, q?: string }
    const show = query.show === 'enabled' || query.show === 'attention' ? query.show : 'all'
    const search = typeof query.q === 'string' ? query.q.trim() : ''
    const rows = tools.map((tool, index) => {
      const listed = instances[index]!
      const configured = tool.name === 'ssh-axi' ? hasSshConfiguration(db) : listed.some(row => row.instance!.configured)
      return { tool, count: listed.length, failing: listed.filter(row => row.instance?.enabled && toolSetupState({ enabled: true, configured: row.instance.configured, health: row.instance.health }) === 'failing').length,
        state: tool.name === 'ssh-axi' && configured ? 'hostChecks' as const : toolSetupState({ enabled: tool.enabled, configured, health: tool.health }) }
    })
    const attention = (row: typeof rows[number]) => row.state === 'failing' || row.state === 'needsCredential'
    const counts = { all: rows.length, enabled: rows.filter(row => row.tool.enabled).length, attention: rows.filter(attention).length }
    const visible = rows.filter(row => (show === 'all' || (show === 'enabled' ? row.tool.enabled : attention(row)))
      && (!search || `${toolProducts[row.tool.name].name} ${row.tool.name}`.toLowerCase().includes(search.toLowerCase())))
    const link = (value: string) => '/admin/tools' + (value === 'all' ? '' : '?show=' + value) + (search ? `${value === 'all' ? '?' : '&'}q=${encodeURIComponent(search)}` : '')
    const filters = `<form class="filters" method="get" action="/admin/tools" data-filters><div class="seg" role="group" aria-label="Show">${(['all', 'enabled', 'attention'] as const).map(value =>
      `<a href="${escape(link(value))}"${show === value ? ' aria-current="page"' : ''}>${{ all: 'All', enabled: 'Enabled', attention: 'Needs attention' }[value]} ${counts[value]}</a>`).join('')}</div>${show === 'all' ? '' : `<input type="hidden" name="show" value="${show}">`}<label class="search narrow"><span class="sr-only">Filter tools</span>${icon('search')}<input type="search" name="q" value="${escape(search)}" placeholder="Filter tools"></label></form>`
    const body = visible.map(({ tool, state, count, failing }) => `<tr><td><div class="cell-main">${toolIcon(tool.name)}<div><a href="/admin/tools/${tool.name}">${escape(toolProducts[tool.name].name)}</a><span>${escape(tool.name)} · ${escape(tool.version)}</span></div></div></td>
      <td data-label="Instances" class="muted">${count} ${tool.name === 'ssh-axi' ? 'host' : 'instance'}${count === 1 ? '' : 's'}</td>
      <td data-label="State">${setupBadge(state)}${failing && count > 1 ? `<p class="hint">${failing} of ${count} failing</p>` : ''}</td><td data-label="Enabled" class="muted"><span class="row"><span class="switch${tool.enabled ? ' on' : ''}" aria-hidden="true"></span>${tool.enabled ? 'On' : 'Off'}</span></td>
      <td data-label="Writes">${writesState({ capable: tool.writeAccess.capable, enabled: !tool.readOnly, operations: tool.writeAccess.supportedOperations ? tool.writeAccess.allowedOperations.length : null }, 'status')}</td>
      <td data-label="Roles" class="muted">${roles.get(tool.name) ?? 0}</td><td data-label="Last checked" class="num faint">${timestamp(tool.health.checkedAt, 'Never')}</td></tr>`).join('')
    const table = `<section class="card"><table class="tbl stack-sm"><caption class="sr-only">Tools</caption><thead><tr><th scope="col">Tool</th><th scope="col">Instances</th><th scope="col">State</th><th scope="col">Enabled</th><th scope="col">Writes</th><th scope="col">Roles</th><th scope="col" class="num">Last checked</th></tr></thead><tbody>${body}</tbody></table>${visible.length ? '' : '<p class="empty">No tools match these filters. <a href="/admin/tools">Show all tools</a>.</p>'}</section>`
    const trust = trustedCertificates.length
      ? `<table class="tbl stack-sm"><caption class="sr-only">Server-wide trusted CA bundle</caption><thead><tr><th scope="col">Subject</th><th scope="col">Issuer</th><th scope="col">Expires (UTC)</th><th scope="col">SHA-256 fingerprint</th></tr></thead><tbody>${trustedCertificates.map(certificate => `<tr><td>${escape(certificate.subject)}</td><td data-label="Issuer">${escape(certificate.issuer)}</td><td data-label="Expires">${escape(certificate.expiresAt)}</td><td data-label="SHA-256"><code>${escape(certificate.fingerprint)}</code></td></tr>`).join('')}</tbody></table>`
      : ''
    const footer = `<section class="card"><div class="list-row">${icon('cert')}<div class="grow"><strong>Server-wide trusted CA bundle</strong><p>${trustedCertificates.length ? `${trustedCertificates.length} certificate${trustedCertificates.length === 1 ? '' : 's'}.` : 'None configured.'} An operator sets ARTIUM_AXI_EXTRA_CA_FILE and restarts the server to change it. Per-instance trust is on each instance's page.</p></div><span class="badge">Read-only</span></div>${trust}</section>`
    return browserPage(reply, 'Tools', filters + table + footer, current, 'Each tool starts off. Connect it, test it, enable it, then grant it to a role.')
  })
  app.get('/admin/tools/:tool', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const parsed = toolSchema.safeParse((request.params as { tool: string }).tool)
    if (!parsed.success) throw new ArtiumError('NOT_FOUND')
    const query = request.query as { tab?: string, q?: string, show?: string, sheet?: string }
    const api = '/v1/admin/tools/' + parsed.data
    const tool = await adminRead(app, request, api, adminToolRoutes.get.response)
    const rawCapable = tool.rawApi.modes.length > 0
    const tab: Tab = tabNames.find(name => name === query.tab && (rawCapable || name !== 'raw-api')) ?? 'instances'
    const instanceRows = await readInstanceRows(app, request, db, tool)
    const configured = tool.name === 'ssh-axi' ? hasSshConfiguration(db) : instanceRows.some(row => row.instance!.configured)
    const csrf = reply.generateCsrf()
    const product = toolProducts[tool.name].name
    // Forms keep today's API, CSRF token, revision and confirmation; buttons sit wherever the card needs them.
    const formStart = (action: string, method: string, confirmation: string, attributes = '', className = '') =>
      `<form${className ? ` class="${className}"` : ''} data-api data-method="${method}" data-confirm="${escape(confirmation)}"${attributes ? ' ' + attributes : ''} action="${escape(action)}" method="post"><input type="hidden" name="_csrf" value="${escape(csrf)}">`
    const roles = db.prepare(`SELECT roles.id, roles.name, roles.revision, role_tools.all_instances AS allInstances,
      (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE user_roles.role_id = roles.id) AS members
      FROM roles JOIN role_tools ON role_tools.role_id = roles.id WHERE tool = ? ORDER BY roles.name`).all(tool.name) as { id: string, name: string, revision: number, allInstances: number, members: number }[]
    const state = tool.name === 'ssh-axi' && configured ? 'hostChecks' : toolSetupState({ enabled: tool.enabled, configured, health: tool.health })
    const tested = state === 'healthy'
    const failing = state === 'failing'
    const writes = tool.writeAccess
    const awx = tool.name === 'awx-axi'

    const enable = formStart(api, 'PATCH', tool.enabled ? 'Disable this tool and block new calls?' : 'Enable this tool for people whose roles grant access?') +
      `<input type="hidden" name="expectedRevision" data-type="number" value="${tool.revision}"><input type="hidden" name="enabled" data-type="boolean" value="${!tool.enabled}"><button class="toggle" role="switch" aria-checked="${tool.enabled}"><span class="switch${tool.enabled ? ' on' : ''}" aria-hidden="true"></span>Enabled</button></form>`
    const meta = `<span class="mono">${escape(tool.name)} · ${escape(tool.version)}</span><span>${setupBadge(state)}</span>${writesState({ capable: writes.capable, enabled: !tool.readOnly, operations: writes.supportedOperations ? writes.allowedOperations.length : null }, 'badge')}<span>Checked ${timestamp(tool.health.checkedAt, 'never')}</span>`
    const grants = roles.map(role => role.name).join(', ')
    const configuredAt = Math.max(0, ...instanceRows.map(row => row.instance?.updatedAt ?? 0))
    const setup = steps([
      { title: tool.name === 'ssh-axi' ? 'Ordinary host binding configured' : 'Credential saved', detail: tool.name === 'ssh-axi' ? configured ? 'Enabled host with an ordinary account binding' : 'No enabled host with an ordinary account binding' : configured ? `${instanceRows.length} instance${instanceRows.length === 1 ? '' : 's'}, last saved ${timestamp(configuredAt)}` : 'Not saved yet', state: configured ? 'done' : 'todo' },
      ...(tool.name === 'ssh-axi' ? [] : [{ title: 'Test passes', detail: tested ? 'Passed' : failing ? `Failing: ${escape(tool.health.errorCode ?? 'error')}` : 'Not run', state: tested ? 'done' as const : failing ? 'fail' as const : 'todo' as const }]),
      { title: 'Enabled', detail: tool.enabled ? 'On' : 'Off', state: tool.enabled ? 'done' : 'todo' },
      { title: 'Granted to a role', detail: roles.length ? escape(grants) : 'No roles yet', state: roles.length ? 'done' : 'todo' },
    ])
    const writesNote = !writes.capable ? 'Read-only' : tool.readOnly ? 'Off' : writes.supportedOperations ? `${writes.allowedOperations.length} on` : 'On'
    const navigation = tabs(`/admin/tools/${tool.name}`, tab, [
      { id: 'instances', label: 'Instances', icon: 'globe', note: String(instanceRows.length) },
      { id: 'writes', label: 'Write permissions', icon: 'zap', note: writesNote },
      ...(rawCapable ? [{ id: 'raw-api', label: 'Raw API', icon: 'terminal' as const, note: rawApiModeWords[tool.rawApi.mode].label }] : []),
      { id: 'access', label: 'Access', icon: 'users', note: String(roles.length) },
      { id: 'advanced', label: 'Advanced', icon: 'sliders' },
    ], 'Tool sections')
    const result = '<p class="note" data-test-result role="status"></p>'

    let panel: string
    if (tab === 'instances') {
      panel = instancesPanel({ tool, csrf, rows: instanceRows, profile: editorProfile(tool.name, credentialProfiles[tool.name]), sheet: query.sheet })
    } else if (tab === 'writes') {
      panel = writesPanel()
    } else if (tab === 'raw-api') {
      const options = tool.rawApi.modes.map(mode => `<label class="option"><input type="radio" name="mode" value="${mode}"${mode === tool.rawApi.mode ? ' checked' : ''}><div><strong>${rawApiModeWords[mode].label}</strong><span>${rawApiModeWords[mode].detail}</span></div></label>`).join('')
      const form = formStart(api + '/raw-api', 'PATCH', `Change the Raw API mode for ${product}? It applies to every caller on the next call. This change is audited.`, '', 'card') +
        `<div class="card-head"><div><h2>Raw API mode</h2><p>The most ${escape(product)} raw API calls may do for any caller.</p></div></div>
        <div class="card-body"><fieldset class="options"><legend class="sr-only">Raw API mode</legend>${options}</fieldset>${revision(tool.revision)}</div>
        <div class="card-foot"><span>Saving keeps the credential and other settings. Audited.</span><div class="actions"><button class="btn btn-primary btn-sm">Save Raw API mode</button></div></div></form>`
      panel = `<div class="split has-aside"><div class="column">${form}</div><div class="column">${noteCard('Two settings are required',
        `<p>A raw call needs this mode and the Raw API access switch on a role that grants ${escape(product)} to the caller. Set the switch on the role’s page.</p>`)}</div></div>`
    } else if (tab === 'access') {
      const instances = db.prepare('SELECT id, name, description FROM credentials WHERE tool = ? ORDER BY name').all(tool.name) as { id: string, name: string, description: string }[]
      const granted = db.prepare('SELECT credential_id AS id FROM role_tool_instances WHERE role_id = ? AND tool = ?')
      const accessHref = (sheetName?: string) => `/admin/tools/${tool.name}?tab=access${sheetName ? '&sheet=' + encodeURIComponent(sheetName) : ''}`
      const sheets: string[] = []
      const rows = roles.map(role => {
        const selected = new Set((granted.all(role.id, tool.name) as { id: string }[]).map(row => row.id))
        const scope = role.allInstances ? 'All instances' : `Selected instances: ${instances.filter(instance => selected.has(instance.id)).map(instance => instance.name).join(', ') || 'None'}`
        const name = 'instances-' + role.id
        sheets.push(sheet({ name, open: query.sheet === name, closeHref: accessHref(), title: `Instance access for ${role.name}`,
          description: `Choose which ${product} instances members of this role can use.`,
          body: `<fieldset class="options"><legend class="sr-only">Instance access</legend>
            <label class="option"><input type="radio" name="scope" value="all"${role.allInstances ? ' checked' : ''}><div><strong>All instances</strong><span>Includes instances added later.</span></div></label>
            <label class="option"><input type="radio" name="scope" value="selected"${role.allInstances ? '' : ' checked'}><div><strong>Selected instances</strong><span>Only the instances checked below. Any other instance reports that it does not exist.</span></div></label></fieldset>
            <fieldset class="options"><legend>Instances</legend><input type="hidden" name="instances" disabled data-type="array">${instances.map(instance =>
            checkOption(`<input type="checkbox" name="instances" value="${escape(instance.name)}"${selected.has(instance.id) ? ' checked' : ''}>`, instance.name, instance.description)).join('')}</fieldset>${revision(role.revision)}`,
          submit: '<button class="btn btn-primary">Save access</button>',
          wrap: inner => actionForm(csrf, `/v1/admin/roles/${encodeURIComponent(role.id)}/tools/${tool.name}/instances`, 'PUT', inner,
            { consequence: `Replace ${role.name}’s ${product} instance access? Changes apply to every member on the next call.`, title: 'Save instance access', action: 'Save access' }) }))
        return `<div class="list-row">${icon('shield')}<div class="grow"><a href="/admin/roles/${escape(role.id)}">${escape(role.name)}</a><p>${role.members} ${role.members === 1 ? 'person' : 'people'} · ${escape(scope)}</p></div>${sheetLink(name, accessHref(name), 'Instances', 'btn btn-ghost btn-sm')}${icon('chev')}</div>`
      }).join('')
      panel = card(`Roles that grant ${product}`, 'Enabling alone gives nobody access. Assign these roles to people on People.',
        rows || '<p class="empty">No roles grant this tool. Open a role and select this tool to give its members access.</p>',
        { actions: '<a class="btn btn-secondary btn-sm" href="/admin/roles">Manage roles</a>' }) + sheets.join('') + userGrantCards()
    } else {
      const writeState = `writes ${writes.enabled ? 'on' : 'off'}`
      const policies = userGrantPolicies[tool.name] ?? {}
      const settings = { ...tool.nativeSettings }
      for (const key of Object.keys(policies)) {
        if (settings[key] !== undefined) {
          const { grants: _, ...rest } = settings[key] as Record<string, unknown>
          settings[key] = rest
        }
      }
      const grantNote = Object.keys(policies).length ? ' Per-person grants are managed with the picker on the Access tab. Omitting a policy turns it off and removes its grants.' : ''
      panel = callout('warn', 'This replaces all native settings', 'Saving keeps the credential and clears cached health. Omitting write settings turns writes off. Use Write permissions for everyday changes.' + grantNote, '') +
        formStart(api, 'PATCH', 'Replace native settings while keeping the credential?', '', 'card') +
        `<div class="card-head"><div><h2>Native settings (JSON)</h2><p>Current: ${escape(writeState)}.</p></div></div><div class="card-body"><input type="hidden" name="expectedRevision" data-type="number" value="${tool.revision}"><p>${escape(settingsGuide[tool.name])}</p>${grantNote ? '<p class="note">Per-person grants are managed with the picker on the Access tab.</p>' : ''}<label>Native settings (JSON object)<textarea name="nativeSettings" data-type="json" data-json-check rows="10" required spellcheck="false">${escape(JSON.stringify(settings, null, 2))}</textarea></label><p class="note" data-json-status aria-live="polite"></p></div>
        <div class="card-foot"><span>{} clears settings.</span><div class="actions"><button class="btn btn-secondary btn-sm">Replace settings</button></div></div></form>`
    }
    // The filter form sits outside the write form; its controls join it through the form attribute.
    const filterForm = tab === 'writes' && writes.capable && writes.supportedOperations ? `<form id="ops-filter" method="get" action="/admin/tools/${tool.name}" hidden><input type="hidden" name="tab" value="writes"></form>` : ''
    return browserPage(reply, product, setup + result + navigation + panel + filterForm, current, undefined, { lead: toolIcon(tool.name, 'lg'), heading: product, meta, actions: `<div class="actions">${enable}</div>`, helpTopic: 'Tools' })

    function userGrantCards(): string {
      const people = db.prepare('SELECT id, username, display_name AS displayName FROM users WHERE archived_at IS NULL AND disabled = 0 ORDER BY username').all() as { id: string, username: string, displayName: string }[]
      const accessHref = (sheetName?: string) => `/admin/tools/${tool.name}?tab=access${sheetName ? '&sheet=' + encodeURIComponent(sheetName) : ''}`
      return Object.entries(userGrantPolicies[tool.name] ?? {}).map(([key, policy]) => {
        const saved = tool.nativeSettings[key] as { grants: Record<string, string[]> } | undefined
        const creatable = saved !== undefined || nativeSettingsSchemas[tool.name].safeParse({ ...tool.nativeSettings, [key]: { grants: {} } }).success
        const catalogue = new Map(policy.operations.map(operation => [operation.id, operation.label]))
        const grants = Object.entries(saved?.grants ?? {}).sort(([left], [right]) => left.localeCompare(right))
        const granted = new Set(grants.map(([id]) => id))
        const grantSheet = (name: string, title: string, userId: string | undefined, selected: readonly string[]) => {
          const outside = [...new Set(selected)].filter(operation => !catalogue.has(operation))
          const who = userId === undefined
            ? field(`${name}-user`, 'Person', attributes => `<select ${attributes} name="userId" required>${people.filter(person => !granted.has(person.id)).map(person =>
              `<option value="${escape(person.id)}">${escape(person.username)}${person.displayName === person.username ? '' : ` (${escape(person.displayName)})`}</option>`).join('')}</select>`)
            : `<input type="hidden" name="userId" value="${escape(userId)}">`
          return sheet({ name, open: query.sheet === name, closeHref: accessHref(), title, description: policy.description,
            body: `${who}<fieldset class="options"><legend>Operations</legend><input type="hidden" name="operations" disabled data-type="array">${[...policy.operations, ...outside.map(id => ({ id, label: id }))].map(operation =>
              checkOption(`<input type="checkbox" name="operations" value="${escape(operation.id)}"${selected.includes(operation.id) ? ' checked' : ''}>`, operation.label, operation.id)).join('')}</fieldset>
              <input type="hidden" name="policy" value="${escape(key)}">${revision(tool.revision)}`,
            submit: '<button class="btn btn-primary">Save grants</button>',
            wrap: inner => actionForm(csrf, `${api}/user-grants`, 'PUT', inner,
              { consequence: `Replace this person’s ${policy.title.toLowerCase()} grants for ${product}? Clearing every operation removes the person. The change applies on their next call and is audited.`,
                title: 'Save grants', action: 'Save grants' }) })
        }
        const rows = grants.map(([id, operations]) => {
          const person = people.find(candidate => candidate.id === id)
          const name = `grants-${key}-${id}`
          const labels = operations.map(operation => { const label = catalogue.get(operation); return label && label !== operation ? `${label} (${operation})` : operation }).join(', ') || 'None'
          return { sheet: grantSheet(name, `${policy.title} for ${person?.username ?? id}`, id, operations),
            row: `<div class="list-row">${icon('users')}<div class="grow"><strong>${escape(person?.username ?? id)}</strong>${person ? '' : ' <span class="badge warn">Not an active person</span>'}<p>${escape(labels)}</p></div>${sheetLink(name, accessHref(name), 'Edit', 'btn btn-ghost btn-sm')}</div>` }
        })
        const addName = `grants-${key}-add`
        const add = creatable && people.some(person => !granted.has(person.id))
        return card(`${policy.title} by person`, policy.description,
          rows.map(row => row.row).join('') || '<p class="empty">No one is granted. Nobody can use this until you grant a person.</p>',
          { actions: add ? sheetLink(addName, accessHref(addName), 'Grant a person', 'btn btn-secondary btn-sm') : undefined,
            foot: creatable ? undefined : 'Set the ceilings for this policy in Advanced native settings before granting people here.' })
          + rows.map(row => row.sheet).join('') + (add ? grantSheet(addName, `Grant ${policy.title.toLowerCase()}`, undefined, []) : '')
      }).join('')
    }

    function writesPanel(): string {
      const blocked = noteCard(awx ? 'Capability boundary' : 'Always blocked', `<p>${escape(writes.blocked)}</p>`)
      if (!writes.capable) {
        return `<div class="split has-aside" data-write-access><div class="column">${card('Always read-only', `${product} cannot change data through Artium.`, `<div class="card-body"><p>${escape(writes.reason ?? 'No write actions.')}</p><p>No write actions are currently granted.</p></div>`)}</div><div class="column">${blocked}</div></div>`
      }
      const deletes = (tool.nativeSettings.writes as { allowDeletes?: boolean } | undefined)?.allowDeletes === true
      let switches = `<label class="switch-row"><input type="checkbox" class="switch" role="switch" name="enabled" data-type="boolean"${writes.enabled ? ' checked' : ''}><div><b>Allow writes</b><span>${writes.enabled ? 'On.' : 'Off.'} ${awx ? 'All writes for this tenant, including configuration, deletes, removals and security administration. Secret and structured inputs require the future secure input channel. Reads and help remain available while off.' : `Agents can only read from ${escape(product)} while this is off.${writes.supportedOperations ? ' Turning it on allows only the operations you select below.' : ''}`}</span></div></label>`
      if (tool.name === 'beyondtrust-axi') switches += `<label class="switch-row"><input type="checkbox" class="switch" role="switch" name="allowDeletes" data-type="boolean"${deletes ? ' checked' : ''}><div><b>Allow deletes</b><span>${deletes ? 'On.' : 'Off.'} Deletes also need their exact operation selected below and both native confirmations.</span></div></label>`
      const grant = `<p class="note">${writes.enabled ? `Current grant: ${escape(writes.unlocks)}` : 'No write actions are currently granted.'}</p>`
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
      const kind = instanceRows[0]?.instance?.metadata.kind
      const groups = operationGroups(tool.name, supported, kind)
      const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
      const show = query.show === 'selected' || query.show === 'deletes' ? query.show : 'all'
      const filtered = Boolean(search) || show !== 'all'
      const matches = (operation: Operation) => (!search || `${operation.label} ${operation.name}`.toLowerCase().includes(search))
        && (show === 'all' || (show === 'selected' ? selected.has(operation.name) : operation.risk.includes('delete')))
      const deleteCount = groups.reduce((total, group) => total + group.operations.filter(operation => operation.risk.includes('delete')).length, 0)
      const families = new Set(groups.map(group => group.family).filter(Boolean))
      const family = typeof kind === 'string' && families.has(kind) ? kind : undefined
      const familyNote = family ? ` Operations for your ${escape(family.toUpperCase())} deployment are listed first.` : ''
      const selectControls = (scope: string) => `<div class="ops-actions" data-ops-actions hidden><button type="button" class="btn btn-ghost btn-sm" data-ops-select="all" aria-label="Select all ${scope}">Select all</button><button type="button" class="btn btn-ghost btn-sm" data-ops-select="none" aria-label="Clear all ${scope}">Clear all</button></div>`
      const filters = `<div class="filters" data-ops-filter><label class="search"><span class="sr-only">Filter operations</span>${icon('search')}<input type="search" name="q" form="ops-filter" value="${escape(query.q ?? '')}" placeholder="Filter operations, for example note or close"></label>
        <div class="seg" role="radiogroup" aria-label="Show">${(['all', 'selected', 'deletes'] as const).map(value => `<label><input class="sr-only" type="radio" name="show" value="${value}" form="ops-filter"${show === value ? ' checked' : ''}>${{ all: 'All', selected: 'Selected', deletes: `Deletes ${deleteCount}` }[value]}</label>`).join('')}</div>
        <button class="btn btn-secondary btn-sm" form="ops-filter" data-ops-apply>Apply</button></div>`
      const body = groups.map((group, index) => {
        const visible = group.operations.filter(matches)
        const picked = group.operations.filter(operation => selected.has(operation.name)).length
        const groupDeletes = group.operations.filter(operation => operation.risk.includes('delete')).length
        const other = group.family && group.family !== family && family
        return `<details class="ops-group" data-ops-group${filtered ? (visible.length ? ' open' : ' hidden') : picked || index === 0 ? ' open' : ''}><summary>${icon('chev')}<b>${escape(group.title)}</b><span class="muted">${group.family ? `${escape(group.family.toUpperCase())} · ` : ''}${group.operations.length} operation${group.operations.length === 1 ? '' : 's'}<span data-ops-picked>${picked ? ` · ${picked} selected` : ''}</span>${other ? ' · not used by this deployment' : ''}</span>${groupDeletes ? `<span class="end"><span class="badge err">${groupDeletes} delete${groupDeletes === 1 ? '' : 's'}</span></span>` : ''}</summary>
          <div class="ops-body">${selectControls(`operations in ${escape(group.title)}`)}${group.operations.map(operation => `<label class="op" data-op="${escape(`${operation.label} ${operation.name}`.toLowerCase())}"${operation.risk.includes('delete') ? ' data-delete' : ''}${matches(operation) ? '' : ' hidden'}><input type="checkbox" name="operations" data-type="array" value="${escape(operation.name)}"${selected.has(operation.name) ? ' checked' : ''}><span>${escape(operation.label)}</span>${operation.label === operation.name ? '' : `<code>${escape(operation.name)}</code>`}${operation.risk.includes('delete') ? '<span class="badge err">Delete</span>' : ''}${operation.risk.includes('bulk') ? '<span class="badge warn">Bulk</span>' : ''}</label>`).join('')}</div></details>`
      }).join('')
      return `<section class="card"><div class="card-head"><div><h2>Allowed operations</h2><p><span data-ops-selected>${selected.size}</span> of ${supported.length} selected. Unselected operations stay blocked. At least one is required to turn writes on.${familyNote}</p></div></div>
        <div class="card-body column">${filters}${selectControls('shown operations')}<div class="ops">${body}</div><p class="ops-empty" data-ops-empty${groups.some(group => group.operations.some(matches)) ? ' hidden' : ''}>No operations match this filter.</p></div>
        <div class="card-foot"><span>Saving keeps the credential and other settings. Audited.</span>${save}</div></section>`
    }
  })
  registerInstancePages(app, db, credentialProfiles)
}
