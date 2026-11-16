import { deepStrictEqual } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { CredentialProfile, loadCredentialProfile } from '../src/server/adapters/credential-profile.js'
import { CredentialEditor } from '../src/views/credential-editor.js'
import { credentialEditor, editorProfile } from '../src/server/admin/credential-form.js'
import { toolCredentialSchemaPaths } from '../src/server/config.js'
import { credentialTlsSettings } from '../src/server/credential-tls-settings.js'
import { toolSchema } from '../src/shared/api.js'
import type { ToolName } from '../src/server/store/credential-store.js'

const inventories = new URL('../tools/inventories/', import.meta.url)
const profiles = readdirSync(inventories).filter(name => name.endsWith('.json')).flatMap(name => {
  const inventory = JSON.parse(readFileSync(new URL(name, inventories), 'utf8'))
  return inventory.credentialSchema ? [[name.slice(0, -5) as ToolName, inventory.credentialSchema] as const] : []
})

const schemaRegistry = Object.fromEntries(Object.entries(toolCredentialSchemaPaths).map(([name, path]) => {
  const tool = name as ToolName
  const published = path ? loadCredentialProfile(tool, path.replace('/opt/tools/', fileURLToPath(new URL('../tools/', import.meta.url)))) : undefined
  if (path && !published) throw new Error(`Missing credential schema: ${tool}`)
  return [tool, { configured: published, editor: editorProfile(tool, published) }]
})) as Record<ToolName, { configured: CredentialProfile | undefined, editor: CredentialProfile }>

function assertTlsFieldsRegistered(registry: typeof schemaRegistry) {
  const leaves = (schema: Record<string, any>, path: string): string[] => schema.properties
    ? Object.entries(schema.properties).flatMap(([name, child]) => leaves(child as Record<string, any>, `${path}.${name}`)) : [path]
  const unregistered = Object.entries(registry).flatMap(([name, profiles]) => {
    const settings = credentialTlsSettings[name as ToolName]
    const registered = new Set(Object.values(settings))
    if (settings.pin) for (const field of ['origin', 'replaceHostname']) registered.add(`${settings.pin}.${field}`)
    return [profiles.configured, profiles.editor].flatMap(profile => profile?.fields() ?? []).filter(field => !['startTls', 'tlsMaxVersion'].includes(field.name)
      && /^(tls|caFile|caBundle|certificateAuthority|certificatePin|connectAddress|serverName|trustedCertificate|peerFingerprint)/i.test(field.name))
      .flatMap(field => leaves(field.schema, field.name)).filter(path => !registered.has(path)).map(path => `${name}.${path}`)
  })
  deepStrictEqual(unregistered, [], 'Every declared TLS trust field must be registered in the shared TLS layer')
}

test('every credential schema registers its TLS trust fields in the shared layer', () => {
  assertTlsFieldsRegistered(schemaRegistry)
})

test('the schema guard rejects a seeded unregistered TLS field in the real registry', () => {
  const schema = structuredClone(schemaRegistry['gh-axi'].editor.schema)
  schema.properties.caFile = structuredClone(schemaRegistry['ldap-axi'].editor.inputSchema.properties.caFile)
  const seeded = { ...schemaRegistry, 'gh-axi': { ...schemaRegistry['gh-axi'], editor: new CredentialProfile(schema, 'gh-axi') } }
  expect(() => assertTlsFieldsRegistered(seeded)).toThrow('gh-axi.caFile')
})

test('the schema guard rejects a seeded unregistered TLS field in a configured profile', () => {
  const schema = structuredClone(schemaRegistry['unifi-axi'].configured!.schema)
  schema.properties.caFile = structuredClone(schemaRegistry['ldap-axi'].editor.inputSchema.properties.caFile)
  const seeded = { ...schemaRegistry, 'unifi-axi': { ...schemaRegistry['unifi-axi'], configured: new CredentialProfile(schema, 'unifi-axi') } }
  expect(() => assertTlsFieldsRegistered(seeded)).toThrow('unifi-axi.caFile')
})

test.each(toolSchema.options)('%s explains supported certificate identity settings', tool => {
  const published = profiles.find(([name]) => name === tool)
  const profile = editorProfile(tool, published ? new CredentialProfile(published[1], tool) : undefined)
  const html = renderToString(createElement(CredentialEditor, credentialEditor(tool, profile, {}, false)))
  if (tool === 'ssh-axi') { expect(html).not.toContain('Certificate verification'); return }
  const settings = { connectAddress: tool === 'unifi-axi' ? 'tls.connectAddress' : undefined,
    serverName: ['technitium-axi', 'kubernetes-axi'].includes(tool) ? 'tlsServerName' : undefined }
  for (const [kind, label] of [['connectAddress', 'Connect via IP address'], ['serverName', 'Certificate name to verify']] as const) {
    expect(html).toContain(label)
    if (settings[kind]) expect(html).toContain(`data-profile-field="${settings[kind]}"`)
    else expect(html).toContain(kind === 'connectAddress' ? 'does not support a separate connection IP' : 'does not support a separate certificate name')
  }
})

test.each([
  ['ldap-axi', { caFile: 'CANARY-LDAP-CA' }, 'CANARY-LDAP-CA', undefined, 'caFile', undefined],
  ['vectra-axi', { caBundle: 'CANARY-VECTRA-CA' }, 'CANARY-VECTRA-CA', undefined, 'caBundle', undefined],
  ['technitium-axi', { caFile: 'CANARY-DNS-CA' }, 'CANARY-DNS-CA', undefined, 'caFile', undefined],
  ['proxmox-axi', { caBundle: 'CANARY-PROXMOX-CA', certificatePin: { sha256: 'CANARY-PIN' } }, 'CANARY-PROXMOX-CA', 'CANARY-PIN', 'caBundle', 'certificatePin'],
  ['kubernetes-axi', { certificateAuthority: 'CANARY-CLUSTER-CA' }, 'CANARY-CLUSTER-CA', undefined, 'certificateAuthority', undefined],
  ['unifi-axi', { tls: { trustedCertificatePem: 'CANARY-UNIFI-CA', peerFingerprintSha256: 'CANARY-UNIFI-PIN' } }, 'CANARY-UNIFI-CA', 'CANARY-UNIFI-PIN', 'tls.trustedCertificatePem', 'tls'],
] as const)('%s displays saved trust and offers supported replacement', (tool, metadata, certificate, fingerprint, entry, hidden) => {
  const published = profiles.find(([name]) => name === tool)
  const profile = editorProfile(tool, published ? new CredentialProfile(published[1], tool) : undefined)
  const html = renderToString(createElement(CredentialEditor, credentialEditor(tool, profile, metadata, true)))
  expect(html).toContain(`<pre>${certificate}</pre>`)
  if (fingerprint) expect(html).toContain(`<pre>${fingerprint}</pre>`)
  if (entry) expect(html).toContain(`data-profile-field="${entry}"`)
  if (tool === 'unifi-axi') expect(html).toContain('data-profile-field="tls.peerFingerprintSha256"')
  if (hidden) expect(html).not.toContain(`data-profile-field="${hidden}"`)
})

const controlsOf = (tool: ToolName | undefined, profile: CredentialProfile, metadata: Record<string, unknown> = {}, configured = false) =>
  credentialEditor(tool, profile, metadata, configured).controls

test.each(profiles)('%s explains every visible non-secret credential field', (tool, schema) => {
  const visible = controlsOf(tool, new CredentialProfile(schema, tool)).filter(control => !control.secret)
  expect(visible.length).toBeGreaterThan(0)
  for (const control of visible) expect(control.help, `${tool}.${control.name}`).not.toContain('Optional profile value.')
})

test('schema titles and descriptions take precedence over tool help', () => {
  const profile = new CredentialProfile({ type: 'object', properties: {
    region: { type: 'string', title: 'Regional gateway', description: 'Schema-owned region guidance.' },
  } })
  const [region] = controlsOf('checkpoint-axi', profile)
  expect([region!.label, region!.help]).toEqual(['Regional gateway', 'Schema-owned region guidance.'])
})

test.each([
  ['saas', 'office365_emails', 'Default: office365_emails.'],
  ['downloads', { allow: false }, 'Default: {"allow":false}.'],
  ['enabled', false, 'Default: false.'],
  ['limit', 0, 'Default: 0.'],
])('shows the schema default for %s', (name, value, help) => {
  const profile = new CredentialProfile({ type: 'object', properties: {
    [name]: { default: value, description: 'Field guidance.' },
  } })
  expect(controlsOf('checkpoint-axi', profile)[0]!.help).toBe(`Field guidance. ${help}`)
})

test.each([
  ['checkpoint-axi', 'saas', 'SaaS application name, not a URL'],
  ['checkpoint-axi', 'scope', 'printable ASCII with no spaces'],
  ['checkpoint-axi', 'downloads', 'Artium manages download permissions'],
  ['beyondtrust-axi', 'host', '<organization>-services.pm.beyondtrustcloud.com'],
  ['beyondtrust-axi', 'downloads', 'Artium manages download permissions'],
  [undefined, 'tenantId', 'Directory tenant ID (UUID). Changing it requires new secrets.'],
  [undefined, 'clientId', 'Application client ID. Changing it requires new secrets.'],
  [undefined, 'auth', 'Choose authentication first. Changing it requires new secrets.'],
  [undefined, 'privateKey', 'Paste the PEM private key. Line breaks are preserved.'],
  [undefined, 'thumbprintSha256', 'SHA-256 certificate fingerprint (64 hexadecimal characters). A combined PEM upload calculates it.'],
  ['gh-axi', 'auth', 'Choose authentication first. Changing it requires new secrets.'],
] as const)('%s explains %s when upstream descriptions are absent', (tool, name, help) => {
  const profile = new CredentialProfile({ type: 'object', properties: { [name]: { type: 'string' } } })
  expect(controlsOf(tool, profile)[0]!.help).toContain(help)
})

test('the editor marks a field secret from its profile schema, not from its name', () => {
  const profile = new CredentialProfile({ type: 'object', properties: { harmless: { type: 'string', 'x-secret': true }, apiToken: { type: 'string' } } })
  const { controls } = credentialEditor('checkpoint-axi', profile, { harmless: 'CANARY-harmless', apiToken: 'plain-token' }, true)
  expect(controls.map(({ name, secret, kind, value, stored }) => ({ name, secret, kind, value, stored }))).toEqual([
    { name: 'harmless', secret: true, kind: 'textarea', value: '', stored: true },
    { name: 'apiToken', secret: false, kind: 'input', value: 'plain-token', stored: false },
  ])
})

test.each(toolSchema.options.filter(tool => tool !== 'ssh-axi'))('%s editor model and markup never carry a saved secret value', tool => {
  const published = profiles.find(([name]) => name === tool)
  const profile = editorProfile(tool, published ? new CredentialProfile(published[1], tool) : undefined)
  const secrets = profile.fields().filter(field => field.schema['x-secret'] === true).map(field => field.name)
  expect(secrets.length).toBeGreaterThan(0)
  const metadata = Object.fromEntries(profile.fields().map(field => [field.name, `CANARY-${tool}-${field.name}-END`]))
  const editor = credentialEditor(tool, profile, metadata, true)
  const offered = secrets.filter(name => !(tool === 'gh-axi' && name === 'accessToken'))
  expect(editor.controls.filter(control => control.secret).map(control => [control.name, control.kind, control.value])).toEqual(offered.map(name => [name, 'textarea', '']))
  for (const name of secrets) {
    expect(JSON.stringify(editor)).not.toContain(`CANARY-${tool}-${name}-END`)
    expect(renderToString(createElement(CredentialEditor, editor))).not.toContain(`CANARY-${tool}-${name}-END`)
  }
})
