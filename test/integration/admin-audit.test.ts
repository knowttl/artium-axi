import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { toolSchema } from '../../src/shared/api.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { browserCookie } from '../../src/server/auth/browser.js'
import { createBrowserSession } from '../../src/server/auth/sessions.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { seedToolUser } from '../fixtures/tokens.js'

type Element = DefaultTreeAdapterMap['element']

let directory: string
let db: Database.Database
let app: ReturnType<typeof createApp>
let headers: Record<string, string>
let at: number
const now = Date.UTC(2026, 0, 15, 12)
const minute = 60_000
const day = 24 * 60 * minute
const key = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
const owner = 'synthetic-development-user'
const second = 'synthetic-second'
const transfer = { transfer_id: 'f105c3b9-a58f-4d4c-bb60-8d17a70b5b86', session_family_id: 'family', transfer_operation: 'hash-download-bin' as const,
  artifact_type: 'bin' as const, artifact_selector: 'a'.repeat(64), requested_target_digest: 'b'.repeat(64), archive_bytes: null, archive_sha256: null,
  native_audit_id: null, native_journal_result: null, client_save_outcome: 'unconfirmed' as const }

const ids: Record<string, number> = {}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  directory = mkdtempSync(join(tmpdir(), 'artium-admin-audit-'))
  db = openStore(join(directory, 'artium.db'), key)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (?, 'second-user', 'Second User', 'CANARY-hash')").run(second)
  const store = createCredentialStore(db, key)
  app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [], credentialStore: store,
    resolver: new SharedIdentityResolver(store, db), environment: {} })
  headers = { host: 'localhost', origin: 'http://localhost', cookie: `${browserCookie}=${createBrowserSession(db, owner, 'CANARY-csrf').id}; _csrf=CANARY-csrf` }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await app.close()
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function seed() {
  const audit = new Audit(db, () => at, () => {})
  const run = { tool: 'falcon-axi' as const, clientAddress: '192.0.2.7', durationMs: 5, outputBytes: { stdout: 0, stderr: 0 } }
  const record = (label: string, offset: number, event: Parameters<Audit['record']>[0]) => {
    at = now + offset
    ids[label] = audit.record(event).id
  }
  record('old-sign-in', -30 * day, { event: 'sign-in', userId: owner, tool: null, outcome: 'success', authenticationMethod: 'local', requestId: 'old-sign-in', clientAddress: '192.0.2.1' })
  record('sign-out', -3 * day, { event: 'sign-out', userId: owner, tool: null, outcome: 'success', requestId: 'sign-out', clientAddress: '192.0.2.1' })
  record('break-glass-sign-in', -180 * minute, { event: 'sign-in', userId: owner, tool: null, outcome: 'success', authenticationMethod: 'break-glass', requestId: 'break-glass', clientAddress: '192.0.2.2' })
  record('sso-failure', -179 * minute, { event: 'sign-in', userId: second, tool: null, outcome: 'failure', authenticationMethod: 'sso', requestId: 'sso-failure', clientAddress: '192.0.2.3' })
  record('reauth', -178 * minute, { event: 'reauth', userId: owner, tool: null, outcome: 'success', authenticationMethod: 'local', requestId: 'reauth', clientAddress: null })
  record('break-glass-password', -177 * minute, { event: 'password-change', userId: owner, tool: null, outcome: 'success', authenticationMethod: 'break-glass', requestId: 'password', clientAddress: null })
  record('run-1-start', -176 * minute, { ...run, event: 'run-start', userId: owner, outcome: 'started', args: ['detection', 'list'], sensitive: { flags: [], positions: [] }, requestId: 'run-1', instance: 'lab' })
  record('run-1-done', -175 * minute, { ...run, event: 'run-terminal', userId: owner, outcome: 'completed', exitCode: 0, requestId: 'run-1', instance: 'lab' })
  record('run-2-start', -174 * minute, { ...run, event: 'run-start', userId: second, outcome: 'started', args: ['host', 'list'], sensitive: { flags: [], positions: [] }, requestId: 'run-2', instance: 'prod' })
  record('run-2-failed', -173 * minute, { ...run, event: 'run-terminal', userId: second, outcome: 'completed', exitCode: 3, errorCode: 'PERMISSION_DENIED', requestId: 'run-2', instance: 'prod',
    failure: { diagnostic: { stage: 'tool run', message: 'Synthetic failure' }, secrets: [] } })
  record('run-3-interrupted', -172 * minute, { ...run, event: 'run-terminal', userId: owner, outcome: 'interrupted', exitCode: null, requestId: 'run-3' })
  record('denial', -171 * minute, { event: 'denial', userId: owner, tool: 'falcon-axi', outcome: 'PERMISSION_DENIED', requestId: 'denial', clientAddress: '192.0.2.4' })
  record('admin-change', -170 * minute, { event: 'admin-change', userId: owner, tool: 'falcon-axi', outcome: 'success', action: 'update-tool', targetId: 'falcon-axi',
    requestId: 'admin-change', clientAddress: null, settingsChanges: [{ path: ['managementGroup'], before: null, after: 'synthetic-group' }] })
  record('maintenance', -169 * minute, { event: 'maintenance', userId: null, tool: null, outcome: 'success', cutoff: now - 90 * day, deletedCount: 4, requestId: 'maintenance', clientAddress: null })
  record('raw-api', -168 * minute, { event: 'raw-api', userId: owner, tool: 'falcon-axi', outcome: 'allowed', route: 'GET **', method: 'GET', path: '/synthetic', query: [],
    bodySha256: 'c'.repeat(64), bodyBytes: 0, requestId: 'raw-api', clientAddress: null, instance: 'lab' })
  record('transfer', -167 * minute, { event: 'transfer', userId: second, tool: 'hybrid-axi', outcome: 'preview', credentialRevision: 1, transfer, requestId: 'transfer', clientAddress: null })
  db.pragma('foreign_keys = OFF')
  record('gone-user-token', -166 * minute, { event: 'token-create', userId: 'removed-user', tool: null, outcome: 'success', targetId: 'token-1', requestId: 'gone-user', clientAddress: null })
  db.pragma('foreign_keys = ON')
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const words = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? words(child) : '').join(' ').replace(/\s+/g, ' ').trim()
const decode = (href: string | undefined) => href?.replaceAll('&amp;', '&')

function view(body: string) {
  const all = nodes(parse(body))
  const within = (root: Element | undefined, tag: string) => root ? nodes(root).filter(element => element.tagName === tag) : []
  const table = all.find(element => element.tagName === 'table')
  const form = all.find(element => element.tagName === 'form' && attribute(element, 'class') === 'filters')
  const pages = all.find(element => attribute(element, 'aria-label') === 'Pages')
  const group = all.find(element => attribute(element, 'aria-label') === 'Time range')
  return {
    heading: words(all.find(element => element.tagName === 'h1')!),
    columns: within(table, 'th').filter(cell => attribute(cell, 'scope') === 'col').map(words),
    rows: within(table, 'tbody').flatMap(tbody => within(tbody, 'tr')).map(row => ({
      cells: row.childNodes.filter((child): child is Element => 'tagName' in child && ['th', 'td'].includes(child.tagName)).map(words),
      href: decode(attribute(within(row, 'a')[0]!, 'href')), current: within(row, 'a').some(link => attribute(link, 'aria-current') === 'true') })),
    controls: Object.fromEntries(within(form, 'input').map(input => [attribute(input, 'name'), { type: attribute(input, 'type') ?? 'text', value: attribute(input, 'value') ?? '' }])),
    selects: within(form, 'select').map(select => ({ name: attribute(select, 'name'), label: attribute(select, 'aria-label'),
      selected: within(select, 'option').filter(option => attribute(option, 'selected') !== undefined).map(option => attribute(option, 'value')),
      options: within(select, 'option').map(option => [attribute(option, 'value'), words(option)]) })),
    links: within(form, 'a').map(link => ({ text: words(link), label: attribute(link, 'aria-label'), href: decode(attribute(link, 'href')), current: attribute(link, 'aria-current') })),
    range: within(group, 'a').map(link => ({ text: words(link), href: decode(attribute(link, 'href')), current: attribute(link, 'aria-current') === 'true' })),
    apply: within(form, 'button').map(button => ({
      text: words(button), type: attribute(button, 'type'),
      hidden: attribute(button, 'hidden') !== undefined, disabled: attribute(button, 'disabled') !== undefined })),
    pager: (pages ? nodes(pages) : []).filter(element => element.tagName === 'a' || element.tagName === 'button' || attribute(element, 'aria-disabled') === 'true').map(element => ({
      text: words(element), href: decode(attribute(element, 'href')), disabled: attribute(element, 'aria-disabled') === 'true' || attribute(element, 'disabled') !== undefined })),
    summary: all.map(words).find(text => /^Showing \d+ records?$/.test(text)),
    downloads: all.filter(element => element.tagName === 'a' && attribute(element, 'download') !== undefined).map(link => ({ text: words(link), href: decode(attribute(link, 'href')) })),
  }
}

const auditPage = (query = '') => app.inject({ url: '/admin/audit' + query, headers })
const listed = async (query: string) => view((await auditPage(query)).body).rows.map(row => row.href!.match(/record=(\d+)/)![1]!)
const labelled = (...labels: string[]) => labels.map(label => String(ids[label]))

test('a fixed set of audit rows, one of each event kind, lists with the same fields and order as before', async () => {
  seed()
  const page = view((await auditPage()).body)
  const time = (offset: number) => new Date(now + offset).toISOString()
  expect(page.heading).toBe('Audit log')
  expect(page.columns).toEqual(['Time', 'Event', 'Actor', 'Tool', 'Instance', 'Outcome'])
  expect(page.rows.map(row => row.cells)).toEqual([
    [time(-166 * minute), 'token-create', 'removed-user', '-', 'default/unknown', 'success'],
    [time(-167 * minute), 'transfer', 'second-user', 'hybrid-axi', 'default/unknown', 'preview'],
    [time(-168 * minute), 'raw-api', 'synthetic-user', 'falcon-axi', 'lab', 'allowed'],
    [time(-169 * minute), 'maintenance', 'System', '-', 'default/unknown', 'success'],
    [time(-170 * minute), 'admin-change', 'synthetic-user', 'falcon-axi', 'default/unknown', 'success'],
    [time(-171 * minute), 'denial', 'synthetic-user', 'falcon-axi', 'default/unknown', 'PERMISSION_DENIED'],
    [time(-172 * minute), 'run-terminal', 'synthetic-user', 'falcon-axi', 'default/unknown', 'interrupted'],
    [time(-173 * minute), 'run-terminal', 'second-user', 'falcon-axi', 'prod', 'completed · exit 3'],
    [time(-174 * minute), 'run-start', 'second-user', 'falcon-axi', 'prod', 'started'],
    [time(-175 * minute), 'run-terminal', 'synthetic-user', 'falcon-axi', 'lab', 'completed'],
    [time(-176 * minute), 'run-start', 'synthetic-user', 'falcon-axi', 'lab', 'started'],
    [time(-177 * minute), 'password-change Break-glass', 'synthetic-user', '-', 'default/unknown', 'success'],
    [time(-178 * minute), 'reauth', 'synthetic-user', '-', 'default/unknown', 'success'],
    [time(-179 * minute), 'sign-in', 'second-user', '-', 'default/unknown', 'failure'],
    [time(-180 * minute), 'sign-in Break-glass', 'synthetic-user', '-', 'default/unknown', 'success'],
    [time(-3 * day), 'sign-out', 'synthetic-user', '-', 'default/unknown', 'success'],
    [time(-30 * day), 'sign-in', 'synthetic-user', '-', 'default/unknown', 'success'],
  ])
  expect(page.rows.map(row => row.href)).toEqual(Object.values(ids).reverse().map(id => `/admin/audit?record=${id}`))
  expect(page.summary).toBe('Showing 17 records')
})

test.each([
  ['no filter', '', ['gone-user-token', 'transfer', 'raw-api', 'maintenance', 'admin-change', 'denial', 'run-3-interrupted', 'run-2-failed', 'run-2-start', 'run-1-done', 'run-1-start',
    'break-glass-password', 'reauth', 'sso-failure', 'break-glass-sign-in', 'sign-out', 'old-sign-in']],
  ['an empty form', '?user=&tool=&instance=&event=&outcome=&requestId=&from=&to=&limit=50', ['gone-user-token', 'transfer', 'raw-api', 'maintenance', 'admin-change', 'denial', 'run-3-interrupted',
    'run-2-failed', 'run-2-start', 'run-1-done', 'run-1-start', 'break-glass-password', 'reauth', 'sso-failure', 'break-glass-sign-in', 'sign-out', 'old-sign-in']],
  ['user', '?user=' + second, ['transfer', 'run-2-failed', 'run-2-start', 'sso-failure']],
  ['tool', '?tool=falcon-axi', ['raw-api', 'admin-change', 'denial', 'run-3-interrupted', 'run-2-failed', 'run-2-start', 'run-1-done', 'run-1-start']],
  ['instance', '?instance=lab', ['raw-api', 'run-1-done', 'run-1-start']],
  ['event', '?event=run-terminal', ['run-3-interrupted', 'run-2-failed', 'run-1-done']],
  ['outcome', '?outcome=success', ['gone-user-token', 'maintenance', 'admin-change', 'break-glass-password', 'reauth', 'break-glass-sign-in', 'sign-out', 'old-sign-in']],
  ['request ID', '?requestId=run-1', ['run-1-done', 'run-1-start']],
  ['failed runs', '?failed=1', ['run-3-interrupted', 'run-2-failed']],
  ['error code', '?errorCode=PERMISSION_DENIED', ['run-2-failed']],
  ['the last 24 hours', '?range=24h', ['gone-user-token', 'transfer', 'raw-api', 'maintenance', 'admin-change', 'denial', 'run-3-interrupted', 'run-2-failed', 'run-2-start', 'run-1-done',
    'run-1-start', 'break-glass-password', 'reauth', 'sso-failure', 'break-glass-sign-in']],
  ['the last 7 days', '?range=7d', ['gone-user-token', 'transfer', 'raw-api', 'maintenance', 'admin-change', 'denial', 'run-3-interrupted', 'run-2-failed', 'run-2-start', 'run-1-done',
    'run-1-start', 'break-glass-password', 'reauth', 'sso-failure', 'break-glass-sign-in', 'sign-out']],
  ['a custom range, both ends included', `?range=custom&from=${new Date(now - 180 * minute).toISOString()}&to=${new Date(now - 178 * minute).toISOString()}`,
    ['reauth', 'sso-failure', 'break-glass-sign-in']],
  ['several filters together', '?user=' + owner + '&tool=falcon-axi&outcome=started&range=24h', ['run-1-start']],
  ['a filter nothing matches', '?outcome=missing', []],
])('filtering by %s returns the same rows in the same order', async (_name, query, expected) => {
  seed()
  expect(await listed(query)).toEqual(labelled(...expected))
})

test('paging by cursor walks every row once, ends on the last page, and every link keeps the filters and limit', async () => {
  seed()
  const walked: string[] = []
  let url = '/admin/audit?range=7d&limit=6'
  const pages: ReturnType<typeof view>[] = []
  for (let guard = 0; guard < 5; guard++) {
    const page = view((await app.inject({ url, headers })).body)
    pages.push(page)
    walked.push(...page.rows.map(row => row.href!.match(/record=(\d+)/)![1]!))
    const older = page.pager.find(item => item.text === 'Older')!
    if (older.disabled) break
    url = older.href!
  }
  expect(walked).toEqual(labelled('gone-user-token', 'transfer', 'raw-api', 'maintenance', 'admin-change', 'denial', 'run-3-interrupted', 'run-2-failed', 'run-2-start', 'run-1-done',
    'run-1-start', 'break-glass-password', 'reauth', 'sso-failure', 'break-glass-sign-in', 'sign-out'))
  expect(pages.map(page => page.summary)).toEqual(['Showing 6 records', 'Showing 6 records', 'Showing 4 records'])
  expect(pages[0]!.pager).toEqual([{ text: 'Newest', href: undefined, disabled: true }, { text: 'Older', href: expect.stringMatching(/^\/admin\/audit\?limit=6&range=7d&cursor=\d+%3A\d+%3A\d+$/), disabled: false }])
  expect(pages[2]!.pager).toEqual([{ text: 'Newest', href: '/admin/audit?limit=6&range=7d', disabled: false }, { text: 'Older', href: undefined, disabled: true }])
})

test('an empty log and an empty result say so, and only a filtered result offers Clear filters', async () => {
  const empty = view((await auditPage()).body)
  expect(empty.rows).toEqual([])
  expect((await auditPage()).body).toContain('No audit records match these filters.')
  expect(empty.links.map(link => link.text)).not.toContain('Clear filters')
  seed()
  const none = view((await auditPage('?outcome=missing')).body)
  expect(none.rows).toEqual([])
  expect(none.links.filter(link => link.text === 'Clear filters')).toEqual([{ text: 'Clear filters', label: undefined, href: '/admin/audit', current: undefined }])
  expect(none.selects.find(select => select.name === 'outcome')!.selected).toEqual(['missing'])
})

test('with every filter set the form, time range, chips and clear links keep their names, values and targets', async () => {
  seed()
  const filters = [['delegationId', 'd1'], ['requestId', 'run-2'], ['failed', '1'], ['user', second], ['tool', 'falcon-axi'], ['instance', 'prod'], ['event', 'run-terminal'],
    ['outcome', 'completed'], ['errorCode', 'PERMISSION_DENIED'], ['limit', '7']]
  const page = view((await auditPage('?' + new URLSearchParams([...filters, ['range', '24h']]))).body)
  const href = (changes: { drop?: string } = {}) => '/admin/audit?' + new URLSearchParams(filters.filter(([name]) => name !== changes.drop))
  expect(page.controls).toEqual({ requestId: { type: 'text', value: 'run-2' }, delegationId: { type: 'text', value: 'd1' }, errorCode: { type: 'hidden', value: 'PERMISSION_DENIED' },
    range: { type: 'hidden', value: '24h' }, failed: { type: 'hidden', value: '1' }, limit: { type: 'hidden', value: '7' } })
  expect(page.selects.map(({ name, label, selected }) => ({ name, label, selected }))).toEqual([{ name: 'user', label: 'User', selected: [second] },
    { name: 'tool', label: 'Tool', selected: ['falcon-axi'] }, { name: 'instance', label: 'Instance', selected: ['prod'] }, { name: 'event', label: 'Event', selected: ['run-terminal'] },
    { name: 'outcome', label: 'Outcome', selected: ['completed'] }])
  const options = (name: string) => page.selects.find(select => select.name === name)!.options
  expect(options('user')).toEqual([['', 'User'], [second, 'second-user'], [owner, 'synthetic-user']])
  expect(options('instance')).toEqual([['', 'Instance'], ['lab', 'lab'], ['prod', 'prod']])
  expect(options('event').map(([value]) => value)).toEqual(['', 'admin-change', 'denial', 'maintenance', 'password-change', 'raw-api', 'reauth', 'run-start', 'run-terminal', 'sign-in',
    'sign-out', 'token-create', 'transfer'])
  expect(options('outcome').map(([value]) => value)).toEqual(['', 'PERMISSION_DENIED', 'allowed', 'completed', 'failure', 'interrupted', 'preview', 'started', 'success'])
  expect(options('tool')).toEqual([['', 'Tool'], ...toolSchema.options.map(tool => [tool, tool])])
  expect(page.range).toEqual([{ text: 'Any time', href: href(), current: false }, { text: '24 h', href: `${href()}&range=24h`, current: true },
    { text: '7 days', href: `${href()}&range=7d`, current: false }, { text: 'Custom', href: `${href()}&range=custom`, current: false }])
  expect(page.links.filter(link => link.label).map(link => [link.label, link.href])).toEqual([
    ['Clear filter: Failed runs only', `${href({ drop: 'failed' })}&range=24h`], ['Clear user filter', `${href({ drop: 'user' })}&range=24h`],
    ['Clear tool filter', `${href({ drop: 'tool' })}&range=24h`], ['Clear instance filter', `${href({ drop: 'instance' })}&range=24h`],
    ['Clear event filter', `${href({ drop: 'event' })}&range=24h`], ['Clear outcome filter', `${href({ drop: 'outcome' })}&range=24h`],
    ['Clear error code filter', `${href({ drop: 'errorCode' })}&range=24h`]])
  expect(page.links.at(-1)).toMatchObject({ text: 'Clear filters', href: '/admin/audit' })
  expect(page.apply).toEqual([{ text: 'Apply', type: 'submit', hidden: false, disabled: false }])
})

test('a custom range shows From and To fields, keeps its Custom link on them and leaves Apply visible', async () => {
  seed()
  const page = view((await auditPage('?range=custom&from=2026-01-01T00:00:00Z')).body)
  expect(page.controls).toEqual({ requestId: { type: 'text', value: '' }, delegationId: { type: 'text', value: '' }, range: { type: 'hidden', value: 'custom' },
    from: { type: 'text', value: '2026-01-01T00:00:00Z' }, to: { type: 'text', value: '' } })
  expect(page.range).toEqual([{ text: 'Any time', href: '/admin/audit', current: false }, { text: '24 h', href: '/admin/audit?range=24h', current: false },
    { text: '7 days', href: '/admin/audit?range=7d', current: false }, { text: 'Custom', href: '#audit-from', current: true }])
  expect(page.links.find(link => link.text === 'Failed runs only')!.href).toBe('/admin/audit?from=2026-01-01T00%3A00%3A00Z&range=custom&failed=1')
  expect(page.apply).toEqual([{ text: 'Apply', type: 'submit', hidden: false, disabled: false }])
})

test('with no filter the form is bare, Any time is current, and the export links name only the format', async () => {
  seed()
  const page = view((await auditPage()).body)
  expect(page.controls).toEqual({ requestId: { type: 'text', value: '' }, delegationId: { type: 'text', value: '' } })
  expect(page.range).toEqual([{ text: 'Any time', href: '/admin/audit', current: true }, { text: '24 h', href: '/admin/audit?range=24h', current: false },
    { text: '7 days', href: '/admin/audit?range=7d', current: false }, { text: 'Custom', href: '/admin/audit?range=custom', current: false }])
  expect(page.links.find(link => link.text === 'Failed runs only')!.href).toBe('/admin/audit?failed=1')
  expect(page.downloads).toEqual([{ text: 'CSV', href: '/v1/admin/audit/export?format=csv' }, { text: 'JSON lines', href: '/v1/admin/audit/export?format=jsonl' }])
})

test('each Export link downloads every retained record matching the filters, not just the page, with the same type and file name', async () => {
  seed()
  const page = view((await auditPage('?tool=falcon-axi&range=24h&limit=3')).body)
  const [csv, jsonl] = page.downloads.map(link => new URL('http://localhost' + link.href))
  expect([csv!.pathname, Object.fromEntries([...csv!.searchParams].filter(([name]) => name !== 'from'))]).toEqual(['/v1/admin/audit/export', { tool: 'falcon-axi', format: 'csv' }])
  expect(csv!.searchParams.get('from')).toBe(new Date(now - day).toISOString())
  const lines = await app.inject({ url: jsonl!.pathname + jsonl!.search, headers })
  expect(lines.headers).toMatchObject({ 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': 'attachment; filename="artium-audit.jsonl"' })
  expect(lines.body.trim().split('\n').map(line => String(JSON.parse(line).id))).toEqual(labelled('raw-api', 'admin-change', 'denial', 'run-3-interrupted', 'run-2-failed', 'run-2-start', 'run-1-done', 'run-1-start'))
  const table = await app.inject({ url: csv!.pathname + csv!.search, headers })
  expect(table.headers).toMatchObject({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="artium-audit.csv"' })
  expect(table.body.split('\r\n')).toHaveLength(8 + 2)
})

test('the open record is marked, row links keep the cursor, and its panel is the same markup as before', async () => {
  seed()
  const first = view((await auditPage('?limit=3')).body)
  const cursor = first.pager.find(item => item.text === 'Older')!.href!.match(/cursor=[^&]+/)![0]
  const page = view((await auditPage(`?limit=3&${cursor}&record=${ids['admin-change']}`)).body)
  expect(page.rows.map(row => row.current)).toEqual([false, true, false])
  expect(page.rows[1]!.href).toBe(`/admin/audit?limit=3&record=${ids['admin-change']}&cursor=${cursor.slice(7)}`)
})

function detail(body: string) {
  const panel = nodes(parse(body)).find(element => element.tagName === 'aside' && attribute(element, 'id') === 'record')
  if (!panel) return null
  const inside = nodes(panel)
  const request = inside.find(element => attribute(element, 'aria-label') === 'Request ID')
  return {
    labelledBy: attribute(panel, 'aria-labelledby'), heading: words(inside.find(element => attribute(element, 'id') === 'record-title')!),
    subtitle: words(inside.find(element => element.tagName === 'p')!),
    close: inside.filter(element => attribute(element, 'aria-label') === 'Close details').map(link => decode(attribute(link, 'href'))),
    lists: inside.filter(element => element.tagName === 'dl').map(list => {
      const terms = nodes(list).filter(element => element.tagName === 'dt').map(words)
      const values = nodes(list).filter(element => element.tagName === 'dd').map(words)
      return terms.map((term, index) => [term, values[index]])
    }),
    sections: inside.filter(element => element.tagName === 'h3').map(words), code: inside.filter(element => element.tagName === 'pre').map(words),
    summary: words(inside.find(element => element.tagName === 'summary') ?? panel).slice(0, 80),
    times: inside.filter(element => element.tagName === 'time').map(time => attribute(time, 'datetime')),
    request: request && { value: attribute(request, 'value'), readonly: attribute(request, 'readonly') !== undefined,
      copy: inside.some(element => attribute(element, 'aria-label') === 'Copy request ID' && attribute(element, 'data-copy') !== undefined),
      status: inside.some(element => attribute(element, 'data-copy-status') !== undefined && attribute(element, 'role') === 'status') },
  }
}

test('the detail panel of every record, and of a record that is gone, shows the same fields and values as before', async () => {
  seed()
  at = now - 165 * minute
  ids['admin-change-lists'] = new Audit(db, () => at, () => {}).record({ event: 'admin-change', userId: owner, tool: 'falcon-axi', outcome: 'success', action: 'update-tool', targetId: 'falcon-axi',
    requestId: 'admin-change-lists', clientAddress: null, settingsChanges: [{ path: ['subscriptions'], added: ['synthetic-c', null], removed: ['synthetic-a'] }, { path: ['mode'], before: 'read', after: 'write' }] }).id
  const models = Object.fromEntries(await Promise.all([...Object.entries(ids), ['gone', 999999]].map(async ([label, id]) => [label, detail((await auditPage('?record=' + id)).body)])))
  await expect(Object.values(models).map(model => JSON.stringify(model)).join('\n') + '\n').toMatchFileSnapshot('../fixtures/audit-record-details.jsonl')
})

test('the hydration data carries only what the list displays, and the open record only as the panel shown', async () => {
  seed()
  db.prepare("UPDATE audit SET subject = 'canary-subject' WHERE event = 'sign-in'").run()
  const props = (body: string) => JSON.parse(body.match(/<script type="application\/json" data-astryx-props>(.*?)<\/script>/)![1]!).props
  const body = (await auditPage()).body
  expect(Object.keys(props(body)).sort()).toEqual(['detail', 'exports', 'filters', 'pager', 'rows'])
  expect(Object.keys(props(body).rows[0]).sort()).toEqual(['actor', 'breakGlass', 'current', 'event', 'href', 'instance', 'outcome', 'time', 'tool'])
  expect(props(body).detail).toBeNull()
  const hidden = ['run-1', 'run-2', 'run-3', 'sso-failure', 'gone-user', 'canary-subject', '192.0.2.', 'c'.repeat(64), 'detection', 'managementGroup', 'synthetic-group', 'token-1']
  for (const value of hidden) expect(JSON.stringify([props(body), body.replace(/<script[\s\S]*?<\/script>/g, '')])).not.toContain(value)
  const opened = props((await auditPage('?record=' + ids['admin-change'])).body)
  expect(Object.keys(opened.detail).sort()).toEqual(['closeHref', 'id', 'record'])
  expect(Object.keys(opened.detail.record).sort()).toEqual(['diagnostic', 'facts', 'fields', 'heading', 'number', 'settingsChanges', 'time'])
  expect(opened.detail.record.fields.map((field: { name: string }) => field.name)).toEqual((db.pragma('table_info(audit)') as { name: string }[]).map(column => column.name))
})

test('no audit URL carries injected markup or a legacy island, in the page or its hydration data', async () => {
  seed()
  for (const query of ['', '?outcome=missing', '?range=custom', `?record=${ids['admin-change']}`, `?record=${ids['run-2-failed']}&event=run-terminal&limit=1`, '?record=999999']) {
    const body = (await auditPage(query)).body
    const data = body.match(/<script type="application\/json" data-astryx-props>(.*?)<\/script>/)![1]!
    expect(body, query).not.toContain('legacy-island')
    const { props } = JSON.parse(data)
    expect(props.detail === null || typeof props.detail === 'object', query).toBe(true)
    expect(JSON.stringify(props), query).not.toContain('<')
  }
})

test('stored values of the open record render as text, never as markup', async () => {
  seed()
  db.prepare("UPDATE audit SET client_address = '<b>address</b>', subject = '<i>subject</i>', action = '<u>action</u>', request_id = '<s>request</s>', arguments = ? WHERE id = ?")
    .run('{"x":"<script>"}', ids['admin-change'])
  const page = (await auditPage('?record=' + ids['admin-change'])).body
  const shown = JSON.stringify(detail(page)!.lists)
  for (const literal of ['<b>address</b>', '<i>subject</i>', '<u>action</u>', '<s>request</s>', '{"x":"<script>"}']) expect(shown).toContain(JSON.stringify(literal).slice(1, -1))
  const markup = page.replace(/<script type="application\/json" data-astryx-props>[\s\S]*?<\/script>/, '')
  for (const tag of ['<b>', '<i>', '<u>', '<s>', '<script>']) expect(markup).not.toContain(tag)
})

test('values from audit rows render as text, never as markup', async () => {
  seed()
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run('<b>actor</b>', owner)
  db.prepare("UPDATE audit SET event = '<i>event</i>', outcome = '<u>outcome</u>', instance = '<s>instance</s>' WHERE id = ?").run(ids['raw-api'])
  const body = (await auditPage()).body
  const markup = body.replace(/<script type="application\/json" data-astryx-props>[\s\S]*?<\/script>/, '')
  expect(view(body).rows[2]!.cells).toEqual([new Date(now - 168 * minute).toISOString(), '<i>event</i>', '<b>actor</b>', 'falcon-axi', '<s>instance</s>', '<u>outcome</u>'])
  for (const tag of ['<b>', '<i>', '<u>', '<s>']) {
    expect(markup).not.toContain(tag)
    expect(body).not.toContain(tag)
  }
})

test('who may read the audit log is unchanged: an ordinary person is refused and an anonymous visitor signs in first', async () => {
  seed()
  const anonymous = await app.inject({ url: '/admin/audit', headers: { host: 'localhost' } })
  expect([anonymous.statusCode, anonymous.headers.location]).toEqual([303, '/login'])
  db.prepare('UPDATE users SET administrator = 1 WHERE id = ?').run(second)
  db.prepare('UPDATE users SET administrator = 0 WHERE id = ?').run(owner)
  const ordinary = await auditPage()
  expect(ordinary.statusCode).toBe(403)
  for (const value of ['removed-user', 'second-user', '192.0.2.']) expect(ordinary.body).not.toContain(value)
})
