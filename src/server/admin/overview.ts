import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { card, icon, type IconName } from './design/ui.js'
import { escape } from './escape.js'

const steps: { title: string, detail: string, href: string, action: string, icon: IconName }[] = [
  { title: 'Connect a tool', detail: 'Save a credential, pass its test, then enable the tool. Writes stay off until you turn them on.', href: '/admin/tools', action: 'Open Tools', icon: 'box' },
  { title: 'Create a role', detail: 'Choose which tools the role grants.', href: '/admin/roles', action: 'Open Roles', icon: 'shield' },
  { title: 'Give people roles', detail: 'Add local users or invite SSO users, then assign their roles.', href: '/admin/users', action: 'Open People', icon: 'users' },
  { title: 'Turn on single sign-on (optional)', detail: 'Choose a break-glass admin first, then set up and enable a provider.', href: '/admin/settings/sign-in', action: 'Open Sign-in & SSO', icon: 'key' },
]

export function registerOverviewPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin', async (request, reply) => {
    // The users list lived here before Overview; keep its filtered and paged bookmarks working.
    const query = request.url.indexOf('?')
    if (query !== -1) return reply.redirect('/admin/users' + request.url.slice(query), 301)
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    const rows = steps.map((step, index) => `<li class="list-row"><span class="step-mark">${index + 1}</span><div class="grow"><strong>${escape(step.title)}</strong><p>${escape(step.detail)}</p></div><a class="btn btn-secondary btn-sm" href="${step.href}">${icon(step.icon)}${escape(step.action)}</a></li>`).join('')
    const content = card('Set up access', 'A person can run a tool only when every link holds. Work through these in order.', `<ol class="rows">${rows}</ol>`) +
      `<p class="note">${icon('list')}<span>Every change is recorded in the <a href="/admin/audit">audit log</a>.</span></p>`
    return browserPage(reply, 'Overview', content, current, 'Start here to connect tools and give people access.')
  })
}
