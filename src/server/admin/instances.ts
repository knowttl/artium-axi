import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminInstanceParamsSchema, adminInstanceRoutes, adminInstanceSchema, adminToolRoutes, adminToolSchema, githubDeviceRoutes } from '../../shared/api.js'
import { ArtiumError, errors } from '../../shared/errors.js'
import type { Diagnostic } from '../../shared/errors.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { credentialCertificates } from '../store/trusted-certificates.js'
import type { ToolName } from '../store/credential-store.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { credentialTlsSettings } from '../credential-tls-settings.js'
import { credentialFields, editorProfile } from './credential-form.js'
import { setupBadge, status, toolIcon, toolProducts, toolSetupState, writes } from './design/status.js'
import { callout, card, field, icon, noteCard, sheet, sheetLink, steps } from './design/ui.js'
import { escape } from './escape.js'
import { actionForm, adminRead, changed, revision, timestamp, type Confirmation } from './forms.js'

const testGuide = {
  'ssh-axi': 'doctor <granted-host> through the signed-in CLI; no shared tenant credential test is available',
  'technitium-axi': 'Technitium user session get (authenticated read)',
  'shodan-axi': 'Shodan API information (authenticated read)',
  'gitea-axi': 'Gitea doctor',
  'kubernetes-axi': 'Kubernetes pod read',
  'unifi-axi': 'UniFi info',
  'proxmox-axi': 'Proxmox get /version',
  'gh-axi': 'GitHub api /rate_limit',
  'hybrid-axi': 'Hybrid Analysis quota',
  'tenable-axi': 'Tenable tag category list --limit 1',
  'beyondtrust-axi': 'BeyondTrust doctor (authentication and bounded About read)',
  'checkpoint-axi': 'Check Point doctor (authentication and bounded email search)',
  'awx-axi': 'AWX job list --limit 1',
  'ado-axi': 'Azure DevOps project list --limit 1',
  'falcon-axi': 'Falcon auth status', 'vectra-axi': 'Vectra health list', 'az-axi': 'Azure account list',
  'mg-axi': 'Graph entra user list --limit 1', 'ldap-axi': 'LDAP auth status',
}
const endpointFields = ['origin', 'url', 'host', 'org', 'tenantId', 'region']

type Tool = z.infer<typeof adminToolSchema>
type Instance = z.infer<typeof adminInstanceSchema>

// One line of an Instances table: a credential instance, or an SSH host reported as an instance.
export interface InstanceRow {
  name: string
  description: string
  endpoint: string
  href: string
  readOnly: boolean
  status: string
  checkedAt: number | null
  instance?: Instance
}

export async function readInstanceRows(app: FastifyInstance, request: FastifyRequest, db: Database.Database, tool: Tool): Promise<InstanceRow[]> {
  if (tool.name === 'ssh-axi') {
    const hosts = db.prepare('SELECT id, address, port, enabled, read_only AS readOnly FROM ssh_hosts ORDER BY id').all() as
      { id: string, address: string, port: number, enabled: number, readOnly: number }[]
    return hosts.map(host => ({ name: host.id, description: '', endpoint: `${host.address}:${host.port}`, href: '/admin/ssh',
      readOnly: Boolean(host.readOnly), status: host.enabled ? status('Check per host', 'neutral') : status('Disabled', 'off'), checkedAt: null }))
  }
  const { instances } = await adminRead(app, request, `/v1/admin/tools/${tool.name}/instances`, adminInstanceRoutes.list.response)
  return instances.map(instance => {
    const identity = endpointFields.map(name => instance.metadata[name]).find(value => typeof value === 'string' && value)
    return { name: instance.name, description: instance.description, endpoint: typeof identity === 'string' ? identity.replace(/^\w+:\/\//, '').replace(/\/.*$/, '') : '',
      href: `/admin/tools/${tool.name}/instances/${instance.name}`, readOnly: tool.readOnly || instance.readOnly,
      status: instance.enabled ? setupBadge(toolSetupState({ enabled: true, configured: instance.configured, health: instance.health })) : status('Disabled', 'off'), checkedAt: instance.health.checkedAt, instance }
  })
}

function diagnosticText(detail?: Diagnostic): string {
  return detail ? [detail.stage, detail.host, detail.toolCode, detail.providerCode, detail.message, detail.hint, detail.issuer, detail.trust].filter(Boolean).join('\n') : ''
}

const versions = (instance: Instance) => `<input type="hidden" name="expectedId" value="${escape(instance.id)}">${revision(instance.revision)}`

type FormBuilder = (action: string, method: string, body: string, confirmation?: Confirmation, attributes?: string) => string

// Device-flow connection: reconnects an existing instance, or creates a new one by name.
function githubCard(form: FormBuilder, tool: Tool, instance?: Instance): string {
  const device = instance?.metadata.auth === 'device'
  const revisions = instance ? `${versions(instance)}<input type="hidden" name="instance" value="${escape(instance.name)}">`
    : `${revision(0)}<label>Instance name<input name="instance" required maxlength="32" pattern="[a-z0-9][a-z0-9\\-]*" autocomplete="off" spellcheck="false"></label>`
  return `<section class="card" data-github-device><div class="card-head"><div><h2>${device ? 'Reconnect' : instance ? 'Connect' : 'Add an instance'} with GitHub</h2><p>A machine identity for ${instance ? 'this instance' : 'a new instance'}.</p></div></div><div class="card-body">
    <p>Use a dedicated machine account. This reuses the GitHub CLI OAuth client ID and requests repo, read:org, gist, workflow and project. These broad scopes permit writes outside Artium even while Artium writes are off.</p>
    <p>The non-expiring OAuth token appears as GitHub CLI in GitHub Settings, Applications, Authorized OAuth Apps. Revoke it there. Store and rotate it like every other secret. No automatic refresh is performed. Connecting ${instance ? 'replaces this instance’s credential' : 'saves the new instance'} only after approval.</p>
    ${device ? `<p>Connected account: <strong>${escape(instance!.metadata.login)}</strong>. ${instance!.metadata.accessTokenExpiresAt ? 'Provider expiry: ' + timestamp(Number(instance!.metadata.accessTokenExpiresAt)) : 'No scheduled expiry.'}</p>` : ''}
    ${instance?.health.errorCode === 'CREDENTIAL_EXPIRED' ? callout('err', 'The credential expired or was revoked', 'Reconnect below.', '', { role: 'alert' }) : ''}
    ${form(githubDeviceRoutes.start.path, 'POST', `${revisions}<input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}"><label>GitHub HTTPS origin<input name="origin" type="url" required value="${escape(instance?.metadata.origin ?? 'https://github.com')}"></label><button class="btn btn-secondary">${icon('link')}${device ? 'Reconnect with GitHub' : 'Connect with GitHub'}</button>`,
      { consequence: `Connect a GitHub account with repo, read:org, gist, workflow and project scopes to ${instance ? 'this instance? This replaces its credential' : 'a new instance? The instance is created'} after authorization.` }, 'data-connect-github')}
    <div class="column" data-github-authorization hidden><p>Open <a data-github-link target="_blank" rel="noopener noreferrer"></a> and enter:</p><div class="bigcode" data-github-code></div><p data-github-status role="status"></p><div><button type="button" class="btn btn-ghost btn-sm" data-cancel-github>Cancel connection</button></div></div>
    ${instance ? '<p>Alternatively, choose token or github-app below to replace the credential using another method.</p>' : ''}</div></section>`
}

export function instancesPanel(options: { tool: Tool, csrf: string, rows: InstanceRow[], profile: CredentialProfile, sheet?: string }): string {
  const { tool, csrf, rows, profile } = options
  const product = toolProducts[tool.name].name
  const api = `/v1/admin/tools/${tool.name}`
  const page = `/admin/tools/${tool.name}`
  const ssh = tool.name === 'ssh-axi'
  const form = (action: string, method: string, body: string, confirmation?: Confirmation, attributes?: string) =>
    actionForm(csrf, action, method, body, confirmation, attributes)
  const sheets: string[] = []
  const body = rows.map(row => {
    const instance = row.instance
    let actions = `<a class="btn btn-ghost btn-sm" href="${escape(row.href)}">${ssh ? 'Manage' : 'Open'}</a>`
    if (instance) {
      const path = `${api}/instances/${instance.name}`
      const name = `edit-${instance.name}`
      sheets.push(sheet({ name, open: options.sheet === name, closeHref: page, title: `Edit ${instance.name}`,
        description: 'The name never changes. To rename an instance, add a new one and delete this one.',
        body: versions(instance) + field(`${name}-description`, 'Description', attributes => `<textarea ${attributes} name="description" rows="3" maxlength="500">${escape(instance.description)}</textarea>`,
          'Agents read this to choose between instances. Say what the instance is for.') +
          `<label class="switch-row"><input type="checkbox" class="switch" role="switch" name="readOnly" data-type="boolean"${instance.readOnly ? ' checked' : ''}><div><b>Read-only</b><span>Blocks every write through this instance, even when the tool allows writes.</span></div></label>
          <p class="note">Change the connection and certificates on <a href="${escape(row.href)}">the instance page</a>.</p>`,
        submit: '<button class="btn btn-primary">Save instance</button>',
        wrap: inner => form(path, 'PATCH', inner, { consequence: `Save the description and read-only setting of ${instance.name}? Agents see the new description on their next listing.`, title: 'Save instance', action: 'Save' }) }))
      actions = form(`${path}/test`, 'POST', `<button class="btn btn-secondary btn-sm">${icon('test')}Test</button>`, undefined, 'data-success-message="Test passed."') +
        sheetLink(name, `${page}?sheet=${name}`, 'Edit', 'btn btn-ghost btn-sm', 'pen') +
        `<details class="more-menu"><summary class="btn btn-ghost btn-icon btn-sm" aria-label="More actions for ${escape(instance.name)}">${icon('more')}</summary><div class="popover">` +
        form(path, 'PATCH', `${versions(instance)}<input type="hidden" name="enabled" data-type="boolean" value="${!instance.enabled}"><button class="btn">${instance.enabled ? 'Disable' : 'Enable'}</button>`,
          instance.enabled ? { consequence: `Disable ${instance.name}? Calls to it fail with INSTANCE_DISABLED until you enable it again. Its credential and certificates are kept.`, title: 'Disable instance', action: 'Disable' }
            : { consequence: `Enable ${instance.name}? Agents who can use it can call it again.`, title: 'Enable instance', action: 'Enable' }) +
        `<hr>${form(path, 'DELETE', `${versions(instance)}<button class="btn danger">${icon('trash')}Delete…</button>`,
          { consequence: `Delete ${instance.name}? Its credential, certificate trust and health are removed. Calls that name it fail with INSTANCE_NOT_FOUND. Audit history is kept.`, title: 'Delete instance', action: 'Delete', typedName: instance.name })}</div></details>`
    }
    return `<tr><td><div class="cell-main"><div><a href="${escape(row.href)}">${escape(row.name)}</a><span>${escape(row.description || (ssh ? 'SSH host' : 'No description'))}</span></div></div></td>
      <td data-label="Endpoint" class="mono">${escape(row.endpoint)}</td><td data-label="Status">${row.status}</td>
      <td data-label="Writes">${writes({ capable: tool.writeAccess.capable, enabled: !row.readOnly, operations: null }, 'status')}</td>
      <td data-label="Last checked" class="num faint">${timestamp(row.checkedAt, 'Never')}</td><td class="actions-cell">${actions}</td></tr>`
  }).join('')
  const table = rows.length
    ? `<table class="tbl stack-sm"><caption class="sr-only">${escape(product)} instances</caption><thead><tr><th scope="col">Instance</th><th scope="col">Endpoint</th><th scope="col">Status</th><th scope="col">Writes</th><th scope="col" class="num">Last checked</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${body}</tbody></table>`
    : `<p class="empty">${ssh ? 'No hosts are registered yet.' : `No instances yet. Add one to connect ${escape(product)}.`}</p>`
  const add = 'add-instance'
  if (!ssh) {
    const awx = tool.name === 'awx-axi'
    sheets.push(sheet({ name: add, open: options.sheet === add, closeHref: page, title: 'Add instance', description: `Connect another ${product} endpoint under its own name.`,
      body: `<input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}">${awx ? revision(0) : ''}` +
        field('instance-name', 'Name', attributes => `<input class="input mono" ${attributes} name="${awx ? 'instance' : 'name'}" required maxlength="32" pattern="[a-z0-9][a-z0-9\\-]*" autocomplete="off" spellcheck="false">`,
          'Lowercase letters, digits and hyphens. Agents type this name, and it never changes.') +
        (awx ? field('instance-origin', 'Controller HTTPS origin', attributes => `<input class="input" ${attributes} name="origin" type="url" required>`,
          'Save the address first, then open the instance to inspect its certificate, save credentials and edit its description.')
          : field('instance-description', 'Description', attributes => `<textarea ${attributes} name="description" rows="3" maxlength="500"></textarea>`,
            'Say what this instance is for, for example “Production cluster. Use for inventory only.”')) +
        (rows.length ? callout('warn', 'Scripts may need to name an instance', 'Calls that omit --instance fail with INSTANCE_REQUIRED when more than one enabled, configured instance is granted to the caller.') : '') +
        (awx ? '' : credentialFields(tool.name, profile, {}, false)) +
        '<p class="note">New instances start read-only. Change this on the instance after it passes its test.</p>',
      submit: `${awx ? '' : '<label class="check"><input type="checkbox" data-save-and-test checked> Test after saving</label>'}<button class="btn btn-primary">Add instance</button>`,
      wrap: inner => form(awx ? `${api}/origin` : `${api}/instances`, awx ? 'PUT' : 'POST', inner, { consequence: `Add this ${product} instance? It starts read-only.`, title: 'Add instance', action: 'Add instance' }, awx ? '' : `data-save-tool="${tool.name}"`) }))
  }
  const sshNote = noteCard('Dedicated SSH identity', '<p>SSH requires separately managed host trust, caller grants and encrypted ordinary account bindings. Generic tenant credentials cannot configure SSH.</p><p><a href="/admin/ssh">Manage hosts, account bindings and grants</a> · <a href="/admin/ssh/credentials">Manage encrypted SSH credentials</a></p>') +
    noteCard('Check authentication per host', '<p>As a caller with a shell grant, run <code>artium-axi ssh-axi host list</code>, then <code>artium-axi ssh-axi doctor &lt;host&gt;</code>. This checks authentication only. There is no shared connection test or cached health result.</p>')
  const aside = ssh ? sshNote : noteCard('What the test does', `<p>Runs one harmless read per instance: <code>${escape(testGuide[tool.name])}</code>. It does not enable the tool or grant access.</p>`) +
    noteCard('Choosing an instance', '<p>Agents name an instance with <code>artium-axi --instance &lt;name&gt; ' + escape(tool.name) + '</code>. With one usable instance the flag is optional.</p>')
  return `<div class="split">${card('Instances', ssh ? 'SSH hosts are reported as instances. Hosts, bindings and grants stay on their own pages.' : `Each instance is a named connection to ${product} with its own credential, certificates and read-only setting.`,
    table, { actions: ssh ? '<a class="btn btn-secondary btn-sm" href="/admin/ssh">Manage hosts</a>' : sheetLink(add, `${page}?sheet=${add}`, 'Add instance', 'btn btn-primary btn-sm', 'plus') })}${tool.name === 'gh-axi' ? githubCard(form, tool) : ''}${aside}</div>${sheets.join('')}`
}

export function registerInstancePages(app: FastifyInstance, db: Database.Database, credentialProfiles: Partial<Record<ToolName, CredentialProfile>>): void {
  app.get('/admin/tools/:tool/instances/:name', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const params = adminInstanceParamsSchema.safeParse(request.params)
    if (!params.success) throw new ArtiumError('NOT_FOUND')
    const api = `/v1/admin/tools/${params.data.tool}`
    const tool = await adminRead(app, request, api, adminToolRoutes.get.response)
    const instance = await adminRead(app, request, `${api}/instances/${params.data.name}`, adminInstanceRoutes.get.response)
    const csrf = reply.generateCsrf()
    const product = toolProducts[tool.name].name
    const path = `${api}/instances/${instance.name}`
    const page = `/admin/tools/${tool.name}/instances/${instance.name}`
    const form = (action: string, method: string, body: string, confirmation?: Confirmation, attributes?: string) =>
      actionForm(csrf, action, method, body, confirmation, attributes)
    const awx = tool.name === 'awx-axi'
    const enabled = tool.enabled && instance.enabled
    const state = toolSetupState({ enabled, configured: instance.configured, health: instance.health })
    const failing = state === 'failing'
    const revisionInputs = `${versions(instance)}<input type="hidden" name="expectedToolRevision" data-type="number" value="${tool.revision}">`

    const test = form(`${path}/test`, 'POST', `<button class="btn btn-secondary">${icon('test')}Test connection</button>`, undefined, `data-test-tool="${tool.name}"`)
    const toggle = form(path, 'PATCH', `${versions(instance)}<input type="hidden" name="enabled" data-type="boolean" value="${!instance.enabled}"><button class="toggle" role="switch" aria-checked="${instance.enabled}"><span class="switch${instance.enabled ? ' on' : ''}" aria-hidden="true"></span>Enabled</button>`,
      { consequence: instance.enabled ? `Disable ${instance.name}? Calls to it fail with INSTANCE_DISABLED until you enable it again.` : `Enable ${instance.name}? Agents who can use it can call it again.`,
        title: instance.enabled ? 'Disable instance' : 'Enable instance', action: instance.enabled ? 'Disable' : 'Enable' })
    const meta = `<span class="mono">${escape(tool.name)}</span><span data-tool-state>${setupBadge(state)}</span>${writes({ capable: tool.writeAccess.capable, enabled: !tool.readOnly && !instance.readOnly, operations: null }, 'badge')}<span>Checked <span data-check-time>${timestamp(instance.health.checkedAt, 'never')}</span></span>`
    const stateTemplates = `<template data-state="ok">${setupBadge('healthy')}</template><template data-state="error">${setupBadge('failing')}</template>`
    const definition = instance.health.errorCode && instance.health.errorCode in errors ? errors[instance.health.errorCode as keyof typeof errors] : undefined
    const failure = callout('err', 'Last test failed', `<span data-check-summary>${escape(instance.health.diagnostic?.message ?? definition?.message ?? '')} ${escape(instance.health.diagnostic?.hint ?? definition?.next ?? '')}</span>`, '',
      { attributes: `data-check-failure${failing ? '' : ' hidden'}`, more: `<p>Agents calling this instance get <code data-check-error>${escape(instance.health.errorCode ?? '')}</code>.${instance.health.errorCode === 'UPSTREAM_TLS_FAILED' ? ' Review the endpoint under Certificates below.' : ''}</p><details><summary>Show diagnostic</summary><pre data-check-diagnostic>${escape(diagnosticText(instance.health.diagnostic))}</pre></details>` })
    const setup = steps([
      { title: 'Credential saved', detail: instance.configured ? timestamp(instance.updatedAt) : 'Not saved yet', state: instance.configured ? 'done' : 'todo' },
      { title: 'Test passes', detail: state === 'healthy' ? 'Passed' : failing ? `Failing: ${escape(instance.health.errorCode ?? 'error')}` : 'Not run', state: state === 'healthy' ? 'done' : failing ? 'fail' : 'todo', attributes: 'data-test-checklist' },
      { title: 'Instance enabled', detail: instance.enabled ? 'On' : 'Off', state: instance.enabled ? 'done' : 'todo' },
    ])

    let connection = ''
    if (tool.name === 'gh-axi') connection += githubCard(form, tool, instance)
    if (awx) {
      connection += form(`${api}/origin`, 'PUT', `<div class="card-head"><div><h2>Controller address</h2><p>For password sign-in, save the address first, then check its certificate and sign in below.</p></div></div><div class="card-body">${revisionInputs}<input type="hidden" name="instance" value="${escape(instance.name)}"><label>Controller HTTPS origin<input name="origin" type="url" required value="${escape(instance.metadata.origin ?? '')}"></label><p>Changing the saved address removes the previous token and certificate trust.</p></div><div class="card-foot"><span>Sends no credentials.</span><div class="actions"><button class="btn btn-secondary btn-sm">Save controller address</button></div></div>`,
        { consequence: 'Save this controller address without sending credentials? A changed address removes the previous token and certificate trust.' }, 'class="card"')
    }
    connection += form(`${path}/credential`, 'PATCH', `<div class="card-head"><div><h2>Connection</h2><p>How Artium signs in to ${escape(product)} for ${escape(instance.name)}. Secrets are encrypted and never shown again.</p></div></div><div class="card-body">${revisionInputs}${credentialFields(tool.name, editorProfile(tool.name, credentialProfiles[tool.name]), instance.metadata, instance.configured)}</div>
      <div class="card-foot"><label class="check"><input type="checkbox" data-save-and-test checked> Test after saving</label><div class="actions"><button class="btn btn-primary btn-sm">Save connection</button></div></div>`,
      { consequence: 'Save this credential, retaining unchanged stored secrets for the same identity and keeping native settings?' }, `class="card" data-save-tool="${tool.name}" data-save-instance="${escape(instance.name)}"`)

    const pins = credentialCertificates(db, instance.id)
    let endpoints: URL[] = []
    // An invalid saved credential must remain editable after a profile upgrade.
    try { endpoints = toolEndpoints(tool.name, { ...instance.metadata, ...tool.nativeSettings }) } catch { /* Save a valid endpoint before inspecting. */ }
    const soon = Date.now() + 30 * 86400000
    const expiring = pins.some(pin => Date.parse(pin.leaf.expiresAt) <= soon || Date.parse(pin.certificate.expiresAt) <= soon)
    const pinRows = pins.map(pin => `<tr><td class="mono">${escape(pin.endpoint)}</td><td data-label="Trust"><span class="badge">${pin.mode === 'pin' ? 'Pinned certificate' : 'Issuing CA'}</span></td>
      <td data-label="SHA-256"><p class="mono">${escape(pin.certificate.fingerprint)}</p>${pin.leaf.fingerprint !== pin.certificate.fingerprint ? `<p class="faint">Endpoint: <span class="mono">${escape(pin.leaf.fingerprint)}</span></p>` : ''}<p class="faint">${escape(pin.certificate.subject)}</p></td>
      <td data-label="Expires">${escape(pin.certificate.expiresAt)}${pin.leaf.expiresAt !== pin.certificate.expiresAt ? `<p class="faint">Endpoint: ${escape(pin.leaf.expiresAt)}</p>` : ''}</td>
      <td class="num">${form(`${path}/certificates`, 'DELETE', `<input type="hidden" name="id" value="${escape(pin.id)}"><button class="btn btn-secondary btn-sm">Remove endpoint trust</button>`, { consequence: 'Remove this endpoint trust record? Separately saved Certificate verification fields remain.' })}</td></tr>`).join('')
    const pinTable = pins.length
      ? `<table class="tbl stack-sm"><caption class="sr-only">Trusted certificates</caption><thead><tr><th scope="col">Endpoint</th><th scope="col">Trust</th><th scope="col">Fingerprint (SHA-256)</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${pinRows}</tbody></table>`
      : '<p class="empty">No certificates trusted for this instance. Hostname and expiry checks always apply.</p>'
    const offered = awx || instance.health.errorCode === 'UPSTREAM_TLS_FAILED' || pins.length > 0
    const inspect = endpoints.length ? form(`${path}/certificates/inspect`, 'POST',
      `${endpoints.length > 1 ? `<label class="sr-only" for="endpoint-index">Saved TLS endpoint</label><select id="endpoint-index" name="endpointIndex" data-type="number">${endpoints.map((endpoint, index) => `<option value="${index}">${escape(endpoint.host)}</option>`).join('')}</select>` : `<input type="hidden" name="endpointIndex" data-type="number" value="0"><span class="mono">${escape(endpoints[0]!.host)}</span>`}<button class="btn btn-secondary btn-sm">${icon('cert')}Inspect certificate</button>`,
      undefined, `class="row" data-inspect-certificate${offered ? '' : ' hidden'}`) : ''
    const trustModes = tool.name === 'kubernetes-axi'
      ? '<option value="ca">Trust the issuing CA</option></select></label><p>This tool requires an issuing CA. Leaf pinning is unavailable. Use the server trusted CA bundle for self-signed endpoints.</p>'
      : '<option value="ca">Trust the issuing CA (recommended, renewed certificates keep working)</option><option value="pin">Strict leaf pinning (re-trust after every rotation)</option></select></label><p>Self-signed endpoints keep a leaf pin. Hostname and date verification always apply.</p>'
    const dialog = `<dialog id="certificate-inspection" class="modal" aria-labelledby="certificate-inspection-title"><div class="modal-body"><h2 id="certificate-inspection-title">Inspect certificate for ${escape(instance.name)}</h2>
      ${callout('warn', 'Compare the fingerprint before trusting', 'Trust is only as safe as the network path when this certificate was fetched. A certificate presented during interception would be trusted too. Compare the full SHA-256 fingerprint with the one shown by the appliance.', '', { role: 'alert' })}
      <div data-certificate-details></div><p data-certificate-error role="alert"></p>${form(`${path}/certificates/use-name`, 'POST', '<input type="hidden" name="inspectionId"><button class="btn btn-secondary" data-use-certificate-name></button>', undefined, 'data-certificate-name-form hidden')}${form(`${path}/certificates/trust`, 'POST', `<input type="hidden" name="inspectionId"><input type="hidden" name="fillFields" data-type="boolean" value="${Boolean(credentialTlsSettings[tool.name].certificate)}">${credentialTlsSettings[tool.name].certificate ? '<p>Initial trust fills Certificate verification. Existing certificates and fingerprints must be replaced manually.</p>' : '<p>This tool does not support a shared trusted certificate field. Confirmed endpoint trust is available.</p>'}<label>Trust mode<select name="mode">${trustModes}<label><input type="checkbox" name="confirmedFingerprint" required> I compared the displayed SHA-256 fingerprint with the appliance through a trusted route.</label><button class="btn btn-primary">Trust this certificate</button>`, undefined, `data-trust-certificate data-trust-test-url="${path}/test"`)}</div>
      <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close-certificate>Close</button></div></dialog>`
    const certificates = !instance.configured && !(awx && instance.metadata.origin)
      ? card('Trusted certificates', 'Trust applies only to this instance’s saved endpoints.', '<p class="empty">Save a connection first. Certificates are inspected at the saved endpoints.</p>')
      : `<section class="card" data-trusted-certificates><div class="card-head"><div><h2>Trusted certificates</h2><p>Trust applies only to this instance’s saved credential. CA trust allows leaf renewal; strict pinning needs re-trust after rotation.</p></div></div>
        ${expiring ? `<div class="card-body">${callout('warn', 'A trusted certificate expires soon', 'A trusted certificate has expired or expires within 30 days. Re-inspect this endpoint for rotation.', '', { role: 'alert' })}</div>` : ''}${pinTable}<div class="card-foot"><span>${offered ? 'Compare the fingerprint with the one the appliance shows before trusting.' : 'Inspection is offered after a connection test fails with a certificate error.'}</span><div class="actions">${inspect}</div></div></section>${dialog}`

    const danger = card('Danger zone', '', `<ul class="rows"><li class="list-row"><div class="grow"><strong>Delete instance</strong><p>Permanent. Removes its credential, certificate trust and health. Calls that name it fail with INSTANCE_NOT_FOUND. Audit history is kept.</p></div>${form(path, 'DELETE',
      `${versions(instance)}<button class="btn btn-danger-outline btn-sm">Delete…</button>`,
      { consequence: `Delete ${instance.name}? Its credential, certificate trust and health are removed. This cannot be undone.`, title: 'Delete instance', action: 'Delete', typedName: instance.name },
      `data-success-url="/admin/tools/${tool.name}"`)}</li></ul>`, { danger: true })
    const aside = noteCard('What the test does', `<p>Runs one harmless read: <code>${escape(testGuide[tool.name])}</code>. It does not enable the tool or grant access.</p>`) +
      noteCard('Keeping secrets', '<p>Leave a stored secret blank to keep it. Changing authentication, mode, kind, tenant, client or URL needs new secrets.</p>') +
      (instance.configured ? changed(db, instance) : '')
    const content = stateTemplates + failure + setup + '<p class="note" data-test-result role="status"></p>' +
      `<div class="split has-aside"><div class="column">${connection}${certificates}${danger}</div><div class="column">${aside}</div></div>`
    return browserPage(reply, product, content, current, instance.description || undefined,
      { lead: toolIcon(tool.name, 'lg'), heading: instance.name, meta, actions: `<div class="actions">${test}${toggle}</div>`, parent: { href: `/admin/tools/${tool.name}`, label: product }, helpTopic: 'Tools' })
  })
}
