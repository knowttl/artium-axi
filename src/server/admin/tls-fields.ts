import { X509Certificate } from 'node:crypto'
import type { TlsField, TlsRemoval, TlsSection } from '../../views/certificate-verification.js'
import { credentialTlsSettings, tlsFieldDefinitions } from '../credential-tls-settings.js'
import type { ToolName } from '../store/credential-store.js'
import { escape } from './escape.js'

export function tlsSection(tool: ToolName, metadata: Record<string, unknown>): TlsSection | null {
  if (tool === 'ssh-axi') return null
  const settings = credentialTlsSettings[tool]
  const read = (path?: string): unknown => path?.split('.').reduce<any>((value, key) => value?.[key], metadata)
  const field = (kind: keyof typeof tlsFieldDefinitions, path: string, value = '', required = false): TlsField => {
    const definition = tlsFieldDefinitions[kind]
    const help = definition.help + (tool === 'kubernetes-axi' && kind === 'serverName'
      ? ' Requires a saved exact certificate pin for this endpoint. Calls and credential tests refuse a name without that pin.' : '')
    return { path, id: `tls-${tool}-${kind}`, label: definition.label, help, value, required, clearable: kind === 'connectAddress' || kind === 'serverName',
      upload: kind === 'certificate' ? 'Upload PEM certificate' : undefined }
  }
  const removal = (path: string, label: string): TlsRemoval => ({ path, label: `Remove ${label} on save` })
  const pem = String(read(settings.certificate) ?? '')
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const fingerprints = certificates.map(certificate => {
    try { return new X509Certificate(certificate).fingerprint256 }
    catch { return 'Certificate fingerprint unavailable. Inspect the certificate before replacing trust.' }
  })
  const fingerprint = read(settings.fingerprint)
  const unifi = tool === 'unifi-axi'
  const kubernetes = tool === 'kubernetes-axi'
  return {
    legend: 'Certificate verification',
    intro: 'Certificate identity, chain or pin, validity and fingerprint verification remain required. Manage endpoint trust in Trusted certificates after saving.',
    connection: (['connectAddress', 'serverName'] as const).map(kind => settings[kind]
      ? { field: field(kind, settings[kind], String(read(settings[kind]) ?? '')) }
      : { label: tlsFieldDefinitions[kind].label, unsupported: tlsFieldDefinitions[kind].unsupported }),
    saved: {
      certificateLabel: `${tlsFieldDefinitions.certificate.label} (saved, read-only)`,
      certificate: pem || 'No certificate stored in this credential. See Trusted certificates below for instance trust.',
      fingerprintLabel: tlsFieldDefinitions.fingerprint.label,
      fingerprint: String(fingerprint || fingerprints.join('\n') || 'No fingerprint stored in this credential.'),
    },
    certificate: settings.certificate ? {
      summary: `${pem ? 'Replace' : 'Enter'} trusted certificate`, open: !pem && kubernetes,
      note: unifi ? 'Supply the certificate and fingerprint together when entering or replacing trust. UniFi requires both for a connection IP override.' : '',
      fields: [field('certificate', settings.certificate, '', kubernetes && !pem), ...unifi ? [field('fingerprint', settings.fingerprint!)] : []],
    } : null,
    certificateRemoval: pem && !kubernetes ? removal(unifi ? 'tls' : settings.certificate!, unifi ? 'certificate, fingerprint and connection IP' : 'trusted certificate') : null,
    pin: settings.pin ? {
      summary: `${fingerprint ? 'Replace' : 'Enter'} fingerprint pin`, fingerprint: field('fingerprint', settings.fingerprint!),
      hostname: { id: `tls-${tool}-replace-hostname`, path: `${settings.pin}.replaceHostname`, label: 'Use fingerprint instead of hostname verification',
        emptyLabel: fingerprint ? 'Keep saved setting' : 'Use hostname verification', help: 'Only enable this when the pinned certificate cannot match the endpoint hostname.' },
    } : null,
    pinRemoval: settings.pin && fingerprint ? removal(settings.pin, 'fingerprint pin') : null,
    note: kubernetes ? 'A trusted certificate is required and can only be replaced.' : '',
  }
}

export function tlsFields(section: TlsSection | null): string {
  if (!section) return ''
  const input = ({ path, id, label, help, value, required, clearable, upload }: TlsField) => {
    const attributes = `id="${id}" name="profile.${path}" data-profile-field="${path}" data-profile-type="string" data-tls-input aria-describedby="${id}-hint" autocomplete="off"${required ? ' required' : ''}`
    const control = upload
      ? `<textarea ${attributes} rows="6" spellcheck="false"></textarea><label>${upload}<input id="${id}-file" type="file" data-tls-file="${path}" accept=".pem"></label>`
      : `<input ${attributes}${clearable ? ' data-profile-clearable' : ''} type="text" value="${escape(value)}">`
    return `<div data-credential-field="${path}"><label for="${id}">${label}</label>${control}<p id="${id}-hint">${escape(help)}</p></div>`
  }
  const remove = (removal: TlsRemoval | null) => removal ? `<label><input type="checkbox" data-tls-remove="${removal.path}"> ${removal.label}</label>` : ''
  const { saved, certificate, pin } = section
  const connection = section.connection.map(entry => 'field' in entry ? input(entry.field) : `<p><strong>${entry.label}</strong>: ${entry.unsupported}</p>`).join('')
  const savedTrust = `<details><summary>${saved.certificateLabel}</summary><pre>${escape(saved.certificate)}</pre></details><p>${saved.fingerprintLabel}</p><pre>${escape(saved.fingerprint)}</pre>`
  const entry = certificate ? `<details${certificate.open ? ' open' : ''}><summary>${certificate.summary}</summary>${certificate.note && `<p>${certificate.note}</p>`}${certificate.fields.map(input).join('')}</details>` : ''
  const pinEntry = pin ? `<details><summary>${pin.summary}</summary>${input(pin.fingerprint)}<label for="${pin.hostname.id}">${pin.hostname.label}</label><select id="${pin.hostname.id}" name="profile.${pin.hostname.path}" data-profile-field="${pin.hostname.path}" data-profile-type="json" data-tls-input><option value="">${pin.hostname.emptyLabel}</option><option value="true">Yes</option><option value="false">No</option></select><p>${pin.hostname.help}</p></details>` : ''
  return `<fieldset><legend>${section.legend}</legend><p>${section.intro}</p>${connection}${savedTrust}${entry}${remove(section.certificateRemoval)}${pinEntry}${remove(section.pinRemoval)}${section.note && `<p>${section.note}</p>`}</fieldset>`
}
