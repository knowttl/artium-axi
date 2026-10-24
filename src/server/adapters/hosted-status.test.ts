import { decode, encode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { hostedStatus } from './hosted-status.js'
import { createAzAdapter } from './az.js'
import { createAdoAdapter } from './ado.js'
import { createLdapAdapter } from './ldap.js'
import { AzureTokenCache } from './azure-token-cache.js'
import { FakeTokenTransport, azureTestTenant } from '../../../test/fixtures/azure-token-transport.js'

const result = { stdout: '', stderr: '', exitCode: 0, durationMs: 1, outputBytes: { stdout: 100, stderr: 0 },
  timedOut: false, truncated: { stdout: false, stderr: false } }

test.each(['hybrid-axi', 'tenable-axi'])('%s status exposes only secret source kinds', tool => {
  const output = hostedStatus(tool, { command: 'auth status', help: false }, { ...result, stdout: encode({ config: '/synthetic/config.json',
    apiKey: { file: '/synthetic/api-key' }, accessKey: { env: 'SYNTHETIC_ACCESS_KEY' }, secretKey: { file: '/synthetic/secret-key' }, readOnly: true }) })
  expect(decode(output.stdout)).toEqual({ apiKey: 'file', accessKey: 'env', secretKey: 'file', readOnly: true })
})

test('LDAP status retains the bind password source kind', () => {
  const output = hostedStatus('ldap-axi', { command: 'auth status', help: false }, { ...result,
    stdout: encode({ config: '/synthetic/ldap.json', bind_password_source: 'env:SYNTHETIC_BIND_PASSWORD', configured: true }) })
  expect(decode(output.stdout)).toEqual({ bind_password_source: 'env', configured: true })
})

test('Vectra status replaces local setup instructions and secret reference examples', () => {
  const output = hostedStatus('vectra-axi', { command: 'home', help: false }, { ...result, stdout: encode({ state: 'configured',
    setup: { config: '/synthetic/vectra.json', example: { token: { env: 'SYNTHETIC_TOKEN' } } } }) })
  expect(decode(output.stdout)).toEqual({ state: 'configured', setup: 'Managed by artium.' })
})

test('hosted home replaces the server executable', () => {
  const output = hostedStatus('hybrid-axi', { command: 'home', help: false }, { ...result, stdout: encode({ bin: '/synthetic/bin/hybrid-axi', profile: 'artium' }) })
  expect(decode(output.stdout)).toEqual({ bin: 'artium-axi hybrid-axi', profile: 'artium' })
})

test('resource data remains unchanged', () => {
  const original = { ...result, stdout: encode({ bin: '/synthetic/data', config: '/synthetic/data' }) }
  expect(hostedStatus('hybrid-axi', { command: 'hash show', help: false }, original)).toBe(original)
})

test('truncated status cannot expose partial paths or source names', () => {
  expect(() => hostedStatus('hybrid-axi', { command: 'home', help: false }, { ...result, stdout: 'bin: /synthetic/', truncated: { stdout: true, stderr: false } }))
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

test.each(statuses.flatMap(status => [0, 1].map(exitCode => ({ ...status, exitCode }))))
  ('$tool TOON status hides references with exit $exitCode', ({ tool, data, expected, exitCode }) => {
    const output = hostedStatus(tool, { command: 'auth status', help: false }, { ...result, stdout: encode(data), exitCode })
    expect(decode(output.stdout)).toEqual(expected)
    expect(output.exitCode).toBe(exitCode)
  })

const identityAdapters = {
  'az-axi': () => createAzAdapter({ getCredential: async () => ({ auth: 'secret', tenantId: azureTestTenant,
    clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret' }) },
  '/synthetic/writes.log', new AzureTokenCache(new FakeTokenTransport())),
  'ado-axi': () => createAdoAdapter({ getCredential: async () => ({ org: 'synthetic-org', auth: 'pat', token: 'CANARY-ado-pat' }) }),
  'ldap-axi': () => createLdapAdapter({ getCredential: async () => ({ url: 'ldaps://directory.test:636', auth: 'simple',
    bindDn: 'uid=reader', bindPassword: 'CANARY-ldap-password' }) }),
}

test.each([
  { tool: 'az-axi', args: ['--full', 'home'] },
  { tool: 'az-axi', args: ['--full', 'false', 'home'] },
  { tool: 'az-axi', args: ['--fields=bin', 'home'] },
  { tool: 'az-axi', args: ['--subscription', 'synthetic', 'auth', 'status'] },
  { tool: 'az-axi', args: ['-s=synthetic', 'auth', 'status'] },
  { tool: 'az-axi', args: ['-s=synthetic', 'home'] },
  { tool: 'az-axi', args: ['auth', 'status', '--help', 'false'] },
  { tool: 'az-axi', args: ['home', '--help', 'false'] },
  { tool: 'az-axi', args: ['home', '--help=false'] },
  { tool: 'ldap-axi', args: ['--base', 'synthetic'] },
  { tool: 'ldap-axi', args: ['--base=synthetic'] },
  { tool: 'ado-axi', args: ['--full', 'home'] },
  { tool: 'ado-axi', args: ['home', '--help', 'false'] },
] as const)('$tool sanitizes prepared status $args', async ({ tool, args }) => {
  const call = await identityAdapters[tool]().prepare(args, { id: 'synthetic', tool, revision: 1 })
  const output = hostedStatus(tool, call.invocation, { ...result, stdout: encode({ bin: '/synthetic/bin/tool', configured: true,
    sources: [{ resource: 'arm', kind: 'env', location: 'SYNTHETIC_TOKEN', available: true }] }) })
  expect(decode(output.stdout)).toEqual({ bin: `artium-axi ${tool}`, configured: true,
    sources: [{ resource: 'arm', kind: 'env', available: true }] })
})

test.each([
  { tool: 'az-axi', args: ['--subscription', 'home', 'resource', 'list'] },
  { tool: 'az-axi', args: ['--full', 'home', '-h'] },
  { tool: 'az-axi', args: ['--full', 'home', '--help=true'] },
  { tool: 'az-axi', args: ['home', '--help', 'true'] },
  { tool: 'az-axi', args: ['--version'] },
  { tool: 'ado-axi', args: ['home', '--help', 'true'] },
] as const)('$tool preserves prepared resource and help output $args', async ({ tool, args }) => {
  const original = { ...result, stdout: encode({ bin: '/synthetic/data', source: 'env:synthetic' }) }
  const call = await identityAdapters[tool]().prepare(args, { id: 'synthetic', tool, revision: 1 })
  expect(hostedStatus(tool, call.invocation, original)).toBe(original)
})

test('failed status hides references repeated in diagnostics on either stream', () => {
  const output = hostedStatus('vectra-axi', { command: 'auth status', help: false }, { ...result, exitCode: 1,
    stdout: encode({ secrets: { token: { file: '/synthetic/token' } }, status: 'unavailable', code: 'AUTH_REQUIRED',
      error: 'Cannot read secret file: /synthetic/token', help: ['Check /synthetic/token'] }),
    stderr: 'Cannot read /synthetic/token\n' })
  expect(decode(output.stdout)).toEqual({ secrets: { token: 'file' }, status: 'unavailable', code: 'AUTH_REQUIRED',
    error: 'Cannot read secret file: file', help: ['Check file'] })
  expect(output.stderr).toBe('Cannot read file\n')
  expect(output.exitCode).toBe(1)
})

test('secret reference names do not alter unrelated status values', () => {
  const output = hostedStatus('vectra-axi', { command: 'auth status', help: false }, { ...result,
    stdout: encode({ auth: 'token', secrets: { token: { env: 'token' } }, status: 'available' }) })
  expect(decode(output.stdout)).toEqual({ auth: 'token', secrets: { token: 'env' }, status: 'available' })
})

test('truncated status diagnostics cannot expose partial references', () => {
  expect(() => hostedStatus('vectra-axi', { command: 'auth status', help: false }, { ...result,
    stdout: encode({ status: 'unavailable' }), stderr: '/synthetic/', truncated: { stdout: false, stderr: true } }))
    .toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
})
