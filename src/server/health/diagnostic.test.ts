import { expect, test } from 'vitest'
import { safeDiagnostic, toolFailure } from './diagnostic.js'

const secret = 'CANARY-diagnostic-secret'
test.each(['message', 'hint', 'host', 'issuer', 'toolCode'])(
  'drops the whole diagnostic when %s contains a known secret', field => {
    expect(safeDiagnostic({ stage: 'TLS', message: 'Synthetic failure', [field]: secret }, [secret])).toBeUndefined()
  })

test('scans beyond the retained diagnostic length', () => {
  expect(safeDiagnostic({ stage: 'tool run', message: 'x'.repeat(5000) + secret }, [secret])).toBeUndefined()
  const safe = safeDiagnostic({ stage: 'tool run', message: 'x'.repeat(5000) }, [secret])!
  expect(safe.stage).toBe('tool run')
  expect(safe.message.length).toBeLessThanOrEqual(4096)
})

test('preserves emitted provider and tool codes with mapped advice', () => {
  expect(toolFailure('code: AUTH_FAILED\nmessage: AADSTS7000222: Rejected', '', 1)).toMatchObject({
    code: 'UPSTREAM_AUTH_FAILED', diagnostic: { toolCode: 'AUTH_FAILED', providerCode: 'AADSTS7000222',
      hint: expect.stringContaining('secret expired') },
  })
})

test.each([
  ['SERVER_UNREACHABLE', 'could not connect to the directory', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['OPERATION_TIMEOUT', 'the operation deadline elapsed', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
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
