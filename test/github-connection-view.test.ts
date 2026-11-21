import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { GithubConnection, type GithubConnectionProps } from '../src/views/github-connection.js'

type Element = DefaultTreeAdapterMap['element']

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const connectForm = (html: string) => find(html, element => element.tagName === 'form' && attribute(element, 'data-connect-github') !== undefined)[0]!
const controls = (form: Element) => nodes(form).filter(element => element.tagName === 'input').map(element => [attribute(element, 'name'), attribute(element, 'type'), attribute(element, 'value')])

const start = '/v1/admin/tools/gh-axi/device'
const added: GithubConnectionProps = { action: start, toolRevision: 7, origin: 'https://github.com', instance: null, connected: null, expired: false }
const saved: GithubConnectionProps = { ...added, origin: 'https://github.example', instance: { id: 'synthetic-lab-id', name: 'lab', revision: 3 } }
const connected: GithubConnectionProps = { ...saved, connected: { login: 'synthetic-machine', expiresAt: '2027-01-02T03:04:05.000Z' } }

const render = (props: GithubConnectionProps) =>
  renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(GithubConnection, { csrf: 'synthetic-csrf', ...props }) }))

test.each([
  { name: 'a new instance', props: added, heading: 'Add an instance with GitHub', button: 'Connect with GitHub',
    consequence: 'Connect a GitHub account with repo, read:org, gist, workflow and project scopes to a new instance? The instance is created after authorization.',
    fields: [['_csrf', 'hidden', 'synthetic-csrf'], ['expectedRevision', 'hidden', '0'], ['instance', 'text', ''], ['expectedToolRevision', 'hidden', '7'], ['origin', 'url', 'https://github.com']] },
  { name: 'a saved instance without a device credential', props: saved, heading: 'Connect with GitHub', button: 'Connect with GitHub',
    consequence: 'Connect a GitHub account with repo, read:org, gist, workflow and project scopes to this instance? This replaces its credential after authorization.',
    fields: [['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3'], ['instance', 'hidden', 'lab'],
      ['expectedToolRevision', 'hidden', '7'], ['origin', 'url', 'https://github.example']] },
  { name: 'an instance with a device credential', props: connected, heading: 'Reconnect with GitHub', button: 'Reconnect with GitHub',
    consequence: 'Connect a GitHub account with repo, read:org, gist, workflow and project scopes to this instance? This replaces its credential after authorization.',
    fields: [['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3'], ['instance', 'hidden', 'lab'],
      ['expectedToolRevision', 'hidden', '7'], ['origin', 'url', 'https://github.example']] },
])('the card for $name starts the device flow with its identity, revisions and confirmation', ({ props, heading, button, consequence, fields }) => {
  const html = render(props)
  const form = connectForm(html)
  expect([attribute(form, 'action'), attribute(form, 'data-method'), attribute(form, 'data-confirm'), attribute(form, 'data-confirm-title')]).toEqual([start, 'POST', consequence, undefined])
  expect(controls(form)).toEqual(fields)
  expect(nodes(form).filter(element => element.tagName === 'button').map(text)).toEqual([button])
  expect(find(html, element => element.tagName === 'h2').map(text)).toEqual([heading])
  expect(nodes(form).filter(element => attribute(element, 'name') === 'expectedToolRevision').map(element => attribute(element, 'data-type'))).toEqual(['number'])
})

test('a new instance needs a lowercase name of at most 32 characters', () => {
  const [name] = nodes(connectForm(render(added))).filter(element => attribute(element, 'name') === 'instance')
  expect([attribute(name!, 'required'), attribute(name!, 'maxlength'), attribute(name!, 'pattern'), attribute(name!, 'autocomplete'), attribute(name!, 'spellcheck')])
    .toEqual(['', '32', '[a-z0-9][a-z0-9\\-]*', 'off', 'false'])
})

test.each([
  { props: connected, shown: 'Connected account: synthetic-machine. Provider expiry: 2027-01-02T03:04:05.000Z' },
  { props: { ...connected, connected: { login: 'synthetic-machine', expiresAt: null } }, shown: 'Connected account: synthetic-machine. No scheduled expiry.' },
])('the connected account is shown with its expiry: $shown', ({ props, shown }) => {
  expect(find(render(props), element => element.tagName === 'p').map(text)).toContain(shown)
})

test.each([
  { props: added, connected: false },
  { props: saved, connected: false },
  { props: connected, connected: true },
])('the connected account line appears only for a device credential (connected=$connected)', ({ props, connected: expected }) => {
  expect(render(props).includes('Connected account:')).toBe(expected)
})

test.each([{ expired: true, alerts: ['The credential expired or was revoked'] }, { expired: false, alerts: [] }])(
  'an expired credential raises one alert (expired=$expired)', ({ expired, alerts }) => {
    const html = render({ ...connected, expired })
    expect(find(html, element => attribute(element, 'role') === 'alert').map(element => text(element).includes('The credential expired or was revoked') ? 'The credential expired or was revoked' : text(element))).toEqual(alerts)
  })

test('the device authorization panel is hidden and empty until a connection starts, and holds the disabled cancel control outside the form', () => {
  const html = render(added)
  const [panel] = find(html, element => attribute(element, 'data-github-authorization') !== undefined)
  expect(attribute(panel!, 'hidden')).toBe('')
  const inside = (name: string) => nodes(panel!).filter(element => attribute(element, name) !== undefined)
  expect(['data-github-link', 'data-github-code', 'data-github-status'].map(name => inside(name).map(text))).toEqual([[''], [''], ['']])
  const [link] = inside('data-github-link')
  expect([link!.tagName, attribute(link!, 'href'), attribute(link!, 'target'), attribute(link!, 'rel')]).toEqual(['a', undefined, '_blank', 'noopener noreferrer'])
  expect(inside('data-github-status').map(element => attribute(element, 'role'))).toEqual(['status'])
  const [cancel] = inside('data-cancel-github')
  expect([cancel!.tagName, attribute(cancel!, 'type'), text(cancel!), attribute(cancel!, 'aria-disabled')]).toEqual(['button', 'button', 'Cancel connection', 'true'])
  expect(nodes(connectForm(html)).some(element => attribute(element, 'data-github-authorization') !== undefined)).toBe(false)
})

test('the card keeps the credential-method note only for a saved instance', () => {
  const note = 'Alternatively, choose token or github-app below to replace the credential using another method.'
  expect([render(added).includes(note), render(saved).includes(note)]).toEqual([false, true])
})
