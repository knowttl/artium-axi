import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import { adminInstanceParamsSchema, adminInstanceRoutes, adminInstanceSchema, adminToolRoutes, adminToolSchema, githubDeviceRoutes } from '../../shared/api.js'
import { ArtiumError, errors } from '../../shared/errors.js'
import type { Diagnostic } from '../../shared/errors.js'
import { structuredDiagnostic } from '../../shared/diagnostic.js'
import type { CredentialProfile } from '../adapters/credential-profile.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { credentialCertificates } from '../store/trusted-certificates.js'
import type { ToolName } from '../store/credential-store.js'
import { toolEndpoints } from '../tool-endpoints.js'
import type { InstancesProps } from '../../views/tool-instances.js'
import { credentialTlsSettings } from '../credential-tls-settings.js'
import { credentialEditor, editorProfile } from './credential-form.js'
import { describe, describeWrites, setupStatus, toolProducts, toolSetupState, type Tone } from './design/status.js'
import { callout, icon } from './design/ui.js'
import { escape } from './escape.js'
import { actionForm, adminRead, lastChange, revision, timestamp, type Confirmation } from './forms.js'
import { renderPage } from './render-page.js'

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
  status: { word: string, tone: Tone }
  checkedAt: number | null
  instance?: Instance
}

export async function readInstanceRows(app: FastifyInstance, request: FastifyRequest, db: Database.Database, tool: Tool): Promise<InstanceRow[]> {
  if (tool.name === 'ssh-axi') {
    const hosts = db.prepare('SELECT id, address, port, enabled, read_only AS readOnly FROM ssh_hosts ORDER BY id').all() as
      { id: string, address: string, port: number, enabled: number, readOnly: number }[]
    return hosts.map(host => ({ name: host.id, description: '', endpoint: `${host.address}:${host.port}`, href: '/admin/ssh',
      readOnly: Boolean(host.readOnly), status: host.enabled ? setupStatus('hostChecks') : describe('health', 'disabled'), checkedAt: null }))
  }
  const { instances } = await adminRead(app, request, `/v1/admin/tools/${tool.name}/instances`, adminInstanceRoutes.list.response)
  return instances.map(instance => {
    const identity = endpointFields.map(name => instance.metadata[name]).find(value => typeof value === 'string' && value)
    return { name: instance.name, description: instance.description, endpoint: typeof identity === 'string' ? identity.replace(/^\w+:\/\//, '').replace(/\/.*$/, '') : '',
      href: `/admin/tools/${tool.name}/instances/${instance.name}`, readOnly: tool.readOnly || instance.readOnly,
      status: instance.enabled ? setupStatus(toolSetupState({ enabled: true, configured: instance.configured, health: instance.health })) : describe('health', 'disabled'), checkedAt: instance.health.checkedAt, instance }
  })
}

function diagnosticText(detail?: Diagnostic): string {
  const safe = structuredDiagnostic(detail)
  return safe ? [safe.stage, safe.toolCode, safe.transportCode, safe.providerCode, safe.upstreamStatus, safe.trust].filter(value => value !== undefined).join('\n') : 'Details unavailable.'
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

export function instancesPanel(options: { tool: Tool, csrf: string, rows: InstanceRow[], profile: CredentialProfile, sheet?: string }): InstancesProps {
  const { tool, csrf, rows, profile } = options
  const product = toolProducts[tool.name].name
  const api = `/v1/admin/tools/${tool.name}`
  const page = `/admin/tools/${tool.name}`
  const ssh = tool.name === 'ssh-axi'
  const form = (action: string, method: string, body: string, confirmation?: Confirmation, attributes?: string) =>
    actionForm(csrf, action, method, body, confirmation, attributes)
  const awx = tool.name === 'awx-axi'
  const addInstance = ssh ? null : { tool: tool.name, product, api, toolRevision: tool.revision, open: options.sheet === 'add-instance', awx, hasInstances: rows.length > 0,
    editor: awx ? null : credentialEditor(tool.name, profile, {}, false) }
  return { page, ssh, testGuide: ssh ? null : testGuide[tool.name],
    rows: rows.map(row => ({ name: row.name, description: row.description, endpoint: row.endpoint, href: row.href, status: row.status,
      writes: describeWrites(!tool.writeAccess.capable || row.readOnly, tool.writeAccess.capable, null),
      checkedAt: row.checkedAt === null ? null : new Date(row.checkedAt).toISOString(),
      instance: row.instance ? { path: `${api}/instances/${row.instance.name}`, id: row.instance.id, revision: row.instance.revision, enabled: row.instance.enabled, readOnly: row.instance.readOnly,
        description: row.instance.description, editOpen: options.sheet === `edit-${row.instance.name}` } : null })),
    github: tool.name === 'gh-axi' ? { legacyHtml: githubCard(form, tool) } : null, addInstance }
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
    const awx = tool.name === 'awx-axi'
    const state = toolSetupState({ enabled: tool.enabled && instance.enabled, configured: instance.configured, health: instance.health })
    const failing = state === 'failing'
    const iso = (value: number | null) => value === null ? null : new Date(value).toISOString()
    const definition = instance.health.errorCode && instance.health.errorCode in errors ? errors[instance.health.errorCode as keyof typeof errors] : undefined

    const pins = credentialCertificates(db, instance.id)
    let endpoints: URL[] = []
    // An invalid saved credential must remain editable after a profile upgrade.
    try { endpoints = toolEndpoints(tool.name, { ...instance.metadata, ...tool.nativeSettings }) } catch { /* Save a valid endpoint before inspecting. */ }
    const soon = Date.now() + 30 * 86400000
    const unifi = tool.name === 'unifi-axi'
    const proxmox = tool.name === 'proxmox-axi'

    const props = { csrf, tool: tool.name, product, mark: toolProducts[tool.name].mark, api, path, toolRevision: tool.revision, id: instance.id, name: instance.name,
      revision: instance.revision, enabled: instance.enabled, state: setupStatus(state), outcomes: { ok: setupStatus('healthy'), error: setupStatus('failing') },
      writes: describeWrites(!tool.writeAccess.capable || tool.readOnly || instance.readOnly, tool.writeAccess.capable, null), checkedAt: iso(instance.health.checkedAt),
      setup: [
        { title: 'Credential saved', detail: instance.configured ? '' : 'Not saved yet', at: instance.configured ? iso(instance.updatedAt) : null, state: instance.configured ? 'done' as const : 'todo' as const },
        { title: 'Test passes', detail: state === 'healthy' ? 'Passed' : failing ? `Failing: ${instance.health.errorCode ?? 'error'}` : 'Not run', at: null, test: true,
          state: state === 'healthy' ? 'done' as const : failing ? 'fail' as const : 'todo' as const },
        { title: 'Instance enabled', detail: instance.enabled ? 'On' : 'Off', at: null, state: instance.enabled ? 'done' as const : 'todo' as const },
      ],
      failure: { shown: failing, summary: [definition?.message, definition?.next].filter(Boolean).join(' '), code: instance.health.errorCode ?? '',
        certificateHint: instance.health.errorCode === 'UPSTREAM_TLS_FAILED', diagnostic: diagnosticText(instance.health.diagnostic) },
      github: tool.name === 'gh-axi' ? { legacyHtml: githubCard((action, method, body, confirmation, attributes) => actionForm(csrf, action, method, body, confirmation, attributes), tool, instance) } : null,
      controllerOrigin: awx ? String(instance.metadata.origin ?? '') : null,
      connection: credentialEditor(tool.name, editorProfile(tool.name, credentialProfiles[tool.name]), instance.metadata, instance.configured),
      certificates: {
        saved: instance.configured || Boolean(awx && instance.metadata.origin),
        intro: `Trust applies only to this instance’s saved credential. ${unifi ? 'UniFi also checks the saved leaf fingerprint. Inspect the certificate to confirm its replacement after renewal.'
          : proxmox ? 'CA trust allows leaf renewal unless a separately saved fingerprint rejects it; strict pinning needs re-trust after rotation.' : 'CA trust allows leaf renewal; strict pinning needs re-trust after rotation.'}`,
        expiring: pins.some(pin => (pin.leaf !== null && Date.parse(pin.leaf.expiresAt) <= soon) || Date.parse(pin.certificate.expiresAt) <= soon),
        pins: pins.map(pin => ({ id: pin.id, endpoint: pin.endpoint, trust: pin.mode === 'pin' ? 'Pinned certificate' : 'Issuing CA', fingerprint: pin.certificate.fingerprint,
          endpointFingerprint: pin.leafFingerprint && pin.leafFingerprint !== pin.certificate.fingerprint ? pin.leafFingerprint : null,
          note: pin.leaf ? null : pin.leafFingerprint ? 'Certificate details not yet inspected.' : 'No confirmed leaf; use Trust or Renew to confirm one',
          subject: pin.certificate.subject, expires: pin.certificate.expiresAt, endpointExpires: pin.leaf && pin.leaf.expiresAt !== pin.certificate.expiresAt ? pin.leaf.expiresAt : null })),
        offered: awx || tool.name === 'kubernetes-axi' && Boolean(instance.metadata.tlsServerName) || instance.health.errorCode === 'UPSTREAM_TLS_FAILED' || pins.length > 0,
        endpoints: endpoints.map(endpoint => endpoint.host),
        trust: { fills: Boolean(credentialTlsSettings[tool.name].certificate),
          caOption: `Trust the issuing CA${unifi ? ' (confirm a new leaf fingerprint after renewal)' : proxmox ? ' (a separately saved fingerprint still applies)' : ' (recommended, renewed certificates keep working)'}` },
      },
      testGuide: testGuide[tool.name], change: instance.configured ? lastChange(db, instance) : null }
    return renderPage(reply, 'Tools', 'instance', props, current, instance.description || undefined, undefined, instance.name, { href: `/admin/tools/${tool.name}`, label: product })
  })
}
