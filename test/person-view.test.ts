import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Person, type PersonProps } from '../src/views/person.js'

type Element = DefaultTreeAdapterMap['element']

const identity: PersonProps['identity'] = { initials: 'SO', username: 'synthetic-one', signIn: { word: 'Password', tone: 'neutral' }, state: { word: 'Enabled', tone: 'ok' }, administrator: false }
const active: NonNullable<PersonProps['active']> = { csrf: 'synthetic-csrf', path: '/v1/admin/users/synthetic-one', revision: 4, displayName: 'Synthetic One', administrator: true, enabled: true,
  linkToSso: '/admin/invitations?userId=synthetic-one&sheet=new-invitation', menu: '<details class="more-menu"></details>',
  roles: [{ id: 'synthetic-role', name: 'Synthetic Role', detail: 'Synthetic Tool' }, { id: 'other-role', name: 'Other Role', detail: 'No tools yet' }], directRoleIds: ['synthetic-role'],
  tools: [{ name: 'falcon-axi', product: 'Falcon', mark: 'FA', access: { word: 'Yes', tone: 'ok' }, failing: true, grantedBy: [{ href: '/admin/roles/synthetic-role', label: 'Synthetic Role · Direct' }] }],
  sessions: '<section id="synthetic-sessions"></section>', facts: { method: 'Local password', failedAttempts: 0, lockedUntil: null, password: 'Set by them' },
  reset: { open: false, closeHref: '/admin/users/synthetic-one' } }

function render(overrides: Partial<PersonProps> = {}) {
  const props: PersonProps = { identity, changed: { actor: 'synthetic-admin', at: '2026-01-01T00:00:00.000Z', revision: 4 }, ruleGrants: [], archived: null, active, ...overrides }
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Person, props) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const forms = (html: string) => find(html, element => element.tagName === 'form' && attribute(element, 'data-api') !== undefined)
const formFor = (html: string, action: string) => forms(html).find(form => attribute(form, 'action') === action)!
const fields = (form: Element) => nodes(form).filter(element => element.tagName === 'input').map(input => [attribute(input, 'name'), attribute(input, 'type') ?? 'text', attribute(input, 'value') ?? ''])

test('each editing form posts to its API route with the CSRF token, revision and confirmation text', () => {
  const html = render()
  const form = (action: string) => formFor(html, action)
  const confirmation = (action: string) => ['method', 'action', 'data-method', 'data-confirm-title', 'data-confirm-action'].map(name => attribute(form(action), name))
  expect(confirmation('/v1/admin/users/synthetic-one/roles')).toEqual(['post', '/v1/admin/users/synthetic-one/roles', 'PUT', 'Save roles', 'Save roles'])
  expect(attribute(form('/v1/admin/users/synthetic-one/roles'), 'data-confirm')).toBe('Replace synthetic-one’s direct roles with this selection? Tool access changes on the next call.')
  expect(fields(form('/v1/admin/users/synthetic-one/roles'))).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['roleIds', 'hidden', ''], ['roleIds', 'checkbox', 'synthetic-role'], ['roleIds', 'checkbox', 'other-role'], ['expectedRevision', 'hidden', '4']])
  const profile = forms(html).find(item => attribute(item, 'data-confirm-title') === 'Save profile')!
  expect([attribute(profile, 'action'), attribute(profile, 'data-method')]).toEqual(['/v1/admin/users/synthetic-one', 'PATCH'])
  expect(fields(profile)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedRevision', 'hidden', '4'], ['displayName', 'text', 'Synthetic One'], ['administrator', 'checkbox', '']])
})

test('direct roles are pre-selected and the empty selection still posts an empty roleIds array', () => {
  const inputs = find(render(), element => element.tagName === 'input' && attribute(element, 'name') === 'roleIds')
  expect(inputs.map(input => [attribute(input, 'type'), attribute(input, 'disabled'), attribute(input, 'checked')])).toEqual([['hidden', '', undefined], ['checkbox', undefined, ''], ['checkbox', undefined, undefined]])
})

test.each([
  { enabled: true, label: 'Disable…', sends: 'false', title: 'Disable access' },
  { enabled: false, label: 'Enable…', sends: 'true', title: 'Enable access' },
])('the access form for enabled=$enabled offers $label and sends enabled=$sends', ({ enabled, label, sends, title }) => {
  const form = forms(render({ active: { ...active, enabled } })).find(item => attribute(item, 'data-confirm-title') === title)!
  expect(text(form)).toBe(label)
  expect(fields(form).find(([name]) => name === 'enabled')).toEqual(['enabled', 'hidden', sends])
  expect(attribute(nodes(form).find(element => attribute(element, 'name') === 'enabled')!, 'data-type')).toBe('boolean')
})

test('archiving asks for the typed username and returns to the people list', () => {
  const form = formFor(render(), '/v1/admin/users/synthetic-one/archive')
  expect([attribute(form, 'data-confirm-name'), attribute(form, 'data-success-url'), attribute(form, 'data-method')]).toEqual(['synthetic-one', '/admin/users', 'POST'])
})

test('unlock appears only while the person is locked, and the lock expiry is shown', () => {
  const unlock = (lockedUntil: string | null) => forms(render({ active: { ...active, facts: { ...active.facts, lockedUntil } } })).filter(form => attribute(form, 'action')?.endsWith('/unlock')).length
  expect([unlock(null), unlock('2026-01-01T00:15:00.000Z')]).toEqual([0, 1])
  const expiry = find(render({ active: { ...active, facts: { ...active.facts, lockedUntil: '2026-01-01T00:15:00.000Z' } } }), element => element.tagName === 'time')
  expect(expiry.map(item => attribute(item, 'datetime') ?? attribute(item, 'dateTime'))).toContain('2026-01-01T00:15:00.000Z')
})

test('the reset-password sheet keeps its field name and opens from the server only when asked', () => {
  const sheet = (open: boolean) => find(render({ active: { ...active, reset: { open, closeHref: '/admin/users/synthetic-one' } } }), element => attribute(element, 'id') === 'sheet-reset-password')
  expect(sheet(false).map(element => attribute(element, 'open'))).toEqual([undefined])
  expect(sheet(true).map(element => attribute(element, 'open'))).toEqual([''])
  expect(fields(formFor(render(), '/v1/admin/users/synthetic-one/password-reset'))).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['temporaryPassword', 'password', '']])
  expect(find(render({ active: { ...active, reset: null } }), element => attribute(element, 'id') === 'sheet-reset-password')).toEqual([])
})

test('effective tools list who grants each tool and flag a failing tool', () => {
  const [row] = find(render(), element => element.tagName === 'tr' && nodes(element).some(item => item.tagName === 'td'))
  expect(text(row!)).toContain('Falcon')
  expect(text(row!)).toContain('(currently failing)')
  expect(nodes(row!).filter(element => element.tagName === 'a').map(link => attribute(link, 'href'))).toEqual(['/admin/roles/synthetic-role'])
})

test('SSO rule grants name their provider and rule', () => {
  const html = render({ ruleGrants: [{ role: 'Synthetic Role', provider: 'Entra ID', rule: 'synthetic-rule' }] })
  expect(text(find(html, element => element.tagName === 'li')[0]!)).toContain('From Entra ID rule synthetic-rule')
})

test('an archived person is read-only: no forms or inputs, with retained roles and the archive time', () => {
  const html = render({ active: null, archived: { at: '2026-01-02T00:00:00.000Z', roles: [{ href: '/admin/roles/synthetic-role', label: 'Synthetic Role · Direct' }] } })
  expect(find(html, element => ['form', 'input', 'button'].includes(element.tagName))).toEqual([])
  expect(html).toContain('Archived person')
  expect(html).toContain('history is retained')
  expect(find(html, element => element.tagName === 'a').map(link => attribute(link, 'href'))).toEqual(['/admin/roles/synthetic-role'])
  expect(text(find(render({ active: null, archived: { at: '2026-01-02T00:00:00.000Z', roles: [] } }), element => element.tagName === 'p').at(-2)!)).toBe('No retained roles remain.')
})
