import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Frame, type FrameAction } from '../src/views/frame.js'
import type { ReauthState } from '../src/views/reauth.js'

function render(options: { description?: string, actions?: FrameAction[], reauth?: ReauthState, sso?: boolean } = {}) {
  const frame = createElement(Frame, { title: 'Synthetic title', reauth: { remainingMs: 0 }, sso: false, ...options, crumbs: [{ label: 'Access', href: '/admin/users' }, { label: 'Synthetic title' }],
    brand: { name: 'Synthetic brand', href: '/synthetic-home' }, account: { name: 'Synthetic Person', initials: 'SP', method: 'Password · Admin', csrf: 'synthetic-token',
      links: [{ href: '/account', label: 'Your account', icon: 'user', current: true }, { href: '/password', label: 'Change password', icon: 'key', current: false }] },
    mode: 'light', themeSwitch: { next: '/synthetic-next' }, help: { title: 'Synthetic Page', paragraphs: ['Synthetic help one', 'Synthetic help two'] }, children: 'Synthetic content',
    navigation: [{ links: [{ href: '/synthetic-top', label: 'Synthetic top', icon: 'home', current: false }] },
      { title: 'Synthetic section', links: [{ href: '/synthetic-one', label: 'Synthetic one', icon: 'users', current: false }, { href: '/synthetic-two', label: 'Synthetic two', icon: 'list', current: true }] }] })
  return renderToString(createElement(Theme, { theme: neutralTheme, children: frame }))
}

test('the page header places actions after the title and description', () => {
  const html = render({ description: 'Synthetic description.', actions: [{ label: 'Synthetic action', href: '/synthetic-action', variant: 'primary', icon: 'plus' }] })
  expect(html).toMatch(/<h1[^>]*>Synthetic title<\/h1>.*Synthetic description\..*<a [^>]*href="\/synthetic-action"[^>]*>.*Synthetic action.*Synthetic content/s)
})

test('an action that opens a sheet names the sheet and stays a link without JavaScript', () => {
  const html = render({ actions: [{ label: 'Open sheet', href: '/synthetic-page?sheet=synthetic', variant: 'primary', icon: 'plus', sheet: 'sheet-synthetic' },
    { label: 'Plain link', href: '/synthetic-plain', variant: 'secondary', icon: 'mail' }] })
  const links = nodes(parseFragment(html)).filter(element => element.tagName === 'a' && attribute(element, 'href')?.startsWith('/synthetic-p'))
  expect(links.map(link => [attribute(link, 'href'), attribute(link, 'data-sheet')])).toEqual([['/synthetic-page?sheet=synthetic', 'sheet-synthetic'], ['/synthetic-plain', undefined]])
})

const nodes = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [
  ...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(nodes) : []),
]
const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: DefaultTreeAdapterMap['element']): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')

test('the frame places the brand, help panel and account menu in its regions', () => {
  const elements = nodes(parseFragment(render()))
  const sidebar = elements.find(element => attribute(element, 'class')?.split(' ').includes('astryx-app-shell-sidenav'))!
  const banner = elements.find(element => attribute(element, 'role') === 'banner')!
  expect(nodes(sidebar).some(element => element.tagName === 'a' && attribute(element, 'href') === '/synthetic-home' && text(element).includes('Synthetic brand'))).toBe(true)
  expect(nodes(sidebar).some(element => attribute(element, 'class')?.split(' ').includes('account-menu') && text(element).includes('Synthetic Person'))).toBe(true)
  expect(nodes(banner).some(element => attribute(element, 'class')?.split(' ').includes('learn'))).toBe(true)
})

test.each([['header end', 'frame-controls-header', 'banner'], ['narrow-screen menu', 'frame-controls-drawer', 'frame-mobile-menu']])('the %s holds the confirmation pill and the theme switch', (_name, controlsClass, ancestorMarker) => {
  const elements = nodes(parseFragment(render()))
  const ancestor = elements.find(element => attribute(element, 'role') === ancestorMarker || attribute(element, 'class')?.split(' ').includes(ancestorMarker))!
  const controls = nodes(ancestor).filter(element => attribute(element, 'class')?.split(' ').includes(controlsClass))
  expect(controls.map(text)).toEqual(['Changes lockedSystemLightDark'])
})

test.each([
  ['unlocked', { remainingMs: 14 * 60_000 }, 'on', 'Changes unlocked · 14 min'],
  ['rounds a partial minute up', { remainingMs: 60_001 }, 'on', 'Changes unlocked · 2 min'],
  ['locked at the end of the window', { remainingMs: 0 }, 'off', 'Changes locked'],
])('the confirmation pill is %s in both header placements', (_name, reauth, state, words) => {
  const pills = nodes(parseFragment(render({ reauth }))).filter(element => attribute(element, 'class')?.split(' ').includes('unlock'))
  expect(pills.map(pill => [attribute(pill, 'class'), text(pill)]))
    .toEqual(Array(2).fill([`unlock ${state}`, words]))
})

const regions = { 'side navigation': 'astryx-app-shell-sidenav', 'narrow-screen menu': 'frame-mobile-menu' }

test.each(Object.entries(regions))('the %s lists the links in order and marks only the current page', (_name, className) => {
  const container = nodes(parseFragment(render())).find(element => attribute(element, 'class')?.split(' ').includes(className))!
  const links = nodes(container).filter(element => element.tagName === 'a' && attribute(element, 'href')?.startsWith('/synthetic-') && attribute(element, 'href') !== '/synthetic-home')
  expect(links.map(link => [attribute(link, 'href'), attribute(link, 'aria-current')])).toEqual([['/synthetic-top', undefined], ['/synthetic-one', undefined], ['/synthetic-two', 'page']])
})

test.each(Object.entries(regions))('the %s names the section that holds the links', (_name, className) => {
  const elements = nodes(parseFragment(render()))
  const container = elements.find(element => attribute(element, 'class')?.split(' ').includes(className))!
  const group = nodes(container).find(element => attribute(element, 'role') === 'group')!
  const title = elements.find(element => attribute(element, 'id') === attribute(group, 'aria-labelledby'))!
  expect(text(title)).toBe('Synthetic section')
  expect(nodes(group).filter(element => element.tagName === 'a').map(link => attribute(link, 'href'))).toEqual(['/synthetic-one', '/synthetic-two'])
})

test('the side navigation is the one navigation landmark labelled Administration', () => {
  const sidebar = nodes(parseFragment(render())).find(element => attribute(element, 'class')?.split(' ').includes('astryx-app-shell-sidenav'))!
  const landmarks = nodes(sidebar).filter(element => element.tagName === 'nav' || attribute(element, 'role') === 'navigation')
  expect(landmarks.map(element => attribute(element, 'aria-label'))).toEqual(['Administration'])
})

test('the breadcrumb links the parent and marks the current page', () => {
  const html = render()
  expect(html).toMatch(/<a [^>]*href="\/admin\/users"[^>]*>Access<\/a>/)
  expect(html).toMatch(/aria-current="page"[^>]*>Synthetic title</)
})

test.each([['side navigation', 'astryx-app-shell-sidenav'], ['narrow-screen menu', 'frame-mobile-menu']])('the %s account menu names the person and links their pages', (_name, className) => {
  const container = nodes(parseFragment(render())).find(element => attribute(element, 'class')?.split(' ').includes(className))!
  const menu = nodes(container).find(element => attribute(element, 'class')?.split(' ').includes('account-menu'))!
  expect(text(nodes(menu).find(element => element.tagName === 'summary')!)).toBe('SPSigned in as Synthetic PersonPassword · Admin')
  expect(nodes(menu).filter(element => element.tagName === 'a').map(link => [attribute(link, 'href'), text(link), attribute(link, 'aria-current')]))
    .toEqual([['/account', 'Your account', 'page'], ['/password', 'Change password', undefined]])
})

test.each([
  [true, [['_csrf', 'hidden', 'synthetic-token', undefined], ['providerLogout', 'checkbox', 'true', undefined]]],
  [false, [['_csrf', 'hidden', 'synthetic-token', undefined]]],
])('both account menu sign-out forms for sso %s submit these fields', (sso, fields) => {
  const elements = nodes(parseFragment(render({ sso })))
  for (const [region, className] of Object.entries(regions)) {
    const container = elements.find(element => attribute(element, 'class')?.split(' ').includes(className))!
    const menu = nodes(container).find(element => attribute(element, 'class')?.split(' ').includes('account-menu'))!
    const forms = nodes(menu).filter(element => element.tagName === 'form' && attribute(element, 'action') === '/logout')
    expect(forms.map(form => [attribute(form, 'method'), nodes(form).filter(element => element.tagName === 'input')
      .map(input => ['name', 'type', 'value', 'checked'].map(name => attribute(input, name)))]), region).toEqual([['post', fields]])
  }
})

test('the help panel titles the page and lists each paragraph', () => {
  const panel = nodes(parseFragment(render())).find(element => attribute(element, 'class')?.split(' ').includes('learn-panel'))!
  expect(nodes(panel).map(element => [element.tagName, text(element)]).filter(([tag]) => tag === 'h2' || tag === 'p'))
    .toEqual([['h2', 'Help with synthetic page'], ['p', 'Synthetic help one'], ['p', 'Synthetic help two']])
})

test('the theme switch posts to the current page and marks the current mode', () => {
  const forms = nodes(parseFragment(render())).filter(element => element.tagName === 'form' && attribute(element, 'action') === '/theme')
  expect(forms.map(form => attribute(nodes(form).find(element => attribute(element, 'name') === 'next')!, 'value'))).toEqual(['/synthetic-next', '/synthetic-next'])
  expect(forms.map(form => nodes(form).filter(element => element.tagName === 'button').map(button => [text(button), attribute(button, 'aria-pressed')])))
    .toEqual(Array(2).fill([['System', 'false'], ['Light', 'true'], ['Dark', 'false']]))
})
