import { decode, encode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { hostedStatus } from './hosted-status.js'

const result = { stdout: '', stderr: '', exitCode: 0, durationMs: 1, outputBytes: { stdout: 100, stderr: 0 },
  timedOut: false, truncated: { stdout: false, stderr: false } }

test.each(['hybrid-axi', 'tenable-axi'])('%s status exposes only secret source kinds', tool => {
  const output = hostedStatus(tool, ['auth', 'status'], { ...result, stdout: encode({ config: '/synthetic/config.json',
    apiKey: { file: '/synthetic/api-key' }, accessKey: { env: 'SYNTHETIC_ACCESS_KEY' }, secretKey: { file: '/synthetic/secret-key' }, readOnly: true }) })
  expect(decode(output.stdout)).toEqual({ apiKey: 'file', accessKey: 'env', secretKey: 'file', readOnly: true })
})

test('LDAP status retains the bind password source kind', () => {
  const output = hostedStatus('ldap-axi', ['auth', 'status', '--offline'], { ...result,
    stdout: encode({ config: '/synthetic/ldap.json', bind_password_source: 'env:SYNTHETIC_BIND_PASSWORD', configured: true }) })
  expect(decode(output.stdout)).toEqual({ bind_password_source: 'env', configured: true })
})

test('Vectra status replaces local setup instructions and secret reference examples', () => {
  const output = hostedStatus('vectra-axi', [], { ...result, stdout: encode({ state: 'configured',
    setup: { config: '/synthetic/vectra.json', example: { token: { env: 'SYNTHETIC_TOKEN' } } } }) })
  expect(decode(output.stdout)).toEqual({ state: 'configured', setup: 'Managed by artium.' })
})

test.each([[], ['home'], ['home', '--full']].map(args => ({ args })))('hosted home replaces the server executable for $args', ({ args }) => {
  const output = hostedStatus('hybrid-axi', args, { ...result, stdout: encode({ bin: '/synthetic/bin/hybrid-axi', profile: 'artium' }) })
  expect(decode(output.stdout)).toEqual({ bin: 'artium-axi hybrid-axi', profile: 'artium' })
})

test('hosted status preserves selected JSON fields', () => {
  const output = hostedStatus('tenable-axi', ['auth', 'status', '--fields', 'secretKey'], { ...result,
    stdout: JSON.stringify({ secretKey: { env: 'SYNTHETIC_SECRET_KEY' } }) })
  expect(JSON.parse(output.stdout)).toEqual({ secretKey: 'env' })
})

test('resource data remains unchanged', () => {
  const original = { ...result, stdout: encode({ bin: '/synthetic/data', config: '/synthetic/data' }) }
  expect(hostedStatus('hybrid-axi', ['hash', 'show', 'synthetic'], original)).toBe(original)
})

test('truncated status cannot expose partial paths or source names', () => {
  expect(() => hostedStatus('hybrid-axi', [], { ...result, stdout: 'bin: /synthetic/', truncated: { stdout: true, stderr: false } }))
    .toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
})
