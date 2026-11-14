import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Auth, type AuthBlock, type AuthProps } from '../src/views/auth.js'

type Element = DefaultTreeAdapterMap['element']

function render(overrides: Partial<AuthProps> = {}) {
  const props: AuthProps = { title: 'Synthetic title', brand: { name: 'Synthetic brand', href: '/synthetic-home' }, blocks: [], help: '<p>Synthetic help</p>', themeSwitch: '', ...overrides }
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Auth, props) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)

const signIn: AuthBlock = { kind: 'form', action: '/synthetic-sign-in', post: { csrf: 'synthetic-token', hidden: { code: 'SYNTH-CODE' } },
  fields: [{ id: 'synthetic-user', name: 'username', label: 'Synthetic user', type: 'text', autoComplete: 'username' },
    { id: 'synthetic-secret', name: 'secret', label: 'Synthetic secret', type: 'password', autoComplete: 'current-password', hint: 'Synthetic hint' }],
  blocks: [{ kind: 'buttons', row: true, buttons: [{ label: 'Synthetic deny', tone: 'destructive', name: 'decision', value: 'deny' }, { label: 'Synthetic approve', tone: 'primary', name: 'decision', value: 'approve' }] }] }

test('a post form keeps its action, method, CSRF token and hidden values', () => {
  const [form] = find(render({ blocks: [signIn] }), element => element.tagName === 'form' && attribute(element, 'action') === '/synthetic-sign-in')
  expect(attribute(form!, 'method')).toBe('post')
  const hidden = nodes(form!).filter(element => element.tagName === 'input' && attribute(element, 'type') === 'hidden')
  expect(hidden.map(input => [attribute(input, 'name'), attribute(input, 'value')])).toEqual([['_csrf', 'synthetic-token'], ['code', 'SYNTH-CODE']])
})

test('a get form carries no CSRF token', () => {
  const html = render({ blocks: [{ kind: 'form', action: '/synthetic-lookup', fields: [], blocks: [] }] })
  const [form] = find(html, element => element.tagName === 'form' && attribute(element, 'action') === '/synthetic-lookup')
  expect(attribute(form!, 'method')).toBe('get')
  expect(nodes(form!).some(element => attribute(element, 'name') === '_csrf')).toBe(false)
})

test('each field is a required input named for its label with its autocomplete and description', () => {
  const html = render({ blocks: [signIn] })
  const inputs = find(html, element => element.tagName === 'input' && ['text', 'password'].includes(attribute(element, 'type') ?? ''))
  expect(inputs.map(input => [attribute(input, 'id'), attribute(input, 'name'), attribute(input, 'type'), attribute(input, 'autocomplete')]))
    .toEqual([['synthetic-user', 'username', 'text', 'username'], ['synthetic-secret', 'secret', 'password', 'current-password']])
  expect(inputs.every(input => attribute(input, 'required') !== undefined)).toBe(true)
  expect(find(html, element => element.tagName === 'label' && attribute(element, 'for') === 'synthetic-secret')).toHaveLength(1)
  const described = attribute(inputs[1]!, 'aria-describedby')!.split(' ')
  expect(find(html, element => described.includes(attribute(element, 'id') ?? '')).map(text)).toContain('Synthetic hint')
})

test('decision buttons submit their name and value and links stay links', () => {
  const html = render({ blocks: [signIn, { kind: 'buttons', buttons: [{ label: 'Synthetic link', tone: 'secondary', href: '/synthetic-next', marker: 'data-synthetic-marker' }] }] })
  const submits = find(html, element => element.tagName === 'button' && attribute(element, 'name') === 'decision')
  expect(submits.map(button => [attribute(button, 'type'), attribute(button, 'value')])).toEqual([['submit', 'deny'], ['submit', 'approve']])
  const [link] = find(html, element => element.tagName === 'a' && attribute(element, 'href') === '/synthetic-next')
  expect(attribute(link!, 'data-synthetic-marker')).toBe('')
})

test('the go back button starts hidden for the history script to reveal', () => {
  const [back] = find(render({ blocks: [{ kind: 'buttons', buttons: [{ label: 'Synthetic back', tone: 'secondary', back: true }] }] }), element => attribute(element, 'data-history-back') !== undefined)
  expect([back!.tagName, attribute(back!, 'type'), attribute(back!, 'hidden')]).toEqual(['button', 'button', ''])
})

test.each([
  [true, ['providerLogout']],
  [false, []],
])('a signed-in viewer with sso %s gets a sign-out form offering these provider sign-out fields', (sso, extra) => {
  const html = render({ signedIn: { name: 'Synthetic viewer', csrf: 'synthetic-token', sso } })
  const [form] = find(html, element => element.tagName === 'form' && attribute(element, 'action') === '/logout')
  const names = nodes(form!).filter(element => element.tagName === 'input').map(input => attribute(input, 'name'))
  expect(names).toEqual(['_csrf', ...extra])
})

test('a signed-out page has no sign-out form', () => {
  expect(find(render(), element => attribute(element, 'action') === '/logout')).toEqual([])
})

test('the page has one h1 and a skip link to the main region', () => {
  const html = render({ description: 'Synthetic description.' })
  expect(find(html, element => element.tagName === 'h1')).toHaveLength(1)
  expect(find(html, element => element.tagName === 'a' && attribute(element, 'href') === '#main')).toHaveLength(1)
  expect(find(html, element => element.tagName === 'main' && attribute(element, 'id') === 'main')).toHaveLength(1)
})
