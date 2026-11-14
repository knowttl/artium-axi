import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { People, type PeopleProps } from '../src/views/people.js'

type Element = DefaultTreeAdapterMap['element']

const person: PeopleProps['people'][number] = { href: '/admin/users/synthetic-one', name: 'Synthetic One', initials: 'SO', username: 'synthetic-one', you: false,
  signIn: { word: 'Password', tone: 'neutral' }, administrator: false, status: { word: 'Enabled', tone: 'ok' }, enabled: true, roles: [{ href: '/admin/roles/synthetic-role', label: 'Synthetic Role · Direct' }] }

function render(overrides: Partial<PeopleProps> = {}) {
  const props: PeopleProps = { filters: { q: '', limit: 25, clear: false, count: '1 person', selects: [] }, people: [person], empty: 'Synthetic empty message',
    pager: { summary: 'Showing 1 of 1', first: null, next: null }, sheet: '<dialog id="synthetic-sheet"></dialog>', ...overrides }
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(People, props) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const rows = (html: string) => find(html, element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td'))

test('the filter form is a get form whose controls submit the query, selections and page size', () => {
  const html = render({ filters: { q: 'synthetic', limit: 50, clear: true, count: '1 person',
    selects: [{ name: 'source', label: 'Sign-in', value: 'sso', options: [['local', 'Password'], ['sso', 'SSO']] }] } })
  const [form] = find(html, element => element.tagName === 'form' && attribute(element, 'data-filters') !== undefined)
  expect([attribute(form!, 'method'), attribute(form!, 'action')]).toEqual(['get', '/admin/users'])
  const controls = nodes(form!).filter(element => ['input', 'select'].includes(element.tagName) && attribute(element, 'type') !== 'hidden' || attribute(element, 'name') === 'limit')
  expect(controls.map(control => attribute(control, 'name'))).toEqual(['q', 'source', 'limit'])
  expect([attribute(controls[0]!, 'value'), attribute(controls[0]!, 'maxlength'), attribute(controls[2]!, 'value')]).toEqual(['synthetic', '256', '50'])
  expect(find(html, element => element.tagName === 'option' && attribute(element, 'selected') !== undefined).map(text)).toEqual(['SSO'])
})

test('the clear link appears only while a filter is applied', () => {
  const clear = (flag: boolean) => find(render({ filters: { q: '', limit: 25, clear: flag, count: '0 people', selects: [] } }), element => element.tagName === 'a' && attribute(element, 'href') === '/admin/users')
  expect([clear(true).length, clear(false).length]).toEqual([1, 0])
})

test('each person row links its name to the person and its roles to their roles', () => {
  const [row] = rows(render())
  const links = nodes(row!).filter(element => element.tagName === 'a')
  expect(links.map(link => [attribute(link, 'href'), text(link)])).toEqual([['/admin/users/synthetic-one', 'Synthetic One'], ['/admin/roles/synthetic-role', 'Synthetic Role · Direct']])
})

test.each([
  { name: 'a disabled person row is dimmed', change: { enabled: false }, dimmed: true },
  { name: 'an enabled person row is not dimmed', change: {}, dimmed: false },
])('$name', ({ change, dimmed }) => {
  const [row] = rows(render({ people: [{ ...person, ...change }] }))
  expect(attribute(row!, 'class')?.split(' ').includes('dim') ?? false).toBe(dimmed)
})

test('a person with no roles says so and the signed-in person is marked', () => {
  const [row] = rows(render({ people: [{ ...person, roles: [], you: true }] }))
  expect(text(row!)).toContain('No roles')
  expect(text(row!)).toContain('synthetic-one · you')
})

test('the pager links to its pages and disables a page that does not exist', () => {
  const pager = (first: string | null, next: string | null) => {
    const html = render({ pager: { summary: 'Showing 1 of 2', first, next } })
    return ['First page', 'Next'].map(label => find(html, element => element.tagName === 'a' && text(element) === label).map(link => attribute(link, 'href'))[0])
  }
  expect(pager(null, '/admin/users?cursor=synthetic')).toEqual([undefined, '/admin/users?cursor=synthetic'])
  expect(pager('/admin/users', null)).toEqual(['/admin/users', undefined])
})

test('no people shows the empty message instead of a table, and the sheet markup is always kept', () => {
  const html = render({ people: [] })
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(html).toContain('Synthetic empty message')
  expect(find(html, element => attribute(element, 'id') === 'synthetic-sheet')).toHaveLength(1)
})
