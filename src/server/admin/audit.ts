import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminAuditExportRoute, adminAuditRoute, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { browserCookie, browserPage } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { auditOutcome, badge } from './design/status.js'
import { icon, pager } from './design/ui.js'
import { escape } from './escape.js'
import { timestamp } from './forms.js'
import type { Audit } from '../audit/audit.js'

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
    const distinct = (column: 'event' | 'outcome', selected: string | undefined) => {
      const values = (db.prepare(`SELECT DISTINCT ${column} AS value FROM audit ORDER BY ${column}`).all() as { value: string }[]).map(row => row.value)
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
    const segment = (label: string, value: string | undefined, on: boolean) =>
      `<a href="${escape(link({ range: value, from: undefined, to: undefined }))}"${on ? ' class="on" aria-current="true"' : ''}>${escape(label)}</a>`
    const time = `<div class="seg" role="group" aria-label="Time range">${segment('Any time', undefined, !preset && !custom)}${segment(ranges['24h'].label, '24h', range === '24h')}${segment(ranges['7d'].label, '7d', range === '7d')}${
      custom ? '<a href="#audit-from" class="on" aria-current="true">Custom</a>' : segment('Custom', 'custom', false)}</div>`
    const chip = (name: 'user' | 'tool' | 'event' | 'outcome', label: string, options: { value: string, text: string }[]) => {
      const value = query.data[name]
      return `<span class="filter${value ? ' set' : ''}">${value ? `<span>${escape(label)}</span>` : icon('plus')}<select name="${name}" aria-label="${escape(label)}"><option value="">${escape(label)}</option>${
        options.map(option => `<option value="${escape(option.value)}"${option.value === value ? ' selected' : ''}>${escape(option.text)}</option>`).join('')}</select>${
        value ? `<a href="${escape(link({ [name]: undefined }))}" aria-label="Clear ${escape(label.toLowerCase())} filter">${icon('x')}</a>` : ''}</span>`
    }
    const failed = query.data.failed === '1'
      ? `<a class="filter set" href="${escape(link({ failed: undefined }))}" aria-label="Clear filter: Failed runs only"><strong>Failed runs only</strong>${icon('x')}</a>`
      : `<a class="filter" href="${escape(link({ failed: '1' }))}">${icon('plus')}Failed runs only</a>`
    // Error code has no chip of its own; a link that sets it can still be read and cleared here.
    const errorCode = query.data.errorCode
      ? `<span class="filter set"><span>Error code</span><strong>${escape(query.data.errorCode)}</strong><input type="hidden" name="errorCode" value="${escape(query.data.errorCode)}"><a href="${escape(link({ errorCode: undefined }))}" aria-label="Clear error code filter">${icon('x')}</a></span>`
      : ''
    const filtered = [...state.keys()].some(key => key !== 'limit')
    const filterRow = `<form class="filters" method="get" action="/admin/audit" data-filters>
      <label class="input-wrap">${icon('search')}<span class="sr-only">Request ID</span><input name="requestId" value="${escape(query.data.requestId ?? '')}" maxlength="100" placeholder="Request ID"></label>
      ${time}${failed}
      ${chip('user', 'User', users.map(user => ({ value: user.id, text: user.username })))}
      ${chip('tool', 'Tool', toolSchema.options.map(tool => ({ value: tool, text: tool })))}
      ${chip('event', 'Event', distinct('event', query.data.event).map(event => ({ value: event, text: event })))}
      ${chip('outcome', 'Outcome', distinct('outcome', query.data.outcome).map(outcome => ({ value: outcome, text: outcome })))}
      ${errorCode}${range === 'custom' ? '<input type="hidden" name="range" value="custom">' : ''}${query.data.limit !== 50 ? `<input type="hidden" name="limit" value="${query.data.limit}">` : ''}
      ${custom ? `<span class="range-fields"><label for="audit-from">From (UTC)</label><input id="audit-from" name="from" value="${escape(query.data.from ?? '')}" placeholder="2026-01-01T00:00:00Z">
        <label for="audit-to">To (UTC)</label><input id="audit-to" name="to" value="${escape(query.data.to ?? '')}" placeholder="2026-01-31T23:59:59Z"></span>` : ''}
      <button class="btn btn-secondary btn-sm"${custom ? '' : ' data-filters-apply'}>Apply</button>${filtered ? '<a class="btn btn-ghost btn-sm" href="/admin/audit">Clear filters</a>' : ''}</form>`

    const selected = selectedId === undefined ? undefined : page.records.find(record => String(record.id) === selectedId)
    const rows = page.records.map(record => {
      const outcome = auditOutcome(record)
      const open = record === selected
      return `<tr${open ? ' class="sel"' : ''}><th scope="row"><a href="${escape(link({ record: String(record.id), cursor: query.data.cursor }))}"${open ? ' aria-current="true"' : ''}>${timestamp(record.occurred_at)}</a></th>
        <td><span class="mono">${escape(record.event)}</span>${record.authentication_method === 'break-glass' ? ' ' + badge('Break-glass', 'warn') : ''}</td>
        <td${record.user_id === null ? ' class="faint"' : ''}>${escape(actor(record.user_id))}</td><td${record.tool ? '' : ' class="faint"'}>${escape(record.tool ?? '-')}</td><td>${badge(outcome.word, outcome.tone)}</td></tr>`
    }).join('')

    const close = link({ cursor: query.data.cursor })
    let panel = ''
    if (selected) {
      const outcome = auditOutcome(selected)
      const diagnostic = selected.event === 'run-terminal' ? audit.runDiagnostic(selected.request_id) : undefined
      const fields = Object.entries(selected)
      const facts = [['Actor', escape(actor(selected.user_id))], ['Tool', escape(selected.tool ?? 'None')], ['Outcome', badge(outcome.word, outcome.tone)],
        ['Request ID', `<span class="copyfield"><input value="${escape(selected.request_id)}" readonly aria-label="Request ID"><button type="button" class="btn btn-ghost btn-icon btn-sm" data-copy aria-label="Copy request ID">${icon('copy')}</button><span class="sr-only" data-copy-status role="status"></span></span>`],
        ['Client address', escape(selected.client_address ?? 'Not recorded')], ['Sign-in method', escape(selected.authentication_method ?? 'Not recorded')],
        ...(selected.action ? [['Action', `<span class="mono">${escape(selected.action)}</span>`]] : []), ...(selected.error_code ? [['Error code', `<span class="mono">${escape(selected.error_code)}</span>`]] : [])]
      panel = `<aside class="sheet docked" id="record" aria-labelledby="record-title"><div class="sheet-head"><div><h2 id="record-title">${escape(selected.event)} · ${outcome.tone === 'err' ? 'failed' : outcome.tone === 'ok' ? 'succeeded' : escape(outcome.word)}</h2>
        <p>${timestamp(selected.occurred_at)} · #${escape(selected.id)}</p></div><a class="btn btn-ghost btn-icon btn-sm" href="${escape(close)}" aria-label="Close details">${icon('x')}</a></div>
        <div class="sheet-body"><dl class="kv">${facts.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('')}</dl>
        ${diagnostic ? `<div><h3>Failure diagnostic</h3><pre class="code">${escape(JSON.stringify(diagnostic, null, 2))}</pre></div>` : ''}
        <details class="all-fields"><summary class="btn btn-secondary btn-sm">Show all ${fields.length} stored fields</summary><dl class="kv">${fields.map(([key, value]) =>
          `<dt>${escape(key)}</dt><dd>${value === null ? 'Not recorded' : timeFields.includes(key) ? timestamp(Number(value)) : escape(value)}</dd>`).join('')}</dl></details></div></aside>`
    } else if (selectedId !== undefined) {
      panel = `<aside class="sheet docked" id="record" aria-labelledby="record-title"><div class="sheet-head"><div><h2 id="record-title">Record not in these results</h2>
        <p>Record #${escape(selectedId)} is on another page or outside these filters.</p></div><a class="btn btn-ghost btn-icon btn-sm" href="${escape(close)}" aria-label="Close details">${icon('x')}</a></div></aside>`
    }

    const exports = new URLSearchParams(params)
    exports.delete('limit')
    exports.delete('cursor')
    const downloads = (['csv', 'jsonl'] as const).map(format => {
      exports.set('format', format)
      return `<a download href="${escape(adminAuditExportRoute.path + '?' + exports)}">${icon('download')}${format === 'csv' ? 'CSV' : 'JSON lines'}</a>`
    }).join('')
    const exportMenu = `<div class="actions"><details class="menu"><summary class="btn btn-secondary">${icon('download')}Export${icon('chevd')}</summary><div class="popover">
      <p class="popover-note">Uses the current filters. Downloads include all retained records matching the applied filters, across every page.</p>${downloads}</div></details></div>`
    const table = rows ? `<section class="card"><div class="tbl-scroll"><table class="tbl audit-table row-links"><caption class="sr-only">Audit records</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Tool</th><th scope="col">Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${pager(`Showing ${page.records.length} record${page.records.length === 1 ? '' : 's'}`, [{ label: 'Newest', href: query.data.cursor ? link({}) : null },
        { label: 'Older', href: page.nextCursor ? link({ cursor: page.nextCursor }) : null }])}</section>`
      : `<section class="card empty"><h2>No audit records match these filters.</h2><p>Widen the time range or clear a filter.</p>${filtered ? '<a class="btn btn-secondary" href="/admin/audit">Clear filters</a>' : ''}</section>`
    const content = `<div class="split${panel ? ' has-aside' : ''}"><div class="split-main">${filterRow}${table}</div>${panel}</div>`
    return browserPage(reply, 'Audit log', content, current, 'Sign-ins, admin changes and tool calls. Kept for 90 days.', { actions: exportMenu })
  })
}
