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

const statuses = [
  { tool: 'vectra-axi', data: { secrets: { token: { env: 'SYNTHETIC_TOKEN' }, clientSecret: { file: '/synthetic/client-secret' } } },
    expected: { secrets: { token: 'env', clientSecret: 'file' } } },
  { tool: 'awx-axi', data: { auth: { source: 'SYNTHETIC_TOKEN', valid: true } }, expected: { auth: { source: 'env', valid: true } } },
  { tool: 'awx-axi', data: { auth: { source: '/synthetic/token', valid: false } }, expected: { auth: { source: 'file', valid: false } } },
  { tool: 'az-axi', data: { sources: [{ resource: 'arm', kind: 'env', location: 'SYNTHETIC_TOKEN', available: true },
    { resource: 'graph', kind: 'file', location: '/synthetic/token', available: false }] },
    expected: { sources: [{ resource: 'arm', kind: 'env', available: true }, { resource: 'graph', kind: 'file', available: false }] } },
  { tool: 'mg-axi', data: { sources: [{ field: 'clientSecret', source: 'env:SYNTHETIC_SECRET', available: true },
    { field: 'privateKey', source: 'file:/synthetic/key', available: false }, { field: 'token', source: 'stored:/synthetic/credentials', available: true }] },
    expected: { sources: [{ field: 'clientSecret', source: 'env', available: true }, { field: 'privateKey', source: 'file', available: false },
      { field: 'token', source: 'file', available: true }] } },
  { tool: 'falcon-axi', data: { client_secret_source: 'env:SYNTHETIC_SECRET', credential_path: '/synthetic/credentials', authenticated: true },
    expected: { client_secret_source: 'env', authenticated: true } },
  { tool: 'falcon-axi', data: { client_secret_source: 'file:/synthetic/secret', credential_path: '/synthetic/secret', authenticated: false },
    expected: { client_secret_source: 'file', authenticated: false } },
]

test.each(statuses.flatMap(status => [0, 1].flatMap(exitCode => ['toon', 'json'].map(format => ({ ...status, exitCode, format })))))
  ('$tool $format status hides references with exit $exitCode', ({ tool, data, expected, exitCode, format }) => {
    const stdout = format === 'json' ? JSON.stringify(data) : encode(data)
    const output = hostedStatus(tool, ['auth', 'status'], { ...result, stdout, exitCode })
    expect(format === 'json' ? JSON.parse(output.stdout) : decode(output.stdout)).toEqual(expected)
    expect(output.exitCode).toBe(exitCode)
  })

test.each([
  { tool: 'az-axi', args: ['--full', 'home'] },
  { tool: 'az-axi', args: ['--full', 'false', 'home'] },
  { tool: 'az-axi', args: ['--fields=bin', 'home'] },
  { tool: 'az-axi', args: ['--subscription', 'synthetic', 'auth', 'status'] },
  { tool: 'ldap-axi', args: ['--base', 'synthetic'] },
  { tool: 'ldap-axi', args: ['--base=synthetic'] },
  { tool: 'ado-axi', args: ['--full', 'home'] },
])('$tool recognizes flag-first status $args', ({ tool, args }) => {
  const output = hostedStatus(tool, args, { ...result, stdout: encode({ bin: '/synthetic/bin/tool', configured: true }) })
  expect(decode(output.stdout)).toEqual({ bin: `artium-axi ${tool}`, configured: true })
})

test.each([
  { tool: 'az-axi', args: ['--subscription', 'home', 'resource', 'list'] },
  { tool: 'az-axi', args: ['--full', 'home', '-h'] },
  { tool: 'az-axi', args: ['--full', 'home', '--help=true'] },
  { tool: 'ldap-axi', args: ['--version'] },
])('$tool preserves resource and help output $args', ({ tool, args }) => {
  const original = { ...result, stdout: encode({ bin: '/synthetic/data', source: 'env:synthetic' }) }
  expect(hostedStatus(tool, args, original)).toBe(original)
})

test('failed status hides references repeated in diagnostics on either stream', () => {
  const output = hostedStatus('vectra-axi', ['auth', 'status'], { ...result, exitCode: 1,
    stdout: encode({ secrets: { token: { file: '/synthetic/token' } }, status: 'unavailable', code: 'AUTH_REQUIRED',
      error: 'Cannot read secret file: /synthetic/token', help: ['Check /synthetic/token'] }),
    stderr: 'Cannot read /synthetic/token\n' })
  expect(decode(output.stdout)).toEqual({ secrets: { token: 'file' }, status: 'unavailable', code: 'AUTH_REQUIRED',
    error: 'Cannot read secret file: file', help: ['Check file'] })
  expect(output.stderr).toBe('Cannot read file\n')
  expect(output.exitCode).toBe(1)
})

test('secret reference names do not alter unrelated status values', () => {
  const output = hostedStatus('vectra-axi', ['auth', 'status'], { ...result,
    stdout: encode({ auth: 'token', secrets: { token: { env: 'token' } }, status: 'available' }) })
  expect(decode(output.stdout)).toEqual({ auth: 'token', secrets: { token: 'env' }, status: 'available' })
})

test('truncated status diagnostics cannot expose partial references', () => {
  expect(() => hostedStatus('vectra-axi', ['auth', 'status'], { ...result,
    stdout: encode({ status: 'unavailable' }), stderr: '/synthetic/', truncated: { stdout: false, stderr: true } }))
    .toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
})
