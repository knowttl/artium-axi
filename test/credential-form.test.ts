import { readFileSync, readdirSync } from 'node:fs'
import { expect, test } from 'vitest'
import { CredentialProfile } from '../src/server/adapters/credential-profile.js'
import { credentialFields } from '../src/server/admin/credential-form.js'
import type { ToolName } from '../src/server/store/credential-store.js'

const inventories = new URL('../tools/inventories/', import.meta.url)
const profiles = readdirSync(inventories).filter(name => name.endsWith('.json')).flatMap(name => {
  const inventory = JSON.parse(readFileSync(new URL(name, inventories), 'utf8'))
  return inventory.credentialSchema ? [[name.slice(0, -5) as ToolName, inventory.credentialSchema] as const] : []
})

test.each(profiles)('%s explains every visible non-secret credential field', (tool, schema) => {
  const html = credentialFields(tool, new CredentialProfile(schema, tool), {}, false)
  const fields = [...html.matchAll(/<div data-credential-field="([^"]+)"([^>]*)>(.*?)<\/div>/gs)]
  expect(fields.length).toBeGreaterThan(0)
  for (const [, name, attributes, content] of fields) {
    if (!attributes.includes('data-secret')) expect(content, `${tool}.${name}`).not.toContain('Optional profile value.')
  }
})

test('schema titles and descriptions take precedence over tool help', () => {
  const profile = new CredentialProfile({ type: 'object', properties: {
    region: { type: 'string', title: 'Regional gateway', description: 'Schema-owned region guidance.' },
  } })
  expect(credentialFields('checkpoint-axi', profile, {}, false)).toContain('<label>Regional gateway<input')
  expect(credentialFields('checkpoint-axi', profile, {}, false)).toContain('<p>Schema-owned region guidance.</p>')
})

test.each([
  ['saas', 'office365_emails', 'Default: office365_emails.'],
  ['downloads', { allow: false }, 'Default: {&quot;allow&quot;:false}.'],
  ['enabled', false, 'Default: false.'],
  ['limit', 0, 'Default: 0.'],
])('shows the schema default for %s', (name, value, help) => {
  const profile = new CredentialProfile({ type: 'object', properties: {
    [name]: { default: value, description: 'Field guidance.' },
  } })
  expect(credentialFields('checkpoint-axi', profile, {}, false)).toContain(`<p>Field guidance. ${help}</p>`)
})

test.each([
  ['checkpoint-axi', 'saas', 'SaaS application name, not a URL'],
  ['checkpoint-axi', 'scope', 'printable ASCII with no spaces'],
  ['checkpoint-axi', 'downloads', 'Artium manages download permissions'],
  ['beyondtrust-axi', 'host', '&lt;organization&gt;-services.pm.beyondtrustcloud.com'],
  ['beyondtrust-axi', 'downloads', 'Artium manages download permissions'],
] as const)('%s explains %s when upstream descriptions are absent', (tool, name, help) => {
  const profile = new CredentialProfile({ type: 'object', properties: { [name]: { type: 'string' } } })
  expect(credentialFields(tool, profile, {}, false)).toContain(help)
})
