import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { adminAuditExportRoute, adminAuditRoute, toolSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import { diagnosticCode } from '../../shared/diagnostic.js'
import { browserCookie } from '../auth/browser.js'
import { readBrowserSession, requireBrowserAdmin } from '../auth/sessions.js'
import { auditOutcome } from './design/status.js'
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

    const settingsChanges = selected?.event === 'admin-change' && selected.arguments !== null
      ? settingsChangesArgumentsSchema.safeParse(JSON.parse(selected.arguments)).data?.settings : undefined
    const showSetting = (value: unknown) => value === null ? 'unset' : JSON.stringify(value)
    const detail = selectedId === undefined ? null : { closeHref: link({ cursor: query.data.cursor }), id: String(selectedId), record: selected ? (() => {
      const outcome = auditOutcome(selected)
      const diagnostic = selected.event === 'run-terminal' ? audit.runDiagnostic(selected.request_id) : undefined
      return { heading: `${selected.event} · ${outcome.tone === 'err' ? 'failed' : outcome.tone === 'ok' ? 'succeeded' : outcome.word}`,
        time: new Date(selected.occurred_at).toISOString(), number: selected.id,
        facts: { actor: actor(selected.user_id), tool: selected.tool ?? 'None', instance: selected.instance || null, outcome, requestId: selected.request_id,
          clientAddress: selected.client_address ?? 'Not recorded', signInMethod: selected.authentication_method ?? 'Not recorded', action: selected.action || null, errorCode: selected.error_code || null },
        settingsChanges: (settingsChanges ?? []).map(change => ({ path: change.path.join('.'), text: 'added' in change
          ? [...change.added.map(item => '+ ' + showSetting(item)), ...change.removed.map(item => '- ' + showSetting(item))].join('\n')
          : `${showSetting(change.before)} → ${showSetting(change.after)}` })),
        diagnostic: diagnostic ? JSON.stringify(diagnostic, null, 2) : null,
        fields: Object.entries(selected).map(([name, value]) => ({ name, value: value === null ? null : timeFields.includes(name) ? new Date(Number(value)).toISOString() : String(value),
          time: timeFields.includes(name) })) }
    })() : null }

    const exports = new URLSearchParams(params)
    exports.delete('limit')
    exports.delete('cursor')
    const download = (format: 'csv' | 'jsonl') => adminAuditExportRoute.path + '?' + new URLSearchParams([...exports, ['format', format]])
    return renderPage(reply, 'Audit log', 'audit', { filters: filterProps, exports: { csv: download('csv'), jsonl: download('jsonl') }, rows, detail,
      pager: { summary: `Showing ${rows.length} record${rows.length === 1 ? '' : 's'}`, newest: query.data.cursor ? link({}) : null,
        older: page.nextCursor ? link({ cursor: page.nextCursor }) : null } }, current, 'Sign-ins, admin changes and tool calls. Kept for 90 days.')
  })
}
