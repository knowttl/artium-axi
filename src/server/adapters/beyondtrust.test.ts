import { spawnSync } from 'node:child_process'
import { expect, test, vi } from 'vitest'
import { decode } from '@toon-format/toon'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { beyondtrustCredentialSchema, beyondtrustWritePolicy, createBeyondtrustAdapter } from './beyondtrust.js'

const credential = { host: 'example.pm.beyondtrustcloud.com', clientId: 'synthetic-client', clientSecret: 'CANARY-beyondtrust-secret' }
const reference = { id: 'synthetic-credential', tool: 'beyondtrust-axi' as const, revision: 1 }
const source = { getCredential: vi.fn(async () => credential) }
const adapter = createBeyondtrustAdapter(source, '/tmp/synthetic-beyondtrust/writes.log')

test('managed profile requires a secret and puts only its environment reference in private config', async () => {
  expect(beyondtrustCredentialSchema.safeParse({ host: credential.host, clientId: credential.clientId }).success).toBe(false)
  const call = await adapter.prepare(['computer', 'list'], reference)
  expect(call.environment).toMatchObject({ BEYONDTRUST_AXI_READ_ONLY: 'true', ARTIUM_SECRET_0: credential.clientSecret })
  expect(call.args).not.toContain(credential.clientSecret)
  expect(JSON.parse(call.files[0].content as string)).toMatchObject({ profiles: { artium: {
    host: credential.host, clientSecret: { env: 'ARTIUM_SECRET_0' }, downloads: { allow: false }, writes: { allowWrites: false, allowDeletes: false, operations: [] },
  } } })
})
test.each(['https://example.pm.beyondtrustcloud.com', 'Example.pm.beyondtrustcloud.com', 'example.beyondtrustcloud.com.evil.test', 'example.pm.beyondtrustcloud.com:443', '127.0.0.1'])('invalid host %s is refused', host => {
  expect(beyondtrustCredentialSchema.safeParse({ ...credential, host }).success).toBe(false)
})
test.each([
  ['policy', 'download', 'synthetic'], ['computer', 'log', 'download', 'synthetic'],
  ['policy', 'revision', 'download', 'synthetic'], ['api-definition', 'download'],
  ['config', 'path'], ['profile', 'list'], ['computer', 'list', '--config=/tmp/config'],
  ['computer', 'list', '--profile', 'other'], ['computer', 'list', '--out', '/tmp/output'],
].map(args => ({ args })))('blocked $args is refused before credential access', async ({ args }) => {
  source.getCredential.mockClear()
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(source.getCredential).not.toHaveBeenCalled()
})
test('uploaded files use a fixed private leaf and stdin and server paths are refused', async () => {
  const input = { files: [{ name: 'apps.json', contentBase64: Buffer.from('[]').toString('base64') }] }
  const call = await adapter.prepare(['policy', 'app', 'add', '--file=apps.json'], reference, input)
  expect(call.args).toEqual(['policy', 'app', 'add', '--file', '/proc/self/cwd/beyondtrust-axi/uploads/input'])
  expect(call.files[1]).toEqual({ name: 'beyondtrust-axi/uploads/input', content: Buffer.from('[]') })
  await expect(adapter.prepare(['policy', 'create', '--file', '/tmp/input'], reference)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  await expect(adapter.prepare(['computer', 'list'], reference, { stdin: '{}' })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})
test.each([
  { flags: ['--default=false'], value: 'false' },
  { flags: ['--default=true'], value: 'true' },
  { flags: ['--default', 'false'], value: 'false' },
  { flags: ['--default', 'true'], value: 'true' },
])('group list preserves the boolean filter $flags', async ({ flags, value }) => {
  const call = await adapter.prepare(['group', 'list', ...flags], reference)
  expect(call.args).toEqual(['group', 'list', '--default', value])
})
test('group create preserves the valueless default switch', async () => {
  const args = ['group', 'create', '--name', 'example', '--default']
  expect((await adapter.prepare(args, reference)).args).toEqual(args)
})
test.each(['true', 'false'])('group create refuses an attached default value %s', async value => {
  await expect(adapter.prepare(['group', 'create', '--name', 'example', `--default=${value}`], reference))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
test('delete toggle can be saved independently while writes and operations remain off', () => {
  expect(beyondtrustWritePolicy.update({}, { enabled: false, allowDeletes: true, operations: [], expectedRevision: 1 }))
    .toEqual({ writes: { allowWrites: false, allowDeletes: true, operations: [] } })
})
test('exact operations and delete permission are independently controlled', () => {
  const settings = beyondtrustWritePolicy.update({}, { enabled: true, allowDeletes: true, operations: ['computer.delete', 'user.preferences'], expectedRevision: 1 })
  expect(settings).toEqual({ writes: { allowWrites: true, allowDeletes: true, operations: ['computer.delete', 'user.preferences'] } })
  expect(() => beyondtrustWritePolicy.update({}, { enabled: true, operations: ['computer.*'], expectedRevision: 1 })).toThrow()
})
test.each([['--help'], ['computer', 'list', '--help'], ['policy', 'app', 'add', '--help']].map(args => ({ args })))('managed published help is stable: $args', ({ args }) => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/beyondtrust-axi/bin/beyondtrust-axi.js', ...args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'beyondtrust-axi')
  expect(help).not.toMatch(/BEYONDTRUST_AXI_|config path|profile list|--config|--profile/)
  expect(decode(help)).toHaveProperty('help')
  expect(rewriteSuggestions(help, 'beyondtrust-axi')).toBe(help)
})

