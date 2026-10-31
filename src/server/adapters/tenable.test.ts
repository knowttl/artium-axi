import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { credentialFields } from '../admin/credential-form.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { createTenableAdapter, tenableCredentialSchema, tenableProfile, tenableWritePolicy } from './tenable.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { toolFailure } from '../health/diagnostic.js'

const credential = { accessKey: 'CANARY-tenable-access', secretKey: 'CANARY-tenable-secret' }
const reference = { id: 'synthetic-tenable', tool: 'tenable-axi' as const, revision: 1 }
const directory = mkdtempSync(join(process.cwd(), '.tmp-tenable-'))
const writeLog = join(directory, 'writes.log')
const adapter = createTenableAdapter({ getCredential: async () => credential }, writeLog)
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('dash-prefixed query values remain values during preparation', async () => {
  const args = ['card', 'list', '--query', '-x', '--full']
  expect(() => adapter.validateArgs(args)).not.toThrow()
  const call = await adapter.prepare(args, reference)
  expect(call.args).toEqual(args)
  expect(call.invocation).toEqual({ command: 'card list', help: false })
})

test('the credential form marks both keys secret and offers only the fixed origin', () => {
  const form = credentialFields('tenable-axi', tenableProfile, {}, false)
  expect(form).toContain('data-credential-field="accessKey" data-secret')
  expect(form).toContain('data-credential-field="secretKey" data-secret')
  expect(form).toContain('https://cloud.tenable.com')
  expect(form).not.toContain('CANARY-')
})

test.each([['--help'], ['card', 'list', '--help'], ['finding', 'summary', '--help'], ['export', 'asset', 'start', '--help']].map(args => ({ args })))('published help stays within managed commands: $args', ({ args }) => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/tenable-axi/bin/tenable-axi.js', ...args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'tenable-axi')
  expect(help).not.toMatch(/--config|--profile|setup hooks|config path|export attack download|TENABLE_AXI_/)
  expect(rewriteSuggestions(help, 'tenable-axi')).toBe(help)
})

test('both keys are secret references and writes default off with a fixed endpoint', async () => {
  const call = await adapter.prepare(['card', 'list'], reference)
  expect(call.environment).toMatchObject({ TENABLE_AXI_READ_ONLY: 'true', TENABLE_AXI_WRITE_LOG: writeLog,
    ARTIUM_SECRET_0: credential.accessKey, ARTIUM_SECRET_1: credential.secretKey })
  expect(JSON.parse(readFileSync(call.environment.TENABLE_AXI_CONFIG, 'utf8'))).toMatchObject({ profiles: { artium: {
    accessKey: { env: 'ARTIUM_SECRET_0' }, secretKey: { env: 'ARTIUM_SECRET_1' },
  } } })
  expect(call.secrets).toEqual([credential.accessKey, credential.secretKey])
  expect((await adapter.prepare(['card', 'list'], reference)).environment.TENABLE_AXI_CONFIG).toBe(call.environment.TENABLE_AXI_CONFIG)
  expect(tenableProfile.metadata(credential)).toEqual({})
  expect(toolEndpoints('tenable-axi', credential).map(url => url.origin)).toEqual(['https://cloud.tenable.com'])
})

test('finding summary is reachable as a managed read', async () => {
  const call = await adapter.prepare(['finding', 'summary'], reference)
  expect(call.args).toEqual(['finding', 'summary'])
  expect(call.invocation).toEqual({ command: 'finding summary', help: false })
  expect(call.effect).toBe('read')
})

test.each([
  {}, { accessKey: credential.accessKey }, { ...credential, origin: 'https://appliance.example' },
  { ...credential, accessKey: 'CANARY;key' }, { ...credential, secretKey: 'CANARY key' },
])('invalid or incomplete credentials are refused: %j', value => {
  expect(tenableCredentialSchema.safeParse(value).success).toBe(false)
})

test.each([
  ['setup', 'hooks'], ['config', 'path'], ['profile', 'list'], ['hook'],
  ['export', 'attack', 'download', '--id', 'synthetic', '--output', '/tmp/output'],
  ['card', 'list', '--config=/tmp/config'], ['card', 'list', '--profile', 'other'],
  ['asset', 'list', '--filter-file', '/tmp/filter'], ['tag', 'value', 'create', '--body-file=/tmp/body'],
].map(args => ({ args })))('managed boundary refuses $args before credential resolution', async ({ args }) => {
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: expect.stringMatching(/FLAG_BLOCKED|UNSUPPORTED_INPUT/) })
})

test('file inputs normalize uploaded leaves and explicit stdin only', async () => {
  const file = { name: 'body.json', contentBase64: Buffer.from('{}').toString('base64') }
  const call = await adapter.prepare(['tag', 'value', 'create', '--body-file=body.json'], reference, { files: [file] })
  expect(call.args).toEqual(['tag', 'value', 'create', '--body-file', 'body.json'])
  expect(call.fileArguments).toEqual([4])
  const stdin = await adapter.prepare(['tag', 'value', 'create', '--body-file', '-'], reference, { stdin: '{}' })
  expect(stdin.args).toEqual(['tag', 'value', 'create', '--body-file', '-'])
  expect(stdin.fileArguments).toEqual([])
  expect(stdin.files).toEqual([])
  await expect(adapter.prepare(['card', 'list'], reference, { stdin: '{}' })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test('the write switch preserves the allow-list and disabled source policy wins', async () => {
  const settings = tenableWritePolicy.update({}, { enabled: true, operations: ['inventory-export-assets'], expectedRevision: 1 })
  expect(tenableWritePolicy.read(settings)).toMatchObject({ capable: true, enabled: true, allowedOperations: ['inventory-export-assets'] })
  const source = { getCredential: async () => ({ ...credential, ...settings }), getSettings: () => ({}) }
  const gated = createTenableAdapter(source, writeLog)
  expect((await gated.prepare(['export', 'asset', 'start'], reference)).environment.TENABLE_AXI_READ_ONLY).toBe('true')
  expect(() => tenableWritePolicy.update({}, { enabled: true, operations: ['unsupported'], expectedRevision: 1 })).toThrow()
  expect(() => tenableWritePolicy.update({}, { enabled: true, operations: [], expectedRevision: 1 })).toThrow()
})

test.each([
  ['AUTH_REQUIRED', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['PERMISSION_DENIED', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['VALIDATION_ERROR', 'TOOL_REJECTED_INPUT', 'configuration'],
])('native %s failures map to managed diagnostics', (native, code, stage) => {
  expect(toolFailure(`error:\n  code: ${native}\n  message: Synthetic failure\n`, '', native === 'VALIDATION_ERROR' ? 2 : 1, 'tenable-axi'))
    .toMatchObject({ code, diagnostic: { stage, toolCode: native } })
})
