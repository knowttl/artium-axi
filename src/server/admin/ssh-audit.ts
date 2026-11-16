import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import type { SshExecutionRow } from '../ssh-executions.js'
import { sshExecutionStatus } from '../../shared/ssh-execution.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession } from '../auth/sessions.js'
import { describe } from './design/status.js'
import { renderPage } from './render-page.js'

const streamSchema = z.object({ text: z.string().optional(), receivedBytes: z.number().optional(), retainedBytes: z.number().optional(),
  truncated: z.boolean().optional(), encodingLoss: z.boolean().optional(), withheld: z.boolean().optional() }).passthrough()
const executionSchema = sshExecutionStatus.extend({ account: z.string(), sudo: z.boolean(), command: z.string(), requestId: z.string(),
  startedAt: z.string(), finishedAt: z.string().nullable(), samples: z.string(), diagnostic: z.string().optional(),
  stdout: streamSchema.optional(), stderr: streamSchema.optional() })
type ConnectionEvent = { id: number, connection_id: string, user_id: string, family_id: string, host_id: string, sudo: number, event: string, occurred_at: number, binding: string }
type Denial = { occurred_at: number, user_id: string | null, request_id: string | null, outcome: string }

function streamProps(stream: z.infer<typeof streamSchema> | undefined) {
  if (!stream) return null
  return { text: stream.text ?? null, counts: [`${stream.receivedBytes ?? 0} bytes received`, `${stream.retainedBytes ?? 0} retained`,
    ...stream.truncated ? ['truncated'] : [], ...stream.encodingLoss ? ['encoding loss'] : [], ...stream.withheld ? ['withheld'] : []].join(' · ') }
}

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
      connections: db.prepare('SELECT * FROM ssh_connection_events ORDER BY id DESC LIMIT 100').all() as ConnectionEvent[],
      denials: db.prepare("SELECT occurred_at,user_id,request_id,outcome FROM audit WHERE tool='ssh-axi' AND event='denial' ORDER BY id DESC LIMIT 100").all() as Denial[] }
  }
  app.get('/v1/admin/ssh/audit', async request => read(request, true, 'ssh-audit-read'))
  app.get('/v1/admin/ssh/audit/export', async (request, reply) => {
    const page = read(request, false, 'ssh-audit-export')
    return reply.header('content-disposition', 'attachment; filename="ssh-executions.json"').send(page)
  })
  app.get('/admin/ssh/audit', async (request, reply) => {
    const page = read(request, true, 'ssh-audit-read')
    const query = new URLSearchParams(request.query as Record<string, string>).toString()
    const iso = (time: number) => new Date(time).toISOString()
    return renderPage(reply, 'SSH audit', 'sshAudit', {
      executions: page.executions.map(item => {
        const { stdout, stderr, ...rest } = executionSchema.parse(item)
        return { id: rest.id, host: rest.host, account: rest.account, sudo: rest.sudo, command: rest.command, outcome: describe('execution', rest.outcome),
          startedAt: rest.startedAt, finishedAt: rest.finishedAt, requestId: rest.requestId, samples: rest.samples, termination: rest.termination,
          remoteExit: rest.remoteExit !== null ? String(rest.remoteExit) : rest.remoteSignal ? `Signal ${rest.remoteSignal}` : 'Not reported',
          stdout: streamProps(stdout), stderr: streamProps(stderr), diagnostic: rest.diagnostic ?? null, record: JSON.stringify(rest, null, 2) }
      }),
      older: page.nextCursor === null ? null : `/admin/ssh/audit?before=${page.nextCursor}`,
      connections: page.connections.map(event => ({ id: event.id, time: iso(event.occurred_at), event: event.event, host: event.host_id, sudo: Boolean(event.sudo),
        user: event.user_id, connection: event.connection_id, family: event.family_id, binding: event.binding })),
      denials: page.denials.map(denial => ({ time: iso(denial.occurred_at), user: denial.user_id, requestId: denial.request_id, outcome: denial.outcome })) },
    readBrowserSession(db, request.cookies[browserCookie] ?? ''), undefined, [
      { label: 'Hosts, bindings and grants', href: '/admin/ssh', variant: 'secondary', icon: 'terminal' },
      { label: 'Export this page (metadata only)', href: `/v1/admin/ssh/audit/export${query ? `?${query}` : ''}`, variant: 'secondary', icon: 'download' }],
    undefined, { href: '/admin/ssh', label: 'SSH' }, 'Tools')
  })
}
