import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SshAdminHost } from '../../shared/ssh-admin.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { escape } from './escape.js'
import { apiForm, revision } from './forms.js'
import { card, field } from './design/ui.js'
import { renderPage } from './render-page.js'

export function registerSshPages(app: FastifyInstance, db: Database.Database, authorize: (request: FastifyRequest) => string,
  readHosts: () => { hosts: SshAdminHost[], bindings: unknown[], grants: unknown[] },
  readCredentials: () => { credentials: unknown[] }): void {
  const text = (prefix: string, name: string, label: string, value: unknown = '', type = 'text') => field(`${prefix}-${name}`, label,
    attrs => `<input ${attrs} name="${name}" type="${type}"${type === 'number' ? ' data-type="number"' : ''} value="${escape(value)}" required>`)
  const proof = '<input type="hidden" name="confirm" data-type="boolean" value="true">'
  const links = '<p><a href="/admin/ssh">Hosts, bindings and grants</a> · <a href="/admin/ssh/credentials">Encrypted credentials</a> · <a href="/admin/ssh/audit">Execution audit</a> · <a href="/admin/tools/ssh-axi">Tool access</a></p>'
  const parent = { href: '/admin/tools/ssh-axi', label: 'SSH' }
  app.get('/admin/ssh', async (request, reply) => {
    authorize(request)
    const data = readHosts()
    const users = db.prepare('SELECT id, username FROM users WHERE archived_at IS NULL ORDER BY username').all() as { id: string, username: string }[]
    const names = new Map(users.map(user => [user.id, user.username]))
    const bindings = data.bindings as { host: string, sudo: number, username: string, credential: string, revision: number }[]
    const grants = data.grants as { user: string, host: string, shell: number, sudo: number }[]
    return renderPage(reply, 'SSH hosts', 'sshHosts', {
      csrf: reply.generateCsrf(),
      intro: 'Verify server public keys through an independent trusted route before registration. Ordinary and sudo bindings require different accounts and credentials. Confirmed execution requires Allow writes, a writable host and current caller grants. Changing policy or grants fences connections and interrupts active commands; inspect remote state before preparing another uncertain command.',
      hosts: data.hosts.map(host => ({ id: host.id, revision: host.revision, address: host.address, port: host.port, approvedHostKeys: JSON.stringify(host.approvedHostKeys),
        allowedAddresses: JSON.stringify(host.allowedAddresses), independentVerification: host.independentVerification ?? '', enabled: host.enabled, readOnly: host.readOnly,
        commandSeconds: host.commandSeconds, outputBytes: host.outputBytes, idleMinutes: host.idleMinutes })),
      credentials: (readCredentials().credentials as { id: string }[]).map(row => row.id),
      users,
      bindings: bindings.map(binding => ({ ...binding, sudo: Boolean(binding.sudo) })),
      grants: grants.map(grant => ({ host: grant.host, user: grant.user, username: names.get(grant.user) ?? null, shell: Boolean(grant.shell), sudo: Boolean(grant.sudo) })) },
    readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined,
    [{ label: 'Encrypted credentials', href: '/admin/ssh/credentials', variant: 'secondary', icon: 'key' },
      { label: 'Execution audit', href: '/admin/ssh/audit', variant: 'secondary', icon: 'list' },
      { label: 'Tool access', href: '/admin/tools/ssh-axi', variant: 'secondary', icon: 'sliders' }],
    undefined, parent, 'Tools')
  })
  app.get('/admin/ssh/credentials', async (request, reply) => {
    authorize(request)
    const csrf = reply.generateCsrf()
    const rows = readCredentials().credentials as { id: string, revision: number }[]
    const credentialForm = (row?: { id: string, revision: number }) => {
      const prefix = row ? `stored-credential-${row.id}` : 'new-credential'
      const form = (method: 'key' | 'password', controls: string) => apiForm(csrf, '/v1/admin/ssh/credential', 'POST', row ? 'Replace credential' : 'Save credential',
        proof + revision(row?.revision ?? 0) + (row ? `<input type="hidden" name="id" value="${escape(row.id)}">` : text(`${prefix}-${method}`, 'id', 'Credential ID')) + controls,
        'Save a replacement SSH credential? Every secret field is replaced, and existing credential revisions become stale.', '', 'btn btn-primary')
      return `<p>Choose one authentication method. Set the username on the host account binding.</p><details name="${escape(prefix)}-auth" open><summary>Use a private key</summary>` +
        form('key', field(`${prefix}-privateKey`, 'Private key', attrs => `<textarea ${attrs} name="privateKey" rows="6" autocomplete="off" required></textarea>`) +
          field(`${prefix}-passphrase`, 'Passphrase (optional)', attrs => `<input ${attrs} name="passphrase" type="password" autocomplete="new-password">`)) +
        `</details><details name="${escape(prefix)}-auth"><summary>Use a password</summary>` +
        form('password', field(`${prefix}-password`, 'Password', attrs => `<input ${attrs} name="password" type="password" autocomplete="off" required>`,
          'A short password will also be withheld from command output and will refuse commands whose text contains it (SECRET_IN_COMMAND), so a longer password avoids unexpected refusals. No minimum length is enforced.')) + '</details>'
    }
    return browserPage(reply, 'SSH credentials', links + rows.map(row => card(row.id, `Revision ${row.revision}`, `<div class="card-body">${credentialForm(row)}${apiForm(csrf,
      '/v1/admin/ssh/credential-delete', 'POST', 'Delete credential', proof + revision(row.revision) + `<input type="hidden" name="id" value="${escape(row.id)}">`,
      'Delete this credential and remove all its host bindings?', `data-confirm-name="${escape(row.id)}"`, 'btn btn-danger')}</div>`)).join('') +
      card('New encrypted credential', 'Keys, passphrases and passwords are never displayed. Replacements require every secret again; blank fields do not retain stored values.', `<div class="card-body">${credentialForm()}</div>`),
      readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined, { parent, helpTopic: 'Tools' })
  })
}
