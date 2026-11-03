import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import type { SshExecutionRow } from '../ssh-executions.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { escape } from './escape.js'
import { card } from './design/ui.js'

export function registerSshAudit(app: FastifyInstance, db: Database.Database,
  authorize: (request: FastifyRequest) => string,
  recordRead: (request: FastifyRequest, user: string, action: string, target?: string) => unknown,
  prune: () => unknown, view: (row: SshExecutionRow, output: boolean) => unknown): void {
  const read = (request: FastifyRequest, output: boolean, action: string) => {
    const user = authorize(request)
    const parsed = z.object({ before: z.coerce.number().int().positive().optional(), id: z.string().max(64).optional() }).strict().safeParse(request.query)
    if (!parsed.success) throw new ArtiumError('INVALID_INPUT')
    prune()
    recordRead(request, user, action)
    const { before, id } = parsed.data
    const rows = db.prepare(`SELECT rowid AS cursor,* FROM ssh_executions WHERE (? IS NULL OR rowid<?)
      AND (? IS NULL OR id=?) ORDER BY rowid DESC LIMIT 51`).all(before ?? null, before ?? null, id ?? null, id ?? null) as (SshExecutionRow & { cursor: number })[]
    return { executions: rows.slice(0, 50).map(row => view(row, output)), count: Math.min(50, rows.length),
      nextCursor: rows.length > 50 ? rows[49].cursor : null,
      connections: db.prepare('SELECT * FROM ssh_connection_events ORDER BY id DESC LIMIT 100').all(),
      denials: db.prepare("SELECT occurred_at,user_id,request_id,outcome FROM audit WHERE tool='ssh-axi' AND event='denial' ORDER BY id DESC LIMIT 100").all() }
  }
  app.get('/v1/admin/ssh/audit', async request => read(request, true, 'ssh-audit-read'))
  app.get('/v1/admin/ssh/audit/export', async (request, reply) => {
    const page = read(request, false, 'ssh-audit-export')
    return reply.header('content-disposition', 'attachment; filename="ssh-executions.json"').send(page)
  })
  app.get('/admin/ssh/audit', async (request, reply) => {
    const page = read(request, true, 'ssh-audit-read')
    const query = new URLSearchParams(request.query as Record<string, string>).toString()
    const links = `<p><a href="/admin/ssh">Hosts, bindings and grants</a> · <a href="/v1/admin/ssh/audit/export${query ? `?${escape(query)}` : ''}">Export this page (metadata only)</a></p>`
    const older = page.nextCursor === null ? '' : `<p><a href="/admin/ssh/audit?before=${page.nextCursor}">Older executions</a></p>`
    return browserPage(reply, 'SSH audit', links + card('Retained executions',
      'Output is untrusted text. Samples expire after 14 days; metadata expires after 90 days. Exports omit output.',
      `<div class="card-body">${page.count ? `<pre>${escape(JSON.stringify(page.executions, null, 2))}</pre>` : '<p>No retained SSH executions.</p>'}${older}</div>`) +
      card('Recent connections and denials', 'Latest 100 connection events and denials.', `<div class="card-body"><pre>${escape(JSON.stringify({ connections: page.connections, denials: page.denials }, null, 2))}</pre></div>`),
    readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined, { parent: { href: '/admin/ssh', label: 'SSH' }, helpTopic: 'Tools' })
  })
}
