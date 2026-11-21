import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import type { CredentialControl } from '../src/views/credential-editor.js'
import { Instance, type InstanceProps } from '../src/views/instance.js'

type Element = DefaultTreeAdapterMap['element']

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const forms = (html: string) => find(html, element => element.tagName === 'form' && attribute(element, 'data-api') !== undefined)
const formFor = (html: string, action: string, method?: string) => forms(html).find(form => attribute(form, 'action') === action && (!method || attribute(form, 'data-method') === method))!
const controls = (form: Element) => nodes(form).filter(element => ['input', 'textarea'].includes(element.tagName)).map(element => [attribute(element, 'name'), attribute(element, 'type') ?? 'textarea', attribute(element, 'value')])

const path = '/v1/admin/tools/falcon-axi/instances/lab'
const control = (overrides: Partial<CredentialControl>): CredentialControl => ({ name: 'region', id: 'profile-falcon-axi-region', label: 'Region', help: 'Falcon API region.', secret: false,
  ephemeral: false, required: true, stored: false, kind: 'input', dataType: 'string', value: 'us-2', ...overrides })

const base: InstanceProps = { csrf: 'synthetic-csrf', tool: 'falcon-axi', product: 'CrowdStrike Falcon', mark: 'FA', api: '/v1/admin/tools/falcon-axi', path, toolRevision: 7,
  id: 'synthetic-lab-id', name: 'lab', revision: 3, enabled: true, state: { word: 'Healthy', tone: 'ok' }, outcomes: { ok: { word: 'Healthy', tone: 'ok' }, error: { word: 'Failing', tone: 'err' } },
  writes: { word: 'Read-only', tone: 'neutral' }, checkedAt: null,
  setup: [{ title: 'Credential saved', detail: 'Not saved yet', at: null, state: 'todo' }, { title: 'Test passes', detail: 'Not run', at: null, state: 'todo', test: true },
    { title: 'Instance enabled', detail: 'On', at: null, state: 'done' }],
  failure: { shown: false, summary: 'Synthetic failure summary.', code: 'AUTH_FAILED', certificateHint: false, diagnostic: 'Details unavailable.' }, github: null, controllerOrigin: null,
  connection: { intro: 'Synthetic credential introduction.', schema: { type: 'object' }, identity: { auth: null }, configured: true, tls: null,
    controls: [control({}), control({ name: 'clientSecret', id: 'profile-falcon-axi-clientSecret', label: 'Client secret', secret: true, required: false, kind: 'textarea', value: '', stored: true })] },
  certificates: { saved: true, intro: 'Synthetic certificate introduction.', expiring: false, pins: [], offered: false, endpoints: ['lab.example'], trust: { fills: true, caOption: 'Trust the issuing CA' } },
  testGuide: 'Falcon auth status', change: { actor: 'synthetic-user', at: null, revision: 3 } }

const render = (overrides: Partial<InstanceProps> = {}) => renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Instance, { ...base, ...overrides }) }))

test.each([
  { enabled: true, consequence: 'Disable lab? Calls to it fail with INSTANCE_DISABLED until you enable it again.', title: 'Disable instance', action: 'Disable', next: 'false', checked: 'true' },
  { enabled: false, consequence: 'Enable lab? Agents who can use it can call it again.', title: 'Enable instance', action: 'Enable', next: 'true', checked: 'false' },
])('the Enabled switch for enabled=$enabled patches the instance with its identity, revision and the opposite value', ({ enabled, consequence, title, action, next, checked }) => {
  const form = formFor(render({ enabled }), path, 'PATCH')
  expect([attribute(form, 'data-confirm'), attribute(form, 'data-confirm-title'), attribute(form, 'data-confirm-action')]).toEqual([consequence, title, action])
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3'], ['enabled', 'hidden', next]])
  expect(nodes(form).filter(element => attribute(element, 'role') === 'switch').map(element => [text(element), attribute(element, 'aria-checked')])).toEqual([['Enabled', checked]])
})

test('Test connection posts to the instance test route and names the tool for the in-place result', () => {
  const form = formFor(render(), `${path}/test`)
  expect([attribute(form, 'data-method'), attribute(form, 'data-test-tool'), attribute(form, 'data-confirm')]).toEqual(['POST', 'falcon-axi', undefined])
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf']])
})

test('the Connection card patches the credential with identity, both revisions, a test option and the saved-instance markers', () => {
  const form = formFor(render(), `${path}/credential`)
  expect([attribute(form, 'data-method'), attribute(form, 'data-save-tool'), attribute(form, 'data-save-instance'),
    attribute(form, 'data-confirm')]).toEqual(['PATCH', 'falcon-axi', 'lab', 'Save this credential, retaining unchanged stored secrets for the same identity and keeping native settings?'])
  expect(controls(form).filter(([name]) => !String(name).startsWith('profile.'))).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'],
    ['expectedRevision', 'hidden', '3'], ['expectedToolRevision', 'hidden', '7'], ['pem.certificatePem', 'file', undefined], ['certificatePem', 'textarea', undefined], ['testAfterSave', 'checkbox', undefined]])
  expect(nodes(form).filter(element => attribute(element, 'data-save-and-test') !== undefined).map(input => attribute(input, 'checked'))).toEqual([''])
  expect(nodes(form).filter(element => element.tagName === 'button').map(text)).toEqual(['Save connection'])
})

test('a saved secret is an empty native textarea that keeps the stored value, and a saved plain value is prefilled', () => {
  const fields = nodes(formFor(render(), `${path}/credential`)).filter(element => attribute(element, 'data-profile-field') !== undefined)
  expect(fields.map(field => [attribute(field, 'name'), field.tagName, attribute(field, 'autocomplete'), attribute(field, 'value') ?? text(field)])).toEqual([
    ['profile.region', 'input', 'off', 'us-2'], ['profile.clientSecret', 'textarea', 'off', '']])
  expect(find(render(), element => attribute(element, 'data-stored-secret') !== undefined).map(text)).toEqual(['Stored when configured. Leave blank to keep; enter a value to replace.'])
})

test('Delete asks for the instance name', () => {
  const form = formFor(render(), path, 'DELETE')
  expect([attribute(form, 'data-confirm'), attribute(form, 'data-confirm-name'), attribute(form, 'data-confirm-title')]).toEqual([
    'Delete lab? Its credential, certificate trust and health are removed. This cannot be undone.', 'lab', 'Delete instance'])
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3']])
})

test('AWX saves its controller address through its own route without credentials', () => {
  const html = render({ api: '/v1/admin/tools/awx-axi', controllerOrigin: 'https://controller.example' })
  const form = formFor(html, '/v1/admin/tools/awx-axi/origin', 'PUT')
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3'], ['expectedToolRevision', 'hidden', '7'],
    ['instance', 'hidden', 'lab'], ['origin', 'url', 'https://controller.example']])
  expect(forms(render()).filter(item => attribute(item, 'action')?.endsWith('/origin'))).toEqual([])
})

test('the failure banner is hidden until a test fails, and names a certificate failure', () => {
  const [hidden] = find(render(), element => attribute(element, 'data-check-failure') !== undefined)
  expect(attribute(hidden!, 'hidden')).toBe('')
  const html = render({ failure: { ...base.failure, shown: true, certificateHint: true } })
  const [shown] = find(html, element => attribute(element, 'data-check-failure') !== undefined)
  expect(attribute(shown!, 'hidden')).toBeUndefined()
  expect(find(html, element => attribute(element, 'data-check-error') !== undefined).map(text)).toEqual(['AUTH_FAILED'])
  expect(text(shown!)).toContain('Review the endpoint under Certificates below.')
})

test('only the Test step carries the checklist marker, and each step names its state', () => {
  const steps = find(render(), element => element.tagName === 'li' && attribute(element, 'class')?.includes('step ') === true)
  expect(steps.map(step => [attribute(step, 'data-test-checklist') !== undefined, text(step)])).toEqual([
    [false, '1To do: Credential savedNot saved yet'], [true, '2To do: Test passesNot run'], [false, 'Done: Instance enabledOn']])
})

test('an unsaved instance offers no certificate inspection', () => {
  const html = render({ certificates: { ...base.certificates, saved: false } })
  expect(html).toContain('Save a connection first.')
  expect(find(html, element => attribute(element, 'id') === 'certificate-inspection')).toEqual([])
})

test.each([
  { endpoints: ['a.example'], inputs: [['endpointIndex', 'hidden', '0']], selects: 0 },
  { endpoints: ['a.example', 'b.example'], inputs: [], selects: 1 },
])('inspection of $endpoints is posted for the saved endpoint index', ({ endpoints, inputs, selects }) => {
  const form = formFor(render({ certificates: { ...base.certificates, endpoints, offered: true } }), `${path}/certificates/inspect`)
  expect([attribute(form, 'data-inspect-certificate'), attribute(form, 'hidden')]).toEqual(['', undefined])
  expect(controls(form).slice(1)).toEqual(inputs)
  expect(nodes(form).filter(element => element.tagName === 'select' && attribute(element, 'name') === 'endpointIndex').map(select => nodes(select).filter(element => element.tagName === 'option').map(text)))
    .toEqual(selects ? [endpoints] : [])
})

test('inspection stays hidden until a certificate failure offers it', () => {
  expect(attribute(formFor(render(), `${path}/certificates/inspect`), 'hidden')).toBe('')
})

test.each([
  { fills: true, note: 'Initial trust fills Certificate verification.' },
  { fills: false, note: 'This tool does not support a shared trusted certificate field.' },
])('the trust form fills the credential fields only when the tool supports them (fills=$fills)', ({ fills, note }) => {
  const html = render({ certificates: { ...base.certificates, trust: { fills, caOption: 'Trust the issuing CA (synthetic)' } } })
  const form = formFor(html, `${path}/certificates/trust`)
  expect(attribute(form, 'data-trust-test-url')).toBe(`${path}/test`)
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['inspectionId', 'hidden', undefined], ['fillFields', 'hidden', String(fills)], ['confirmedFingerprint', 'checkbox', undefined]])
  expect(text(form)).toContain(note)
  expect(nodes(form).filter(element => element.tagName === 'option').map(text)).toEqual(['Trust the issuing CA (synthetic)', 'Strict leaf pinning (re-trust after every rotation)'])
  expect(attribute(formFor(html, `${path}/certificates/use-name`), 'hidden')).toBe('')
})

test('each trusted certificate offers its own removal with its endpoint details', () => {
  const pin = { id: 'synthetic-pin', endpoint: 'lab.example:443', trust: 'Issuing CA', fingerprint: 'AA:11', endpointFingerprint: 'BB:22', note: 'Certificate details not yet inspected.',
    subject: 'CN=synthetic', expires: '2027-01-01', endpointExpires: '2026-12-01' }
  const html = render({ certificates: { ...base.certificates, pins: [pin], expiring: true } })
  const form = formFor(html, `${path}/certificates`, 'DELETE')
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['id', 'hidden', 'synthetic-pin']])
  const [row] = find(html, element => element.tagName === 'tr' && text(element).includes('lab.example:443'))
  expect(text(row!)).toContain('Endpoint: BB:22')
  expect(text(row!)).toContain('Endpoint: 2026-12-01')
  expect(html).toContain('A trusted certificate expires soon')
})

test.each([{ github: null, cards: 0 }, { github: { action: '/v1/admin/tools/gh-axi/device', toolRevision: 7, origin: 'https://github.example',
  instance: { id: 'synthetic-lab-id', name: 'lab', revision: 3 }, connected: null, expired: false }, cards: 1 }])(
  'the GitHub connection card is on the instance page only for a GitHub instance (cards=$cards)', ({ github, cards }) => {
    const html = render({ github })
    expect(find(html, element => element.tagName === 'form' && attribute(element, 'data-connect-github') !== undefined).map(form => controls(form).slice(0, 2)))
      .toEqual(cards ? [[['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id']]] : [])
  })
