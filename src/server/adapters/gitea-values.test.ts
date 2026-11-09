import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createGiteaAdapter } from './gitea.js'
import { createTransferScope, transferTargetDigest } from '../transfer.js'

const reference = { id: 'synthetic', tool: 'gitea-axi', revision: 7 } as const
const secret = 'CANARY-protected-value'
const upload = { files: [{ name: 'value.txt', contentBase64: Buffer.from(secret).toString('base64') }] }
function adapter(operations: string[], enabled = true) {
  const settings = { writes: { allowWrites: enabled, operations } }
  return createGiteaAdapter({ getSettings: () => settings, getCredential: async () => ({ origin: 'https://forge.example',
    tokenOrigin: 'https://forge.example', token: 'CANARY-gitea-token', ...settings }) }, join(tmpdir(), 'synthetic-gitea-writes.log'))
}

test.each([
  { flag: 'value.txt', input: upload },
  { flag: '-', input: { stdin: secret } },
])('Gitea secret inputs stay out of argv and join output scanning with $flag', async ({ flag, input }) => {
  const tool = adapter(['updateRepoSecret'])
  const args = ['secret', 'set', 'SYNTHETIC', '--repo', 'example/project', '--input', flag, '--allow-write', 'updateRepoSecret', '--preview']
  const call = await tool.prepare(args, reference, input)
  expect(call.secrets).toContain(secret)
  expect(call.args.join(' ')).not.toContain(secret)
  expect(tool.sensitiveInput?.(args, input)).toBe(true)
  expect(call.effect).toBe('read')
})
test('Gitea protected JSON also scans the decoded secret value', async () => {
  const args = ['api', 'PUT', 'repos/example/project/actions/secrets/SYNTHETIC', '--input', '-', '--allow-write', 'updateRepoSecret', '--preview']
  const call = await adapter(['updateRepoSecret']).prepare(args, reference, { stdin: JSON.stringify({ data: secret }) })
  expect(call.secrets).toContain(secret)
  expect(call.args.join(' ')).not.toContain(secret)
})
test('Gitea variables retain native empty non-secret values', async () => {
  const call = await adapter(['createRepoVariable']).prepare(['variable', 'set', 'SYNTHETIC', '--repo', 'example/project',
    '--body=', '--allow-write', 'createRepoVariable', '--preview'], reference)
  expect(call.args).toContain('--body=')
  expect(call.environment.GITEA_AXI_HOST_WRITE_OPERATIONS).toBe('createRepoVariable')
})
test.each([
  ['secret', 'set', 'SYNTHETIC', '--repo', 'example/project', '--body', secret, '--allow-write', 'updateRepoSecret', '--preview'],
  ['api', 'PUT', 'repos/example/project/actions/secrets/SYNTHETIC', '--raw-field', 'data=' + secret, '--allow-write', 'updateRepoSecret', '--preview'],
  ['api', 'GET', 'repos/example/project', '--input', '-'],
  ['issue', 'upload', '42', '--repo', 'example/project', '--file', '-', '--allow-write', 'issueCreateIssueAttachment', '--preview'],
].map(args => ({ args })))('Gitea refuses unsafe value/input selection $args', ({ args }) => {
  expect(() => adapter(['updateRepoSecret']).validateArgs(args, { stdin: secret })).toThrow()
})
test.each(['file', 'attach'])('Gitea stages opaque caller bytes selected with --%s', async flag => {
  const bytes = Buffer.from([0, 255, 13, 10])
  const input = { files: [{ name: 'asset.bin', contentBase64: bytes.toString('base64') }] }
  const command = flag === 'file' ? ['issue', 'upload', '42'] : ['issue', 'comment', '42', '--body', 'Synthetic comment']
  const operations = ['issueCreateIssueAttachment', 'issueCreateComment']
  const call = await adapter(operations).prepare([...command, '--repo', 'example/project', '--' + flag, 'asset.bin',
    '--allow-write', operations.join(','), '--preview'], reference, input)
  expect(call.fileArguments?.map(index => call.args[index])).toEqual(['asset.bin'])
  expect(call.secrets).not.toContain(bytes.toString('utf8'))
})
test('Gitea managed downloads require their own exact operation and credential revision', async () => {
  const operation = 'gitea.release.download'
  const scope = createTransferScope({ userId: 'synthetic', sessionFamilyId: 'synthetic-family', reauthenticatedAt: Date.now() }, { id: 'synthetic-credential', revision: 7 },
    { selection: { operation, selector: 'example/project/releases/v1+build/77', type: 'attachment' }, targetDigest: transferTargetDigest('/controlled/new.bin') })
  const args = ['release', 'download', '--repo', 'example/project', '--asset-id', '77', '--output', '/controlled/archive', '--', 'releases/v1+build']
  await expect(adapter([operation], false).prepareArtifact!(args, reference, scope)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  await expect(adapter(['repoCreateReleaseAttachment']).prepareArtifact!(args, reference, scope)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  await expect(adapter([operation]).prepareArtifact!(args, { ...reference, revision: 8 }, scope)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const call = await adapter([operation]).prepareArtifact!(args, reference, scope)
  expect(call.args.slice(1)).toEqual(args)
  expect(call.environment.GITEA_AXI_READ_ONLY).toBe('true')
  await expect(adapter([operation]).prepare(['release', 'download', 'v1', '--repo', 'example/project'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})
