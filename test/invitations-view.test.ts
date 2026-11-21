import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Invitations, type InvitationsProps } from '../src/views/invitations.js'

type Element = DefaultTreeAdapterMap['element']

const invitation: InvitationsProps['invitations'][number] = { id: 'synthetic-invitation', name: 'Synthetic Invitee', initials: 'SI', detail: 'New account',
  username: 'synthetic@identity.example', provider: 'Synthetic Entra', roles: ['Synthetic Role'], status: { word: 'Pending', tone: 'info' },
  expiresAt: '2026-11-22T00:00:00.000Z', actions: { resend: { open: false, closeHref: '/admin/invitations', href: '/admin/invitations?sheet=resend-synthetic-invitation' }, revision: 3 } }

const create: NonNullable<InvitationsProps['create']> = { open: false, closeHref: '/admin/invitations', title: 'New invitation', description: 'Nothing exists until the link is claimed.',
  providers: [{ id: 'synthetic-entra', name: 'Synthetic Entra', enabled: true }, { id: 'synthetic-oidc', name: 'Synthetic OIDC', enabled: false }],
  roles: [{ id: 'synthetic-role', name: 'Synthetic Role', detail: 'Synthetic Falcon' }], userId: null, displayName: '' }

function render(overrides: Partial<InvitationsProps> = {}) {
  const props: InvitationsProps = { csrf: 'synthetic-csrf', path: '/v1/admin/sso/invitations', banner: null, invitations: [invitation],
    pager: { summary: 'Showing 1 invitation', first: null, next: null }, create, ...overrides }
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Invitations, props) }))
}

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const formTo = (html: string, action: string) => find(html, element => element.tagName === 'form' && attribute(element, 'action') === action)[0]!
const fields = (form: Element) => nodes(form).filter(element => ['input', 'select'].includes(element.tagName)).map(control =>
  [attribute(control, 'name'), attribute(control, 'type') ?? (control.tagName === 'select' ? 'select' : 'text'), attribute(control, 'value') ?? '', attribute(control, 'data-type') ?? ''])
const formAttributes = (form: Element) => ['method', 'data-method', 'data-confirm', 'data-confirm-title', 'data-confirm-action']
  .map(name => attribute(form, name))

test('each invitation row names the person, expected username, provider, roles, status and expiry', () => {
  const [row] = find(render(), element => element.tagName === 'tr' && attribute(element, 'data-invitation') === 'synthetic-invitation')
  expect(nodes(row!).filter(element => element.tagName === 'td').map(text)).toEqual([
    'SISynthetic InviteeNew account', 'synthetic@identity.example', 'Synthetic Entra', 'Synthetic Role', 'Pending', '2026-11-22T00:00:00.000Z', 'ResendRevoke'])
  expect(nodes(row!).filter(element => element.tagName === 'time').map(time => attribute(time, 'datetime'))).toEqual(['2026-11-22T00:00:00.000Z'])
})

test('an invitation that cannot be resent or revoked shows no actions, and one with no roles says so', () => {
  const html = render({ invitations: [{ ...invitation, status: { word: 'Claimed', tone: 'ok' }, roles: [], actions: null }] })
  const [row] = find(html, element => element.tagName === 'tr' && attribute(element, 'data-invitation') === 'synthetic-invitation')
  expect(text(row!)).toContain('None')
  expect(nodes(row!).filter(element => ['a', 'button', 'form'].includes(element.tagName))).toEqual([])
  expect(find(html, element => attribute(element, 'id') === 'sheet-resend-synthetic-invitation')).toEqual([])
})

test('revoke posts the revision with the CSRF token behind a confirmation that names its consequence', () => {
  const form = formTo(render(), '/v1/admin/sso/invitations/synthetic-invitation/revoke')
  expect(fields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', ''], ['expectedRevision', 'hidden', '3', 'number']])
  expect(formAttributes(form)).toEqual(['post', 'POST', 'Revoke this invitation? The link can no longer be claimed. Existing accounts and access are unchanged.',
    'Revoke invitation', 'Revoke'])
})

test('resend opens from its own link and posts the revision and lifetime', () => {
  const html = render()
  const [link] = find(html, element => attribute(element, 'data-sheet') === 'sheet-resend-synthetic-invitation')
  expect([attribute(link!, 'href'), text(link!)]).toEqual(['/admin/invitations?sheet=resend-synthetic-invitation', 'Resend'])
  const form = formTo(html, '/v1/admin/sso/invitations/synthetic-invitation/resend')
  expect(fields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', ''], ['expectedRevision', 'hidden', '3', 'number'], ['expiresInDays', 'text', '7', 'number']])
  expect(formAttributes(form)).toEqual(['post', 'POST', 'Replace this invitation link? The old link immediately stops working. Send the new link securely yourself.',
    'Resend invitation', 'Resend'])
})

test('the new-invitation form posts every field with the CSRF token behind a confirmation', () => {
  const form = formTo(render(), '/v1/admin/sso/invitations')
  expect(fields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', ''], ['providerId', 'select', '', ''], ['displayName', 'text', '', ''],
    ['expectedUsername', 'text', '', ''], ['roleIds', 'hidden', '', 'array'], ['roleIds', 'checkbox', 'synthetic-role', ''], ['expiresInDays', 'text', '7', 'number']])
  expect(formAttributes(form)).toEqual(['post', 'POST', 'Create a one-time invitation link? It is shown once; copy it before closing the result and send it securely yourself.',
    'Create invitation', 'Create link'])
  expect(find(render(), element => element.tagName === 'option').map(option => [attribute(option, 'value'), text(option)]))
    .toEqual([['synthetic-entra', 'Synthetic Entra'], ['synthetic-oidc', 'Synthetic OIDC (not enabled yet)']])
})

test('linking a local user posts that user and prefills their display name', () => {
  const form = formTo(render({ create: { ...create, userId: 'synthetic-user', displayName: 'Synthetic Local' } }), '/v1/admin/sso/invitations')
  expect(fields(form).filter(([name]) => ['userId', 'displayName'].includes(name!))).toEqual([['userId', 'hidden', 'synthetic-user', ''], ['displayName', 'text', 'Synthetic Local', '']])
})

test('without a provider the page has no new-invitation form', () => {
  expect(find(render({ create: null }), element => attribute(element, 'id') === 'sheet-new-invitation')).toEqual([])
})

test.each([true, false])('the new-invitation sheet is open without JavaScript only when asked (open=%s)', open => {
  const [dialog] = find(render({ create: { ...create, open } }), element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-new-invitation')
  expect(attribute(dialog!, 'open')).toBe(open ? '' : undefined)
})

test('the claim link dialog is closed, empty, read only and labelled until a link is created', () => {
  const [dialog] = find(render(), element => element.tagName === 'dialog' && attribute(element, 'id') === 'invitation-link')
  expect(attribute(dialog!, 'open')).toBeUndefined()
  const [input] = nodes(dialog!).filter(element => element.tagName === 'input' && attribute(element, 'data-claim-link') !== undefined)
  expect(attribute(input!, 'readonly')).toBeDefined()
  expect(attribute(input!, 'value') ?? '').toBe('')
  expect(attribute(input!, 'aria-label')).toBe('Invitation link')
})

test('a banner names its problem and links to the fix', () => {
  const html = render({ banner: { status: 'warning', title: 'Links can’t be claimed yet', text: 'Synthetic Entra is not enabled.', link: { href: '/admin/settings/sign-in', label: 'Open Sign-in & SSO' } } })
  const [banner] = find(html, element => attribute(element, 'role') === 'status' && text(element).includes('Links can’t be claimed yet'))
  expect(text(banner!)).toContain('Synthetic Entra is not enabled.')
  expect(nodes(banner!).filter(element => element.tagName === 'a').map(link => [attribute(link, 'href'), text(link)])).toEqual([['/admin/settings/sign-in', 'Open Sign-in & SSO']])
  expect(find(render(), element => attribute(element, 'role') === 'status' && text(element).includes('claimed yet'))).toEqual([])
})

test('no invitations shows the empty message and no table', () => {
  const html = render({ invitations: [] })
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(text(find(html, element => element.tagName === 'h2')[0]!)).toBe('No invitations yet')
})

test('the pager links to its pages and disables a page that does not exist', () => {
  const pager = (first: string | null, next: string | null) => {
    const [navigation] = find(render({ pager: { summary: 'Showing 1 invitation', first, next } }), element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Pages')
    return nodes(navigation!).filter(element => ['a', 'button'].includes(element.tagName)).map(control => [text(control), control.tagName, attribute(control, 'href')])
  }
  expect(pager(null, '/admin/invitations?cursor=synthetic')).toEqual([['First page', 'button', undefined], ['Next', 'a', '/admin/invitations?cursor=synthetic']])
  expect(pager('/admin/invitations', null)).toEqual([['First page', 'a', '/admin/invitations'], ['Next', 'button', undefined]])
})
