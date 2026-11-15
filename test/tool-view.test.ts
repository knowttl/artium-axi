import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import type { CredentialControl, CredentialEditorProps } from '../src/views/credential-editor.js'
import { Tool, type ToolProps } from '../src/views/tool.js'
import type { AccessProps } from '../src/views/tool-access.js'
import type { InstancesProps } from '../src/views/tool-instances.js'
import type { WritesProps } from '../src/views/tool-writes.js'

type Element = DefaultTreeAdapterMap['element']

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')
const find = (html: string, match: (element: Element) => boolean) => nodes(parseFragment(html)).filter(match)
const forms = (html: string) => find(html, element => element.tagName === 'form' && attribute(element, 'data-api') !== undefined)
const controls = (form: Element) => nodes(form).filter(element => ['input', 'textarea'].includes(element.tagName)).map(element => [attribute(element, 'name'), attribute(element, 'type') ?? 'textarea', attribute(element, 'value')])

const tabs: ToolProps['tabs'] = [
  { label: 'Instances', href: '/admin/tools/falcon-axi?tab=instances', icon: 'globe', note: '2', current: false },
  { label: 'Write permissions', href: '/admin/tools/falcon-axi?tab=writes', icon: 'zap', note: 'Off', current: false },
  { label: 'Advanced', href: '/admin/tools/falcon-axi?tab=advanced', icon: 'sliders', note: null, current: false },
]

const access: AccessProps = {
  page: '/admin/tools/falcon-axi?tab=access', sheet: null,
  people: [{ id: 'synthetic-one', username: 'synthetic-one', displayName: 'Synthetic One' }, { id: 'synthetic-two', username: 'synthetic-two', displayName: 'synthetic-two' },
    { id: 'synthetic-three', username: 'synthetic-three', displayName: 'Synthetic Three' }],
  roles: [
    { id: 'synthetic-role', name: 'Synthetic Role', members: 1, all: true, revision: 4, instances: [{ name: 'lab', description: 'Lab tenant.', checked: false }, { name: 'production', description: '', checked: false }] },
    { id: 'second-role', name: 'Second Role', members: 2, all: false, revision: 5, instances: [{ name: 'lab', description: 'Lab tenant.', checked: true }, { name: 'production', description: '', checked: false }] },
  ],
  policies: [
    { key: 'sessions', title: 'Interactive sessions', description: 'Synthetic sessions policy.', creatable: true, operations: [{ id: 'exec', label: 'exec' }, { id: 'logs', label: 'logs' }],
      grants: [{ id: 'departed-user', summary: 'watch', operations: [{ id: 'exec', label: 'exec', checked: false }, { id: 'logs', label: 'logs', checked: false }, { id: 'watch', label: 'watch', checked: true }] },
        { id: 'synthetic-two', summary: 'exec', operations: [{ id: 'exec', label: 'exec', checked: true }, { id: 'logs', label: 'logs', checked: false }] }] },
    { key: 'scans', title: 'Scans', description: 'Synthetic scans policy.', creatable: false, operations: [{ id: 'OP-009', label: 'scan submit' }], grants: [] },
  ],
}

const base: ToolProps = { csrf: 'synthetic-csrf', name: 'falcon-axi', api: '/v1/admin/tools/falcon-axi', product: 'CrowdStrike Falcon', mark: 'FA', version: '1.1.0', revision: 7, enabled: false,
  state: { word: 'Ready to test', tone: 'neutral' }, writes: { word: 'Read-only', tone: 'neutral' }, checkedAt: null,
  setup: [{ title: 'Credential saved', detail: 'Not saved yet', at: null, state: 'todo' }, { title: 'Test passes', detail: 'Failing: AUTH_FAILED', at: null, state: 'fail' },
    { title: 'Enabled', detail: 'On', at: null, state: 'done' }],
  tabs, panel: { tab: 'access', access } }

function render(overrides: Partial<ToolProps> = {}) {
  return renderToString(createElement(Theme, { theme: neutralTheme, children: createElement(Tool, { ...base, ...overrides }) }))
}

const writes: WritesProps = { capable: true, readOnlyReason: '', blockedTitle: 'Always blocked', blocked: 'Synthetic blocked text.', unlocks: 'Synthetic unlock text.', grant: 'No write actions are currently granted.',
  unsupported: false, confirmation: 'Synthetic write confirmation?', switches: [{ name: 'enabled', label: 'Allow writes', on: true, text: 'On. Synthetic.' }],
  operations: { supported: 2, selected: 1, familyNote: '', q: 'note', show: 'selected', deleteCount: 1, empty: false, groups: [{ title: 'Notes', family: null, picked: 1, deletes: 1, notUsed: false, open: true, hidden: false,
    operations: [{ name: 'notes.set', label: 'Set notes', search: 'set notes notes.set', delete: false, bulk: false, checked: true, hidden: false },
      { name: 'notes.delete', label: 'notes.delete', search: 'notes.delete notes.delete', delete: true, bulk: false, checked: false, hidden: false }] }] } }

test.each([
  { enabled: false, consequence: 'Enable this tool for people whose roles grant access?', next: 'true', checked: 'false' },
  { enabled: true, consequence: 'Disable this tool and block new calls?', next: 'false', checked: 'true' },
])('the enable switch for enabled=$enabled patches the tool with its revision, CSRF token and the opposite value', ({ enabled, consequence, next, checked }) => {
  const [form] = forms(render({ enabled }))
  expect([attribute(form!, 'action'), attribute(form!, 'data-method'), attribute(form!, 'data-confirm')]).toEqual(['/v1/admin/tools/falcon-axi', 'PATCH', consequence])
  expect(controls(form!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedRevision', 'hidden', '7'], ['enabled', 'hidden', next]])
  expect(nodes(form!).filter(element => attribute(element, 'role') === 'switch').map(element => [text(element), attribute(element, 'aria-checked')])).toEqual([['Enabled', checked]])
})

test('the tabs are plain links that mark only the current one', () => {
  const [nav] = find(render({ tabs: tabs.map(tab => ({ ...tab, current: tab.label === 'Write permissions' })) }), element => element.tagName === 'nav' && attribute(element, 'aria-label') === 'Tool sections')
  expect(nodes(nav!).filter(element => element.tagName === 'a').map(link => [text(link), attribute(link, 'href'), attribute(link, 'aria-current')])).toEqual([
    ['Instances 2', '/admin/tools/falcon-axi?tab=instances', undefined], ['Write permissions Off', '/admin/tools/falcon-axi?tab=writes', 'page'], ['Advanced', '/admin/tools/falcon-axi?tab=advanced', undefined]])
})

test('each setup step names its state, so the failed test is not shown by colour alone', () => {
  const steps = find(render(), element => element.tagName === 'li' && attribute(element, 'class')?.includes('step ') === true)
  expect(steps.map(step => [attribute(step, 'class')!.split(' ').slice(1, 2)[0], text(step)])).toEqual([
    ['todo', '1To do: Credential savedNot saved yet'], ['fail', 'Failed: Test passesFailing: AUTH_FAILED'], ['done', 'Done: EnabledOn']])
})

const instanceRow = (name: string, enabled: boolean, editOpen = false): InstancesProps['rows'][number] => ({ name, description: `Synthetic ${name} tenant.`, endpoint: `${name}.example`,
  href: `/admin/tools/falcon-axi/instances/${name}`, status: { word: enabled ? 'Healthy' : 'Disabled', tone: enabled ? 'ok' : 'off' }, writes: { word: 'Read-only', tone: 'neutral' }, checkedAt: null,
  instance: { path: `/v1/admin/tools/falcon-axi/instances/${name}`, id: `synthetic-${name}-id`, revision: 3, enabled, readOnly: true, description: `Synthetic ${name} tenant.`, editOpen } })

const instances: InstancesProps = { page: '/admin/tools/falcon-axi', ssh: false, testGuide: 'Falcon auth status', rows: [instanceRow('lab', true), instanceRow('old', false, true)], github: null,
  addInstance: { tool: 'falcon-axi', product: 'CrowdStrike Falcon', api: '/v1/admin/tools/falcon-axi', toolRevision: 7, open: false, awx: false, hasInstances: true, editor: null } }

const renderInstances = (panel: Partial<InstancesProps> = {}) => render({ panel: { tab: 'instances', instances: { ...instances, ...panel } } })
const instanceForms = (html: string, name: string) => forms(html).filter(form => attribute(form, 'action')?.endsWith(`/instances/${name}`) || attribute(form, 'action')?.endsWith(`/instances/${name}/test`))
const summary = (form: Element) => [attribute(form, 'action'), attribute(form, 'data-method'), attribute(form, 'data-confirm'), attribute(form, 'data-confirm-name'), attribute(form, 'data-success-message')]

test('an enabled instance offers Test, Disable and Delete, each on its own route with the instance identity and revision', () => {
  const [test, disable, remove] = instanceForms(renderInstances(), 'lab')
  expect(summary(test!)).toEqual(['/v1/admin/tools/falcon-axi/instances/lab/test', 'POST', undefined, undefined, 'Test passed.'])
  expect(summary(disable!)).toEqual(['/v1/admin/tools/falcon-axi/instances/lab', 'PATCH',
    'Disable lab? Calls to it fail with INSTANCE_DISABLED until you enable it again. Its credential and certificates are kept.', undefined, undefined])
  expect(controls(disable!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3'], ['enabled', 'hidden', 'false']])
  expect(summary(remove!)).toEqual(['/v1/admin/tools/falcon-axi/instances/lab', 'DELETE',
    'Delete lab? Its credential, certificate trust and health are removed. Calls that name it fail with INSTANCE_NOT_FOUND. Audit history is kept.', 'lab', undefined])
  expect(controls(remove!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-lab-id'], ['expectedRevision', 'hidden', '3']])
})

test('a disabled instance offers Enable with the opposite value', () => {
  const [, enable] = instanceForms(renderInstances(), 'old')
  expect(attribute(enable!, 'data-confirm')).toBe('Enable old? Agents who can use it can call it again.')
  expect(controls(enable!).slice(-1)).toEqual([['enabled', 'hidden', 'true']])
})

test('Edit sends the description and read-only setting, and only the requested sheet is open', () => {
  const html = renderInstances()
  const dialogs = find(html, element => element.tagName === 'dialog' && attribute(element, 'id')?.startsWith('sheet-edit-') === true)
  expect(dialogs.map(dialog => [attribute(dialog, 'id'), attribute(dialog, 'open') !== undefined])).toEqual([['sheet-edit-lab', false], ['sheet-edit-old', true]])
  const [form] = forms(html).filter(item => attribute(item, 'data-confirm-title') === 'Save instance' && attribute(item, 'action')?.endsWith('/instances/old'))
  expect([attribute(form!, 'data-method'), attribute(form!, 'data-confirm'), attribute(form!, 'data-confirm-action')]).toEqual(['PATCH',
    'Save the description and read-only setting of old? Agents see the new description on their next listing.', 'Save'])
  expect(controls(form!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedId', 'hidden', 'synthetic-old-id'], ['expectedRevision', 'hidden', '3'], ['description', 'textarea', undefined],
    ['readOnly', 'checkbox', undefined]])
  expect(nodes(form!).filter(element => attribute(element, 'name') === 'description').map(text)).toEqual(['Synthetic old tenant.'])
  expect(nodes(form!).filter(element => attribute(element, 'name') === 'readOnly').map(element => attribute(element, 'checked') !== undefined)).toEqual([true])
})

test('the Add instance link opens its sheet and the table lists each instance with its endpoint', () => {
  const html = renderInstances()
  const [add] = find(html, element => element.tagName === 'a' && attribute(element, 'data-sheet') === 'sheet-add-instance')
  expect(attribute(add!, 'href')).toBe('/admin/tools/falcon-axi?sheet=add-instance')
  expect(find(html, element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-add-instance').map(dialog => attribute(dialog, 'open'))).toEqual([undefined])
  expect(find(html, element => element.tagName === 'tr').slice(1).map(row => nodes(row).filter(element => element.tagName === 'code').map(text))).toEqual([['lab.example'], ['old.example']])
})

const control = (overrides: Partial<CredentialControl>): CredentialControl => ({ name: 'region', id: 'profile-falcon-axi-region', label: 'Region', help: 'Falcon API region.', secret: false,
  ephemeral: false, required: true, stored: false, kind: 'input', dataType: 'string', value: 'us-2', ...overrides })
const editor: CredentialEditorProps = { intro: 'Synthetic credential introduction.', schema: { type: 'object' }, identity: { auth: null }, configured: false, tls: { legacyHtml: '' },
  controls: [control({}), control({ name: 'clientSecret', id: 'profile-falcon-axi-clientSecret', label: 'Client secret', secret: true, required: false, kind: 'textarea', value: '' }),
    control({ name: 'auth', id: 'profile-falcon-axi-auth', label: 'Authentication', kind: 'select', dataType: 'json', value: '', emptyLabel: 'Choose a value',
      options: [{ value: '"token"', label: 'token', selected: false }, { value: '"password"', label: 'password', selected: true }] })] }
const addInstance = (add: Partial<NonNullable<InstancesProps['addInstance']>> = {}): InstancesProps['addInstance'] => ({ ...instances.addInstance!, editor, ...add })
const addForm = (html: string) => forms(html).find(form => attribute(form, 'action')?.endsWith('/instances') && attribute(form, 'data-save-tool') !== undefined || attribute(form, 'action')?.endsWith('/origin'))!

test('the Add instance sheet posts the new instance with the tool revision, a test option and the saved-tool marker', () => {
  const html = renderInstances({ addInstance: addInstance({ open: true }) })
  const [dialog] = find(html, element => element.tagName === 'dialog' && attribute(element, 'id') === 'sheet-add-instance')
  expect([attribute(dialog!, 'aria-labelledby'), attribute(dialog!, 'open')]).toEqual(['sheet-add-instance-title', ''])
  const form = addForm(html)
  expect(summary(form)).toEqual(['/v1/admin/tools/falcon-axi/instances', 'POST', 'Add this CrowdStrike Falcon instance? It starts read-only.', undefined, undefined])
  expect([attribute(form, 'data-confirm-title'), attribute(form, 'data-confirm-action'), attribute(form, 'data-save-tool')]).toEqual(['Add instance', 'Add instance', 'falcon-axi'])
  expect(controls(form).filter(([name]) => !String(name).startsWith('profile.'))).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedToolRevision', 'hidden', '7'],
    ['name', 'text', ''], ['description', 'textarea', undefined], [undefined, 'file', undefined], [undefined, 'textarea', undefined], [undefined, 'checkbox', undefined]])
  const [name] = nodes(form).filter(element => attribute(element, 'name') === 'name')
  expect([attribute(name!, 'required'), attribute(name!, 'maxlength'), attribute(name!, 'pattern'), attribute(name!, 'autocomplete')]).toEqual(['', '32', '[a-z0-9][a-z0-9\\-]*', 'off'])
  expect(nodes(form).filter(element => attribute(element, 'data-save-and-test') !== undefined).map(input => attribute(input, 'checked'))).toEqual([''])
  expect(nodes(form).filter(element => element.tagName === 'button').map(text)).toEqual(['Add instance'])
})

test('the Add instance sheet warns that scripts may need to name an instance only when instances exist', () => {
  const warning = (add: Partial<NonNullable<InstancesProps['addInstance']>>) => renderInstances({ addInstance: addInstance(add) }).includes('Scripts may need to name an instance')
  expect([warning({ hasInstances: true }), warning({ hasInstances: false })]).toEqual([true, false])
})

test('AWX adds an instance by origin through its own route and asks for no credential', () => {
  const form = addForm(renderInstances({ addInstance: addInstance({ awx: true, editor: null }) }))
  expect(summary(form)).toEqual(['/v1/admin/tools/falcon-axi/origin', 'PUT', 'Add this CrowdStrike Falcon instance? It starts read-only.', undefined, undefined])
  expect(attribute(form, 'data-save-tool')).toBeUndefined()
  expect(controls(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['expectedToolRevision', 'hidden', '7'], ['expectedRevision', 'hidden', '0'], ['instance', 'text', ''], ['origin', 'url', '']])
  expect(nodes(form).filter(element => attribute(element, 'data-credential-editor') !== undefined || attribute(element, 'data-save-and-test') !== undefined)).toEqual([])
})

test('the credential editor posts each profile field under profile.<name> and keeps a typed secret out of its markup', () => {
  const form = addForm(renderInstances({ addInstance: addInstance() }))
  const fields = nodes(form).filter(element => attribute(element, 'data-profile-field') !== undefined)
  expect(fields.map(field => [field.tagName, attribute(field, 'name'), attribute(field, 'data-profile-type'), attribute(field, 'autocomplete'), attribute(field, 'type')])).toEqual([
    ['input', 'profile.region', 'string', 'off', 'text'], ['textarea', 'profile.clientSecret', 'string', 'off', undefined], ['select', 'profile.auth', 'json', 'off', undefined]])
  const [secret] = fields.filter(field => attribute(field, 'name') === 'profile.clientSecret')
  expect([text(secret!), attribute(secret!, 'value'), attribute(secret!, 'spellcheck'), attribute(secret!, 'rows')]).toEqual(['', undefined, 'false', '6'])
  expect(nodes(form).filter(element => attribute(element, 'data-secret') !== undefined).map(wrapper => attribute(wrapper, 'data-credential-field'))).toEqual(['clientSecret'])
  expect(nodes(form).filter(element => element.tagName === 'option').map(option => [attribute(option, 'value'), attribute(option, 'selected')])).toEqual([['', undefined], ['"token"', undefined], ['"password"', '']])
})

test('the credential editor follows the secret flag of each control, not its name', () => {
  const swapped: CredentialEditorProps = { ...editor, controls: [control({ name: 'clientSecret', id: 'profile-falcon-axi-clientSecret', secret: false, value: 'plain-value' }),
    control({ name: 'region', secret: true, required: false, kind: 'textarea', value: '' })] }
  const fields = nodes(addForm(renderInstances({ addInstance: addInstance({ editor: swapped }) }))).filter(element => attribute(element, 'data-profile-field') !== undefined)
  expect(fields.map(field => [attribute(field, 'data-profile-field'), field.tagName, attribute(field, 'value') ?? text(field)])).toEqual([['clientSecret', 'input', 'plain-value'], ['region', 'textarea', '']])
})

test('SSH hosts link to their own page and offer no instance forms', () => {
  const host = { ...instanceRow('synthetic-host', true), href: '/admin/ssh', instance: null }
  const html = renderInstances({ ssh: true, rows: [host], testGuide: null, addInstance: null })
  expect(forms(html).filter(form => attribute(form, 'action')?.includes('/instances'))).toEqual([])
  expect(find(html, element => element.tagName === 'a' && attribute(element, 'href') === '/admin/ssh').map(text)).toEqual(expect.arrayContaining(['Manage hosts', 'Manage']))
})

test('an empty Instances tab says so and still offers Add instance', () => {
  const html = renderInstances({ rows: [] })
  expect(html).toContain('No instances yet. Add one to connect CrowdStrike Falcon.')
  expect(find(html, element => element.tagName === 'table')).toEqual([])
  expect(find(html, element => attribute(element, 'data-sheet') === 'sheet-add-instance')).toHaveLength(1)
})

test('Raw API keeps both forms, the mode radios and the route fields, and sends a read-only tool\'s write routes as a hidden field', () => {
  const panel = { tab: 'raw-api' as const, mode: 'read', options: [{ mode: 'off', label: 'Off', detail: 'Refused.' }, { mode: 'read', label: 'Read', detail: 'Reads.' }], write: 'POST a', get: 'GET b' }
  const [, mode, routes] = forms(render({ panel: { ...panel, writeRoutes: false } }))
  expect([attribute(mode!, 'action'), attribute(mode!, 'data-method'), attribute(routes!, 'action'), attribute(routes!, 'data-method')])
    .toEqual(['/v1/admin/tools/falcon-axi/raw-api', 'PATCH', '/v1/admin/tools/falcon-axi/raw-api/routes', 'PUT'])
  expect(controls(mode!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['mode', 'radio', 'off'], ['mode', 'radio', 'read'], ['expectedRevision', 'hidden', '7']])
  expect(nodes(mode!).filter(element => attribute(element, 'name') === 'mode' && attribute(element, 'checked') !== undefined).map(element => attribute(element, 'value'))).toEqual(['read'])
  expect(controls(routes!)).toEqual([['_csrf', 'hidden', 'synthetic-csrf'], ['write', 'hidden', 'POST a'], ['get', 'textarea', undefined], ['expectedRevision', 'hidden', '7']])
  const [, , writable] = forms(render({ panel: { ...panel, writeRoutes: true } }))
  expect(controls(writable!).map(([name, kind]) => [name, kind])).toEqual([['_csrf', 'hidden'], ['write', 'textarea'], ['get', 'textarea'], ['expectedRevision', 'hidden']])
})

test('Advanced sends the native settings as JSON with the revision', () => {
  const [, form] = forms(render({ panel: { tab: 'advanced', writeState: 'writes off', guide: 'Synthetic guide.', grantNote: false, settings: '{\n  "a": 1\n}' } }))
  expect([attribute(form!, 'action'), attribute(form!, 'data-method')]).toEqual(['/v1/admin/tools/falcon-axi', 'PATCH'])
  const [settings] = nodes(form!).filter(element => attribute(element, 'name') === 'nativeSettings')
  expect([settings!.tagName, attribute(settings!, 'data-type'), text(settings!)]).toEqual(['textarea', 'json', '{\n  "a": 1\n}'])
  expect(controls(form!).filter(([name]) => name === 'expectedRevision')).toEqual([['expectedRevision', 'hidden', '7']])
})

test('Write permissions patch the write-access route, list each operation under its group and join the get filter form by id', () => {
  const html = render({ panel: { tab: 'writes', writes } })
  const [, form] = forms(html)
  expect([attribute(form!, 'action'), attribute(form!, 'data-method'), attribute(form!, 'data-confirm')]).toEqual(['/v1/admin/tools/falcon-axi/write-access', 'PATCH', 'Synthetic write confirmation?'])
  expect(nodes(form!).filter(element => attribute(element, 'name') === 'operations' && element.tagName === 'input').map(element => [attribute(element, 'value'), attribute(element, 'checked') !== undefined]))
    .toEqual([['notes.set', true], ['notes.delete', false]])
  expect(nodes(form!).filter(element => attribute(element, 'name') === 'enabled').map(element => [attribute(element, 'role'), attribute(element, 'checked') !== undefined])).toEqual([['switch', true]])
  const [filter] = find(html, element => element.tagName === 'form' && attribute(element, 'id') === 'ops-filter')
  expect([attribute(filter!, 'method'), attribute(filter!, 'action'), controls(filter!)]).toEqual(['get', '/admin/tools/falcon-axi', [['tab', 'hidden', 'writes']]])
  expect(find(html, element => attribute(element, 'form') === 'ops-filter').map(element => attribute(element, 'name'))).toEqual(expect.arrayContaining(['q', 'show']))
})

test('a tool that is always read-only offers no write form', () => {
  const html = render({ panel: { tab: 'writes', writes: { ...writes, capable: false, readOnlyReason: 'Synthetic reason.', operations: null } } })
  expect(forms(html).filter(form => attribute(form, 'action')?.endsWith('/write-access'))).toEqual([])
  expect(html).toContain('Synthetic reason.')
})

const renderAccess = (overrides: Partial<AccessProps> = {}) => render({ panel: { tab: 'access', access: { ...access, ...overrides } } })
const dialogIn = (html: string, name: string) => find(html, element => element.tagName === 'dialog' && attribute(element, 'id') === `sheet-${name}`)[0]!
const sheetForm = (html: string, name: string) => nodes(dialogIn(html, name)).find(element => element.tagName === 'form')!
const formSummary = (form: Element) => ['action', 'data-method', 'data-confirm', 'data-confirm-title', 'data-confirm-action'].map(name => attribute(form, name))
const accessFields = (form: Element) => nodes(form).filter(element => ['input', 'select'].includes(element.tagName))
  .map(element => [attribute(element, 'name'), attribute(element, 'type') ?? element.tagName, attribute(element, 'value'), attribute(element, 'checked') !== undefined, attribute(element, 'disabled') !== undefined])
const rowFor = (html: string, label: string) => find(html, element => element.tagName === 'li' && nodes(element).some(inner => inner.tagName === 'a' && text(inner) === label || inner.tagName === 'strong' && text(inner) === label))[0]!
const links = (element: Element) => nodes(element).filter(item => item.tagName === 'a').map(link => [text(link), attribute(link, 'href'), attribute(link, 'data-sheet')])

test('each role granting the tool shows its people and instance scope and opens its own instance sheet', () => {
  const html = renderAccess()
  const [all, selected] = ['Synthetic Role', 'Second Role'].map(name => rowFor(html, name))
  expect(links(all!)).toEqual([['Synthetic Role', '/admin/roles/synthetic-role', undefined],
    ['Instances', '/admin/tools/falcon-axi?tab=access&sheet=instances-synthetic-role', 'sheet-instances-synthetic-role']])
  expect(text(all!)).toContain('1 person · All instances')
  expect(text(selected!)).toContain('2 people · Selected instances: lab')
  expect(find(html, element => element.tagName === 'a' && attribute(element, 'href') === '/admin/roles').map(text)).toEqual(['Manage roles'])
  expect(find(html, element => element.tagName === 'h2' && text(element) === 'Roles that grant CrowdStrike Falcon')).toHaveLength(1)
})

test('a role sheet replaces that role\'s instance access with its revision, after the confirmation the legacy sheet showed', () => {
  const html = renderAccess({ sheet: 'instances-second-role' })
  const form = sheetForm(html, 'instances-second-role')
  expect(formSummary(form)).toEqual(['/v1/admin/roles/second-role/tools/falcon-axi/instances', 'PUT',
    'Replace Second Role’s CrowdStrike Falcon instance access? Changes apply to every member on the next call.', 'Save instance access', 'Save access'])
  expect(accessFields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', false, false], ['scope', 'radio', 'all', false, false], ['scope', 'radio', 'selected', true, false],
    ['instances', 'hidden', undefined, false, true], ['instances', 'checkbox', 'lab', true, false], ['instances', 'checkbox', 'production', false, false], ['expectedRevision', 'hidden', '5', false, false]])
  expect(find(html, element => element.tagName === 'dialog' && attribute(element, 'id')?.startsWith('sheet-instances-') === true).map(dialog => [attribute(dialog, 'id'), attribute(dialog, 'open') !== undefined]))
    .toEqual([['sheet-instances-synthetic-role', false], ['sheet-instances-second-role', true]])
  expect(accessFields(sheetForm(html, 'instances-synthetic-role')).filter(([name]) => name === 'scope').map(field => [field[2], field[3]])).toEqual([['all', true], ['selected', false]])
})

test('a tool no role grants says how to grant it and offers no instance sheet', () => {
  const html = renderAccess({ roles: [] })
  expect(find(html, element => element.tagName === 'p').map(text)).toContain('No roles grant this tool. Open a role and select this tool to give its members access.')
  expect(find(html, element => element.tagName === 'dialog' && attribute(element, 'id')?.startsWith('sheet-instances-') === true)).toEqual([])
})

test('a person grant lists each person with their operations, flags a departed one and offers one Grant a person link for a policy that can add', () => {
  const html = renderAccess()
  expect(find(html, element => element.tagName === 'h2').map(text)).toEqual(expect.arrayContaining(['Interactive sessions by person', 'Scans by person']))
  const departed = rowFor(html, 'departed-user')
  expect(text(departed)).toContain('Not an active person')
  expect(text(departed)).toContain('watch')
  expect(links(departed)).toEqual([['Edit', '/admin/tools/falcon-axi?tab=access&sheet=grants-sessions-departed-user', 'sheet-grants-sessions-departed-user']])
  const active = rowFor(html, 'synthetic-two')
  expect(text(active)).not.toContain('Not an active person')
  expect(links(active)).toEqual([['Edit', '/admin/tools/falcon-axi?tab=access&sheet=grants-sessions-synthetic-two', 'sheet-grants-sessions-synthetic-two']])
  expect(find(html, element => element.tagName === 'a' && text(element) === 'Grant a person').map(link => [attribute(link, 'href'), attribute(link, 'data-sheet')]))
    .toEqual([['/admin/tools/falcon-axi?tab=access&sheet=grants-sessions-add', 'sheet-grants-sessions-add']])
})

test('editing a person sends their id, the policy and the tool revision, and keeps a saved operation the catalogue does not list', () => {
  const html = renderAccess({ sheet: 'grants-sessions-departed-user' })
  const form = sheetForm(html, 'grants-sessions-departed-user')
  expect(formSummary(form)).toEqual(['/v1/admin/tools/falcon-axi/user-grants', 'PUT',
    'Replace this person’s interactive sessions grants for CrowdStrike Falcon? Clearing every operation removes the person. The change applies on their next call and is audited.', 'Save grants', 'Save grants'])
  expect(accessFields(form)).toEqual([['_csrf', 'hidden', 'synthetic-csrf', false, false], ['userId', 'hidden', 'departed-user', false, false], ['operations', 'hidden', undefined, false, true],
    ['operations', 'checkbox', 'exec', false, false], ['operations', 'checkbox', 'logs', false, false], ['operations', 'checkbox', 'watch', true, false],
    ['policy', 'hidden', 'sessions', false, false], ['expectedRevision', 'hidden', '7', false, false]])
  expect(dialogIn(html, 'grants-sessions-departed-user').attrs.some(item => item.name === 'open')).toBe(true)
  expect(dialogIn(html, 'grants-sessions-synthetic-two').attrs.some(item => item.name === 'open')).toBe(false)
  expect(text(dialogIn(html, 'grants-sessions-departed-user'))).toContain('Interactive sessions for departed-user')
})

test('the Grant a person sheet offers only people without a grant and checks no operation', () => {
  const form = sheetForm(renderAccess({ sheet: 'grants-sessions-add' }), 'grants-sessions-add')
  expect(accessFields(form).filter(([name]) => name !== '_csrf')).toEqual([['userId', 'select', undefined, false, false], ['operations', 'hidden', undefined, false, true],
    ['operations', 'checkbox', 'exec', false, false], ['operations', 'checkbox', 'logs', false, false], ['policy', 'hidden', 'sessions', false, false], ['expectedRevision', 'hidden', '7', false, false]])
  const [picker] = nodes(form).filter(element => attribute(element, 'name') === 'userId')
  expect(attribute(picker!, 'required')).toBe('')
  expect(nodes(picker!).filter(element => element.tagName === 'option').map(option => [attribute(option, 'value'), text(option)]))
    .toEqual([['synthetic-one', 'synthetic-one (Synthetic One)'], ['synthetic-three', 'synthetic-three (Synthetic Three)']])
  expect(nodes(form).filter(element => attribute(element, 'for') !== undefined).map(label => [attribute(label, 'for'), text(label)])).toEqual([['grants-sessions-add-user', 'Person']])
})

test('a policy whose ceilings are not saved offers no grant, and the page says where to set them', () => {
  const html = renderAccess()
  expect(find(html, element => attribute(element, 'id')?.startsWith('sheet-grants-scans') === true)).toEqual([])
  expect(find(html, element => element.tagName === 'p').map(text)).toEqual(expect.arrayContaining([
    'No one is granted. Nobody can use this until you grant a person.', 'Set the ceilings for this policy in Advanced native settings before granting people here.']))
  const everyone = renderAccess({ policies: [{ ...access.policies[0]!, grants: access.people.map(person => ({ id: person.id, summary: 'exec', operations: [] })) }] })
  expect(find(everyone, element => element.tagName === 'a' && text(element) === 'Grant a person')).toEqual([])
  expect(find(everyone, element => attribute(element, 'id') === 'sheet-grants-sessions-add')).toEqual([])
})
