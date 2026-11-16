import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Tokens, type TokensProps } from '../src/views/tokens.js'

type Element = DefaultTreeAdapterMap['element']

const token: TokensProps['tokens'][number] = { id: 'token-1', label: 'Synthetic token', creator: 'synthetic-user', writable: false, singleUse: false,
  expiresAt: '2026-01-01T01:00:00.000Z', status: { word: 'Active', tone: 'ok' }, revocable: true, scope: [{ tool: 'falcon-axi' }] }
const settings: TokensProps['settings'] = { mintingEnabled: true, maxLifetimeHours: 720, ssoWindowDays: 7 }

const render = (tokens: TokensProps['tokens']) => renderToString(createElement(Theme, { theme: neutralTheme,
  children: createElement(Tokens, { csrf: 'CANARY-csrf', settings, tokens }) }))

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const cells = (html: string) => nodes(find(html, element => attribute(element, 'data-token') === token.id)[0]!).filter(element => ['th', 'td'].includes(element.tagName))

test('a token row shows its label and id, creator, access with scope, expiry, status and Revoke in separate cells', () => {
  expect(cells(render([token])).map(text)).toEqual(['Synthetic tokentoken-1', 'synthetic-user', 'Read-only · Reusablefalcon-axi: Tool-wide', '2026-01-01T01:00:00.000Z', 'Active', 'Revoke'])
})

test.each([
  { writable: false, singleUse: false, access: 'Read-only · Reusable' },
  { writable: true, singleUse: false, access: 'Writes allowed · Reusable' },
  { writable: false, singleUse: true, access: 'Read-only · Single use' },
  { writable: true, singleUse: true, access: 'Writes allowed · Single use' },
])('a token with writable=$writable and singleUse=$singleUse says $access', ({ writable, singleUse, access }) => {
  expect(text(cells(render([{ ...token, writable, singleUse }]))[2]!)).toMatch(new RegExp(`^${access}`))
})

test.each([
  { scope: [{ tool: 'falcon-axi' }], items: ['falcon-axi: Tool-wide'] },
  { scope: [{ tool: 'falcon-axi', commands: ['detection list', 'detection show'] }], items: ['falcon-axi: detection list, detection show'] },
  { scope: [{ tool: 'falcon-axi', instances: ['lab', 'prod'] }], items: ['falcon-axi (instances: lab, prod): Tool-wide'] },
  { scope: [{ tool: 'falcon-axi', instances: ['lab'], commands: ['detection list'] }, { tool: 'gh-axi' }],
    items: ['falcon-axi (instances: lab): detection list', 'gh-axi: Tool-wide'] },
])('the scope $scope lists $items', ({ scope, items }) => {
  const list = nodes(cells(render([{ ...token, scope }]))[2]!).filter(element => element.tagName === 'li')
  expect(list.map(text)).toEqual(items)
})

test('a revoked token has no Revoke form, and a token that is not revoked has one that posts to its own URL', () => {
  const html = render([{ ...token, id: 'token-live' }, { ...token, id: 'token-gone', revocable: false, status: { word: 'Revoked', tone: 'neutral' } }])
  const actions = find(html, element => element.tagName === 'form').map(form => attribute(form, 'action'))
  expect(actions).toEqual(['/v1/admin/token-settings', '/v1/admin/tokens/token-live/revoke', '/v1/admin/tokens/revoke-all'])
})

test('with no tokens there is an empty state and no table', () => {
  const html = render([])
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(text(find(html, element => element.tagName === 'h3')[0]!)).toBe('No tokens')
})
