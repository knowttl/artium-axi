import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import inventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import { nativeSettingsSchemas } from '../../shared/api.js'
import { createGhAdapter, ghWritePolicy } from './gh.js'
import { prepareRunJournal } from './run-journal.js'
import { redactArguments } from '../audit/redact.js'
import { GithubAppTokenCache } from './github-app-tokens.js'

const reference = { id: 'synthetic-github', tool: 'gh-axi' as const, revision: 1 }
const credential = { origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' }
const samples = [
  ['issue create', [], ['--title=synthetic', '--body=content']],
  ['issue edit', ['1'], ['--title=synthetic']],
  ['issue comment', ['1'], ['--body=content']],
  ['issue close', ['1'], []], ['issue reopen', ['1'], []],
  ['pr create', [], ['--title=synthetic', '--body=content', '--base=main', '--head=synthetic-branch']],
  ['pr edit', ['1'], ['--title=synthetic']], ['pr comment', ['1'], ['--body=content']],
  ['pr ready', ['1'], []], ['pr review', ['1'], ['--approve']],
  ['discussion comment', ['1'], ['--body=content']],
  ['label create', [], ['--name=synthetic', '--color=abcdef']], ['label edit', ['synthetic'], ['--color=abcdef']],
  ['project item-add', ['1'], ['--owner=canary', '--url=https://github.com/canary/repo/issues/1']],
  ['project item-create', ['1'], ['--owner=canary', '--title=synthetic', '--body=content']],
  ['project item-edit', [], ['--id=synthetic-item', '--title=synthetic']],
  ['project item-archive', ['1'], ['--owner=canary', '--id=synthetic-item']],
  ['pr merge', ['1'], ['--squash']], ['pr update-branch', ['1'], []], ['pr revert', ['1'], []],
  ['release create', ['v1'], ['--title=synthetic', '--notes=content']],
  ['release edit', ['v1'], ['--title=synthetic', '--draft=false', '--prerelease=false', '--latest=true']],
  ['workflow run', ['123'], ['--ref=main', '--field=message=synthetic']],
  ['workflow enable', ['123'], []], ['workflow disable', ['123'], []],
  ['run rerun', ['123'], ['--failed']], ['run cancel', ['123'], []],
  ['repo create', ['canary/synthetic'], ['--private']], ['repo edit', [], ['--description=synthetic']],
  ['repo fork', [], []],
  ['gist create', [], ['--filename=synthetic.txt', '--secret']],
  ['gist edit', ['abc123'], ['--filename=synthetic.txt']], ['gist rename', ['abc123', 'old.txt', 'new.txt'], []],
  ['variable set', ['SYNTHETIC'], ['--body=content']],
  ['issue lock', ['1'], []], ['issue pin', ['1'], []], ['issue transfer', ['1'], ['--to-repo=canary/destination']],
] satisfies [string, string[], string[]][]

test.each(samples)('%s requires its exact admin operation and host confirmation', async (operation, rest, flags) => {
  const route = inventory.commands.find(route => route.command === operation)!
  const args = [...operation.split(' '), ...rest, ...flags, ...(route.repository ? ['-R', 'canary/repo'] : [])]
  const input = operation.startsWith('gist ') && operation !== 'gist rename' ? { stdin: 'synthetic content' } : undefined
  const getCredential = vi.fn(async () => credential)
  let settings = {}
  const adapter = createGhAdapter({ getCredential, getSettings: () => settings })
  await expect(adapter.prepare(args, reference, input)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
  settings = { writes: { allowWrites: true, operations: [operation] } }
  const preview = await adapter.prepare(args, reference, input)
  expect(preview).toMatchObject({ effect: 'read', preview: { operation, confirm: expect.stringMatching(/^[a-f0-9]{64}$/) }, secrets: [], environment: {} })
  const call = await adapter.prepare([...args, '--confirm', preview.preview!.confirm], reference, input)
  expect(call.effect).toBe('write')
  expect(call.args).not.toContain('--confirm')
  expect(call.args.join(' ')).not.toContain(credential.token)
  expect(call.environment.GH_TOKEN).toBe(credential.token)
  expect(call.write?.operation).toBe(operation)
  expect((await adapter.prepare(call.write!.checkArgs, reference)).effect).toBe('read')
  expect(await (await prepareRunJournal(call.environment, 'gh-axi', call.effect)).action(true)).toBe('write')
  expect(await (await prepareRunJournal(call.environment, 'gh-axi', call.effect)).action(false)).toBe('unknown')
  const directory = mkdtempSync(join(tmpdir(), 'artium-gh-write-'))
  try {
    const fake = join(directory, 'gh.mjs')
    copyFileSync('test/fixtures/fake-gh.mjs', fake)
    chmodSync(fake, 0o755)
    const child = spawnSync(process.execPath, [resolve('tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...call.args], {
      cwd: directory, encoding: 'utf8', input: input?.stdin,
      env: { PATH: process.env.PATH, ...call.environment, GH_BIN: fake, ARTIUM_TEST_GH_WRITES: '1' },
    })
    expect(child.status, child.stdout + child.stderr).toBe(0)
    expect(child.stdout + child.stderr).not.toContain(credential.token)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('confirmation fails after request, input, credential revision or policy changes', async () => {
  let settings = { writes: { allowWrites: true, operations: ['gist edit'] } }
  const adapter = createGhAdapter({ getCredential: async () => credential, getSettings: () => settings })
  const args = ['gist', 'edit', 'abc123', '--filename=synthetic.txt']
  const input = { stdin: 'original content' }
  const confirm = (await adapter.prepare(args, reference, input)).preview!.confirm
  await expect(adapter.prepare([...args, '--desc=changed', '--confirm', confirm], reference, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(adapter.prepare([...args, '--confirm', confirm], reference, { stdin: 'changed content' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(adapter.prepare([...args, '--confirm', confirm], { ...reference, revision: 2 }, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  settings = { writes: { allowWrites: true, operations: ['gist edit', 'gist rename'] } }
  await expect(adapter.prepare([...args, '--confirm', confirm], reference, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  settings.writes.allowWrites = false
  await expect(adapter.prepare([...args, '--confirm', confirm], reference, input)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test('write bodies preserve multiline and explicit dash-leading text', async () => {
  const adapter = createGhAdapter({ getCredential: async () => credential,
    getSettings: () => ({ writes: { allowWrites: true, operations: ['issue comment'] } }) })
  const args = ['issue', 'comment', '1', '-R', 'canary/repo', '--body=- first line\nsecond line']
  const confirm = (await adapter.prepare(args, reference)).preview!.confirm
  const call = await adapter.prepare([...args, '--confirm', confirm], reference)
  expect(call.args).toContain('--body=- first line\nsecond line')
})

test('GitHub App preview mints no token and confirmed execution keeps both secrets private', async () => {
  const tokens = new GithubAppTokenCache()
  const acquire = vi.spyOn(tokens, 'acquire').mockResolvedValue('ghs_CANARY-installation')
  const adapter = createGhAdapter({ getCredential: async () => ({ origin: 'https://github.com', auth: 'github-app',
    appId: '123', installationId: '456', privateKey: 'CANARY-private-key' }),
    getSettings: () => ({ writes: { allowWrites: true, operations: ['issue comment'] } }) }, tokens)
  const args = ['issue', 'comment', '1', '-R', 'canary/repo', '--body=synthetic']
  const preview = await adapter.prepare(args, reference)
  expect(acquire).not.toHaveBeenCalled()
  const call = await adapter.prepare([...args, '--confirm', preview.preview!.confirm], reference)
  expect(acquire).toHaveBeenCalledOnce()
  expect(call.environment.GH_TOKEN).toBe('ghs_CANARY-installation')
  expect(call.secrets).toEqual(['ghs_CANARY-installation', 'CANARY-private-key'])
  expect(JSON.stringify({ args: call.args, files: call.files })).not.toContain('CANARY')
})

test.each([
  ['issue', 'delete', '1'], ['run', 'delete', '1'], ['release', 'delete', 'v1'], ['label', 'delete', 'name'],
  ['gist', 'delete', 'abc123'], ['project', 'item-delete', '1'], ['secret', 'delete', 'NAME'], ['variable', 'delete', 'NAME'],
  ['secret', 'set', 'NAME'], ['pr', 'merge', '1', '--admin'], ['pr', 'merge', '1', '--delete-branch'],
  ['repo', 'create', 'synthetic', '--source=/tmp/source'], ['repo', 'fork', '--clone'],
  ['release', 'create', 'v1', '/tmp/asset'], ['gist', 'create', '/tmp/asset', '--secret'],
  ['gist', 'edit', 'abc123', '--add=/tmp/asset'], ['workflow', 'run', '123', '--field=x=@/tmp/secret'],
  ['api', 'PATCH', '/user'], ['api', '/user', '--field=x=y'],
].map(args => [args]))('permanent refusal cannot be enabled: %j', async args => {
  const getCredential = vi.fn(async () => credential)
  const adapter = createGhAdapter({ getCredential, getSettings: () => ({ writes: {
    allowWrites: true, operations: inventory.commands.map(route => route.command),
  } }) })
  await expect(adapter.prepare([...args, '-R', 'canary/repo', '--confirm=anything'], reference)).rejects.toThrow()
  expect(getCredential).not.toHaveBeenCalled()
})

test('admin write policy accepts exact operations and refuses unknown operations', () => {
  const settings = ghWritePolicy.update({}, { enabled: true, operations: ['issue comment', 'workflow run'], expectedRevision: 1 })
  expect(nativeSettingsSchemas['gh-axi'].parse(settings)).toEqual(settings)
  expect(ghWritePolicy.read(settings)).toMatchObject({ enabled: true, allowedOperations: ['issue comment', 'workflow run'] })
  expect(ghWritePolicy.read(ghWritePolicy.update(settings, { enabled: false, expectedRevision: 2 })))
    .toMatchObject({ enabled: false, allowedOperations: ['issue comment', 'workflow run'] })
  expect(() => ghWritePolicy.update({}, { enabled: true, operations: ['*'], expectedRevision: 1 })).toThrow()
  expect(nativeSettingsSchemas['gh-axi'].safeParse({ writes: { allowWrites: true, operations: ['secret set'] } }).success).toBe(false)
})

test('audit preserves operation, repository and number while hiding write text and confirmation', () => {
  const adapter = createGhAdapter({ getCredential: async () => credential })
  const args = ['issue', 'comment', '42', '-R', 'canary/repo', '--body', 'CANARY-private-body', '--confirm=CANARY-confirm']
  expect(redactArguments(args, adapter.sensitiveArguments(args))).toEqual([
    'issue', 'comment', '42', '-R', 'canary/repo', '--body', '[redacted]', '--confirm=[redacted]',
  ])
})
