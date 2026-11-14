import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
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
  const html = render()
  expect(html).toContain('<a class="brand" href="/synthetic-home">Synthetic brand</a>')
  expect(html).toContain('<nav aria-label="Synthetic links"></nav>')
  expect(html).toContain('<span>Synthetic header end</span>')
})

test('the breadcrumb links the parent and marks the current page', () => {
  const html = render()
  expect(html).toMatch(/<a [^>]*href="\/admin\/users"[^>]*>Access<\/a>/)
  expect(html).toMatch(/aria-current="page"[^>]*>Synthetic title</)
})
