import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Roles, type RolesProps } from '../src/views/roles.js'

type Element = DefaultTreeAdapterMap['element']

const role: RolesProps['roles'][number] = { href: '/admin/roles/synthetic-role', name: 'Synthetic Role', members: 3, rules: 0,
  tools: [{ name: 'Synthetic Falcon', enabled: true }, { name: 'Synthetic Vectra', enabled: false }] }

function render(overrides: Partial<RolesProps> = {}) {
  const props: RolesProps = { roles: [role], pager: { summary: '1 role', first: null, next: null }, newRole: '<dialog id="synthetic-dialog"></dialog>', ...overrides }
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Roles, props) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const rows = (html: string) => find(html, element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td'))

test('each role row links its name to the role and states its member and SSO rule counts', () => {
  const [row] = rows(render())
  expect(nodes(row!).filter(element => element.tagName === 'a').map(link => [attribute(link, 'href'), text(link)])).toEqual([['/admin/roles/synthetic-role', 'Synthetic Role']])
  expect(nodes(row!).filter(element => attribute(element, 'data-label') !== undefined).map(cell => [attribute(cell, 'data-label'), text(cell)])).toEqual([['Members', '3'], ['SSO rules', '0']])
})

test('the role name is the row header of the table named by its columns', () => {
  const html = render()
  const headers = find(html, element => element.tagName === 'th').map(header => [attribute(header, 'scope'), text(header)])
  expect(headers).toEqual([['col', 'Role'], ['col', 'Tools'], ['col', 'Members'], ['col', 'SSO rules'], ['col', 'Open'], ['row', 'Synthetic Role']])
})

test('a disabled tool carries its state in text and a role with no tools says so', () => {
  const [granted] = rows(render())
  expect(text(granted!)).toContain('Synthetic Falcon')
  expect(find(render(), element => attribute(element, 'title') === 'Tool disabled').map(text)).toEqual(['Synthetic Vectra (disabled)'])
  const [empty] = rows(render({ roles: [{ ...role, tools: [] }] }))
  expect(text(empty!)).toContain('No tools yet')
})

test.each([
  [4, 'Tool 1Tool 2Tool 3Tool 4'],
  [5, 'Tool 1Tool 2Tool 3+2 more: Tool 4, Tool 5'],
  [7, 'Tool 1Tool 2Tool 3+4 more: Tool 4, Tool 5, Tool 6, Tool 7'],
])('a role granting %i tools shows at most four slots, the last naming the rest', (count, expected) => {
  const tools = Array.from({ length: count }, (_, index) => ({ name: `Tool ${index + 1}`, enabled: true }))
  const [row] = rows(render({ roles: [{ ...role, tools }] }))
  expect(text(nodes(row!).find(element => element.tagName === 'td')!)).toBe(expected)
})

test('the pager links to its pages and disables a page that does not exist', () => {
  const pager = (first: string | null, next: string | null) => {
    const html = render({ pager: { summary: '2 roles', first, next } })
    const [navigation] = find(html, element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Pages')
    return nodes(navigation!).filter(element => ['a', 'button'].includes(element.tagName)).map(control => [text(control), control.tagName, attribute(control, 'href')])
  }
  expect(pager(null, '/admin/roles?cursor=synthetic&limit=25')).toEqual([['First', 'button', undefined], ['Next', 'a', '/admin/roles?cursor=synthetic&limit=25']])
  expect(pager('/admin/roles?limit=25', null)).toEqual([['First', 'a', '/admin/roles?limit=25'], ['Next', 'button', undefined]])
})

test('no roles shows the empty message with a New role entry point, and the new-role dialog is always kept', () => {
  const html = render({ roles: [] })
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(text(find(html, element => element.tagName === 'h2')[0]!)).toBe('No roles yet')
  const [entry] = find(html, element => attribute(element, 'data-open-dialog') === 'new-role')
  expect([attribute(entry!, 'href'), text(entry!)]).toEqual(['/admin/roles?dialog=new-role', 'New role'])
  expect(find(html, element => attribute(element, 'id') === 'synthetic-dialog')).toHaveLength(1)
  expect(find(render(), element => attribute(element, 'id') === 'synthetic-dialog')).toHaveLength(1)
})
