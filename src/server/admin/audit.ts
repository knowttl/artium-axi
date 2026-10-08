import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminAuditRoute, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { escape } from './escape.js'
import { adminNav } from './forms.js'

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
    const selected = (value: string | undefined, candidate: string) => value === candidate ? ' selected' : ''
    const filters = `<form method="get" action="/admin/audit">
      <label>User <select name="user"><option value="">All users</option>${users.map(user => `<option value="${escape(user.id)}"${selected(query.data.user, user.id)}>${escape(user.username)}</option>`).join('')}</select></label>
      <label>Tool <select name="tool"><option value="">All tools</option>${toolSchema.options.map(tool => `<option${selected(query.data.tool, tool)}>${tool}</option>`).join('')}</select></label>
      <label>Outcome <input name="outcome" value="${escape(query.data.outcome ?? '')}" placeholder="success, completed, or error code"></label>
      <label>From (UTC, inclusive) <input name="from" value="${escape(query.data.from ?? '')}" placeholder="2026-01-01T00:00:00Z"></label>
      <label>To (UTC, inclusive) <input name="to" value="${escape(query.data.to ?? '')}" placeholder="2026-01-31T23:59:59Z"></label>
      <label>Records per page <input name="limit" type="number" min="1" max="100" value="${escape(query.data.limit)}" required></label>
      <button>Apply filters</button> <a href="/admin/audit">Clear filters</a></form>`
    const names = new Map(users.map(user => [user.id, user.username]))
    const records = page.records.map(record => `<section><h2>${escape(record.event)} | ${escape(record.outcome)}</h2>
      <p>UTC: ${escape(new Date(record.occurred_at).toISOString())} | Record: ${escape(record.id)}</p>
      <p>User: ${escape(record.user_id === null ? 'System' : names.get(record.user_id) ?? record.user_id)} | User ID: ${escape(record.user_id ?? '')} | Tool: ${escape(record.tool ?? 'None')}</p>
      <p>Action: ${escape(record.action ?? '')} | Target: ${escape(record.target_id ?? '')} | Request: ${escape(record.request_id)}</p>
      <p>Arguments: ${escape(record.arguments ?? '')}</p>
      <p>Exit: ${escape(record.exit_code ?? '')} | Duration (ms): ${escape(record.duration_ms ?? '')} | Output bytes: stdout ${escape(record.stdout_bytes ?? '')}, stderr ${escape(record.stderr_bytes ?? '')} | Client address: ${escape(record.client_address ?? '')}</p>
      ${record.checked_at !== null || record.credential_revision !== null ? `<p>Credential revision: ${escape(record.credential_revision ?? '')} | Checked (UTC): ${escape(record.checked_at === null ? '' : new Date(record.checked_at).toISOString())} | Error: ${escape(record.error_code ?? '')}</p>` : ''}
      ${record.cutoff !== null ? `<p>Retention cutoff (UTC): ${escape(new Date(record.cutoff).toISOString())} | Deleted: ${escape(record.deleted_count ?? '')}</p>` : ''}</section>`).join('')
    params.delete('cursor')
    const first = '/admin/audit?' + params
    if (page.nextCursor) params.set('cursor', page.nextCursor)
    const content = `${adminNav('Audit')}<p>Signed in as ${escape(current.display_name)}.</p>${filters}
      ${records || '<p>No audit records match these filters.</p>'}
      <p><a href="${escape(first)}">First page</a>${page.nextCursor ? ` | <a href="${escape('/admin/audit?' + params)}">Next page</a>` : ''}</p>
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escape(reply.generateCsrf())}"><button>Sign out</button></form>`
    return browserPage(reply, 'Audit', content)
  })
}
