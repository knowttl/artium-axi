import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import { adminToolRoutes, nativeSettingsSchemas, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { userGrantPolicies } from '../../shared/user-grants.js'
import operationCatalogue from '../../../tools/inventories/write-operations.json' with { type: 'json' }
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { adminRead } from './forms.js'
import { editorProfile } from './credential-form.js'
import { instancesPanel, readInstanceRows, registerInstancePages } from './instances.js'
import { describeWrites, rawApiModeWords, setupStatus, toolProducts, toolSetupState } from './design/status.js'
import { renderPage } from './render-page.js'
import type { AccessProps } from '../../views/tool-access.js'
import type { ToolProps } from '../../views/tool.js'
import type { WritesProps } from '../../views/tool-writes.js'
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
  'awx-axi': 'Optional allowWrites (boolean), off by default, gates all writes and previews. Optional allowDeletes (boolean), off by default, additionally gates destructive deletes, api delete and bulk host operations. Optional allowSecurityAdministration (boolean), off by default, additionally gates security administration and raw API writes to security resources. Preview with --dry-run, then repeat with --confirm; AWX resource permission is required. File flags upload local bytes privately; structured flags accept inline text or @local-file. Credential inputs-file and password-file accept stdin (-). Legacy allowConfigurationWrites is ignored. Use {} to turn writes off.',
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
    return renderPage(reply, 'Tools', 'tools', {
      filters: { show, q: search, links: (['all', 'enabled', 'attention'] as const).map(value =>
        ({ label: { all: 'All', enabled: 'Enabled', attention: 'Needs attention' }[value], count: counts[value], href: link(value), current: show === value })) },
      tools: visible.map(({ tool, state, count, failing }) => ({ href: `/admin/tools/${tool.name}`, name: tool.name, product: toolProducts[tool.name].name, mark: toolProducts[tool.name].mark,
        version: tool.version, instances: `${count} ${tool.name === 'ssh-axi' ? 'host' : 'instance'}${count === 1 ? '' : 's'}`, failing: failing && count > 1 ? `${failing} of ${count} failing` : null,
        state: setupStatus(state), enabled: tool.enabled,
        writes: describeWrites(!tool.writeAccess.capable || tool.readOnly, tool.writeAccess.capable, tool.writeAccess.supportedOperations ? tool.writeAccess.allowedOperations.length : null),
        rawApi: tool.rawApi.modes.length ? rawApiModeWords[tool.rawApi.mode].label : 'None', roles: roles.get(tool.name) ?? 0,
        checkedAt: tool.health.checkedAt === null ? null : new Date(tool.health.checkedAt).toISOString() })),
      certificates: trustedCertificates.map(({ subject, issuer, expiresAt, fingerprint }) => ({ subject, issuer, expiresAt, fingerprint })),
    }, current, 'Each tool starts off. Connect it, test it, enable it, then grant it to a role.')
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
    const roles = db.prepare(`SELECT roles.id, roles.name, roles.revision, role_tools.all_instances AS allInstances,
      (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE user_roles.role_id = roles.id) AS members
      FROM roles JOIN role_tools ON role_tools.role_id = roles.id WHERE tool = ? ORDER BY roles.name`).all(tool.name) as { id: string, name: string, revision: number, allInstances: number, members: number }[]
    const state = tool.name === 'ssh-axi' && configured ? 'hostChecks' : toolSetupState({ enabled: tool.enabled, configured, health: tool.health })
    const tested = state === 'healthy'
    const failing = state === 'failing'
    const writes = tool.writeAccess
    const awx = tool.name === 'awx-axi'

    const configuredAt = Math.max(0, ...instanceRows.map(row => row.instance?.updatedAt ?? 0))
    const setup: ToolProps['setup'] = [
      { title: tool.name === 'ssh-axi' ? 'Ordinary host binding configured' : 'Credential saved', state: configured ? 'done' : 'todo',
        ...tool.name === 'ssh-axi' ? { detail: configured ? 'Enabled host with an ordinary account binding' : 'No enabled host with an ordinary account binding', at: null }
          : configured ? { detail: `${instanceRows.length} instance${instanceRows.length === 1 ? '' : 's'}, last saved `, at: new Date(configuredAt).toISOString() } : { detail: 'Not saved yet', at: null } },
      ...(tool.name === 'ssh-axi' ? [] : [{ title: 'Test passes', detail: tested ? 'Passed' : failing ? `Failing: ${tool.health.errorCode ?? 'error'}` : 'Not run', at: null,
        state: tested ? 'done' as const : failing ? 'fail' as const : 'todo' as const }]),
      { title: 'Enabled', detail: tool.enabled ? 'On' : 'Off', at: null, state: tool.enabled ? 'done' : 'todo' },
      { title: 'Granted to a role', detail: roles.length ? roles.map(role => role.name).join(', ') : 'No roles yet', at: null, state: roles.length ? 'done' : 'todo' },
    ]
    const writesNote = !writes.capable ? 'Read-only' : tool.readOnly ? 'Off' : writes.supportedOperations ? `${writes.allowedOperations.length} on` : 'On'
    const tabs: ToolProps['tabs'] = [
      { id: 'instances', label: 'Instances', icon: 'globe', note: String(instanceRows.length) },
      { id: 'writes', label: 'Write permissions', icon: 'zap', note: writesNote },
      ...(rawCapable ? [{ id: 'raw-api', label: 'Raw API', icon: 'terminal', note: rawApiModeWords[tool.rawApi.mode].label }] : []),
      { id: 'access', label: 'Access', icon: 'users', note: String(roles.length) },
      { id: 'advanced', label: 'Advanced', icon: 'sliders', note: null },
    ].map(({ id, ...item }) => ({ ...item, href: `/admin/tools/${tool.name}?tab=${id}`, current: id === tab }))

    let panel: ToolProps['panel']
    if (tab === 'instances') {
      panel = { tab, instances: instancesPanel({ tool, rows: instanceRows, profile: editorProfile(tool.name, credentialProfiles[tool.name]), sheet: query.sheet }) }
    } else if (tab === 'writes') {
      panel = { tab, writes: writesProps() }
    } else if (tab === 'raw-api') {
      panel = { tab, mode: tool.rawApi.mode, options: tool.rawApi.modes.map(mode => ({ mode, ...rawApiModeWords[mode] })), writeRoutes: tool.rawApi.writes,
        write: tool.rawApi.routes.write.join('\n'), get: tool.rawApi.routes.get.join('\n') }
    } else if (tab === 'access') {
      const instances = db.prepare('SELECT id, name, description FROM credentials WHERE tool = ? ORDER BY name').all(tool.name) as { id: string, name: string, description: string }[]
      const granted = db.prepare('SELECT credential_id AS id FROM role_tool_instances WHERE role_id = ? AND tool = ?')
      const catalogues = userGrantPolicies[tool.name] ?? {}
      panel = { tab, access: { page: `/admin/tools/${tool.name}?tab=access`, sheet: query.sheet ?? null,
        people: db.prepare('SELECT id, username, display_name AS displayName FROM users WHERE archived_at IS NULL AND disabled = 0 ORDER BY username').all() as AccessProps['people'],
        roles: roles.map(role => {
          const selected = new Set((granted.all(role.id, tool.name) as { id: string }[]).map(row => row.id))
          return { id: role.id, name: role.name, members: role.members, all: Boolean(role.allInstances), revision: role.revision,
            instances: instances.map(instance => ({ name: instance.name, description: instance.description, checked: selected.has(instance.id) })) }
        }),
        policies: Object.entries(catalogues).map(([key, policy]) => {
          const saved = tool.nativeSettings[key] as { grants: Record<string, string[]> } | undefined
          const labels = new Map(policy.operations.map(operation => [operation.id, operation.label]))
          return { key, title: policy.title, description: policy.description, operations: policy.operations.map(({ id, label }) => ({ id, label })),
            creatable: saved !== undefined || nativeSettingsSchemas[tool.name].safeParse({ ...tool.nativeSettings, [key]: { grants: {} } }).success,
            grants: Object.entries(saved?.grants ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([id, operations]) => ({ id,
              summary: operations.map(operation => { const label = labels.get(operation); return label && label !== operation ? `${label} (${operation})` : operation }).join(', ') || 'None',
              operations: [...policy.operations, ...[...new Set(operations)].filter(operation => !labels.has(operation)).map(operation => ({ id: operation, label: operation }))]
                .map(operation => ({ id: operation.id, label: operation.label, checked: operations.includes(operation.id) })) })) }
        }) } }
    } else {
      const policies = userGrantPolicies[tool.name] ?? {}
      const settings = { ...tool.nativeSettings }
      for (const key of Object.keys(policies)) {
        if (settings[key] !== undefined) {
          const { grants: _, ...rest } = settings[key] as Record<string, unknown>
          settings[key] = rest
        }
      }
      panel = { tab: 'advanced', writeState: `writes ${writes.enabled ? 'on' : 'off'}`, guide: settingsGuide[tool.name], grantNote: Object.keys(policies).length > 0, settings: JSON.stringify(settings, null, 2) }
    }
    return renderPage(reply, 'Tools', 'tool', { csrf, name: tool.name, api, product, mark: toolProducts[tool.name].mark, version: tool.version, revision: tool.revision, enabled: tool.enabled,
      state: setupStatus(state), writes: describeWrites(!writes.capable || tool.readOnly, writes.capable, writes.supportedOperations ? writes.allowedOperations.length : null),
      checkedAt: tool.health.checkedAt === null ? null : new Date(tool.health.checkedAt).toISOString(), setup, tabs, panel }, current, undefined, undefined, product)

    function writesProps(): WritesProps {
      const deletes = (awx ? tool.nativeSettings.allowDeletes : (tool.nativeSettings.writes as { allowDeletes?: boolean } | undefined)?.allowDeletes) === true
      const securityAdministration = tool.nativeSettings.allowSecurityAdministration === true
      const flag = (on: boolean, text: string) => `${on ? 'On.' : 'Off.'} ${text}`
      const switches: WritesProps['switches'] = [{ name: 'enabled', label: 'Allow writes', on: writes.enabled, text: flag(writes.enabled, awx
        ? 'Writes and previews for this tenant. Deletes and bulk host operations also require Allow destructive deletes. Reads and help remain available while off.'
        : `Agents can only read from ${product} while this is off.${writes.supportedOperations ? ' Turning it on allows only the operations you select below.' : ''}`) }]
      if (awx) {
        switches.push({ name: 'allowDeletes', label: 'Allow destructive deletes', on: deletes, text: flag(deletes, 'Deletes, api delete and bulk host operations also need Allow writes. Preview with --dry-run, then repeat with --confirm.') },
          { name: 'allowSecurityAdministration', label: 'Allow security administration', on: securityAdministration,
            text: flag(securityAdministration, 'Organization, user, team, role and token administration also need Allow writes. Resource deletes additionally need Allow destructive deletes. Preview with --dry-run, then repeat with --confirm.') })
      }
      if (tool.name === 'beyondtrust-axi') switches.push({ name: 'allowDeletes', label: 'Allow deletes', on: deletes, text: flag(deletes, 'Deletes also need their exact operation selected below and both native confirmations.') })
      return { capable: writes.capable, readOnlyReason: writes.reason ?? 'No write actions.', blockedTitle: awx ? 'Capability boundary' : 'Always blocked', blocked: writes.blocked, unlocks: writes.unlocks,
        grant: writes.enabled ? `Current grant: ${writes.unlocks}` : 'No write actions are currently granted.',
        unsupported: Boolean(writes.supportedOperations && writes.allowedOperations.some(operation => !writes.supportedOperations!.includes(operation))),
        confirmation: 'Save write access and the selected operations for this tool? Other native settings stay unchanged. Turning writes on allows the actions described on this page; turning writes off blocks them. This change is audited.',
        switches, operations: writes.capable && writes.supportedOperations ? operationsProps(writes.supportedOperations) : null }
    }

    function operationsProps(supported: readonly string[]): NonNullable<WritesProps['operations']> {
      const selected = new Set(writes.allowedOperations)
      const kind = instanceRows[0]?.instance?.metadata.kind
      const groups = operationGroups(tool.name, supported, kind)
      const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
      const show = query.show === 'selected' || query.show === 'deletes' ? query.show : 'all'
      const filtered = Boolean(search) || show !== 'all'
      const matches = (operation: Operation) => (!search || `${operation.label} ${operation.name}`.toLowerCase().includes(search))
        && (show === 'all' || (show === 'selected' ? selected.has(operation.name) : operation.risk.includes('delete')))
      const families = new Set(groups.map(group => group.family).filter(Boolean))
      const family = typeof kind === 'string' && families.has(kind) ? kind : undefined
      return { supported: supported.length, selected: selected.size, q: query.q ?? '', show, empty: !groups.some(group => group.operations.some(matches)),
        familyNote: family ? ` Operations for your ${family.toUpperCase()} deployment are listed first.` : '',
        deleteCount: groups.reduce((total, group) => total + group.operations.filter(operation => operation.risk.includes('delete')).length, 0),
        groups: groups.map((group, index) => {
          const picked = group.operations.filter(operation => selected.has(operation.name)).length
          const visible = group.operations.some(matches)
          return { title: group.title, family: group.family?.toUpperCase() ?? null, picked, deletes: group.operations.filter(operation => operation.risk.includes('delete')).length,
            notUsed: Boolean(group.family && group.family !== family && family), open: filtered ? visible : picked > 0 || index === 0, hidden: filtered && !visible,
            operations: group.operations.map(operation => ({ name: operation.name, label: operation.label, search: `${operation.label} ${operation.name}`.toLowerCase(),
              delete: operation.risk.includes('delete'), bulk: operation.risk.includes('bulk'), checked: selected.has(operation.name), hidden: !matches(operation) })) }
        }) }
    }
  })
  registerInstancePages(app, db, credentialProfiles)
}
