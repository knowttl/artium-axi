import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { SignIn, type SignInProps } from '../src/views/sign-in.js'
import { SignInMatches, type SignInMatchesProps } from '../src/views/sign-in-matches.js'

type Element = DefaultTreeAdapterMap['element']

const provider: SignInProps['providers'][number] = { href: '/admin/settings/sign-in/synthetic-entra', name: 'Synthetic Entra', initials: 'SE', kind: 'Entra ID',
  issuer: 'https://login.example/tenant/v2.0', configured: true, enabled: true }

const summaries: SignInProps['summaries'] = [
  { label: 'Current mode', value: 'Passwords for everyone', detail: 'No provider is enabled.', warning: false, action: null },
  { label: 'Break-glass admins', value: 'None designated', detail: 'Choose a local administrator.', warning: true, action: { href: '/admin/users?source=local', label: 'Choose admin' } },
]

const signIn = (overrides: Partial<SignInProps> = {}) => renderToString(createElement(Theme, { theme: neutralTheme,
  children: createElement(SignIn, { summaries, providers: [provider], addHref: '/admin/settings/sign-in?sheet=add-provider',
    add: { open: null, closeHref: '/admin/settings/sign-in', csrf: 'CANARY-csrf' }, ...overrides }) }))
const matches = (overrides: Partial<SignInMatchesProps> = {}) => renderToString(createElement(Theme, { theme: neutralTheme,
  children: createElement(SignInMatches, { people: [], note: 'Matches come from the last sign-in.', ...overrides }) }))

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const links = (html: string) => find(html, element => element.tagName === 'a').map(link => [attribute(link, 'href'), attribute(link, 'aria-label') ?? text(link)])

test('each summary card is a labelled region with its value, detail and optional action', () => {
  const html = signIn()
  const [mode, breakGlass] = find(html, element => attribute(element, 'role') === 'region' && ['Current mode', 'Break-glass admins'].includes(attribute(element, 'aria-label') ?? ''))
  expect(text(mode!)).toBe('Current modePasswords for everyoneNo provider is enabled.')
  expect(text(breakGlass!)).toBe('Break-glass adminsNone designatedChoose a local administrator.Choose admin')
  expect(links(html)).toContainEqual(['/admin/users?source=local', 'Choose admin'])
})

test.each([
  { configured: true, enabled: true, badges: 'Enabled', action: 'Open Synthetic Entra', visible: 'Open' },
  { configured: true, enabled: false, badges: 'Disabled', action: 'Continue setup of Synthetic Entra', visible: 'Continue setup' },
  { configured: false, enabled: false, badges: 'Needs credentialDisabled', action: 'Continue setup of Synthetic Entra', visible: 'Continue setup' },
])('a provider row with configured=$configured and enabled=$enabled says $badges and offers $action', ({ configured, enabled, badges, action, visible }) => {
  const [row] = find(signIn({ providers: [{ ...provider, configured, enabled }] }), element => attribute(element, 'data-provider') === provider.href)
  const cells = nodes(row!).filter(element => element.tagName === 'td')
  expect(text(cells[0]!)).toBe('SESynthetic EntraEntra ID · https://login.example/tenant/v2.0')
  expect(text(cells[1]!)).toBe(badges)
  expect(text(cells[2]!)).toBe(visible)
  expect(nodes(row!).filter(element => element.tagName === 'a').map(link => [attribute(link, 'href'), attribute(link, 'aria-label') ?? text(link)]))
    .toEqual([[provider.href, 'Synthetic Entra'], [provider.href, action]])
})

test('with no provider the list says so and offers the same Add provider link as the page frame', () => {
  const html = signIn({ providers: [] })
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(text(find(html, element => element.tagName === 'h3')[0]!)).toBe('No providers yet')
  expect(html).toContain('Add one, then save its credential.')
  expect(links(html)).toContainEqual(['/admin/settings/sign-in?sheet=add-provider', 'Add provider'])
})

test('the page content has no form, so nothing on it changes a provider or a secret', () => {
  expect(find(signIn(), element => ['form', 'input', 'textarea', 'select'].includes(element.tagName))).toEqual([])
})

test.each([
  { people: [], content: 'No one matches this rule in the saved sign-in claims.' },
  { people: [{ href: '/admin/users/synthetic-person', name: 'synthetic-person', initials: 'SY', claimsAt: '2026-11-15T10:00:00.000Z' }], content: 'synthetic-person' },
])('matching people content is in a named region', ({ people, content }) => {
  const regions = find(matches({ people }), element => attribute(element, 'role') === 'region' && attribute(element, 'aria-label') === 'Matching people')
  expect(regions).toHaveLength(1)
  expect(text(regions[0]!)).toContain(content)
})

test('matching people link to their pages with the time their claims were recorded', () => {
  const html = matches({ people: [{ href: '/admin/users/synthetic-person', name: 'synthetic-person', initials: 'SY', claimsAt: '2026-11-15T10:00:00.000Z' }] })
  const [row] = find(html, element => element.tagName === 'tr' && text(element).includes('synthetic-person'))
  expect(text(row!)).toBe('SYsynthetic-person2026-11-15T10:00:00.000Z')
  expect(find(html, element => element.tagName === 'table').map(table => attribute(table, 'aria-label'))).toEqual(['1 matching person'])
  expect(links(html)).toEqual([['/admin/users/synthetic-person', 'synthetic-person']])
  expect(find(html, element => element.tagName === 'time').map(time => attribute(time, 'datetime'))).toEqual(['2026-11-15T10:00:00.000Z'])
})

test('with no matching people the page says so and still explains where matches come from', () => {
  const html = matches()
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(html).toContain('No one matches this rule in the saved sign-in claims.')
  expect(find(html, element => attribute(element, 'role') === 'status').map(text)).toEqual(['Where matches come fromMatches come from the last sign-in.'])
})
