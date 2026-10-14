import type Database from 'better-sqlite3'
import type { BrowserSession } from '../auth/sessions.js'
import { listUserSessions } from '../auth/user-sessions.js'
import { escape } from './escape.js'
import { sessionTable } from './session-table.js'

export function accountContent(db: Database.Database, current: BrowserSession, csrf: string, origin: string): string {
  const roles = db.prepare(`SELECT roles.name FROM roles JOIN user_roles ON roles.id = user_roles.role_id
    WHERE user_roles.user_id = ? ORDER BY roles.name`).all(current.user_id) as { name: string }[]
  const tools = db.prepare(`SELECT DISTINCT tools.name, tools.enabled FROM tools
    JOIN role_tools ON role_tools.tool = tools.name JOIN user_roles ON user_roles.role_id = role_tools.role_id
    WHERE user_roles.user_id = ? ORDER BY tools.name`).all(current.user_id) as { name: string, enabled: number }[]
  return `<section><h2>Your account</h2><p>${escape(current.display_name)} (${escape(current.username)}). Local password sign-in.</p>
    <p>Roles: ${roles.map(role => escape(role.name)).join(', ') || 'None'}.</p><p><a href="/password">Change password</a></p></section>
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
    <pre>${escape(`./artium-axi.mjs login --username ${shellQuote(current.username)}
./artium-axi.mjs tools
./artium-axi.mjs setup --host codex`)}</pre><p>Login prompts for your password without displaying it. If a temporary password must be changed, run ./artium-axi.mjs passwd, then sign in again. Setup installs the agent skill; use --host claude or --host opencode for those hosts. SSO sign-in is not available in this phase.</p></section>
    ${sessionTable(csrf, '/v1/account/sessions', listUserSessions(db, current.user_id, current.family_id).sessions)}`
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}
