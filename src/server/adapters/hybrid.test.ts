import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { credentialFields } from '../admin/credential-form.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { toolFailure } from '../health/diagnostic.js'
import { createHybridAdapter, hybridCredentialSchema, hybridProfile, hybridWritePolicy } from './hybrid.js'

const credential = { apiKey: 'CANARY-hybrid-key' }
const reference = { id: 'synthetic-hybrid', tool: 'hybrid-axi' as const, revision: 1 }
const adapter = createHybridAdapter({ getCredential: async () => credential }, '/tmp/synthetic-hybrid/writes.log')

test('one required secret and the fixed origin form the managed credential', async () => {
  const form = credentialFields('hybrid-axi', hybridProfile, {}, false)
  expect(form).toContain('data-credential-field="apiKey" data-secret')
  expect(form).toContain('https://hybrid-analysis.com')
  const call = await adapter.prepare(['quota'], reference)
  expect(call.secrets).toEqual([credential.apiKey])
  expect(call.environment).toMatchObject({ ARTIUM_SECRET_0: credential.apiKey, HYBRID_AXI_READ_ONLY: 'true' })
  expect(JSON.parse(String(call.files[0].content))).toMatchObject({ profiles: { artium: { apiKey: { env: 'ARTIUM_SECRET_0' } } } })
  expect(hybridProfile.metadata(credential)).toEqual({})
  expect(toolEndpoints('hybrid-axi', credential).map(url => url.origin)).toEqual(['https://hybrid-analysis.com'])
})

test.each([{}, { apiKey: ' ' }, { apiKey: 'CANARY;key' }, { apiKey: 'CANARY key' },
  { ...credential, origin: 'https://appliance.example' }])('invalid credentials are refused: %j', value => {
  expect(hybridCredentialSchema.safeParse(value).success).toBe(false)
})

test.each([
  ['setup'], ['setup', 'hooks'], ['profile', 'list'], ['quota', '--config=/tmp/config'],
  ['quota', '--profile', 'other'], ['quota', '--origin', 'https://appliance.example'],
  ['quota', '--'], ['quota', '--unknown'], ['quota', '--help=true'],
  ['submit', 'file', '--file=/tmp/sample'], ['hunting', 'yara', 'create', '--body-file=/tmp/body'],
].map(args => ({ args })))('managed boundary refuses $args', async ({ args }) => {
  await expect(adapter.prepare(args, reference)).rejects.toBeDefined()
})

test.each([['hash', 'file', 'a'.repeat(64)], ['report', 'file', 'synthetic-job']].map(args => ({ args })))('download refusal names the local alternative: $args', async ({ args }) => {
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED',
    message: 'Hosted downloads are not available yet through artium; use hybrid-axi locally.' })
})

test('uploaded leaves and explicit JSON stdin normalize without server file access', async () => {
  const files = [{ name: 'sample.bin', contentBase64: Buffer.from('inert synthetic sample').toString('base64') }]
  const call = await adapter.prepare(['submit', 'file', '--file=sample.bin', '--environment-id', '160'], reference, { files })
  expect(call.args).toEqual(['submit', 'file', '--file', '/proc/self/cwd/hybrid-axi/uploads/sample.bin', '--environment-id', '160'])
  expect(call.files[1]).toEqual({ name: 'hybrid-axi/uploads/sample.bin', content: Buffer.from('inert synthetic sample') })
  await expect(adapter.prepare(['hunting', 'yara', 'create', '--body-file', '-'], reference, { stdin: '{}' })).resolves.toBeDefined()
  await expect(adapter.prepare(['quota'], reference, { stdin: '{}' })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test.each([
  ['submit', 'file', '--custom-cmd-line=--silent', '--document-password=-password', '--comment=-comment', '--submit-name=-name'],
  ['submit', 'url', '--custom-cmd-line=--silent', '--document-password=-password', '--comment=-comment', '--submit-name=-name'],
  ['quick-scan', 'submit', '--custom-cmd-line=--silent', '--document-password=-password', '--comment=-comment', '--submit-name=-name'],
  ['quick-scan', 'file', '--comment=-comment', '--submit-name=-name'],
  ['quick-scan', 'url', '--comment=-comment', '--submit-name=-name'],
  ['hunting', 'yara', 'list', '--search=-search'],
].map(args => ({ args })))('inline values retain their native representation: $args', async ({ args }) => {
  expect((await adapter.prepare(args, reference)).args).toEqual(args)
})

test('write switch exposes only hosted operations and source policy can force read-only', async () => {
  const settings = hybridWritePolicy.update({}, { enabled: true, operations: ['submitFile', 'yaraCreate', 'huntingMatches'], expectedRevision: 1 })
  expect(hybridWritePolicy.read(settings)).toMatchObject({ enabled: true, allowedOperations: ['submitFile', 'yaraCreate', 'huntingMatches'] })
  expect(hybridWritePolicy.read({}).enabled).toBe(false)
  expect(() => hybridWritePolicy.update({}, { enabled: true, operations: ['report-download-memory'], expectedRevision: 1 })).toThrow()
  const gated = createHybridAdapter({ getCredential: async () => ({ ...credential, ...settings }), getSettings: () => ({}) }, '/tmp/synthetic-hybrid/writes.log')
  expect((await gated.prepare(['hunting', 'matches', '--execute'], reference)).environment.HYBRID_AXI_READ_ONLY).toBe('true')
})

test.each([['--help'], ['quota', '--help'], ['submit', 'file', '--help'], ['hunting', 'matches', '--help']].map(args => ({ args })))('published help is adapted for managed use: $args', ({ args }) => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/hybrid-axi/bin/hybrid-axi.js', ...args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'hybrid-axi')
  expect(help).not.toMatch(/--config|--profile|HYBRID_AXI_|setup hooks|config path/)
  expect(rewriteSuggestions(help, 'hybrid-axi')).toBe(help)
})

test('restricted-key 403 retains upstream denial and vetted-download advice in diagnostics', () => {
  const error = toolFailure('error:\n  code: PERMISSION_DENIED\n  status: 403\n  message: Restricted key cannot download\nhelp[1]: Request vetted download access\n', '', 1, 'hybrid-axi')
  expect(error).toMatchObject({ code: 'UPSTREAM_AUTH_FAILED', diagnostic: { toolCode: 'PERMISSION_DENIED' } })
  expect(error.diagnostic?.message).toContain('Request vetted download access')
})
