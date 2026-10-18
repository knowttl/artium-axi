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

test('preserves Graph provider and tool codes with mapped advice', () => {
  expect(toolFailure('code: AUTH_FAILED\nmessage: AADSTS7000222: Rejected', '', 1)).toMatchObject({
    code: 'UPSTREAM_AUTH_FAILED', diagnostic: { toolCode: 'AUTH_FAILED', providerCode: 'AADSTS7000222',
      hint: expect.stringContaining('secret expired') },
  })
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
