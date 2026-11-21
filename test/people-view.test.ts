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

const addUser: PeopleProps['addUser'] = { open: false, closeHref: '/admin/users?limit=25', csrf: 'synthetic-csrf', roles: [{ id: 'synthetic-role', name: 'Synthetic Role', detail: 'Synthetic Tool' }] }

function render(overrides: Partial<PeopleProps> = {}) {
  const props: PeopleProps = { filters: { q: '', limit: 25, clear: false, count: '1 person', selects: [] }, people: [person], empty: 'Synthetic empty message',
    pager: { summary: 'Showing 1 of 1', first: null, next: null }, addUser, ...overrides }
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
  const [form] = find(html, element => element.tagName === 'form' && attribute(element, 'class') === 'filters')
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

test('no people shows the empty message instead of a table, and the add-user sheet is always kept', () => {
  const html = render({ people: [] })
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(html).toContain('Synthetic empty message')
  expect(find(html, element => attribute(element, 'id') === 'sheet-add-user')).toHaveLength(1)
})

const addUserForm = (html: string) => find(html, element => element.tagName === 'form' && attribute(element, 'action') === '/v1/admin/users')[0]!

test('the add-user form posts the fields the API form handler reads, with the CSRF token and the confirmation text', () => {
  const form = addUserForm(render())
  const controls = nodes(form).filter(element => element.tagName === 'input')
  expect(controls.map(control => [attribute(control, 'name'), attribute(control, 'type') ?? 'text', attribute(control, 'value') ?? ''])).toEqual([
    ['_csrf', 'hidden', 'synthetic-csrf'], ['displayName', 'text', ''], ['username', 'text', ''], ['temporaryPassword', 'password', ''],
    ['roleIds', 'hidden', ''], ['roleIds', 'checkbox', 'synthetic-role'], ['administrator', 'checkbox', ''],
  ])
  expect(controls.filter(control => attribute(control, 'name') === 'roleIds').map(control => attribute(control, 'disabled'))).toEqual(['', undefined])
  expect(controls.filter(control => attribute(control, 'required') !== undefined).map(control => attribute(control, 'name'))).toEqual(['displayName', 'username', 'temporaryPassword'])
  expect(attribute(controls.find(control => attribute(control, 'name') === 'administrator')!, 'data-type')).toBe('boolean')
  expect([attribute(form, 'method'), attribute(form, 'data-method'), attribute(form, 'data-confirm-title'), attribute(form, 'data-confirm-action')]).toEqual(['post', 'POST', 'Add user', 'Add user'])
  expect(attribute(form, 'data-confirm')).toBe('Create this local account? They can sign in with the temporary password and must replace it first. Tool access comes from the selected roles.')
})

test('every add-user field keeps its label for assistive technology', () => {
  const html = render()
  const labels = find(html, element => element.tagName === 'label' && attribute(element, 'for') !== undefined)
  const labelled = (name: string) => {
    const input = find(html, element => element.tagName === 'input' && attribute(element, 'name') === name)[0]!
    return labels.filter(label => attribute(label, 'for') === attribute(input, 'id')).map(text)
  }
  expect(['displayName', 'username', 'temporaryPassword'].map(labelled)).toEqual([['Display name'], ['Username'], ['Temporary password']])
  expect(find(html, element => element.tagName === 'legend').map(text)).toEqual(['Roles'])
})

test('the add-user sheet opens from the server only when asked, with a scrim link that closes it', () => {
  const sheetState = (open: boolean) => {
    const html = render({ addUser: { ...addUser, open } })
    const [dialog] = find(html, element => element.tagName === 'dialog')
    return [attribute(dialog!, 'open'), find(html, element => attribute(element, 'data-sheet-scrim') !== undefined).map(link => attribute(link, 'href')),
      find(html, element => attribute(element, 'data-sheet-close') !== undefined).map(link => attribute(link, 'href'))]
  }
  expect(sheetState(false)).toEqual([undefined, [], ['/admin/users?limit=25', '/admin/users?limit=25']])
  expect(sheetState(true)).toEqual(['', ['/admin/users?limit=25'], ['/admin/users?limit=25', '/admin/users?limit=25']])
})

test('add-user roles list each role with its tools, and say so when there are none', () => {
  const withRoles = render()
  expect(find(withRoles, element => element.tagName === 'label' && attribute(element, 'class') === 'check').map(text)).toEqual(['Synthetic RoleSynthetic Tool', 'AdministratorCan manage people, roles, tools and sign-in. Tool access still comes from roles.'])
  const without = render({ addUser: { ...addUser, roles: [] } })
  const [roles] = find(without, element => element.tagName === 'fieldset'
    && element.childNodes.some(child => 'tagName' in child && child.tagName === 'legend' && text(child) === 'Roles'))
  expect(text(roles!)).toContain('No roles yet. Create a role on Roles to grant tool access.')
})
