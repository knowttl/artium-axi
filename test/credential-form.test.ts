import { readFileSync, readdirSync } from 'node:fs'
import { expect, test } from 'vitest'
import { CredentialProfile } from '../src/server/adapters/credential-profile.js'
import { credentialFields, editorProfile } from '../src/server/admin/credential-form.js'
import { tlsCredentialRoots } from '../src/server/credential-tls-settings.js'
import { toolSchema } from '../src/shared/api.js'
import type { ToolName } from '../src/server/store/credential-store.js'

const inventories = new URL('../tools/inventories/', import.meta.url)
const profiles = readdirSync(inventories).filter(name => name.endsWith('.json')).flatMap(name => {
  const inventory = JSON.parse(readFileSync(new URL(name, inventories), 'utf8'))
  return inventory.credentialSchema ? [[name.slice(0, -5) as ToolName, inventory.credentialSchema] as const] : []
})

test.each(toolSchema.options)('%s uses the shared TLS editor for every credential trust setting', tool => {
  const published = profiles.find(([name]) => name === tool)
  const profile = editorProfile(tool, published ? new CredentialProfile(published[1], tool) : undefined)
  const roots = profile.fields().map(field => field.name).filter(name => name !== 'tlsMaxVersion' && /^(tls|caFile|caBundle|certificate|connectAddress|serverName)/.test(name))
  expect(roots.sort()).toEqual(tlsCredentialRoots(tool).sort())
  const html = credentialFields(tool, profile, {}, false)
  if (tool === 'ssh-axi') { expect(html).not.toContain('Certificate verification'); return }
  const settings = { connectAddress: tool === 'unifi-axi' ? 'tls.connectAddress' : undefined,
    serverName: tool === 'technitium-axi' ? 'tlsServerName' : undefined }
  for (const [kind, label] of [['connectAddress', 'Connect via IP address'], ['serverName', 'Certificate name to verify']] as const) {
    expect(html).toContain(label)
    if (settings[kind]) expect(html).toContain(`data-profile-field="${settings[kind]}"`)
    else expect(html).toContain(kind === 'connectAddress' ? 'does not support a separate connection IP' : 'does not support a separate certificate name')
  }
  for (const root of roots.filter(name => ['tls', 'certificatePin'].includes(name))) {
    const properties = profile.fields().find(field => field.name === root)!.schema.properties
    const expected = root === 'tls' ? ['connectAddress', 'peerFingerprintSha256', 'trustedCertificatePem'] : ['origin', 'replaceHostname', 'sha256']
    expect(Object.keys(properties).sort()).toEqual(expected)
    expect(html).not.toContain(`data-profile-field="${root}"`)
  }
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
  expect(credentialFields('checkpoint-axi', profile, {}, false)).toContain('Schema-owned region guidance.</p>')
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
  expect(credentialFields('checkpoint-axi', profile, {}, false)).toContain(`Field guidance. ${help}</p>`)
})

test.each([
  ['checkpoint-axi', 'saas', 'SaaS application name, not a URL'],
  ['checkpoint-axi', 'scope', 'printable ASCII with no spaces'],
  ['checkpoint-axi', 'downloads', 'Artium manages download permissions'],
  ['beyondtrust-axi', 'host', '&lt;organization&gt;-services.pm.beyondtrustcloud.com'],
  ['beyondtrust-axi', 'downloads', 'Artium manages download permissions'],
  [undefined, 'tenantId', 'Directory tenant ID (UUID). Changing it requires new secrets.'],
  [undefined, 'clientId', 'Application client ID. Changing it requires new secrets.'],
  [undefined, 'auth', 'Choose authentication first. Changing it requires new secrets.'],
  [undefined, 'privateKey', 'Paste the PEM private key. Line breaks are preserved.'],
  [undefined, 'thumbprintSha256', 'SHA-256 certificate fingerprint (64 hexadecimal characters). A combined PEM upload calculates it.'],
  ['gh-axi', 'auth', 'Choose authentication first. Changing it requires new secrets.'],
] as const)('%s explains %s when upstream descriptions are absent', (tool, name, help) => {
  const profile = new CredentialProfile({ type: 'object', properties: { [name]: { type: 'string' } } })
  expect(credentialFields(tool, profile, {}, false)).toContain(help)
})
