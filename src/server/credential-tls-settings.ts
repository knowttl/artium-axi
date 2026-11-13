import type { ToolName } from './store/credential-store.js'
import { ArtiumError } from '../shared/errors.js'

type TlsSettings = { certificate?: string, fingerprint?: string, pin?: string, connectAddress?: string, serverName?: string }

export const credentialTlsSettings: Record<ToolName, TlsSettings> = {
  'unifi-axi': { certificate: 'tls.trustedCertificatePem', fingerprint: 'tls.peerFingerprintSha256', connectAddress: 'tls.connectAddress' },
  'proxmox-axi': { certificate: 'caBundle', fingerprint: 'certificatePin.sha256', pin: 'certificatePin' },
  'technitium-axi': { certificate: 'caFile', serverName: 'tlsServerName' },
  'ldap-axi': { certificate: 'caFile' },
  'vectra-axi': { certificate: 'caBundle' },
  'kubernetes-axi': { certificate: 'certificateAuthority' },
  'gh-axi': {}, 'ado-axi': {}, 'az-axi': {}, 'mg-axi': {}, 'awx-axi': {}, 'beyondtrust-axi': {},
  'checkpoint-axi': {}, 'falcon-axi': {}, 'gitea-axi': {}, 'hybrid-axi': {}, 'shodan-axi': {}, 'tenable-axi': {}, 'ssh-axi': {},
}

export const tlsFieldDefinitions = {
  connectAddress: { label: 'Connect via IP address', help: 'Connect to this IP while verifying the certificate identity. Leave blank to use the saved URL.', unsupported: 'This tool does not support a separate connection IP address. The connection uses its saved endpoint.' },
  serverName: { label: 'Certificate name to verify', help: 'Verify this DNS name in the certificate. Chain, validity and fingerprint checks still apply. Leave blank to verify the saved URL.', unsupported: 'This tool does not support a separate certificate name. The certificate must match its saved endpoint.' },
  certificate: { label: 'Trusted certificate', help: 'Paste PEM certificate contents or upload a PEM file. Leave blank to keep saved trust for the same endpoint.' },
  fingerprint: { label: 'SHA-256 fingerprint', help: 'Enter the 64 hexadecimal characters shown by the appliance. Compare through an independent trusted route.' },
}

export function tlsCredentialRoots(tool: ToolName): string[] {
  return [...new Set(Object.values(credentialTlsSettings[tool]).filter((value): value is string => typeof value === 'string').map(path => path.split('.')[0]!))]
}

export function retainCredentialTls(tool: ToolName, stored: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  if (tool === 'unifi-axi' && value.tls && typeof value.tls === 'object' && !Array.isArray(value.tls)) {
    if (Object.hasOwn(value.tls, 'trustedCertificatePem') !== Object.hasOwn(value.tls, 'peerFingerprintSha256')) {
      throw new ArtiumError('INVALID_INPUT', 'Enter the trusted certificate and SHA-256 fingerprint together.')
    }
  }
  if (stored.origin === value.origin && stored.url === value.url) {
    for (const root of tlsCredentialRoots(tool)) if (!Object.hasOwn(next, root) && Object.hasOwn(stored, root)) next[root] = stored[root]
    if (tool === 'unifi-axi' && value.tls && typeof value.tls === 'object' && !Array.isArray(value.tls)) {
      next.tls = { ...(stored.tls as object), ...value.tls }
    }
  }
  const settings = credentialTlsSettings[tool]
  if (settings.pin && value[settings.pin] && typeof value[settings.pin] === 'object' && !Array.isArray(value[settings.pin])) {
    const pin = value[settings.pin] as Record<string, unknown>
    if (Object.keys(pin).length === 1 && Object.hasOwn(pin, 'sha256')) {
      const previous = stored.origin === value.origin ? stored[settings.pin] : undefined
      next[settings.pin] = { ...(previous && typeof previous === 'object' ? previous : {}), origin: value.origin, ...pin }
    }
  }
  for (const root of tlsCredentialRoots(tool)) if (next[root] === null) delete next[root]
  if (settings.serverName && next[settings.serverName] === null) delete next[settings.serverName]
  if (settings.connectAddress && next.tls && typeof next.tls === 'object' && !Array.isArray(next.tls)) {
    const tls = { ...next.tls } as Record<string, unknown>
    if (tls.connectAddress === null) delete tls.connectAddress
    if (Object.keys(tls).length) next.tls = tls
    else delete next.tls
  }
  return next
}
