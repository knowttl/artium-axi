import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createGiteaAdapter } from './gitea.js'
import { validateFileInput } from '../../shared/file-input.js'

const reference = { id: 'synthetic', tool: 'gitea-axi', revision: 7 } as const
const operation = 'issueEditIssue'
const confirmation = '11111111-1111-4111-8111-111111111111'
const command = ['issue', 'edit', '42', '--repo', 'example/project', '--title', 'Updated title', '--allow-write', operation]
const adapter = (enabled = true, operations = [operation]) => {
  const settings = { writes: { allowWrites: enabled, operations } }
  return createGiteaAdapter({ getSettings: () => settings,
    getCredential: async () => ({ origin: 'https://forge.example', tokenOrigin: 'https://forge.example', token: 'CANARY-gitea-token', ...settings }),
  }, join(tmpdir(), 'synthetic-gitea-writes.log'))
}

test('Gitea native preview and confirmation keep exact host operations and revision binding', async () => {
  const tool = adapter()
  const preview = await tool.prepare([...command, '--preview'], reference)
  expect(preview.effect).toBe('read')
  expect(preview.environment).toMatchObject({ GITEA_AXI_READ_ONLY: 'false', GITEA_AXI_HOST_WRITE_OPERATIONS: operation })
  expect(JSON.parse(preview.environment.GITEA_AXI_CREDENTIAL_REVISION)).toEqual({ reference, settings: { writes: { allowWrites: true, operations: [operation] } } })
  const confirmed = await tool.prepare([...command, '--preview=false', '--confirm', confirmation], reference)
  expect(confirmed.effect).toBe('write')
  expect(confirmed.write?.checkArgs).toEqual(['write', 'reconcile', confirmation])
  expect(JSON.stringify(confirmed.args)).not.toContain('CANARY')
})
test.each([{ enabled: false, operations: [operation] }, { enabled: true, operations: ['issueCreateIssue'] }])('Gitea refuses disabled or missing exact operation policy: %j', async ({ enabled, operations }) => {
  await expect(adapter(enabled, operations).prepare([...command, '--preview'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})
test.each(['--body-file', '--body-file=body.md'])('Gitea stages only referenced uploaded text with %s', async flag => {
  const args = [...command, '--preview', flag, ...(flag.includes('=') ? [] : ['body.md'])]
  const input = { files: [{ name: 'body.md', contentBase64: Buffer.from('Synthetic text').toString('base64') }] }
  const prepared = await adapter().prepare(args, reference, input)
  expect(prepared.fileArguments?.map(index => prepared.args[index])).toEqual(['body.md'])
  expect(() => validateFileInput('gitea-axi', args, input)).not.toThrow()
})
test('Gitea file aliases retain their managed upload contract', async () => {
  const args = ['release', 'edit', 'v1', '--repo', 'example/project', '-Fnotes.md', '--allow-write', 'repoEditRelease', '--preview']
  const input = { files: [{ name: 'notes.md', contentBase64: Buffer.from('Synthetic notes').toString('base64') }] }
  const prepared = await adapter(true, ['repoEditRelease']).prepare(args, reference, input)
  expect(prepared.fileArguments?.map(index => prepared.args[index])).toEqual(['notes.md'])
  expect(() => validateFileInput('gitea-axi', args, input)).not.toThrow()
})
test('Gitea reconciliation remains a read with administrator writes disabled', async () => {
  const prepared = await adapter(false).prepare(['write', 'reconcile', confirmation], reference)
  expect(prepared.effect).toBe('read')
  expect(prepared.environment.GITEA_AXI_READ_ONLY).toBe('true')
})
test('Gitea credential values cannot enable administrator write policy', async () => {
  const tool = createGiteaAdapter({ getCredential: async () => ({ origin: 'https://forge.example', tokenOrigin: 'https://forge.example',
    token: 'CANARY-gitea-token', writes: { allowWrites: true, operations: [operation] } }) })
  await expect(tool.prepare([...command, '--preview'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})
test.each([
  ['issue', 'edit', '42', '--repo', 'example/project', '--allow-write', operation],
  ['issue', 'edit', '42', '--repo', 'example/project', '--allow-write', operation, '--preview', '--confirm', confirmation],
  ['api', 'PUT', 'repos/example/project/actions/secrets/name', '--allow-write', 'updateRepoSecret', '--preview'],
  ['repo', 'create', 'example/project', '--source', '/tmp/repository', '--allow-write', 'createCurrentUserRepo', '--preview'],
].map(args => ({ args })))('Gitea refuses unsafe or incomplete write arguments $args', ({ args }) => {
  expect(() => adapter().validateArgs(args)).toThrow()
})
test('Gitea refuses server paths and unselected stdin before credential preparation', async () => {
  await expect(adapter().prepare([...command, '--preview', '--body-file', '/tmp/other'], reference)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  await expect(adapter().prepare([...command, '--preview'], reference, { stdin: 'unselected' })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})
