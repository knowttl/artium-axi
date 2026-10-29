import { spawnSync } from 'node:child_process'
import { expect, test, vi } from 'vitest'
import { decode } from '@toon-format/toon'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { credentialFields } from '../admin/credential-form.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { checkpointCredentialSchema, checkpointProfile, checkpointWritePolicy, createCheckpointAdapter } from './checkpoint.js'

const credential = { region: 'ca', clientId: 'synthetic-client', clientSecret: 'CANARY-checkpoint-secret' }
const reference = { id: 'synthetic-credential', tool: 'checkpoint-axi' as const, revision: 1 }
const source = { getCredential: vi.fn(async () => credential) }
const adapter = createCheckpointAdapter(source, '/tmp/synthetic-checkpoint/writes.log')

test('managed credentials require a secret and emit only env references in the private profile', async () => {
  expect(checkpointCredentialSchema.safeParse({ region: 'ca', clientId: 'synthetic-client' }).success).toBe(false)
  expect(checkpointCredentialSchema.safeParse({ ...credential, region: 'https://arbitrary.example' }).success).toBe(false)
  expect(checkpointCredentialSchema.safeParse({ ...credential, saas: 'https://arbitrary.example' }).success).toBe(false)
  const call = await adapter.prepare(['email', 'search'], reference)
  expect(call.environment).toMatchObject({ CHECKPOINT_AXI_READ_ONLY: 'true', ARTIUM_SECRET_0: credential.clientSecret })
  expect(call.args).not.toContain(credential.clientSecret)
  expect(JSON.parse(call.files[0].content as string)).toMatchObject({ profiles: { artium: {
    clientSecret: { env: 'ARTIUM_SECRET_0' }, downloads: { allow: false }, region: 'ca',
  } } })
  expect(checkpointProfile.metadata(credential)).toEqual({ region: 'ca', clientId: 'synthetic-client' })
  expect(credentialFields('checkpoint-axi', checkpointProfile, {}, false)).toContain('data-credential-field="clientSecret" data-secret')
  expect(toolEndpoints('checkpoint-axi', credential).map(url => url.origin)).toEqual(['https://cloudinfra-gw.ca.portal.checkpoint.com'])
})

test.each([
  ['saas', 'SaaS application name'],
  ['scope', 'Download scope'],
])('managed %s field renders its published title and description', (name, title) => {
  const field = checkpointProfile.fields().find(field => field.name === name)!
  const html = credentialFields('checkpoint-axi', checkpointProfile, {}, false)
  const rendered = html.match(new RegExp(`<div data-credential-field="${name}">(.+?)</div>`))![1]!
  expect(rendered).toContain(`<label>${title}<input`)
  expect(rendered).toContain(`<p>${field.schema.description}</p>`)
  expect(rendered).not.toContain('Optional profile value.')
})

test.each([
  ['email', 'download', 'synthetic-email', '--out', '/tmp/output'],
  ['attachment', 'download', 'synthetic-email', 'synthetic-attachment'], ['attachment', 'download-all', 'synthetic-email'],
  ['config', 'path'], ['profile', 'list'], ['email', 'search', '--config=/tmp/config'],
  ['email', 'search', '--profile', 'other'], ['email', 'search', '--origin', 'https://arbitrary.example'],
  ['exception', 'remove', 'malware', 'synthetic'], ['exception', 'remove', 'url', 'synthetic'], ['exception', 'remove', 'dlp', 'synthetic'],
  ['exception', 'clear', 'malware'], ['exception', 'clear', 'url'], ['exception', 'clear', 'dlp'],
].map(args => ({ args })))('blocked $args is refused before credentials', async ({ args }) => {
  source.getCredential.mockClear()
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(source.getCredential).not.toHaveBeenCalled()
})

test('uploaded exception inputs use stable private paths and stdin is refused', async () => {
  const call = await adapter.prepare(['exception', 'create', 'spam-allow', '--input=rule.json'], reference,
    { files: [{ name: 'rule.json', contentBase64: Buffer.from('{"subject":"synthetic"}').toString('base64') }] })
  expect(call.args).toEqual(['exception', 'create', 'spam-allow', '--input', '/proc/self/cwd/checkpoint-axi/uploads/rule.json'])
  expect(call.files[1]).toEqual({ name: 'checkpoint-axi/uploads/rule.json', content: Buffer.from('{"subject":"synthetic"}') })
  await expect(adapter.prepare(['exception', 'create', 'spam-allow', '--input', '/tmp/rule.json'], reference)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  await expect(adapter.prepare(['email', 'search'], reference, { stdin: '{}' })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test('only execution is classified as a write and administrator operations remain exact', async () => {
  expect((await adapter.prepare(['email', 'quarantine', '--ids', 'synthetic'], reference)).effect).toBe('read')
  expect((await adapter.prepare(['email', 'quarantine', '--ids', 'synthetic', '--execute'], reference)).effect).toBe('write')
  expect(checkpointWritePolicy.read({}).enabled).toBe(false)
  const settings = checkpointWritePolicy.update({}, { enabled: true, operations: ['email.quarantine', 'event.action.dismiss'], expectedRevision: 1 })
  expect(checkpointWritePolicy.read(settings)).toMatchObject({ enabled: true, allowedOperations: ['email.quarantine', 'event.action.dismiss'] })
  expect(() => checkpointWritePolicy.update({}, { enabled: true, operations: ['event.action.*'], expectedRevision: 1 })).toThrow()
  expect(() => checkpointWritePolicy.update({}, { enabled: true, operations: ['exception.malware.remove'], expectedRevision: 1 })).toThrow()
  const gated = createCheckpointAdapter({ getCredential: async () => ({ ...credential, ...settings }), getSettings: () => ({}) }, '/tmp/synthetic/writes.log')
  expect((await gated.prepare(['email', 'search'], reference)).environment.CHECKPOINT_AXI_READ_ONLY).toBe('true')
})

test.each([['--help'], ['email', 'search', '--help'], ['exception', 'create', '--help']].map(args => ({ args })))(
  'published help stays within the managed boundary: $args', ({ args }) => {
    const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/checkpoint-axi/bin/checkpoint-axi.js', ...args], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const help = rewriteSuggestions(result.stdout, 'checkpoint-axi')
    expect(help).not.toMatch(/CHECKPOINT_AXI_|config path|profile list|--config|--profile/)
    expect(decode(help)).toHaveProperty('help')
    expect(rewriteSuggestions(help, 'checkpoint-axi')).toBe(help)
  })
