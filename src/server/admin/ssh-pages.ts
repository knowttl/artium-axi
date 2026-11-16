import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SshAdminHost } from '../../shared/ssh-admin.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { renderPage } from './render-page.js'

export function registerSshPages(app: FastifyInstance, db: Database.Database, authorize: (request: FastifyRequest) => string,
  readHosts: () => { hosts: SshAdminHost[], bindings: unknown[], grants: unknown[] },
  readCredentials: () => { credentials: unknown[] }): void {
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
    return renderPage(reply, 'SSH credentials', 'sshCredentials', { csrf: reply.generateCsrf(),
      credentials: (readCredentials().credentials as { id: string, revision: number }[]).map(({ id, revision }) => ({ id, revision })) },
    readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined, [
      { label: 'Hosts, bindings and grants', href: '/admin/ssh', variant: 'secondary', icon: 'terminal' },
      { label: 'Execution audit', href: '/admin/ssh/audit', variant: 'secondary', icon: 'list' },
      { label: 'Tool access', href: '/admin/tools/ssh-axi', variant: 'secondary', icon: 'sliders' }],
    undefined, parent, 'Tools')
  })
}
