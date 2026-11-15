import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Role, type RoleProps } from '../src/views/role.js'

type Element = DefaultTreeAdapterMap['element']

const base: RoleProps = {
  csrf: 'synthetic-csrf', path: '/v1/admin/roles/synthetic-role', name: 'Synthetic Role', changed: { actor: 'synthetic-admin', at: '2026-01-01T00:00:00.000Z', revision: 7 },
  tools: [
    { name: 'falcon-axi', product: 'Falcon', mark: 'FA', granted: true, state: { word: 'Disabled', tone: 'off' }, note: 'members can’t use it yet' },
    { name: 'vectra-axi', product: 'Vectra', mark: 'VE', granted: false, state: { word: 'Healthy', tone: 'ok' }, note: null }],
  rawApi: [{ name: 'falcon-axi', product: 'Falcon', mode: 'Read', off: false, allowed: true }, { name: 'vectra-axi', product: 'Vectra', mode: 'Off', off: true, allowed: false }],
  members: { people: [{ href: '/admin/users/synthetic-one', name: 'Synthetic One', initials: 'SO', username: 'synthetic-one', grants: [{ word: 'Direct', tone: 'neutral' }, { word: 'SSO rule', tone: 'info' }],
    state: { word: 'Enabled', tone: 'ok' } }], pager: { summary: 'Showing 1 of 3', first: null, next: '/admin/roles/synthetic-role?cursor=synthetic&limit=1' } },
  blocked: null, rename: { open: false, closeHref: '/admin/roles/synthetic-role?limit=25' },
}

function render(overrides: Partial<RoleProps> = {}) {
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Role, { ...base, ...overrides }) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const formFor = (html: string, action: string, method: string) => find(html, element => element.tagName === 'form' && attribute(element, 'action') === action && attribute(element, 'data-method') === method)[0]
const fields = (form: Element) => nodes(form).filter(element => element.tagName === 'input').map(input => [attribute(input, 'name'), attribute(input, 'type') ?? 'text', attribute(input, 'value') ?? '', attribute(input, 'checked'), attribute(input, 'disabled')])
const formAttributes = (form: Element) => ['method', 'data-confirm', 'data-confirm-title', 'data-confirm-action', 'data-confirm-name', 'data-success-url', 'data-success-message', 'data-track-changes'].map(name => attribute(form, name))

test('the tool grants form replaces the selection after a confirmation, posts the revision and tracks changes', () => {
  const form = formFor(render(), '/v1/admin/roles/synthetic-role/tools', 'PUT')!
  expect(formAttributes(form)).toEqual(['post', 'Replace Synthetic Role’s tool grants? Changes apply to every member on the next call.', undefined, 'Save tools', undefined, undefined, undefined, ''])
  expect(fields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', undefined, undefined], ['expectedRevision', 'hidden', '7', undefined, undefined],
    ['tools', 'hidden', '', undefined, ''], ['tools', 'checkbox', 'falcon-axi', '', undefined], ['tools', 'checkbox', 'vectra-axi', undefined, undefined]])
})

test('every tool tile names its product and state, and a granted but disabled tool says members cannot use it', () => {
  const tiles = find(render(), element => element.tagName === 'label' && attribute(element, 'class') === 'tile').map(text)
  expect(tiles).toEqual(['FAFalconDisabled· members can’t use it yet', 'VEVectraHealthy'])
})

test('each raw API row posts its own route and confirmation, and the switch shows whether members are allowed', () => {
  const html = render()
  const falcon = formFor(html, '/v1/admin/roles/synthetic-role/tools/falcon-axi/raw-api', 'PUT')!
  expect(formAttributes(falcon).slice(0, 4)).toEqual(['post', 'Change Synthetic Role’s Raw API access to Falcon? Changes apply to every member on the next call.', undefined, 'Save access'])
  expect(fields(falcon)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', undefined, undefined], ['expectedRevision', 'hidden', '7', undefined, undefined], ['enabled', 'checkbox', '', '', undefined]])
  const vectra = formFor(html, '/v1/admin/roles/synthetic-role/tools/vectra-axi/raw-api', 'PUT')!
  expect(fields(vectra).at(-1)).toEqual(['enabled', 'checkbox', '', undefined, undefined])
  expect(attribute(nodes(vectra).find(element => attribute(element, 'name') === 'enabled')!, 'aria-label')).toBe('Allow Raw API for Vectra')
  expect(find(html, element => text(element).startsWith('Tool mode: ') && !nodes(element).some(inner => inner !== element && text(inner) === text(element))).map(text))
    .toEqual(['Tool mode: Read.', 'Tool mode: Off. Members cannot make raw calls until an administrator changes it.'])
})

test('a role granting no raw API tool says how to offer it', () => {
  const html = render({ rawApi: [] })
  expect(find(html, element => attribute(element, 'action')?.endsWith('/raw-api') === true)).toEqual([])
  expect(find(html, element => element.tagName === 'p').map(text)).toContain('Grant a tool with raw API routes to offer this.')
})

test('an unused role offers a typed-name delete that returns to the list', () => {
  const form = formFor(render(), '/v1/admin/roles/synthetic-role', 'DELETE')!
  expect(formAttributes(form)).toEqual(['post', 'Delete Synthetic Role? Its tool grants will be removed. This cannot be undone.', undefined, 'Delete role', 'Synthetic Role', '/admin/roles', 'Role deleted.', undefined])
  expect(fields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', undefined, undefined], ['expectedRevision', 'hidden', '7', undefined, undefined]])
})

test('a role still in use shows why it cannot be deleted and offers no delete form', () => {
  const html = render({ blocked: 'Only an unused role can be deleted. Blocked by: 2 members.' })
  expect(formFor(html, '/v1/admin/roles/synthetic-role', 'DELETE')).toBeUndefined()
  expect(find(html, element => element.tagName === 'button' && text(element) === 'Delete…').map(button => attribute(button, 'aria-disabled'))).toEqual(['true'])
  expect(find(html, element => text(element) === 'Only an unused role can be deleted. Blocked by: 2 members.')).not.toEqual([])
})

test('the members table links each person and names how they hold the role', () => {
  const html = render()
  const [row] = find(html, element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td'))
  expect(nodes(row!).filter(element => element.tagName === 'a').map(link => [attribute(link, 'href'), text(link)])).toEqual([['/admin/users/synthetic-one', 'Synthetic One']])
  expect(nodes(row!).filter(element => element.tagName === 'th').map(cell => [attribute(cell, 'scope'), text(cell)])).toEqual([['row', 'SOSynthetic Onesynthetic-one']])
  expect(nodes(row!).filter(element => element.tagName === 'td').map(text)).toEqual(['DirectSSO rule', 'Enabled'])
  expect(find(html, element => element.tagName === 'th' && attribute(element, 'scope') === 'col').map(text)).toEqual(['Name', 'How', 'Status'])
  expect(find(html, element => element.tagName === 'table').map(table => attribute(table, 'aria-label'))).toEqual(['Members of Synthetic Role'])
})

test('the members pager links the next page and disables a missing first page', () => {
  const [navigation] = find(render(), element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Pages')
  expect(nodes(navigation!).filter(element => ['a', 'button'].includes(element.tagName)).map(control => [text(control), control.tagName, attribute(control, 'href')]))
    .toEqual([['First', 'button', undefined], ['Next', 'a', '/admin/roles/synthetic-role?cursor=synthetic&limit=1']])
})

test('a role with no members says how to give it', () => {
  const html = render({ members: { people: [], pager: base.members.pager } })
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(find(html, element => element.tagName === 'p').map(text)).toContain('No members yet. Give this role to people on their page in People.')
})

test('the rename sheet patches the name with the revision and no confirmation, and opens only when asked', () => {
  const state = (open: boolean) => find(render({ rename: { ...base.rename, open } }), element => element.tagName === 'dialog').map(dialog => attribute(dialog, 'open'))
  expect([state(false), state(true)]).toEqual([[undefined], ['']])
  const form = formFor(render(), '/v1/admin/roles/synthetic-role', 'PATCH')!
  expect(formAttributes(form)).toEqual(['post', undefined, undefined, undefined, undefined, undefined, 'Role renamed.', undefined])
  expect(fields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', undefined, undefined], ['expectedRevision', 'hidden', '7', undefined, undefined], ['name', 'text', 'Synthetic Role', undefined, undefined]])
  expect(find(render(), element => element.tagName === 'a' && attribute(element, 'data-sheet-close') !== undefined).map(link => attribute(link, 'href'))).toEqual(['/admin/roles/synthetic-role?limit=25', '/admin/roles/synthetic-role?limit=25'])
})

test('the last change is shown with its actor, time and revision', () => {
  expect(find(render(), element => element.tagName === 'p' && text(element).startsWith('Last changed')).map(text)).toEqual(['Last changed by synthetic-admin at 2026-01-01T00:00:00.000Z. Revision 7.'])
})
