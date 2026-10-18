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
