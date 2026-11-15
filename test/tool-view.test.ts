import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Tool, type ToolProps } from '../src/views/tool.js'
import type { WritesProps } from '../src/views/tool-writes.js'

type Element = DefaultTreeAdapterMap['element']

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const forms = (html: string) => find(html, element => element.tagName === 'form' && attribute(element, 'data-api') !== undefined)
const controls = (form: Element) => nodes(form).filter(element => ['input', 'textarea'].includes(element.tagName)).map(element => [attribute(element, 'name'), attribute(element, 'type') ?? 'textarea', attribute(element, 'value')])

const tabs: ToolProps['tabs'] = [
  { label: 'Instances', href: '/admin/tools/falcon-axi?tab=instances', icon: 'globe', note: '2', current: false },
  { label: 'Write permissions', href: '/admin/tools/falcon-axi?tab=writes', icon: 'zap', note: 'Off', current: false },
  { label: 'Advanced', href: '/admin/tools/falcon-axi?tab=advanced', icon: 'sliders', note: null, current: false },
]

const base: ToolProps = { csrf: 'synthetic-csrf', name: 'falcon-axi', api: '/v1/admin/tools/falcon-axi', product: 'CrowdStrike Falcon', mark: 'FA', version: '1.1.0', revision: 7, enabled: false,
  state: { word: 'Ready to test', tone: 'neutral' }, writes: { word: 'Read-only', tone: 'neutral' }, checkedAt: null,
  setup: [{ title: 'Credential saved', detail: 'Not saved yet', at: null, state: 'todo' }, { title: 'Test passes', detail: 'Failing: AUTH_FAILED', at: null, state: 'fail' },
    { title: 'Enabled', detail: 'On', at: null, state: 'done' }],
  tabs, panel: { tab: 'instances', legacyHtml: '<p data-legacy="instances">Synthetic legacy instances</p>' } }

function render(overrides: Partial<ToolProps> = {}) {
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Tool, { ...base, ...overrides }) }))
}

const writes: WritesProps = { capable: true, readOnlyReason: '', blockedTitle: 'Always blocked', blocked: 'Synthetic blocked text.', unlocks: 'Synthetic unlock text.', grant: 'No write actions are currently granted.',
  unsupported: false, confirmation: 'Synthetic write confirmation?', switches: [{ name: 'enabled', label: 'Allow writes', on: true, text: 'On. Synthetic.' }],
  operations: { supported: 2, selected: 1, familyNote: '', q: 'note', show: 'selected', deleteCount: 1, empty: false, groups: [{ title: 'Notes', family: null, picked: 1, deletes: 1, notUsed: false, open: true, hidden: false,
    operations: [{ name: 'notes.set', label: 'Set notes', search: 'set notes notes.set', delete: false, bulk: false, checked: true, hidden: false },
      { name: 'notes.delete', label: 'notes.delete', search: 'notes.delete notes.delete', delete: true, bulk: false, checked: false, hidden: false }] }] } }

test.each([
  { enabled: false, consequence: 'Enable this tool for people whose roles grant access?', next: 'true', checked: 'false' },
  { enabled: true, consequence: 'Disable this tool and block new calls?', next: 'false', checked: 'true' },
])('the enable switch for enabled=$enabled patches the tool with its revision, CSRF token and the opposite value', ({ enabled, consequence, next, checked }) => {
  const [form] = forms(render({ enabled }))
  expect([attribute(form!, 'action'), attribute(form!, 'data-method'), attribute(form!, 'data-confirm')]).toEqual(['/v1/admin/tools/falcon-axi', 'PATCH', consequence])
  expect(controls(form!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedRevision', 'hidden', '7'], ['enabled', 'hidden', next]])
  expect(nodes(form!).filter(element => attribute(element, 'role') === 'switch').map(element => [text(element), attribute(element, 'aria-checked')])).toEqual([['Enabled', checked]])
})

test('the tabs are plain links that mark only the current one', () => {
  const [nav] = find(render({ tabs: tabs.map(tab => ({ ...tab, current: tab.label === 'Write permissions' })) }), element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Tool sections')
  expect(nodes(nav!).filter(element => element.tagName === 'a').map(link => [text(link), attribute(link, 'href'), attribute(link, 'aria-current')])).toEqual([
    ['Instances 2', '/admin/tools/falcon-axi?tab=instances', undefined], ['Write permissions Off', '/admin/tools/falcon-axi?tab=writes', 'page'], ['Advanced', '/admin/tools/falcon-axi?tab=advanced', undefined]])
})

test('each setup step names its state, so the failed test is not shown by colour alone', () => {
  const steps = find(render(), element => element.tagName === 'li' && attribute(element, 'class')?.includes('step ') === true)
  expect(steps.map(step => [attribute(step, 'class')!.split(' ').slice(1, 2)[0], text(step)])).toEqual([
    ['todo', '1To do: Credential savedNot saved yet'], ['fail', 'Failed: Test passesFailing: AUTH_FAILED'], ['done', 'Done: EnabledOn']])
})

test('a legacy tab renders its markup in place', () => {
  expect(find(render(), element => attribute(element, 'data-legacy') === 'instances').map(text)).toEqual(['Synthetic legacy instances'])
})

test('Raw API keeps both forms, the mode radios and the route fields, and sends a read-only tool\'s write routes as a hidden field', () => {
  const panel = { tab: 'raw-api' as const, mode: 'read', options: [{ mode: 'off', label: 'Off', detail: 'Refused.' }, { mode: 'read', label: 'Read', detail: 'Reads.' }], write: 'POST a', get: 'GET b' }
  const [, mode, routes] = forms(render({ panel: { ...panel, writeRoutes: false } }))
  expect([attribute(mode!, 'action'), attribute(mode!, 'data-method'), attribute(routes!, 'action'), attribute(routes!, 'data-method')])
    .toEqual(['/v1/admin/tools/falcon-axi/raw-api', 'PATCH', '/v1/admin/tools/falcon-axi/raw-api/routes', 'PUT'])
  expect(controls(mode!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['mode', 'radio', 'off'], ['mode', 'radio', 'read'], ['expectedRevision', 'hidden', '7']])
  expect(nodes(mode!).filter(element => attribute(element, 'name') === 'mode' && attribute(element, 'checked') !== undefined).map(element => attribute(element, 'value'))).toEqual(['read'])
  expect(controls(routes!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['write', 'hidden', 'POST a'], ['get', 'textarea', undefined], ['expectedRevision', 'hidden', '7']])
  const [, , writable] = forms(render({ panel: { ...panel, writeRoutes: true } }))
  expect(controls(writable!).map(([name, kind]) => [name, kind])).toEqual([['_csrf', 'hidden'], ['write', 'textarea'], ['get', 'textarea'], ['expectedRevision', 'hidden']])
})

test('Advanced sends the native settings as JSON with the revision', () => {
  const [, form] = forms(render({ panel: { tab: 'advanced', writeState: 'writes off', guide: 'Synthetic guide.', grantNote: false, settings: '{\n  "a": 1\n}' } }))
  expect([attribute(form!, 'action'), attribute(form!, 'data-method')]).toEqual(['/v1/admin/tools/falcon-axi', 'PATCH'])
  const [settings] = nodes(form!).filter(element => attribute(element, 'name') === 'nativeSettings')
  expect([settings!.tagName, attribute(settings!, 'data-type'), text(settings!)]).toEqual(['textarea', 'json', '{\n  "a": 1\n}'])
  expect(controls(form!).filter(([name]) => name === 'expectedRevision')).toEqual([['expectedRevision', 'hidden', '7']])
})

test('Write permissions patch the write-access route, list each operation under its group and join the get filter form by id', () => {
  const html = render({ panel: { tab: 'writes', writes } })
  const [, form] = forms(html)
  expect([attribute(form!, 'action'), attribute(form!, 'data-method'), attribute(form!, 'data-confirm')]).toEqual(['/v1/admin/tools/falcon-axi/write-access', 'PATCH', 'Synthetic write confirmation?'])
  expect(nodes(form!).filter(element => attribute(element, 'name') === 'operations' && element.tagName === 'input').map(element => [attribute(element, 'value'), attribute(element, 'checked') !== undefined]))
    .toEqual([['notes.set', true], ['notes.delete', false]])
  expect(nodes(form!).filter(element => attribute(element, 'name') === 'enabled').map(element => [attribute(element, 'role'), attribute(element, 'checked') !== undefined])).toEqual([['switch', true]])
  const [filter] = find(html, element => element.tagName === 'form' && attribute(element, 'id') === 'ops-filter')
  expect([attribute(filter!, 'method'), attribute(filter!, 'action'), controls(filter!)]).toEqual(['get', '/admin/tools/falcon-axi', [['tab', 'hidden', 'writes']]])
  expect(find(html, element => attribute(element, 'form') === 'ops-filter').map(element => attribute(element, 'name'))).toEqual(expect.arrayContaining(['q', 'show']))
})

test('a tool that is always read-only offers no write form', () => {
  const html = render({ panel: { tab: 'writes', writes: { ...writes, capable: false, readOnlyReason: 'Synthetic reason.', operations: null } } })
  expect(forms(html).filter(form => attribute(form, 'action')?.endsWith('/write-access'))).toEqual([])
  expect(html).toContain('Synthetic reason.')
})
