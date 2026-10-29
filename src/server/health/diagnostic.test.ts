import { expect, test } from 'vitest'
import { diagnosticSchema } from '../../shared/api.js'
import { safeDiagnostic, toolFailure, toolFailureCode } from './diagnostic.js'

const secret = 'CANARY-diagnostic-secret'
test.each(['message', 'hint', 'host', 'issuer', 'toolCode', 'providerCode'])(
  'drops the whole diagnostic when %s contains a known secret', field => {
    expect(safeDiagnostic({ stage: 'TLS', message: 'Synthetic failure', [field]: secret }, [secret])).toBeUndefined()
  })

test.each(['message', 'hint', 'issuer'])('scans %s beyond the retained diagnostic length', field => {
  expect(safeDiagnostic({ stage: 'tool run', message: 'Synthetic failure', [field]: 'x'.repeat(5000) + secret }, [secret])).toBeUndefined()
  const safe = safeDiagnostic({ stage: 'tool run', message: 'x'.repeat(5000) }, [secret])!
  expect(safe.stage).toBe('tool run')
  expect(safe.message.length).toBeLessThanOrEqual(4096)
})

test('shares the text budget while preserving destination and trust', () => {
  const bounded = safeDiagnostic({ stage: 'TLS', message: 'm'.repeat(5000), hint: 'h'.repeat(5000),
    issuer: 'i'.repeat(5000), host: 'appliance.test', trust: 'self-signed' }, [])!
  expect(bounded).toMatchObject({ stage: 'TLS', host: 'appliance.test', trust: 'self-signed',
    message: expect.stringMatching(/^m+$/), hint: expect.stringMatching(/^h+$/), issuer: expect.stringMatching(/^i+$/) })
  expect(diagnosticSchema.safeParse(bounded).success).toBe(true)
  expect(Object.values(bounded).join('').length).toBeLessThanOrEqual(4096)
})

test.each([
  ['error:\n  code: PERMISSION_DENIED\n  message: CANARY-message\nhelp[1]: CANARY-help', 'PERMISSION_DENIED'],
  ['code: AUTH_FAILED\nmessage: CANARY-message', 'AUTH_FAILED'],
  ['error_code: "RATE_LIMITED"', 'RATE_LIMITED'],
  ["code: 'ACCESS_DENIED'", 'ACCESS_DENIED'],
  ['message: AADSTS7000215: CANARY-message', 'AADSTS7000215'],
])('extracts only the bounded failure code from %s', (text, code) => {
  expect(toolFailureCode(text, '')).toBe(code)
  expect(toolFailureCode('', text)).toBe(code)
})

test.each([
  'CANARY-message with PERMISSION_DENIED inside',
  'message: PERMISSION_DENIED',
  'help[1]: PERMISSION_DENIED',
  'code: PERMISSION DENIED',
  'code: PERMISSION-DENIED',
  `code: ${'A'.repeat(81)}`,
  'code:',
  '',
])('stores nothing for output without a recognizable code: %s', text => {
  expect(toolFailureCode(text, '')).toBeUndefined()
})

test('preserves emitted provider and tool codes with mapped advice', () => {
  expect(toolFailure('code: AUTH_FAILED\nmessage: AADSTS7000222: Rejected', '', 1)).toMatchObject({
    code: 'UPSTREAM_AUTH_FAILED', diagnostic: { toolCode: 'AUTH_FAILED', providerCode: 'AADSTS7000222',
      hint: expect.stringContaining('secret expired') },
  })
})

test.each(['message', 'issuer'] as const)('retains structured context when %s exceeds the diagnostic budget', field => {
  const detail = { stage: 'TLS' as const, message: 'Certificate verification failed', hint: 'Check the trusted CA',
    issuer: 'CN=synthetic issuer', [field]: 'x'.repeat(5000), host: 'appliance.test',
    toolCode: 'TLS_UNTRUSTED', providerCode: 'AADSTS700027', trust: 'untrusted' as const,
    checkedAt: 123, credentialRevision: 2 }
  const bounded = safeDiagnostic(detail, [])!
  expect(bounded).toMatchObject({ stage: 'TLS', host: 'appliance.test', toolCode: 'TLS_UNTRUSTED',
    providerCode: 'AADSTS700027', trust: 'untrusted', hint: 'Check the trusted CA', checkedAt: 123, credentialRevision: 2 })
  expect(diagnosticSchema.safeParse(bounded).success).toBe(true)
  expect(Object.values(bounded).filter(value => typeof value === 'string').join('').length).toBeLessThanOrEqual(4096)
  expect(safeDiagnostic(Object.fromEntries(Object.entries(detail).reverse()) as typeof detail, [])).toEqual(bounded)
})

test.each([
  ['API_RESPONSE_INVALID', 'Unexpected response', 'UPSTREAM_RESPONSE_INVALID', 'response'],
  ['AUTH_RESPONSE_INVALID', 'Token response does not match the documented schema', 'UPSTREAM_RESPONSE_INVALID', 'response'],
  ['AUTH_RESPONSE_INVALID', 'Unexpected response with dnsHostName sessionTimeout unauthorizedCount', 'UPSTREAM_RESPONSE_INVALID', 'response'],
  ['RESPONSE_INVALID', 'Unexpected response', 'UPSTREAM_RESPONSE_INVALID', 'response'],
  ['MALFORMED_RESPONSE', 'Unexpected response', 'UPSTREAM_RESPONSE_INVALID', 'response'],
  ['INVALID_RESPONSE', 'Unexpected response', 'UPSTREAM_RESPONSE_INVALID', 'response'],
  ['AUTH_ENDPOINT_NOT_FOUND', 'Token endpoint returned 404', 'TOOL_REJECTED_INPUT', 'configuration'],
  ['SERVER_UNREACHABLE', 'could not connect to the directory', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['OPERATION_TIMEOUT', 'the operation deadline elapsed', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['TRANSPORT_FAILED', 'ENETUNREACH', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['TRANSPORT_FAILED', 'EHOSTUNREACH', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['TRANSPORT_FAILED', 'response terminated before completion', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['TRANSPORT_FAILED', 'getaddrinfo ENOTFOUND appliance.test', 'UPSTREAM_NETWORK_FAILED', 'DNS'],
  ['TRANSPORT_FAILED', 'certificate verification failed', 'UPSTREAM_TLS_FAILED', 'TLS'],
  ['AUTH_EXCHANGE_FAILED', 'OAuth credential exchange could not complete', 'UPSTREAM_NETWORK_FAILED', 'token acquisition'],
  ['AUTH_EXCHANGE_FAILED', 'OAuth credential exchange failed', 'TOOL_FAILED', 'token acquisition'],
  ['AUTH_FAILED', 'OAuth client credentials were rejected', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['ACCESS_DENIED', 'API access was denied', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['AUTH_EXPIRED', 'API credential has expired', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['AUTH_REQUIRED', 'The profile secret reference is unset or empty', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['PASSWORD_EXPIRED', 'password expired', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['ACCOUNT_DISABLED', 'account disabled', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['ACCOUNT_EXPIRED', 'account expired', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['ACCOUNT_LOCKED', 'account locked out', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['INSUFFICIENT_ACCESS', 'the bound identity is not permitted to read this', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['STRONGER_AUTH_REQUIRED', 'the server requires a stronger or encrypted bind', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['GSSAPI_CREDENTIAL_UNAVAILABLE', 'no usable ambient credential', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['GSSAPI_NEGOTIATION_FAILED', 'GSSAPI protected LDAP transport failed', 'UPSTREAM_AUTH_FAILED', 'authentication'],
])('classifies native %s output on either stream', (toolCode, message, code, stage) => {
  const text = `code: ${toolCode}\nmessage: ${message}`
  expect(toolFailure(text, '', 1)).toMatchObject({ code, diagnostic: { stage, toolCode, message: text } })
  expect(toolFailure('', text, 1)).toMatchObject({ code, diagnostic: { stage, toolCode, message: text } })
})

test('preserves redacted response diagnostics without changing secret suppression', () => {
  const text = 'code: API_RESPONSE_INVALID\nmessage: Unexpected response: [REDACTED]\nhint: Check the service endpoint.'
  const failure = toolFailure(text, '', 1)
  expect(safeDiagnostic(failure.diagnostic, [secret])).toEqual({ stage: 'response',
    toolCode: 'API_RESPONSE_INVALID', message: text, hint: 'Check the service endpoint.' })
  expect(safeDiagnostic(toolFailure(`${text}\n${secret}`, '', 1).diagnostic, [secret])).toBeUndefined()
})

test.each([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED', 'CERTIFICATE_VERIFY_FAILED', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'INVALID_CA', 'PATH_LENGTH_EXCEEDED', 'HOSTNAME_MISMATCH', 'INVALID_PURPOSE',
  'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'CRL_SIGNATURE_FAILURE', 'UNABLE_TO_GET_CRL',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
])('classifies tool certificate failure %s as TLS', code => {
  expect(toolFailure('', `code: ${code}`, 1)).toMatchObject({
    code: 'UPSTREAM_TLS_FAILED', diagnostic: { stage: 'TLS', toolCode: code },
  })
})

test.each([
  ['Application authentication failed for the configured identity; no user or device-code fallback was attempted', 'token acquisition'],
  ['Graph rejected the credential for users.list (401)', 'authentication'],
])('keeps the Graph failure stage for %s', (message, stage) => {
  const text = `code: AUTH_REQUIRED\nmessage: ${message}`
  expect(toolFailure(text, '', 1, 'mg-axi')).toMatchObject({
    code: 'UPSTREAM_AUTH_FAILED', diagnostic: { stage, toolCode: 'AUTH_REQUIRED', message: text },
  })
})
