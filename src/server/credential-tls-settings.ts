import type { ToolName } from './store/credential-store.js'
import { ArtiumError } from '../shared/errors.js'
import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

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

export function initialCertificateTrust(tool: ToolName, value: Record<string, unknown>, pem: string, fingerprint: string, mode: 'ca' | 'pin') {
  const settings = credentialTlsSettings[tool]
  if (!settings.certificate) throw new ArtiumError('INVALID_INPUT', 'This tool does not support a shared trusted certificate field. Use endpoint trust instead.')
  const savedFingerprint = settings.fingerprint?.split('.').reduce<any>((parent, key) => parent?.[key], value)
  const normalized = fingerprint.replaceAll(':', '').toLowerCase()
  if (savedFingerprint && String(savedFingerprint).replaceAll(':', '').toLowerCase() !== normalized) {
    throw new ArtiumError('INVALID_INPUT', 'The saved fingerprint differs. Replace the certificate and fingerprint manually in Certificate verification.')
  }
  const next = { ...value }
  const write = (path: string, content: string) => {
    const [root, key] = path.split('.') as [string, string?]
    if (key) next[root] = { ...(next[root] as object), [key]: content }
    else next[root] = content
  }
  write(settings.certificate, pem)
  if (settings.fingerprint && !settings.pin) write(settings.fingerprint, normalized)
  if (settings.pin && mode === 'pin' && !savedFingerprint) {
    write(settings.fingerprint!, normalized)
    next[settings.pin] = { ...(next[settings.pin] as object), origin: value.origin, replaceHostname: false }
  }
  return next
}

export function certificateNameChange(tool: ToolName, value: Record<string, unknown>, endpoint: URL, leafPem: string) {
  const settings = credentialTlsSettings[tool]
  const certificate = new X509Certificate(leafPem)
  const host = endpoint.hostname.replace(/^\[|\]$/g, '')
  const identity = settings.serverName ? String(value[settings.serverName] || host) : host
  if (isIP(identity) ? certificate.checkIP(identity) : certificate.checkHost(identity)) return null
  const names = [...(certificate.subjectAltName ?? '').matchAll(/DNS:("(?:[^"\\]|\\.)*"|[^,]+)/g)]
    .map(match => match[1]!.startsWith('"') ? JSON.parse(match[1]!) as string : match[1]!.trim())
  if (!names.length) names.push(...[certificate.toLegacyObject().subject.CN ?? ''].flat())
  const certificateName = names.map(name => domainToASCII(name).toLowerCase())
    .find(name => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) && !isIP(name) && certificate.checkHost(name))
  const read = (path: string) => path.split('.').reduce<unknown>((parent, key) =>
    parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[key] : undefined, value)
  const connectAddress = settings.connectAddress ? String(read(settings.connectAddress) || host) : host
  const refusalReason = !certificateName ? 'The certificate has no concrete DNS name to use. Configure a matching certificate name manually.'
    : !settings.connectAddress && !settings.serverName
      ? tool === 'proxmox-axi' ? 'This tool cannot keep connecting to the IP with separate hostname verification. Its fingerprint replacement option bypasses hostname verification.'
        : tlsFieldDefinitions.connectAddress.unsupported
      : settings.connectAddress && !isIP(connectAddress) ? 'This tool requires an IP connection address and cannot preserve a DNS connection address.'
        : settings.connectAddress && settings.certificate && settings.fingerprint && (!read(settings.certificate) || !read(settings.fingerprint))
          ? 'Save the trusted certificate and SHA-256 fingerprint in Certificate verification first, then inspect again to use this name.' : null
  return { certificateName: certificateName ?? null, connectAddress, refusalReason }
}

export function useCertificateName(tool: ToolName, value: Record<string, unknown>, endpoint: URL, leafPem: string) {
  const change = certificateNameChange(tool, value, endpoint, leafPem)
  if (!change || change.refusalReason || !change.certificateName) throw new ArtiumError('INVALID_INPUT', change?.refusalReason ?? undefined)
  const settings = credentialTlsSettings[tool]
  if (settings.serverName) return { ...value, [settings.serverName]: change.certificateName }
  const origin = new URL(String(value.origin))
  origin.hostname = change.certificateName
  return { ...value, origin: origin.origin, tls: { ...(value.tls as object), connectAddress: change.connectAddress } }
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
    if (Object.keys(pin).length > 0 && Object.keys(pin).every(key => key === 'sha256' || key === 'replaceHostname')) {
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
