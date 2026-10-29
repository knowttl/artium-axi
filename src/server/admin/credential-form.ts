import { CredentialProfile } from '../adapters/credential-profile.js'
import { adoProfile } from '../adapters/ado.js'
import { ghProfile } from '../adapters/gh.js'
import { awxProfile } from '../adapters/awx.js'
import { tenableProfile } from '../adapters/tenable.js'
import { hybridProfile } from '../adapters/hybrid.js'
import { beyondtrustProfile } from '../adapters/beyondtrust.js'
import { checkpointProfile } from '../adapters/checkpoint.js'
import { nativeSettingsSchemas } from '../../shared/api.js'
import type { ToolName } from '../store/credential-store.js'
import { escape } from './escape.js'

// Legacy adapters need a host editor even when no published profile is available.
export function editorProfile(tool: ToolName, profile?: CredentialProfile): CredentialProfile {
  if (tool === 'beyondtrust-axi') return beyondtrustProfile
  if (tool === 'checkpoint-axi') return checkpointProfile
  if (tool === 'ado-axi') return adoProfile
  if (tool === 'gh-axi') return ghProfile
  if (tool === 'awx-axi') return awxProfile
  if (tool === 'tenable-axi') return tenableProfile
  if (tool === 'hybrid-axi') return hybridProfile
  if (profile && tool !== 'az-axi') return profile
  const text = { type: 'string' }
  const secret = { ...text, 'x-secret': true }
  const certificate = (fingerprint: string) => ({ type: 'object', required: ['tenantId', 'clientId', 'auth'],
    properties: { tenantId: text, clientId: text, auth: { enum: ['secret', 'certificate'] },
      clientSecret: secret, privateKey: secret, [fingerprint]: text },
    oneOf: [
      { properties: { auth: { const: 'secret' } }, required: ['clientSecret'], not: { anyOf: [{ required: ['privateKey'] }, { required: [fingerprint] }] } },
      { properties: { auth: { const: 'certificate' } }, required: ['privateKey', fingerprint], not: { required: ['clientSecret'] } },
    ] })
  const schemas = {
    'falcon-axi': { type: 'object', required: ['clientId', 'clientSecret', 'region'], properties: { clientId: text, clientSecret: secret, region: text, memberCid: text } },
    'az-axi': certificate('thumbprintSha256'), 'mg-axi': certificate('thumbprint'),
    'ldap-axi': { type: 'object', required: ['url', 'auth', 'bindDn', 'bindPassword'], properties: {
      url: text, auth: { const: 'simple' }, bindDn: text, bindPassword: secret, base: text,
      pageSize: { type: 'integer' }, startTls: { type: 'boolean' }, tlsMaxVersion: { const: '1.2' }, caFile: text } },
    'vectra-axi': { type: 'object', required: ['kind', 'apiVersion', 'origin', 'auth'], properties: {
      kind: { enum: ['qux', 'rux'] }, apiVersion: { enum: ['2.5', '3.4'] }, origin: text,
      auth: { enum: ['token', 'oauth'] }, clientId: text, token: secret, clientSecret: secret, caBundle: text, applianceRelease: text },
      oneOf: [
        { properties: { auth: { const: 'token' } }, required: ['token'], not: { anyOf: [{ required: ['clientId'] }, { required: ['clientSecret'] }] } },
        { properties: { auth: { const: 'oauth' } }, required: ['clientId', 'clientSecret'], not: { required: ['token'] } },
      ] },
  }
  return new CredentialProfile(schemas[tool])
}

const fieldHelp: Record<string, string> = {
  org: 'Azure DevOps organization name or organization-root HTTPS URL. Changing it requires new secrets.',
  project: 'Optional default Azure DevOps project.',
  tenantId: 'Directory tenant ID (UUID). Changing it requires new secrets.',
  clientId: 'Application client ID. Changing it requires new secrets.',
  origin: 'HTTPS origin only, for example https://appliance.example. Changing it requires new secrets.',
  memberCid: 'Optional member account ID.',
  url: 'Directory URL, for example ldaps://directory.example. LDAP requires Start TLS.',
  bindDn: 'Directory bind identity, for example cn=reader,dc=example.', base: 'Optional search base, for example dc=example.',
  caFile: 'Paste trusted CA certificate PEM contents. Line breaks are preserved; do not enter a file path.',
  caBundle: 'Paste trusted CA certificate PEM contents. Line breaks are preserved; do not enter a file path.',
  privateKey: 'Paste the PEM private key. Line breaks are preserved.',
  thumbprintSha256: 'SHA-256 certificate fingerprint (64 hexadecimal characters). A combined PEM upload calculates it.',
  thumbprint: 'SHA-1 certificate fingerprint (40 hexadecimal characters). A combined PEM upload calculates it.',
  auth: 'Choose authentication first. Changing it requires new secrets.',
  signIn: 'Choose password to sign in with a username and password. Artium mints one personal access token and stores only that token. Choose token, or leave this blank, to paste or keep a token.',
  username: 'Controller username. Used once to mint a token and not stored.',
  password: 'Controller password. Used once to mint a token, then discarded. It is not stored or logged.',
  mode: 'Application uses a service identity; delegated uses a supplied user token.',
  kind: 'Qux supports token or OAuth; Rux requires OAuth. Qux uses API 2.5 and Rux uses 3.4.',
  apiVersion: 'Use 2.5 for Qux or 3.4 for Rux.', pageSize: 'Optional number of directory entries per page.',
  startTls: 'Required for ldap:// URLs; leave at the default for ldaps:// URLs, which are already encrypted.', tlsMaxVersion: 'Optional TLS maximum version.',
  applianceRelease: 'Optional release label for Qux appliances.',
}

export function credentialFields(tool: ToolName | undefined, profile: CredentialProfile, metadata: Record<string, unknown>, configured: boolean): string {
  const excluded = new Set([...(tool ? Object.keys(nativeSettingsSchemas[tool].shape) : []), 'tokenEnv', 'secretEnv'])
  if (tool === 'gh-axi') for (const name of ['accessToken', 'accessTokenExpiresAt', 'login']) excluded.add(name)
  const fields = profile.fields().filter(field => !excluded.has(field.name))
    .sort((a, b) => Number(['signIn', 'mode', 'auth', 'kind'].includes(b.name)) - Number(['signIn', 'mode', 'auth', 'kind'].includes(a.name)))
    .map(({ name, schema, required }) => {
    const secret = schema['x-secret'] === true
    const ephemeral = schema['x-ephemeral'] === true
    const value = secret ? undefined : metadata[name]
    const attributes = `name="profile.${escape(name)}" data-profile-field="${escape(name)}"${required && !secret ? ' required' : ''} autocomplete="off"`
    const label = escape(schema.title ?? name) + (secret ? ' (secret)' : schema.type === 'object' ? ' (advanced JSON)' : '')
    const help = tool === 'beyondtrust-axi' ? schema.description
      : name === 'region' && tool === 'checkpoint-axi' ? 'Check Point API region for your tenant, for example us.'
      : name === 'region' && tool === 'falcon-axi' ? 'Falcon API region, for example us-1.' : fieldHelp[name]
    let input: string
    if (schema.enum) {
      const choices = tool === 'gh-axi' && name === 'auth' ? schema.enum.filter((choice: unknown) => choice !== 'device') : schema.enum
      input = `<select ${attributes} data-profile-type="json"><option value="">Choose a value</option>${choices.map((choice: unknown) =>
        `<option value="${escape(JSON.stringify(choice))}"${choice === value ? ' selected' : ''}>${escape(String(choice))}</option>`).join('')}</select>`
    } else if (schema.type === 'boolean') {
      input = `<select ${attributes} data-profile-type="json"><option value="">Use the default</option><option value="true"${value === true ? ' selected' : ''}>True</option><option value="false"${value === false ? ' selected' : ''}>False</option></select>`
    } else if (schema.type === 'array' && (schema.items?.type === 'string' || schema.items?.const)) {
      input = `<textarea ${attributes} data-profile-type="list" rows="3">${escape(Array.isArray(value) ? value.join('\n') : '')}</textarea><p>One value per line.</p>`
    } else if (secret || ['caFile', 'caBundle'].includes(name) || !['string', 'number', 'integer'].includes(schema.type)) {
      const type = secret || schema.type === 'string' ? 'string' : 'json'
      input = `<textarea ${attributes} data-profile-type="${type}" rows="6" spellcheck="false">${escape(value === undefined ? '' : type === 'json' ? JSON.stringify(value) : String(value))}</textarea>`
    } else {
      input = `<input ${attributes} data-profile-type="${schema.type === 'string' ? 'string' : 'json'}" type="${schema.type === 'string' ? 'text' : 'number'}" value="${escape(value ?? '')}"${schema.type === 'number' ? ' step="any"' : ''}>`
    }
    return `<div data-credential-field="${escape(name)}"${secret ? ' data-secret' : ''}${ephemeral ? ' data-ephemeral' : ''}><label>${label}${input}</label><p>${escape(help ?? schema.description ?? (secret ? 'Enter the secret itself. Leave blank to keep a stored secret for the same identity.' : 'Optional profile value.'))}</p>${secret && configured && !ephemeral ? '<p data-stored-secret>Stored when configured below. Leave blank to keep; enter a value to replace.</p>' : ''}</div>`
  }).join('')
  return `<div data-credential-editor data-schema="${escape(JSON.stringify(profile.inputSchema))}" data-identity="${escape(JSON.stringify(Object.fromEntries(['mode', 'kind', 'auth', 'tenantId', 'clientId', 'origin', 'org', 'appId', 'installationId'].map(key => [key, metadata[key] ?? null]))))}" data-configured="${configured}"><p>Non-secret values are pre-filled. Secrets are never displayed. Leave a secret blank to keep it, or enter a replacement. Changing authentication, mode, kind, tenant, client, origin, organization, App ID or installation ID requires new secrets.${tool ? ' Saving keeps native settings and clears cached health.' : ' Saving keeps SSO sign-in disabled.'}</p>${fields}
    <div data-certificate hidden><label>Certificate and private key (one PEM file)<input type="file" data-certificate-file accept=".pem"></label><label>Or paste certificate and private key<textarea data-certificate-pem rows="8" autocomplete="off" spellcheck="false"></textarea></label><p>Include one certificate and its matching unencrypted private key. The server calculates the fingerprint. Leave blank to keep the stored key and fingerprint, or use the separate fields above.</p></div>
    <details><summary>Advanced: profile schema and requirements</summary><pre>${escape(JSON.stringify(profile.inputSchema, null, 2))}</pre></details></div>`
}
