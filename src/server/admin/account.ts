import type Database from 'better-sqlite3'
import type { BrowserSession } from '../auth/sessions.js'
import { listUserSessions } from '../auth/user-sessions.js'
import { card, copyBlock, icon, step } from './design/ui.js'
import { status, toolProducts } from './design/status.js'
import { escape } from './escape.js'
import { sessionTable } from './session-table.js'
import { transferLimits, transferWarning, transferWarningFor } from '../../shared/api.js'

const hosts = [['claude', 'Claude'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['pi', 'Pi']] as const
const savingTools = ['hybrid-axi', 'checkpoint-axi', 'mg-axi', 'beyondtrust-axi']

export function accountRoles(db: Database.Database, current: BrowserSession): string[] {
  return (db.prepare(`SELECT DISTINCT roles.name FROM roles JOIN user_roles ON roles.id = user_roles.role_id
    WHERE user_roles.user_id = ? ORDER BY roles.name`).all(current.user_id) as { name: string }[]).map(role => role.name)
}

export function accountContent(db: Database.Database, current: BrowserSession, csrf: string, origin: string): string {
  const tools = db.prepare(`SELECT DISTINCT tools.name, tools.enabled FROM tools
    JOIN role_tools ON role_tools.tool = tools.name JOIN user_roles ON user_roles.role_id = role_tools.role_id
    WHERE user_roles.user_id = ? ORDER BY tools.name`).all(current.user_id) as { name: keyof typeof toolProducts, enabled: number }[]
  const transfers = db.prepare(`SELECT tool, artifact_type, artifact_selector, archive_bytes, archive_sha256, outcome, client_save_outcome,
    native_journal_result, EXISTS(SELECT 1 FROM audit AS delivery WHERE delivery.transfer_id = prior.transfer_id
      AND delivery.outcome = 'delivery-completed') AS delivered
    FROM audit AS prior WHERE event = 'transfer' AND user_id = ? AND NOT EXISTS
      (SELECT 1 FROM audit AS later WHERE later.transfer_id = prior.transfer_id AND later.id > prior.id)
    ORDER BY id DESC LIMIT 20`).all(current.user_id) as { tool: string, artifact_type: string, artifact_selector: string,
      archive_bytes: number | null, archive_sha256: string | null, outcome: string, client_save_outcome: string,
      native_journal_result: string | null, delivered: number }[]
  const has = (name: string) => tools.some(tool => tool.name === name)
  const sso = current.source === 'sso' ? ' --sso' : ''
  const toolGrid = tools.length
    ? `<ul class="tool-grid">${tools.map(tool => `<li><span class="tool-ico" aria-hidden="true">${toolProducts[tool.name].mark}</span><div><strong>${escape(toolProducts[tool.name].name)}</strong>${tool.enabled ? status('Available', 'ok') : status('Turned off by admin', 'off')}</div></li>`).join('')}</ul>`
    : '<p>No tools granted. Ask an administrator to assign a role that grants the tools you need.</p>'
  const download = `export ARTIUM_AXI_URL=${shellQuote(origin)}
curl --fail --output artium-axi.mjs "$ARTIUM_AXI_URL/cli/artium-axi.mjs" &&
curl --fail --output artium-axi.mjs.sha256 "$ARTIUM_AXI_URL/cli/artium-axi.mjs.sha256" &&
sha256sum --check artium-axi.mjs.sha256 &&
chmod 755 artium-axi.mjs`
  const signIn = `${current.source === 'sso' ? './artium-axi.mjs login --sso' : './artium-axi.mjs login --username ' + shellQuote(current.username)}
./artium-axi.mjs tools`
  const signInHelp = current.source === 'sso'
    ? 'Open the displayed /device URL in any browser, enter your terminal code, choose your sign-in provider and review the requesting IP and time. Approve only a request you started on a device you control. Choose “This wasn\'t me” for an unexpected request. Codes expire after 10 minutes; CLI access ends after 8 hours and requires a new sign-in. This works on headless and SSH hosts without enabling an identity provider device-code grant.'
    : 'Login prompts for your password without displaying it. If a temporary password must be changed, run ./artium-axi.mjs passwd, then sign in again.'
  const picker = `<div class="hosts"><div class="seg" role="radiogroup" aria-label="Agent host">${hosts.map(([id, label], index) =>
    `<input type="radio" name="host" id="host-${id}" value="${id}"${index ? '' : ' checked'}><label for="host-${id}">${label}</label>`).join('')}</div>
    ${hosts.map(([id, label]) => `<div class="host-command ${id}">${copyBlock(`Set up ${label}`, `./artium-axi.mjs setup --host ${id}`)}</div>`).join('')}</div>`
  const cli = `<ol class="vsteps">${step(1, 'current', 'Download and verify', `<p>From this trusted server. Stop if download or verification fails; the checksum detects corruption, so trust the server URL first.</p>${copyBlock('Download and verify commands', download)}
      <p class="hint">Private CA? Add <code>--cacert</code> with your CA file to both curl commands and set <code>ARTIUM_AXI_CA_FILE</code> for the CLI. Keep certificate verification enabled. Or download the <a href="/cli/artium-axi.mjs">CLI</a> and its <a href="/cli/artium-axi.mjs.sha256">SHA-256 checksum</a> directly.</p>`)}
    ${step(2, 'todo', 'Sign in', copyBlock('Sign-in commands', signIn) + `<p class="hint">${escape(signInHelp)}</p>`)}
    ${step(3, 'todo', 'Connect your agent', picker + '<p class="hint">Setup installs skills for your granted tools. Run it again after you get new tools.</p>')}</ol>`
  const saving = tools.some(tool => savingTools.includes(tool.name)) ? `<details class="card disclosure"><summary class="list-row">${icon('download')}<div class="grow"><strong>Saving files from tools</strong>
      <p>${tools.filter(tool => savingTools.includes(tool.name)).map(tool => escape(toolProducts[tool.name].name)).join(', ')}. Saves happen only through the CLI on a controlled Linux host; the browser never handles the files.</p></div>${icon('chevd')}</summary><div class="card-body">
      <p>${escape(has('hybrid-axi') || has('checkpoint-axi') ? transferWarning : transferWarningFor(has('beyondtrust-axi') ? 'policy.download' : 'mail.message.export'))}</p><p>Use the local CLI on a dedicated controlled Linux analysis client.
      The browser provides guidance and metadata only. Artifact bytes are never saved, rendered, opened or executed here.
      Downloads require administrator selection of the requested write operation and a configured dedicated artifact mount.</p>
      <p>Run <code>artium-axi download --help</code> for preview and explicit save commands.
      Choose a new absolute destination in a dedicated private directory (mode 0700), with no symlink components.
      Review type, exact selector, local destination, the ${transferLimits.artifactBytes / 1024 ** 2} MiB limit (50 MiB for Check Point, Graph and BeyondTrust) and exact expiry before executing.
      Limits are ${transferLimits.reservationsPerUser} reservation per user, ${transferLimits.reservations} globally and ${transferLimits.reservedBytes / 1024 ** 3} GiB total artifact capacity.
      The ten-minute deadline includes generation and retrieval. There is no resume or automatic retry.</p>
      <p>After preview, repeat the exact selection and destination with <code>--transfer &lt;transferId&gt; --execute --confirm &lt;exact-confirm&gt;</code>.
      The CLI reports archive size, archive SHA-256 and local save outcome. Server delivery completion is separate from upstream success and verified saving.
      Missing verified-save receipt remains unconfirmed. Absolute local paths are not stored by the server.</p>
      ${has('hybrid-axi') ? `<h3>Hybrid Analysis archive saving</h3><pre>artium-axi download --operation report-download-bin --selector &lt;report-id&gt; --type bin --destination /controlled/artifacts/new-archive.bin${sso}</pre>
      <p>HTTP 403 with KEY_LEVEL_RESTRICTED requires vetted-account download access. PERMISSION_DENIED with unknown key level does not prove restriction.
      Administrator write settings cannot grant upstream entitlement. Never retry another key or route.</p>` : ''}
      ${has('checkpoint-axi') ? `<h3>Check Point email and attachment saving</h3><p>Select email.download (type email or original), attachment.download (type attachment; selector entity-id/attachment-id) or attachment.download-all (type zip).
      Each requires its own administrator selection. Check Point uses host-owned confirmation and evidence, a 50 MiB cap, mandatory upstream SHA-256 and independent host byte verification.
      It has no native download journal. Scope and email/ZIP hash availability remain uncommissioned; ZIP responses may be partial.</p>
      <pre>artium-axi download --operation email.download --selector &lt;entity-id&gt; --type email --destination /controlled/artifacts/new-message.eml${sso}</pre>` : ''}
      ${has('mg-axi') ? `<h3>Microsoft Graph mail saving</h3><p>${escape(transferWarningFor('mail.message.export'))}
      Select mail.message.export with type mime and selector mailbox/message-id, or mail.attachment.save with type attachment and selector mailbox/message-id/attachment-id.
      Each requires the mail pack, application sign-in, its exact administrator-selected operation and scoped Exchange Application Mail.Read.
      Host-owned confirmation binds the destination and selection; native journal and SHA-256 are verified before retrieval. Audit selectors are hashed.</p>
      <pre>artium-axi download --operation mail.message.export --selector &lt;mailbox&gt;/&lt;message-id&gt; --type mime --destination /controlled/artifacts/new-message.eml${sso}</pre>` : ''}
      ${has('beyondtrust-axi') ? '<h3>BeyondTrust endpoint content saving</h3><p>Select computer.log.download, policy.download or policy.revision.download with type content and a UUID selector; api-definition.download uses type yaml and selector api. Each operation requires administrator selection. Host-owned confirmation binds the destination and selection; native SHA-256 and bytes are independently verified, with no native download journal. Maximum 50 MiB; save only.</p>' : ''}
      <h3>Your latest 20 archive transfers</h3>
      ${transfers.length ? `<div class="table-scroll"><table><caption class="sr-only">Your latest 20 archive transfers</caption><thead><tr><th>Tool</th><th>Type</th><th>Selector</th><th>Bytes</th><th>Archive SHA-256</th><th>Native outcome</th><th>Delivery</th><th>Service outcome</th><th>Client save receipt</th></tr></thead><tbody>${transfers.map(row => `<tr><td>${escape(row.tool)}</td><td>${escape(row.artifact_type)}</td><td>${escape(row.artifact_selector)}</td><td>${row.archive_bytes ?? 'Unknown'}</td><td>${escape(row.archive_sha256 ?? 'Unknown')}</td><td>${escape(['checkpoint-axi', 'beyondtrust-axi'].includes(row.tool) ? 'Host-owned evidence; no native journal' : row.native_journal_result ?? 'Unknown')}</td><td>${row.delivered ? 'Completed' : 'Unconfirmed'}</td><td>${escape(row.outcome)}</td><td>${escape(row.client_save_outcome)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No archive transfers recorded.</p>'}</div></details>` : ''
  return card('Your tools', 'From your roles. Ask an administrator to change your roles or configure a tool.', `<div class="card-body">${toolGrid}</div>`) +
    card('Set up the CLI', 'Linux with Node 24.11 or later, curl and sha256sum.', `<div class="card-body">${cli}</div>`) +
    saving + sessionTable(csrf, '/v1/account/sessions', listUserSessions(db, current.user_id, current.family_id).sessions)
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}
