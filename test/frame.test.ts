import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Frame } from '../src/views/frame.js'

function render(options: { description?: string, actions?: ReactNode } = {}) {
  const frame = createElement(Frame, { title: 'Synthetic title', ...options, crumbs: [{ label: 'Access', href: '/admin/users' }, { label: 'Synthetic title' }],
    brand: { name: 'Synthetic brand', href: '/synthetic-home' }, account: '<button>Synthetic account</button>', topbarEnd: '<span>Synthetic header end</span>', children: 'Synthetic content',
    navigation: [{ links: [{ href: '/synthetic-top', label: 'Synthetic top', icon: 'home', current: false }] },
      { title: 'Synthetic section', links: [{ href: '/synthetic-one', label: 'Synthetic one', icon: 'users', current: false }, { href: '/synthetic-two', label: 'Synthetic two', icon: 'list', current: true }] }] })
  return renderToString(createElement(Theme, { theme: neutralTheme, children: frame }))
}

test('the page header places actions after the title and description', () => {
  const html = render({ description: 'Synthetic description.', actions: createElement('a', { href: '/synthetic-action' }, 'Synthetic action') })
  expect(html).toMatch(/<h1[^>]*>Synthetic title<\/h1>.*Synthetic description\..*<a href="\/synthetic-action">Synthetic action<\/a>.*Synthetic content/s)
})

const nodes = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [
  ...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(nodes) : []),
]
const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: DefaultTreeAdapterMap['element']): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')

test('the frame places the brand, header end markup and account menu in its regions', () => {
  const elements = nodes(parseFragment(render()))
  const sidebar = elements.find(element => attribute(element, 'class')?.split(' ').includes('astryx-app-shell-sidenav'))!
  const banner = elements.find(element => attribute(element, 'role') === 'banner')!
  expect(nodes(sidebar).some(element => element.tagName === 'a' && attribute(element, 'href') === '/synthetic-home' && text(element).includes('Synthetic brand'))).toBe(true)
  expect(nodes(sidebar).some(element => element.tagName === 'button' && text(element) === 'Synthetic account')).toBe(true)
  expect(nodes(banner).some(element => 'childNodes' in element && element.childNodes.some(child => 'value' in child && child.value === 'Synthetic header end'))).toBe(true)
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
