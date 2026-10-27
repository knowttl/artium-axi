import type Database from 'better-sqlite3'
import type { BrowserSession } from '../auth/sessions.js'
import { listUserSessions } from '../auth/user-sessions.js'
import { escape } from './escape.js'
import { sessionTable } from './session-table.js'
import { transferLimits, transferWarning } from '../../shared/api.js'

export function accountContent(db: Database.Database, current: BrowserSession, csrf: string, origin: string): string {
  const roles = db.prepare(`SELECT DISTINCT roles.name FROM roles JOIN user_roles ON roles.id = user_roles.role_id
    WHERE user_roles.user_id = ? ORDER BY roles.name`).all(current.user_id) as { name: string }[]
  const tools = db.prepare(`SELECT DISTINCT tools.name, tools.enabled FROM tools
    JOIN role_tools ON role_tools.tool = tools.name JOIN user_roles ON user_roles.role_id = role_tools.role_id
    WHERE user_roles.user_id = ? ORDER BY tools.name`).all(current.user_id) as { name: string, enabled: number }[]
  const transfers = db.prepare(`SELECT tool, artifact_type, artifact_selector, archive_bytes, archive_sha256, outcome, client_save_outcome,
    native_journal_result, EXISTS(SELECT 1 FROM audit AS delivery WHERE delivery.transfer_id = prior.transfer_id
      AND delivery.outcome = 'delivery-completed') AS delivered
    FROM audit AS prior WHERE event = 'transfer' AND user_id = ? AND NOT EXISTS
      (SELECT 1 FROM audit AS later WHERE later.transfer_id = prior.transfer_id AND later.id > prior.id)
    ORDER BY id DESC LIMIT 20`).all(current.user_id) as { tool: string, artifact_type: string, artifact_selector: string,
      archive_bytes: number | null, archive_sha256: string | null, outcome: string, client_save_outcome: string,
      native_journal_result: string | null, delivered: number }[]
  return `<section><h2>Your account</h2><p>${escape(current.display_name)} (${escape(current.username)}). ${current.source === 'sso' ? 'SSO sign-in' : 'Local password sign-in'}.</p>
    <p>Roles: ${roles.map(role => escape(role.name)).join(', ') || 'None'}.</p>${current.source === 'local' ? '<p><a href="/password">Change password</a></p>' : ''}</section>
    <section><h2>Your tools</h2><p>Roles determine your tool access. Ask an administrator to change your roles or configure a tool.</p>
    ${tools.length ? `<div class="table-scroll"><table><caption>Granted tools</caption><thead><tr><th>Tool</th><th>Access</th></tr></thead><tbody>${tools.map(tool =>
      `<tr><th scope="row">${escape(tool.name)}</th><td>${tool.enabled ? 'Enabled' : 'Tool disabled'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No tools granted. Ask an administrator to assign a role that grants the tools you need.</p>'}</section>
    <section><h2>Use the CLI</h2><p>On Linux, install Node 22.12 or later, curl and sha256sum. Download the client and checksum from this trusted server, verify before running, then make it executable. For a private CA, add --cacert with your CA file to both curl commands and set ARTIUM_AXI_CA_FILE for the CLI. Keep certificate verification enabled.</p>
    <p><a href="/cli/artium-axi.mjs">Download CLI</a> | <a href="/cli/artium-axi.mjs.sha256">Download SHA-256 checksum</a></p>
    <pre>${escape(`export ARTIUM_AXI_URL=${shellQuote(origin)}
curl --fail --output artium-axi.mjs "$ARTIUM_AXI_URL/cli/artium-axi.mjs" &&
curl --fail --output artium-axi.mjs.sha256 "$ARTIUM_AXI_URL/cli/artium-axi.mjs.sha256" &&
sha256sum --check artium-axi.mjs.sha256 &&
chmod 755 artium-axi.mjs`)}</pre><p>Stop if download or verification fails. The checksum detects corruption; trust the server URL first.</p>
    <pre>${escape(`${current.source === 'sso' ? './artium-axi.mjs login --sso' : './artium-axi.mjs login --username ' + shellQuote(current.username)}
./artium-axi.mjs tools
./artium-axi.mjs setup --host codex`)}</pre><p>${current.source === 'sso' ? 'Open the displayed /device URL in any browser, enter your terminal code, choose your sign-in provider and review the requesting IP and time. Approve only a request you started on a device you control. Choose “This wasn\'t me” for an unexpected request. Codes expire after 10 minutes; CLI access ends after 8 hours and requires a new sign-in. This works on headless and SSH hosts without enabling an identity provider device-code grant.' : 'Login prompts for your password without displaying it. If a temporary password must be changed, run ./artium-axi.mjs passwd, then sign in again.'} After sign-in, setup installs skills for your granted tools; re-run it after new grants. Use --host claude, --host opencode or --host pi for those hosts.</p></section>
    ${tools.some(tool => tool.name === 'hybrid-axi' || tool.name === 'checkpoint-axi') ? `<section><h2>${tools.some(tool => tool.name === 'hybrid-axi') ? 'Hybrid Analysis archive saving' : 'Check Point email and attachment saving'}</h2>
      <p>${escape(transferWarning)}</p><p>Use the local CLI on a dedicated controlled Linux analysis client.
      The browser provides guidance and metadata only. Artifact bytes are never saved, rendered, opened or executed here.
      Downloads require administrator selection of the requested write operation and a configured dedicated artifact mount.</p>
      <p>Run <code>artium-axi download --help</code> for preview and explicit save commands.
      Choose a new absolute destination in a dedicated private directory (mode 0700), with no symlink components.
      Review type, exact selector, local destination, the ${transferLimits.artifactBytes / 1024 ** 2} MiB limit (50 MiB for Check Point) and exact expiry before executing.
      Limits are ${transferLimits.reservationsPerUser} reservation per user, ${transferLimits.reservations} globally and ${transferLimits.reservedBytes / 1024 ** 3} GiB total artifact capacity.
      The ten-minute deadline includes generation and retrieval. There is no resume or automatic retry.</p>
      ${tools.some(tool => tool.name === 'hybrid-axi') ? `<pre>artium-axi download --operation report-download-bin --selector &lt;report-id&gt; --type bin --destination /controlled/artifacts/new-archive.bin${current.source === 'sso' ? ' --sso' : ''}</pre>` : ''}
      <p>After preview, repeat the exact selection and destination with <code>--transfer &lt;transferId&gt; --execute --confirm &lt;exact-confirm&gt;</code>.
      The CLI reports archive size, archive SHA-256 and local save outcome. Server delivery completion is separate from upstream success and verified saving.
      Missing verified-save receipt remains unconfirmed. Absolute local paths are not stored by the server.</p>
      ${tools.some(tool => tool.name === 'hybrid-axi') ? `<p>HTTP 403 with KEY_LEVEL_RESTRICTED requires vetted-account download access. PERMISSION_DENIED with unknown key level does not prove restriction.
      Administrator write settings cannot grant upstream entitlement. Never retry another key or route.</p>` : ''}
      ${tools.some(tool => tool.name === 'checkpoint-axi') ? `${tools.some(tool => tool.name === 'hybrid-axi') ? '<h3>Check Point email and attachment saving</h3>' : ''}<p>Select email.download (type email or original), attachment.download (type attachment; selector entity-id/attachment-id) or attachment.download-all (type zip).
      Each requires its own administrator selection. Check Point uses host-owned confirmation and evidence, a 50 MiB cap, mandatory upstream SHA-256 and independent host byte verification.
      It has no native download journal. Scope and email/ZIP hash availability remain uncommissioned; ZIP responses may be partial.</p>
      <pre>artium-axi download --operation email.download --selector &lt;entity-id&gt; --type email --destination /controlled/artifacts/new-message.eml${current.source === 'sso' ? ' --sso' : ''}</pre>` : ''}
      ${transfers.length ? `<div class="table-scroll"><table><caption>Your latest 20 archive transfers</caption><thead><tr><th>Tool</th><th>Type</th><th>Selector</th><th>Bytes</th><th>Archive SHA-256</th><th>Native outcome</th><th>Delivery</th><th>Service outcome</th><th>Client save receipt</th></tr></thead><tbody>${transfers.map(row => `<tr><td>${escape(row.tool)}</td><td>${escape(row.artifact_type)}</td><td>${escape(row.artifact_selector)}</td><td>${row.archive_bytes ?? 'Unknown'}</td><td>${escape(row.archive_sha256 ?? 'Unknown')}</td><td>${escape(row.tool === 'checkpoint-axi' ? 'Host-owned evidence; no native journal' : row.native_journal_result ?? 'Unknown')}</td><td>${row.delivered ? 'Completed' : 'Unconfirmed'}</td><td>${escape(row.outcome)}</td><td>${escape(row.client_save_outcome)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No archive transfers recorded.</p>'}</section>` : ''}
    ${sessionTable(csrf, '/v1/account/sessions', listUserSessions(db, current.user_id, current.family_id).sessions)}`
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}
