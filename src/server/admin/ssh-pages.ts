import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SshAdminHost } from '../../shared/ssh-admin.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { escape } from './escape.js'
import { apiForm, revision } from './forms.js'
import { card, checkOption, field } from './design/ui.js'

export function registerSshPages(app: FastifyInstance, db: Database.Database, authorize: (request: FastifyRequest) => string,
  readHosts: () => { hosts: SshAdminHost[], bindings: unknown[], grants: unknown[] },
  readCredentials: () => { credentials: unknown[] }): void {
  const text = (prefix: string, name: string, label: string, value: unknown = '', type = 'text') => field(`${prefix}-${name}`, label,
    attrs => `<input ${attrs} name="${name}" type="${type}"${type === 'number' ? ' data-type="number"' : ''} value="${escape(value)}" required>`)
  const boolean = (name: string, label: string, value: boolean) => checkOption(`<input type="checkbox" name="${name}" data-type="boolean"${value ? ' checked' : ''}>`, label)
  const json = (prefix: string, name: string, label: string, value: string[]) => field(`${prefix}-${name}`, label,
    attrs => `<textarea ${attrs} name="${name}" data-type="json" rows="3" required>${escape(JSON.stringify(value))}</textarea>`)
  const proof = '<input type="hidden" name="confirm" data-type="boolean" value="true">'
  const links = '<p><a href="/admin/ssh">Hosts, bindings and grants</a> · <a href="/admin/ssh/credentials">Encrypted credentials</a> · <a href="/admin/tools/ssh-axi">Tool access</a></p>'
  const parent = { href: '/admin/tools/ssh-axi', label: 'SSH' }
  app.get('/admin/ssh', async (request, reply) => {
    authorize(request)
    const csrf = reply.generateCsrf()
    const form = (path: string, label: string, controls: string, consequence: string) => apiForm(csrf, `/v1/admin/ssh/${path}`, 'POST', label,
      proof + controls, consequence, '', 'btn btn-primary')
    const hostForm = (host?: SshAdminHost) => {
      const prefix = host ? `stored-host-${host.id}` : 'new-host'
      return form('hosts', 'Save host', revision(host?.revision ?? 0) + (host
        ? `<input type="hidden" name="id" value="${escape(host.id)}">` : text(prefix, 'id', 'Host ID')) +
        text(prefix, 'address', 'Approved hostname or address', host?.address) + text(prefix, 'port', 'Port', host?.port ?? 22, 'number') +
        json(prefix, 'approvedHostKeys', 'Independently verified server public keys (JSON array)', host?.approvedHostKeys ?? []) +
        json(prefix, 'allowedAddresses', 'Allowed literal IP addresses (JSON array)', host?.allowedAddresses ?? []) +
        text(prefix, 'independentVerification', 'Independent verification reference', host?.independentVerification) +
        boolean('enabled', 'Enable this host', host?.enabled ?? false) + boolean('readOnly', 'Keep this host read only', host?.readOnly ?? true) +
        text(prefix, 'commandSeconds', 'Maximum command seconds (1-600)', host?.commandSeconds ?? 600, 'number') +
        text(prefix, 'outputBytes', 'Maximum output bytes (0-1048576)', host?.outputBytes ?? 65536, 'number') +
        text(prefix, 'idleMinutes', 'Maximum connection idle minutes (1-60)', host?.idleMinutes ?? 60, 'number'),
        'Save this host trust and policy? Existing drafts using its previous revision will become stale.')
    }
    const data = readHosts()
    const credentialRows = readCredentials().credentials as { id: string }[]
    const users = db.prepare('SELECT id, username FROM users WHERE archived_at IS NULL ORDER BY username').all() as { id: string, username: string }[]
    const hostSections = data.hosts.map(host => {
      const context = revision(host.revision) + `<input type="hidden" name="host" value="${escape(host.id)}">`
      const binding = form('binding', 'Save account binding', context + boolean('sudo', 'Separate sudo binding', false) +
        text(host.id, 'username', 'Account username') + field(`${host.id}-credential`, 'Encrypted credential', attrs =>
          `<select ${attrs} name="credential" required><option value="">Select a credential</option>${credentialRows.map(row => `<option value="${escape(row.id)}">${escape(row.id)}</option>`).join('')}</select>`),
        'Replace this account binding? Ordinary and sudo accounts and credentials must differ.')
      const grant = form('grant', 'Save caller grant', context + field(`${host.id}-user`, 'Person', attrs =>
        `<select ${attrs} name="user" required>${users.map(user => `<option value="${escape(user.id)}">${escape(user.username)}</option>`).join('')}</select>`) +
        boolean('shell', 'Allow this person to use the host', false) + boolean('sudo', 'Allow the separate sudo account', false),
        'Replace this caller’s host grant? Tool and role grants remain required. Clearing access revokes subsequent calls.')
      const remove = apiForm(csrf, '/v1/admin/ssh/host-delete', 'POST', 'Delete host', proof + revision(host.revision) +
        `<input type="hidden" name="id" value="${escape(host.id)}">`, 'Delete this host and remove its bindings and caller grants?',
        `data-confirm-name="${escape(host.id)}"`, 'btn btn-danger')
      return card(host.id, `Revision ${host.revision}`, `<div class="card-body"><details><summary>Edit trust and policy</summary>${hostForm(host)}</details><h3>Account binding</h3>${binding}<h3>Caller grant</h3>${grant}<div class="actions">${remove}</div></div>`)
    }).join('')
    return browserPage(reply, 'SSH hosts', links + '<p>Verify server public keys through an independent trusted route before registration. Ordinary and sudo bindings require different accounts and credentials. Remote execution and reusable connections are unavailable.</p>' +
      hostSections + card('Register host', 'New hosts start disabled and read only.', `<div class="card-body">${hostForm()}</div>`) +
      card('Current bindings and grants', 'Reload after each save to use the current host revision.', `<div class="card-body"><pre>${escape(JSON.stringify({ bindings: data.bindings, grants: data.grants }, null, 2))}</pre></div>`),
      readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined, { parent, helpTopic: 'Tools' })
  })
  app.get('/admin/ssh/credentials', async (request, reply) => {
    authorize(request)
    const csrf = reply.generateCsrf()
    const rows = readCredentials().credentials as { id: string, revision: number }[]
    const credentialForm = (row?: { id: string, revision: number }) => {
      const prefix = row ? `stored-credential-${row.id}` : 'new-credential'
      return apiForm(csrf, '/v1/admin/ssh/credential', 'POST', row ? 'Replace credential' : 'Save credential', proof + revision(row?.revision ?? 0) +
        (row ? `<input type="hidden" name="id" value="${escape(row.id)}">` : text(prefix, 'id', 'Credential ID')) +
        field(`${prefix}-privateKey`, 'Private key', attrs => `<textarea ${attrs} name="privateKey" rows="6" autocomplete="off" required></textarea>`) +
        field(`${prefix}-passphrase`, 'Passphrase (optional)', attrs => `<input ${attrs} name="passphrase" type="password" autocomplete="new-password">`),
        'Save a replacement SSH credential? Every secret field is replaced, and existing credential revisions become stale.', '', 'btn btn-primary')
    }
    return browserPage(reply, 'SSH credentials', links + rows.map(row => card(row.id, `Revision ${row.revision}`, `<div class="card-body">${credentialForm(row)}${apiForm(csrf,
      '/v1/admin/ssh/credential-delete', 'POST', 'Delete credential', proof + revision(row.revision) + `<input type="hidden" name="id" value="${escape(row.id)}">`,
      'Delete this credential and remove all its host bindings?', `data-confirm-name="${escape(row.id)}"`, 'btn btn-danger')}</div>`)).join('') +
      card('New encrypted credential', 'Keys and passphrases are never displayed. Replacements require every secret again; blank fields do not retain stored values.', `<div class="card-body">${credentialForm()}</div>`),
      readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined, { parent, helpTopic: 'Tools' })
  })
}
