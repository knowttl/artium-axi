import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { CertificateInspectionDialog, type CertificateInspection } from '../src/views/certificate-inspection.js'

type Element = DefaultTreeAdapterMap['element']

const nodes = (node: DefaultTreeAdapterMap['node']): Element[] => [...'tagName' in node ? [node] : [], ...'childNodes' in node ? node.childNodes.flatMap(nodes) : []]
const attribute = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value
const text = (element: Element): string => element.childNodes.map(child => 'value' in child ? child.value : 'tagName' in child ? text(child) : '').join('')

const certificate = (overrides: Partial<CertificateInspection['chain'][number]> = {}): CertificateInspection['chain'][number] => ({ subject: 'CN=synthetic.example', issuer: 'CN=synthetic.example',
  subjectAlternativeNames: 'DNS:synthetic.example', validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', fingerprint: 'AA:11', matchesHostname: true, expired: false,
  notYetValid: false, weakKey: false, keyType: 'rsa', keyBits: 2048, signatureAlgorithm: 'sha256WithRSAEncryption', selfSigned: true, ca: false, ...overrides })

const issuer = certificate({ subject: 'CN=Synthetic CA', issuer: 'CN=Synthetic CA', subjectAlternativeNames: '', fingerprint: 'CC:33', matchesHostname: false, ca: true })
const issuedLeaf = certificate({ issuer: issuer.subject, selfSigned: false })
const connectAddress = '203.0.113.7'
const ipEndpoint = { hostname: connectAddress, endpoint: `https://${connectAddress}/` }
const mismatchReason = 'The saved SHA-256 fingerprint does not match the presented certificate.'
const verifiedReason = 'No trust is needed. The certificate verifies with this server’s existing trust.'
const inspect = (overrides: Partial<CertificateInspection> = {}): CertificateInspection => ({ inspectionId: 'synthetic-inspection', credentialRevision: 1, hostname: 'synthetic.example',
  endpoint: 'https://synthetic.example/', chain: [certificate()], anchor: certificate(), warnings: [], reason: 'The server presents a self-signed certificate.', verificationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  previousFingerprints: [], trustMode: null, rotation: false, pinRequired: false, nameChange: null, ...overrides })

const render = (inspection: CertificateInspection, fills = true, tool = fills ? 'unifi-axi' : 'falcon-axi') => parseFragment(renderToString(createElement(Theme, { theme: neutralTheme, children:
  createElement(CertificateInspectionDialog, { csrf: 'synthetic-csrf', path: `/v1/admin/tools/${tool}/instances/lab`, name: 'lab', trust: { fills, caOption: 'Trust the issuing CA' }, inspection, onClose: () => {} }) })))
const form = (html: ReturnType<typeof render>, suffix: string) => nodes(html).find(element => element.tagName === 'form' && attribute(element, 'action')?.endsWith(suffix))
const field = (element: Element, name: string) => nodes(element).find(item => attribute(item, 'name') === name)!
const trustMode = (html: ReturnType<typeof render>) => {
  const select = field(form(html, '/certificates/trust')!, 'mode')
  return { options: nodes(select).filter(element => element.tagName === 'option').map(option => [attribute(option, 'value'), attribute(option, 'disabled') !== undefined, attribute(option, 'selected') !== undefined]) }
}

test.each([
  { name: 'a self-signed leaf is pinned', overrides: {}, mode: 'pin', ca: 'disabled', pin: 'enabled', replace: 'false', button: 'Trust this certificate' },
  { name: 'an issuing CA is trusted by default', overrides: { chain: [issuedLeaf, issuer], anchor: issuer, verificationError: 'SELF_SIGNED_CERT_IN_CHAIN', reason: 'The certificate was issued by a CA this server does not trust.' }, mode: 'ca', ca: 'enabled', pin: 'enabled', replace: 'false', button: 'Trust this certificate' },
  { name: 'a rotation keeps the saved pin mode', overrides: { chain: [issuedLeaf, issuer], anchor: issuer, trustMode: 'pin', rotation: true, verificationError: 'CERTIFICATE_PIN_MISMATCH', reason: mismatchReason }, mode: 'pin', ca: 'disabled', pin: 'enabled', replace: 'true', button: 'Replace trusted certificate' },
  { name: 'a rotation keeps the saved CA mode', overrides: { chain: [issuedLeaf], anchor: issuer, trustMode: 'ca', rotation: true, verificationError: 'CERTIFICATE_PIN_MISMATCH', reason: mismatchReason }, mode: 'ca', ca: 'enabled', pin: 'disabled', replace: 'true', button: 'Replace trusted certificate' },
  { name: 'a required pin disables saved CA trust as a choice', tool: 'kubernetes-axi', overrides: { ...ipEndpoint, chain: [issuedLeaf], anchor: issuer, trustMode: 'ca', pinRequired: true, verificationError: null, reason: verifiedReason }, mode: 'pin', ca: 'disabled', pin: 'enabled', replace: 'false', button: 'Trust this certificate' },
] as const)('trust form: $name', row => {
  const { overrides, mode, ca, pin, replace, button } = row
  const html = render(inspect(overrides as Partial<CertificateInspection>), true, 'tool' in row ? row.tool : undefined)
  const trust = form(html, '/certificates/trust')!
  expect(trustMode(html).options).toEqual([['ca', ca === 'disabled', mode === 'ca'], ['pin', pin === 'disabled', mode === 'pin']])
  expect([attribute(field(trust, 'replace'), 'value'), attribute(field(trust, 'inspectionId'), 'value'), attribute(field(trust, 'confirmedFingerprint'), 'value'), text(nodes(trust).find(element => element.tagName === 'button')!)])
    .toEqual([replace, 'synthetic-inspection', 'AA:11', button])
})

test('a leaf with no obtainable issuer must be pinned by an explicit choice', () => {
  const html = render(inspect({ chain: [issuedLeaf], anchor: issuedLeaf, verificationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    reason: 'The server sent no intermediate and its issuer could not be verified.' }))
  expect(trustMode(html).options).toEqual([['', true, true], ['ca', true, false], ['pin', false, false]])
  expect(nodes(html).some(element => attribute(element, 'role') === 'alert' && text(element).startsWith('CA trust is unavailable'))).toBe(true)
})

test('a verified endpoint with no saved trust offers none', () => {
  expect(form(render(inspect({ chain: [issuedLeaf, issuer], anchor: issuer, verificationError: null, reason: verifiedReason })), '/certificates/trust')).toBeUndefined()
})

test.each([{ fills: true, note: 'Initial trust fills Certificate verification.' }, { fills: false, note: 'This tool does not support a shared trusted certificate field.' }])(
  'the trust form fills the credential fields only when the tool supports them (fills=$fills)', ({ fills, note }) => {
    const trust = form(render(inspect(), fills), '/certificates/trust')!
    expect(attribute(field(trust, 'fillFields'), 'value')).toBe(String(fills))
    expect(text(trust)).toContain(note)
  })

test('a name change offers one form and a refusal explains itself instead', () => {
  const leaf = certificate({ matchesHostname: false })
  const warnings = ['The hostname does not match the certificate names.', 'Trust does not bypass hostname or validity checks. Renew the certificate or use its matching hostname to fix these failures.']
  const named = form(render(inspect({ ...ipEndpoint, chain: [leaf], anchor: leaf, warnings,
    nameChange: { certificateName: 'synthetic.example', connectAddress, refusalReason: null } }), true, 'technitium-axi'), '/certificates/use-name')!
  expect([attribute(field(named, 'inspectionId'), 'value'), text(nodes(named).find(element => element.tagName === 'button')!)])
    .toEqual(['synthetic-inspection', 'Use synthetic.example as the name and keep connecting to 203.0.113.7'])
  const wildcard = certificate({ subject: 'CN=*.synthetic.example', issuer: 'CN=*.synthetic.example', subjectAlternativeNames: 'DNS:*.synthetic.example', matchesHostname: false })
  const refusalReason = 'The certificate has no concrete DNS name to use. Configure a matching certificate name manually.'
  const refused = render(inspect({ ...ipEndpoint, chain: [wildcard], anchor: wildcard, warnings,
    nameChange: { certificateName: null, connectAddress, refusalReason } }), true, 'technitium-axi')
  expect(form(refused, '/certificates/use-name')).toBeUndefined()
  expect(nodes(refused).some(element => attribute(element, 'role') === 'alert' && text(element) === refusalReason)).toBe(true)
})
