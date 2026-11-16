import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminAuditExportRoute, adminAuditRoute, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { diagnosticCode } from '../../shared/diagnostic.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { auditOutcome, badge } from './design/status.js'
import { icon } from './design/ui.js'
import { escape } from './escape.js'
import { timestamp } from './forms.js'
import { renderPage } from './render-page.js'
import type { Audit, AuditRecord } from '../audit/audit.js'
import { settingsChangesArgumentsSchema } from '../audit/settings-diff.js'

// Rolling presets resolve to an inclusive UTC start when the page is requested.
const ranges = { '24h': { label: '24 h', ms: 24 * 3600_000 }, '7d': { label: '7 days', ms: 7 * 24 * 3600_000 } } as const
const timeFields = ['occurred_at', 'checked_at', 'cutoff']

export function registerAuditPage(app: FastifyInstance, db: Database.Database, audit: Audit): void {
  app.get('/admin/audit', async (request, reply) => {
    requireBrowserAdmin(db, request.cookies[browserCookie] ?? '', false)
    const current = readBrowserSession(db, request.cookies[browserCookie]!)
    // Empty form fields mean no filter; the API itself accepts only explicit valid filters.
    // `range` and `record` are page state: the time preset and the record shown in the detail panel.
    const { range, record: selectedId, ...filters } = Object.fromEntries(Object.entries(request.query as Record<string, unknown>)
      .filter(([, value]) => value !== ''))
    const query = adminAuditRoute.input.safeParse(filters)
    if (!query.success || (range !== undefined && range !== '24h' && range !== '7d' && range !== 'custom') ||
      (selectedId !== undefined && !/^[1-9]\d{0,15}$/.test(String(selectedId)))) throw new ArtiumError('INVALID_INPUT')
    const preset = range === '24h' || range === '7d' ? ranges[range] : undefined
    const applied = { ...query.data, ...(preset ? { from: new Date(Date.now() - preset.ms).toISOString(), to: undefined } : {}) }
    const params = new URLSearchParams(Object.entries(applied).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
    const response = await app.inject({ method: 'GET', url: adminAuditRoute.path + '?' + params,
      headers: { cookie: request.headers.cookie ?? '' } })
    if (response.statusCode !== 200) return reply.code(response.statusCode).type('application/json').send(response.body)
    const page = adminAuditRoute.response.parse(response.json())
    const users = db.prepare('SELECT id, username FROM users ORDER BY username').all() as { id: string, username: string }[]
    const distinct = (column: 'event' | 'outcome' | 'instance', selected: string | undefined) => {
      const values = (db.prepare(`SELECT DISTINCT ${column} AS value FROM audit WHERE ${column} IS NOT NULL ORDER BY ${column}`).all() as { value: string }[]).map(row => row.value)
      return selected && !values.includes(selected) ? [...values, selected] : values
    }
    const names = new Map(users.map(user => [user.id, user.username]))
    const actor = (id: string | null) => id === null ? 'System' : names.get(id) ?? id

    // Links keep every filter the page was opened with, so they change one thing at a time.
    const state = new URLSearchParams(Object.entries({ ...query.data, range }).filter(([key, value]) => value !== undefined && key !== 'cursor' &&
      !(key === 'limit' && value === 50)).map(([key, value]) => [key, String(value)]))
    const link = (change: Record<string, string | undefined>) => {
      const next = new URLSearchParams(state)
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) next.delete(key)
        else next.set(key, value)
      }
      return '/admin/audit' + (next.size ? '?' + next : '')
    }

    const custom = range === 'custom' || (!preset && (query.data.from !== undefined || query.data.to !== undefined))
    const chip = (name: 'user' | 'tool' | 'instance' | 'event' | 'outcome', label: string, options: { value: string, text: string }[]) =>
      ({ name, label, value: query.data[name] ?? '', clearHref: query.data[name] ? link({ [name]: undefined }) : null, options })
    const filtered = [...state.keys()].some(key => key !== 'limit')
    const filterProps = {
      requestId: query.data.requestId ?? '', delegationId: query.data.delegationId ?? '',
      range: [{ label: 'Any time', href: link({ range: undefined, from: undefined, to: undefined }), current: !preset && !custom },
        { label: ranges['24h'].label, href: link({ range: '24h', from: undefined, to: undefined }), current: range === '24h' },
        { label: ranges['7d'].label, href: link({ range: '7d', from: undefined, to: undefined }), current: range === '7d' },
        custom ? { label: 'Custom', href: '#audit-from', current: true } : { label: 'Custom', href: link({ range: 'custom', from: undefined, to: undefined }), current: false }],
      failed: query.data.failed === '1' ? { on: true, href: link({ failed: undefined }) } : { on: false, href: link({ failed: '1' }) },
      chips: [chip('user', 'User', users.map(user => ({ value: user.id, text: user.username }))),
        chip('tool', 'Tool', toolSchema.options.map(tool => ({ value: tool, text: tool }))),
        chip('instance', 'Instance', distinct('instance', query.data.instance).map(instance => ({ value: instance, text: instance }))),
        chip('event', 'Event', distinct('event', query.data.event).map(event => ({ value: event, text: event }))),
        chip('outcome', 'Outcome', distinct('outcome', query.data.outcome).map(outcome => ({ value: outcome, text: outcome })))],
      // Error code has no chip of its own; a link that sets it can still be read and cleared here.
      errorCode: query.data.errorCode ? { value: query.data.errorCode, clearHref: link({ errorCode: undefined }) } : null,
      hidden: [...range ? [{ name: 'range', value: range }] : [], ...query.data.failed ? [{ name: 'failed', value: query.data.failed }] : [],
        ...query.data.limit !== 50 ? [{ name: 'limit', value: String(query.data.limit) }] : []],
      custom: custom ? { from: query.data.from ?? '', to: query.data.to ?? '' } : null, clear: filtered }

    const selected = selectedId === undefined ? undefined : db.prepare('SELECT * FROM audit WHERE id = ?').get(selectedId) as AuditRecord | undefined
    if (selected) selected.error_code = diagnosticCode(selected.error_code)
    const rows = page.records.map(record => ({ href: link({ record: String(record.id), cursor: query.data.cursor }), current: record.id === selected?.id,
      time: new Date(record.occurred_at).toISOString(), event: record.event, breakGlass: record.authentication_method === 'break-glass',
      actor: record.user_id === null ? null : actor(record.user_id), tool: record.tool, instance: record.instance ?? null, outcome: auditOutcome(record) }))

    const close = link({ cursor: query.data.cursor })
    let panel = ''
    if (selected) {
      const outcome = auditOutcome(selected)
      const diagnostic = selected.event === 'run-terminal' ? audit.runDiagnostic(selected.request_id) : undefined
      const settingsChanges = selected.event === 'admin-change' && selected.arguments !== null
        ? settingsChangesArgumentsSchema.safeParse(JSON.parse(selected.arguments)).data?.settings : undefined
      const fields = Object.entries(selected)
      const facts = [['Actor', escape(actor(selected.user_id))], ['Tool', escape(selected.tool ?? 'None')], ...(selected.instance ? [['Instance', escape(selected.instance)]] : []), ['Outcome', badge(outcome.word, outcome.tone)],
        ['Request ID', `<span class="copyfield" data-copy-scope><input value="${escape(selected.request_id)}" readonly aria-label="Request ID"><button type="button" class="btn btn-ghost btn-icon btn-sm" data-copy aria-label="Copy request ID">${icon('copy')}</button><span class="sr-only" data-copy-status role="status"></span></span>`],
        ['Client address', escape(selected.client_address ?? 'Not recorded')], ['Sign-in method', escape(selected.authentication_method ?? 'Not recorded')],
        ...(selected.action ? [['Action', `<span class="mono">${escape(selected.action)}</span>`]] : []), ...(selected.error_code ? [['Error code', `<span class="mono">${escape(selected.error_code)}</span>`]] : [])]
      panel = `<aside class="sheet docked" id="record" aria-labelledby="record-title"><div class="sheet-head"><div><h2 id="record-title">${escape(selected.event)} · ${outcome.tone === 'err' ? 'failed' : outcome.tone === 'ok' ? 'succeeded' : escape(outcome.word)}</h2>
        <p>${timestamp(selected.occurred_at)} · #${escape(selected.id)}</p></div><a class="btn btn-ghost btn-icon btn-sm" href="${escape(close)}" aria-label="Close details">${icon('x')}</a></div>
        <div class="sheet-body"><dl class="kv">${facts.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('')}</dl>
        ${settingsChanges ? `<div><h3>Settings changes</h3><dl class="kv">${settingsChanges.map(change => {
          const show = (value: unknown) => value === null ? 'unset' : JSON.stringify(value)
          const text = 'added' in change
            ? [...change.added.map(item => '+ ' + show(item)), ...change.removed.map(item => '- ' + show(item))].join('\n')
            : `${show(change.before)} → ${show(change.after)}`
          return `<dt class="mono">${escape(change.path.join('.'))}</dt><dd><pre class="code">${escape(text)}</pre></dd>`
        }).join('')}</dl></div>` : ''}
        ${diagnostic ? `<div><h3>Failure diagnostic</h3><pre class="code">${escape(JSON.stringify(diagnostic, null, 2))}</pre></div>` : ''}
        <details class="all-fields"><summary class="btn btn-secondary btn-sm">Show all ${fields.length} stored fields</summary><dl class="kv">${fields.map(([key, value]) =>
          `<dt>${escape(key)}</dt><dd>${value === null ? 'Not recorded' : timeFields.includes(key) ? timestamp(Number(value)) : escape(value)}</dd>`).join('')}</dl></details></div></aside>`
    } else if (selectedId !== undefined) {
      panel = `<aside class="sheet docked" id="record" aria-labelledby="record-title"><div class="sheet-head"><div><h2 id="record-title">Record not found</h2>
        <p>Record #${escape(selectedId)} is no longer retained or does not exist.</p></div><a class="btn btn-ghost btn-icon btn-sm" href="${escape(close)}" aria-label="Close details">${icon('x')}</a></div></aside>`
    }

    const exports = new URLSearchParams(params)
    exports.delete('limit')
    exports.delete('cursor')
    const download = (format: 'csv' | 'jsonl') => adminAuditExportRoute.path + '?' + new URLSearchParams([...exports, ['format', format]])
    return renderPage(reply, 'Audit log', 'audit', { filters: filterProps, exports: { csv: download('csv'), jsonl: download('jsonl') }, rows, detail: panel || null,
      pager: { summary: `Showing ${rows.length} record${rows.length === 1 ? '' : 's'}`, newest: query.data.cursor ? link({}) : null,
        older: page.nextCursor ? link({ cursor: page.nextCursor }) : null } }, current, 'Sign-ins, admin changes and tool calls. Kept for 90 days.')
  })
}
