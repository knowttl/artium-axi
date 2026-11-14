import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Frame } from '../src/views/frame.js'

function render(options: { description?: string, actions?: ReactNode } = {}) {
  const frame = createElement(Frame, { title: 'Synthetic title', ...options, crumbs: [{ label: 'Access', href: '/admin/users' }, { label: 'Synthetic title' }],
    brand: '<a class="brand" href="/synthetic-home">Synthetic brand</a>', navigation: '<nav aria-label="Synthetic links"></nav>', mobileNavigation: '', topbarEnd: '<span>Synthetic header end</span>', children: 'Synthetic content' })
  return renderToString(createElement(Theme, { theme: neutralTheme, children: frame }))
}

test('the page header places actions after the title and description', () => {
  const html = render({ description: 'Synthetic description.', actions: createElement('a', { href: '/synthetic-action' }, 'Synthetic action') })
  expect(html).toMatch(/<h1[^>]*>Synthetic title<\/h1>.*Synthetic description\..*<a href="\/synthetic-action">Synthetic action<\/a>.*Synthetic content/s)
})

test('the frame places the server-built brand, navigation and header end markup in its regions', () => {
  const nodes = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'][] => [
    ...('tagName' in node ? [node] : []), ...('childNodes' in node ? node.childNodes.flatMap(nodes) : []),
  ]
  const elements = nodes(parseFragment(render()))
  const attribute = (element: DefaultTreeAdapterMap['element'], name: string) => element.attrs.find(item => item.name === name)?.value
  const sidebar = elements.find(element => attribute(element, 'class')?.split(' ').includes('astryx-app-shell-sidenav'))!
  const banner = elements.find(element => attribute(element, 'role') === 'banner')!
  expect(nodes(sidebar).some(element => element.tagName === 'a' && attribute(element, 'href') === '/synthetic-home')).toBe(true)
  expect(nodes(sidebar).some(element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Synthetic links')).toBe(true)
  expect(nodes(banner).some(element => 'childNodes' in element && element.childNodes.some(child => 'value' in child && child.value === 'Synthetic header end'))).toBe(true)
})

test('the breadcrumb links the parent and marks the current page', () => {
  const html = render()
  expect(html).toMatch(/<a [^>]*href="\/admin\/users"[^>]*>Access<\/a>/)
  expect(html).toMatch(/aria-current="page"[^>]*>Synthetic title</)
})
