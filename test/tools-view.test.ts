import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Tools, type ToolsProps } from '../src/views/tools.js'

type Element = DefaultTreeAdapterMap['element']

const tool: ToolsProps['tools'][number] = { href: '/admin/tools/falcon-axi', name: 'falcon-axi', product: 'CrowdStrike Falcon', mark: 'FA', version: '1.1.0',
  instances: '2 instances', failing: null, state: { word: 'Healthy', tone: 'ok' }, enabled: true, writes: { word: 'Read-only', tone: 'neutral' }, rawApi: 'Off', roles: 3,
  checkedAt: '2026-11-15T10:00:00.000Z' }

const links: ToolsProps['filters']['links'] = [{ label: 'All', count: 19, href: '/admin/tools', current: true }, { label: 'Enabled', count: 2, href: '/admin/tools?show=enabled', current: false },
  { label: 'Needs attention', count: 1, href: '/admin/tools?show=attention', current: false }]

function render(overrides: Partial<ToolsProps> = {}) {
  const props: ToolsProps = { filters: { show: 'all', q: '', links }, tools: [tool], certificates: [], ...overrides }
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Tools, props) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const rows = (html: string) => find(html, element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td'))
const cells = (row: Element) => nodes(row).filter(element => element.tagName === 'th' || element.tagName === 'td').map(text)

test('the page offers no action: its only form is the get filter, with no CSRF token', () => {
  const html = render({ certificates: [{ subject: 'Synthetic CA', issuer: 'Synthetic CA', expiresAt: '2027-01-01T00:00:00.000Z', fingerprint: 'AA:BB' }] })
  const forms = find(html, element => element.tagName === 'form')
  expect(forms.map(form => [attribute(form, 'method'), attribute(form, 'action')])).toEqual([['get', '/admin/tools']])
  expect(find(html, element => attribute(element, 'name') === '_csrf')).toEqual([])
  expect(find(html, element => element.tagName === 'button' && attribute(element, 'type') === 'submit')).toEqual([])
})

test('the filter links name their view and count, and mark the current one', () => {
  const html = render({ filters: { show: 'enabled', q: '', links: links.map(link => ({ ...link, current: link.label === 'Enabled' })) } })
  const [group] = find(html, element => attribute(element, 'role') === 'group' && attribute(element, 'aria-label') === 'Show')
  const anchors = nodes(group!).filter(element => element.tagName === 'a')
  expect(anchors.map(anchor => [text(anchor), attribute(anchor, 'href'), attribute(anchor, 'aria-current')])).toEqual([
    ['All 19', '/admin/tools', undefined], ['Enabled 2', '/admin/tools?show=enabled', 'page'], ['Needs attention 1', '/admin/tools?show=attention', undefined]])
})

test.each([
  { show: 'all' as const, hidden: [] },
  { show: 'attention' as const, hidden: ['attention'] },
])('the filter form submits the search with show=$show kept only when it is not all', ({ show, hidden }) => {
  const html = render({ filters: { show, q: 'synthetic query', links } })
  const [form] = find(html, element => element.tagName === 'form')
  const inputs = nodes(form!).filter(element => element.tagName === 'input')
  expect(inputs.filter(input => attribute(input, 'type') === 'hidden').map(input => attribute(input, 'value'))).toEqual(hidden)
  const [search] = inputs.filter(input => attribute(input, 'name') === 'q')
  expect([attribute(search!, 'type'), attribute(search!, 'value'), attribute(search!, 'placeholder')]).toEqual(['search', 'synthetic query', 'Filter tools'])
  expect(attribute(form!, 'data-filters')).toBeDefined()
  expect(find(html, element => element.tagName === 'label' && text(element) === 'Filter tools')).toHaveLength(1)
})

test('a tool row links the product to its page and shows every column', () => {
  const [row] = rows(render())
  expect(nodes(row!).filter(element => element.tagName === 'a').map(link => [attribute(link, 'href'), text(link)])).toEqual([['/admin/tools/falcon-axi', 'CrowdStrike Falcon']])
  expect(cells(row!)).toEqual(['FACrowdStrike Falconfalcon-axi · 1.1.0', '2 instances', 'Healthy', 'On', 'Read-only', 'Off', '3', '2026-11-15T10:00:00.000Z'])
})

test.each([
  { tool: { enabled: false, state: { word: 'Not set up', tone: 'neutral' as const } }, enabled: 'Off', state: 'Not set up' },
  { tool: { state: { word: 'Failing', tone: 'err' as const }, failing: '1 of 2 failing' }, enabled: 'On', state: 'Failing 1 of 2 failing' },
  { tool: { state: { word: 'Needs credential', tone: 'warn' as const } }, enabled: 'On', state: 'Needs credential' },
])('a tool row reports enabled=$tool.enabled and the state $state', ({ tool: override, enabled, state }) => {
  const [row] = rows(render({ tools: [{ ...tool, ...override }] }))
  expect([cells(row!)[3], cells(row!)[2]]).toEqual([enabled, state])
})

test('a tool never checked shows Never and write access that is on is named', () => {
  const [row] = rows(render({ tools: [{ ...tool, checkedAt: null, writes: { word: '2 operations on', tone: 'warn' } }] }))
  expect([cells(row!)[4], cells(row!)[7]]).toEqual(['2 operations on', 'Never'])
})

test('no tool shows the empty message with a link back to all tools instead of a table of tools', () => {
  const html = render({ tools: [] })
  expect(find(html, element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td'))).toEqual([])
  expect(html).toContain('No tools match these filters')
  expect(find(html, element => element.tagName === 'a' && text(element) === 'Show all tools').map(link => attribute(link, 'href'))).toEqual(['/admin/tools'])
})

test('the trusted CA bundle lists each certificate, or says none is configured', () => {
  expect(render()).toContain('None configured.')
  const html = render({ certificates: [{ subject: 'Synthetic Subject', issuer: 'Synthetic Issuer', expiresAt: '2027-01-01T00:00:00.000Z', fingerprint: 'AA:BB:CC' }] })
  expect(html).toContain('1 certificate.')
  const certificateRows = find(html, element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td') && text(element).includes('Synthetic'))
  expect(cells(certificateRows[0]!)).toEqual(['Synthetic Subject', 'Synthetic Issuer', '2027-01-01T00:00:00.000Z', 'AA:BB:CC'])
})
