import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { Provider, type ProviderProps } from '../src/views/provider.js'

type Element = DefaultTreeAdapterMap['element']

const page = '/admin/settings/sign-in/synthetic-provider'
const entra: ProviderProps = {
  csrf: 'CANARY-csrf', page, api: '/v1/admin/sso/providers/synthetic-provider', tab: 'setup', tabs: [], initials: 'SP', kind: 'entra', kindLabel: 'Entra ID', name: 'Synthetic provider',
  issuer: 'https://login.example/tenant/v2.0', tenantId: 'tenant', enabled: false, revision: 4, changed: { actor: 'synthetic-admin', at: '2026-11-15T10:00:00.000Z', revision: 4 },
  credentialConfigured: false, breakGlass: false, problems: ['No credential saved.', 'A usable break-glass local administrator is required.'],
  activationConsequence: 'Enable synthetic sign-in?', redirectUri: 'https://artium.example/auth/sso/synthetic-provider/callback', logoutUri: 'https://artium.example/login',
}
const oidc: ProviderProps = { ...entra, kind: 'oidc', kindLabel: 'OpenID Connect', tenantId: null, issuer: 'https://identity.example' }

const render = (props: ProviderProps) => renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Provider, props) }))
const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const steps = (html: string) => find(html, element => /^vstep(\s|$)/.test(attribute(element, 'class') ?? ''))
  .map(step => [text(nodes(step).find(element => element.tagName === 'strong')!), attribute(step, 'class')!.split(' ').slice(1).join(' ')])

test.each([
  { name: 'entra', props: entra, titles: ['Save the directory tenant', 'Add a Web platform redirect URI', 'Save the app credential', 'Define app roles', 'Require assignment', 'Have a break-glass admin ready', 'Prepare invitations', 'Enable, then test in a separate browser'] },
  { name: 'oidc', props: oidc, titles: ['Save the issuer', 'Register Artium as a confidential web app', 'Save the app credential', 'Include the claims Artium needs', 'Have a break-glass admin ready', 'Prepare access', 'Enable, then test in a separate browser'] },
])('the $name checklist ticks the steps the provider state proves and marks the first open step current', ({ props, titles }) => {
  const states = (overrides: Partial<ProviderProps>) => steps(render({ ...props, ...overrides })).map(([, state]) => state)
  expect(steps(render(props)).map(([title]) => title)).toEqual(titles)
  expect(states({})).toEqual(titles.map((_title, index) => index === 0 ? 'done' : index === 1 ? 'current' : ''))
  const credential = titles.indexOf('Save the app credential')
  const breakGlass = titles.indexOf('Have a break-glass admin ready')
  expect(states({ credentialConfigured: true, breakGlass: true, enabled: true })).toEqual(titles.map((_title, index) =>
    [0, credential, breakGlass, titles.length - 1].includes(index) ? 'done' : index === 1 ? 'current' : ''))
})

test.each([
  { enabled: true, problems: [], banner: 'Sign-in is enabled', detail: 'Saving provider settings or the credential disables this provider until you enable it again.' },
  { enabled: false, problems: [], banner: 'Ready to enable', detail: 'Credential configuration and a usable break-glass administrator are present.' },
  { enabled: false, problems: ['No credential saved.', 'A usable break-glass local administrator is required.'], banner: 'Not ready to enable',
    detail: 'No credential saved. A usable break-glass local administrator is required.' },
])('the readiness banner for enabled=$enabled with $problems.length problems says $banner', ({ enabled, problems, banner, detail }) => {
  const [region] = find(render({ ...entra, enabled, problems }), element => attribute(element, 'role') === 'status' && text(element).includes(banner))
  expect(text(region!)).toContain(detail)
})

test.each([
  { enabled: false, problems: [], label: 'Enable sign-in', value: 'true' },
  { enabled: true, problems: [], label: 'Disable sign-in', value: 'false' },
  { enabled: true, problems: ['No credential saved.'], label: 'Disable sign-in', value: 'false' },
])('an activation form for enabled=$enabled offers $label and posts the opposite state with the revision', ({ enabled, problems, label, value }) => {
  const [form] = find(render({ ...entra, enabled, problems }), element => attribute(element, 'action') === `${entra.api}/activation`)
  expect(attribute(form!, 'data-method')).toBe('PATCH')
  expect(attribute(form!, 'data-confirm')).toBe(entra.activationConsequence)
  expect(nodes(form!).filter(element => element.tagName === 'input').map(input => [attribute(input, 'name'), attribute(input, 'value')]))
    .toEqual([['_csrf', 'CANARY-csrf'], ['expectedRevision', '4'], ['enabled', value]])
  expect(text(nodes(form!).find(element => element.tagName === 'button')!)).toBe(label)
})
