import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminAuditExportRoute, adminAuditRoute, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { timestamp } from './forms.js'

export function registerAuditPage(app: FastifyInstance, db: Database.Database): void {
  app.get('/admin/audit', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    // Empty form fields mean no filter; the API itself accepts only explicit valid filters.
    const query = adminAuditRoute.input.safeParse(Object.fromEntries(Object.entries(request.query as Record<string, unknown>)
      .filter(([, value]) => value !== '')))
    if (!query.success) throw new ArtiumError('INVALID_INPUT')
    const params = new URLSearchParams(Object.entries(query.data).map(([key, value]) => [key, String(value)]))
    const response = await app.inject({ method: 'GET', url: adminAuditRoute.path + '?' + params,
      headers: { cookie: request.headers.cookie ?? '' } })
    if (response.statusCode !== 200) return reply.code(response.statusCode).type('application/json').send(response.body)
    const page = adminAuditRoute.response.parse(response.json())
    const users = db.prepare('SELECT id, username FROM users ORDER BY username').all() as { id: string, username: string }[]
    const events = db.prepare('SELECT DISTINCT event FROM audit ORDER BY event').all() as { event: string }[]
    if (query.data.event && !events.some(row => row.event === query.data.event)) events.push({ event: query.data.event })
    const selected = (value: string | undefined, candidate: string) => value === candidate ? ' selected' : ''
    const filters = `<form method="get" action="/admin/audit">
      <label>User <select name="user"><option value="">All users</option>${users.map(user => `<option value="${escape(user.id)}"${selected(query.data.user, user.id)}>${escape(user.username)}</option>`).join('')}</select></label>
      <label>Tool <select name="tool"><option value="">All tools</option>${toolSchema.options.map(tool => `<option${selected(query.data.tool, tool)}>${tool}</option>`).join('')}</select></label>
      <label>Event <select name="event"><option value="">All events</option>${events.map(({ event }) => `<option value="${escape(event)}"${selected(query.data.event, event)}>${escape(event)}</option>`).join('')}</select><small>Event types currently in retained history, such as sign-in or admin-change.</small></label>
      <label>Outcome <input name="outcome" value="${escape(query.data.outcome ?? '')}" placeholder="success, completed, or error code"><small>Exact match, such as success, completed or TOOL_NOT_GRANTED.</small></label>
      <label>Error code <input name="errorCode" value="${escape(query.data.errorCode ?? '')}" placeholder="PERMISSION_DENIED"><small>Exact stored failure code, such as a tool failure code or CREDENTIAL_INVALID.</small></label>
      <label>From (UTC, inclusive) <input name="from" value="${escape(query.data.from ?? '')}" placeholder="2026-01-01T00:00:00Z"><small>Include records at or after this UTC instant; leave blank for no start date.</small></label>
      <label>To (UTC, inclusive) <input name="to" value="${escape(query.data.to ?? '')}" placeholder="2026-01-31T23:59:59Z"><small>Include records at or before this UTC instant; leave blank for no end date.</small></label>
      <label>Records per page <input name="limit" type="number" min="1" max="100" value="${escape(query.data.limit)}" required></label>
      <button>Apply filters</button> <a href="/admin/audit">Clear filters</a></form>`
    const names = new Map(users.map(user => [user.id, user.username]))
    const records = page.records.map(record => `<tr><td>${timestamp(record.occurred_at)}</td>
      <td><details><summary>${record.authentication_method === 'break-glass' ? '<strong>Break-glass</strong> ' : ''}${escape(record.event)} <small>#${escape(record.id)}</small></summary><dl>${Object.entries(record).map(([key, value]) =>
        `<dt>${escape(key)}</dt><dd>${value === null ? 'Not recorded' : ['occurred_at', 'checked_at', 'cutoff'].includes(key) ? timestamp(Number(value)) : escape(value)}</dd>`).join('')}</dl></details></td>
      <td>${escape(record.user_id === null ? 'System' : names.get(record.user_id) ?? record.user_id)}</td>
      <td>${escape(record.tool ?? 'None')}</td><td>${escape(record.outcome)}</td></tr>`).join('')
    params.delete('cursor')
    const first = '/admin/audit?' + params
    const exports = new URLSearchParams(params)
    exports.delete('limit')
    const downloads = (['csv', 'jsonl'] as const).map(format => {
      exports.set('format', format)
      return `<a download href="${escape(adminAuditExportRoute.path + '?' + exports)}">Download ${format === 'csv' ? 'CSV' : 'JSON lines'}</a>`
    }).join(' | ')
    if (page.nextCursor) params.set('cursor', page.nextCursor)
    const content = `${filters}
      <p>${downloads}</p><p>Downloads include all retained records matching the applied filters, across every page.</p>
      ${records ? `<div class="table-scroll"><table class="audit-table"><caption>Audit records</caption><thead><tr><th scope="col">Time</th><th scope="col">Event and details</th><th scope="col">User</th><th scope="col">Tool</th><th scope="col">Outcome</th></tr></thead><tbody>${records}</tbody></table></div>` : '<p>No audit records match these filters.</p>'}
      <p><a href="${escape(first)}">First page</a>${page.nextCursor ? ` | <a href="${escape('/admin/audit?' + params)}">Next page</a>` : ''}</p>`
    return browserPage(reply, 'Audit', content, current)
  })
}
