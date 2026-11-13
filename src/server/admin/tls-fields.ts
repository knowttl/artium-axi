import { X509Certificate } from 'node:crypto'
import { credentialTlsSettings, tlsFieldDefinitions } from '../credential-tls-settings.js'
import type { ToolName } from '../store/credential-store.js'
import { escape } from './escape.js'

export function tlsFields(tool: ToolName, metadata: Record<string, unknown>): string {
  if (tool === 'ssh-axi') return ''
  const settings = credentialTlsSettings[tool]
  const read = (path?: string): unknown => path?.split('.').reduce<any>((value, key) => value?.[key], metadata)
  const input = (kind: keyof typeof tlsFieldDefinitions, path: string, value = '', required = false) => {
    const field = tlsFieldDefinitions[kind]
    const id = `tls-${tool}-${kind}`
    const attributes = `id="${id}" name="profile.${path}" data-profile-field="${path}" data-profile-type="string" data-tls-input aria-describedby="${id}-hint" autocomplete="off"${required ? ' required' : ''}`
    const control = kind === 'certificate'
      ? `<textarea ${attributes} rows="6" spellcheck="false"></textarea><label>Upload PEM certificate<input id="${id}-file" type="file" data-tls-file="${path}" accept=".pem"></label>`
      : `<input ${attributes}${['connectAddress', 'serverName'].includes(kind) ? ' data-profile-clearable' : ''} type="text" value="${escape(value)}">`
    return `<div data-credential-field="${path}"><label for="${id}">${field.label}</label>${control}<p id="${id}-hint">${escape(field.help)}</p></div>`
  }
  const connection = (['connectAddress', 'serverName'] as const).map(kind => settings[kind]
    ? input(kind, settings[kind], String(read(settings[kind]) ?? ''))
    : `<p><strong>${tlsFieldDefinitions[kind].label}</strong>: ${tlsFieldDefinitions[kind].unsupported}</p>`).join('')
  const pem = String(read(settings.certificate) ?? '')
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const fingerprints = certificates.map(certificate => {
    try { return new X509Certificate(certificate).fingerprint256 }
    catch { return 'Certificate fingerprint unavailable. Inspect the certificate before replacing trust.' }
  })
  const fingerprint = read(settings.fingerprint)
  const saved = `<details><summary>${tlsFieldDefinitions.certificate.label} (saved, read-only)</summary><pre>${escape(pem || 'No certificate stored in this credential. See Trusted certificates below for instance trust.')}</pre></details><p>${tlsFieldDefinitions.fingerprint.label}</p><pre>${escape(fingerprint || fingerprints.join('\n') || 'No fingerprint stored in this credential.')}</pre>`
  const entry = settings.certificateEntry
    ? `<details${!pem && tool === 'kubernetes-axi' ? ' open' : ''}><summary>${pem ? 'Replace' : 'Enter'} trusted certificate</summary>${settings.fingerprint ? '<p>Supply the certificate and fingerprint together when entering or replacing trust. UniFi requires both for a connection IP override.</p>' : ''}${input('certificate', settings.certificate!, '', tool === 'kubernetes-axi' && !pem)}${settings.fingerprint ? input('fingerprint', settings.fingerprint) : ''}</details>` : ''
  return `<fieldset><legend>Certificate verification</legend><p>Certificate identity, chain or pin, validity and fingerprint verification remain required. Manage endpoint trust in Trusted certificates after saving.</p>${connection}${saved}${entry}</fieldset>`
}
