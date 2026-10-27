import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { decode } from '@toon-format/toon'
import inventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import { nativeSettingsSchemas } from '../../shared/api.js'
import { createGhAdapter, ghWritePolicy } from './gh.js'
import { prepareRunJournal } from './run-journal.js'
import { redactArguments } from '../audit/redact.js'
import { GithubAppTokenCache } from './github-app-tokens.js'
import { hostedStatus } from './hosted-status.js'
import type { PreparedCall } from './types.js'

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
  ['project item-edit', [], ['--owner=canary', '--id=synthetic-item', '--title=synthetic']],
  ['project item-archive', ['1'], ['--owner=canary', '--id=synthetic-item']],
  ['pr merge', ['1'], ['--method=squash']], ['pr update-branch', ['1'], []], ['pr revert', ['1'], []],
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
  ['issue pin', ['1'], []], ['issue transfer', ['1'], ['--to-repo=canary/destination']],
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
  executeWrite(call, input)
})

function executeWrite(call: PreparedCall, input?: { stdin?: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'artium-gh-write-'))
  try {
    const fake = join(directory, 'gh.mjs')
    copyFileSync('test/fixtures/fake-gh.mjs', fake)
    chmodSync(fake, 0o755)
    const log = join(directory, 'calls.jsonl')
    const child = spawnSync(process.execPath, [call.invocation?.nativeGh ? fake : resolve('tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...call.args], {
      cwd: directory, encoding: 'utf8', input: input?.stdin,
      env: { PATH: process.env.PATH, ...call.environment, GH_BIN: fake, ARTIUM_TEST_GH_WRITES: '1', ARTIUM_TEST_GH_LOG: log },
    })
    expect(child.status, child.stdout + child.stderr).toBe(0)
    expect(child.stdout + child.stderr).not.toContain(credential.token)
    const result = hostedStatus('gh-axi', call.invocation, { stdout: child.stdout, stderr: child.stderr,
      exitCode: child.status!, durationMs: 1, outputBytes: { stdout: Buffer.byteLength(child.stdout), stderr: Buffer.byteLength(child.stderr) },
      timedOut: false, truncated: { stdout: false, stderr: false } })
    return { result, calls: readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

async function confirmed(args: string[]) {
  const operation = args.slice(0, 2).join(' ')
  const adapter = createGhAdapter({ getCredential: async () => credential,
    getSettings: () => ({ writes: { allowWrites: true, operations: [operation] } }) })
  const confirm = (await adapter.prepare(args, reference)).preview!.confirm
  return adapter.prepare([...args, '--confirm', confirm], reference)
}

test('transfer acknowledges completion without returning the destination issue at the old number', async () => {
  const call = await confirmed(['issue', 'transfer', '42', '-R', 'canary/repo', '--to-repo=canary/destination'])
  const { result } = executeWrite(call)
  expect(decode(result.stdout)).toEqual({ status: 'transferred', checkArgs: ['issue', 'list', '--state', 'all', '--limit', '100', '-R', 'canary/destination'] })
})

test('issue comments return the created identity without reading a later participant comment', async () => {
  const call = await confirmed(['issue', 'comment', '1', '-R', 'canary/repo', '--body=created comment'])
  const { result, calls } = executeWrite(call)
  expect(decode(result.stdout)).toEqual({ comment: { url: 'https://github.com/canary/repo/issues/1#issuecomment-123' } })
  expect(calls).toEqual([['issue', 'comment', '1', '--repo=canary/repo', '--body=created comment']])
})

test('workflow dispatch preserves every field and binds every value to confirmation', async () => {
  const args = ['workflow', 'run', '123', '-R', 'canary/repo', '--field=first=a', '--field', 'second=b']
  const call = await confirmed(args)
  const { calls } = executeWrite(call)
  expect(calls).toEqual([['workflow', 'run', '123', '--field', 'first=a', '--field', 'second=b', '--repo', 'canary/repo']])
  const adapter = createGhAdapter({ getCredential: async () => credential,
    getSettings: () => ({ writes: { allowWrites: true, operations: ['workflow run'] } }) })
  const confirm = (await adapter.prepare(args, reference)).preview!.confirm
  await expect(adapter.prepare([...args, '--field=third=c', '--confirm', confirm], reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test.each([
  ['--field=first=@/tmp/secret', '--field=second=b'],
  ['--field=first=a', '--field=second=@/tmp/secret'],
])('workflow dispatch refuses local files in every field: %s %s', async (first, second) => {
  await expect(confirmed(['workflow', 'run', '123', '-R', 'canary/repo', first, second])).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test.each([
  ['pr', 'list', '--draft'], ['search', 'prs', '--draft'],
])('resolves boolean types with leading flags for %s %s', async (group, action, flag) => {
  const adapter = createGhAdapter({ getCredential: async () => credential })
  const scope = group === 'pr' ? ['-R', 'canary/repo'] : ['--owner', 'canary']
  const call = await adapter.prepare([...scope, group, action, flag], reference)
  expect(call.args).toEqual([group, action, group === 'pr' ? '--repo=canary/repo' : '--owner=canary', '--draft'])
  executeWrite(call)
})

test('resolves flag types between command words', async () => {
  const adapter = createGhAdapter({ getCredential: async () => credential })
  const call = await adapter.prepare(['pr', '--draft', 'list', '-R', 'canary/repo'], reference)
  expect(call.args).toEqual(['pr', 'list', '--draft', '--repo=canary/repo'])
  executeWrite(call)
})

test('resolves release boolean values with leading flags', async () => {
  const adapter = createGhAdapter({ getCredential: async () => credential,
    getSettings: () => ({ writes: { allowWrites: true, operations: ['release edit'] } }) })
  const args = ['-R', 'canary/repo', '--draft', 'false', 'release', 'edit', 'v1']
  const confirm = (await adapter.prepare(args, reference)).preview!.confirm
  const call = await adapter.prepare([...args, '--confirm', confirm], reference)
  expect(call.args).toEqual(['release', 'edit', 'v1', '--repo=canary/repo', '--draft=false'])
  executeWrite(call)
})

test('native repository description edits retain the explicit repository target', async () => {
  const { calls } = executeWrite(await confirmed(['repo', 'edit', '-R', 'canary/repo', '--description=']))
  expect(calls).toEqual([['repo', 'edit', 'canary/repo', '--description=']])
})

test.each([
  { body: ['--body='], expected: ['--body=', '--remove-type'] },
  { body: ['--body', ''], expected: ['--body=', '--remove-type'] },
  { body: ['--body=content'], expected: ['--body=content', '--no-type'] },
  { body: [], expected: ['--no-type'] },
])('issue edits preserve type removal with body $body', async ({ body, expected }) => {
  const call = await confirmed(['issue', 'edit', '1', '-R', 'canary/repo', ...body, '--no-type'])
  expect(call.args).toEqual(['issue', 'edit', '1', '--repo=canary/repo', ...expected])
  const { result } = executeWrite(call)
  expect(result.exitCode).toBe(0)
})

test.each(['stdout', 'stderr'] as const)('native device writes identify revoked credentials on %s', stream => {
  expect(() => hostedStatus('gh-axi', { command: 'issue comment', help: false, nativeGh: true, credentialAuth: 'device' }, {
    stdout: '', stderr: '', exitCode: 1, durationMs: 1, outputBytes: { stdout: 0, stderr: 0 },
    timedOut: false, truncated: { stdout: false, stderr: false }, [stream]: 'gh: Bad credentials (HTTP 401)',
  })).toThrow(expect.objectContaining({ code: 'CREDENTIAL_EXPIRED' }))
})

test.each([
  ['label', 'edit', 'priority:high', '-R', 'canary/repo', '--color=abcdef'],
  ['workflow', 'run', 'CI: tests', '-R', 'canary/repo'],
  ['workflow', 'enable', 'CI: tests', '-R', 'canary/repo'],
  ['workflow', 'disable', 'CI: tests', '-R', 'canary/repo'],
  ['release', 'edit', 'v1:canary', '-R', 'canary/repo', '--title=synthetic'],
  ['gist', 'rename', 'abc123', 'old:name.txt', 'new:name.txt'],
])('accepts punctuation in names through %j', async (...args) => {
  const call = await confirmed(args)
  expect(call.args).toContain(args[2])
})

test.each([
  ['issue', 'create', '-R', 'canary/repo', '--title=synthetic'],
  ['issue', 'create', '-R', 'canary/repo', '--title=synthetic', '--body='],
  ['issue', 'edit', '1', '-R', 'canary/repo', '--body='],
  ['pr', 'create', '-R', 'canary/repo', '--title=synthetic', '--body=', '--base=main', '--head=canary'],
  ['pr', 'edit', '1', '-R', 'canary/repo', '--body='],
  ['release', 'create', 'v1', '-R', 'canary/repo', '--notes='],
  ['release', 'edit', 'v1', '-R', 'canary/repo', '--notes='],
  ['gist', 'edit', 'abc123', '--desc='],
  ['project', 'item-create', '1', '--owner=canary', '--title=synthetic', '--body='],
  ['project', 'item-edit', '--owner=canary', '--id=synthetic-item', '--body='],
  ['project', 'item-edit', '--owner=canary', '--id=synthetic-item', '--project-id=synthetic-project', '--field-id=synthetic-field', '--text='],
  ['label', 'edit', 'synthetic', '-R', 'canary/repo', '--description='],
  ['repo', 'edit', '-R', 'canary/repo', '--description='],
])('forwards explicitly empty editable content through %j', async (...args) => {
  const { calls } = executeWrite(await confirmed(args))
  expect(calls.some(call => call.includes('') || call.some(arg => /^(?:--(?:body|notes|desc|description|text)=|description=)$/.test(arg)))).toBe(true)
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

test.each(['synthetic', 'other.example/canary/repo', '//canary/repo', 'https://other.example/canary/repo'])
  ('repository creation refuses noncanonical selectors before preview: %s', async name => {
    const getCredential = vi.fn(async () => credential)
    const adapter = createGhAdapter({ getCredential,
      getSettings: () => ({ writes: { allowWrites: true, operations: ['repo create'] } }) })
    await expect(adapter.prepare(['repo', 'create', name, '--private'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
    await expect(adapter.prepare(['repo', 'create', name, '--private', '--confirm=anything'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
    expect(getCredential).not.toHaveBeenCalled()
  })

test.each([
  ['issue', 'view', '1', '-R', 'other.example/canary/repo'],
  ['issue', 'view', '1', '--repo=synthetic'],
  ['issue', 'transfer', '1', '-R', 'canary/repo', '--to-repo=other.example/canary/destination'],
  ['issue', 'transfer', '1', '-R', 'canary/repo', '--to-repo=destination'],
  ['repo', 'create', 'canary/new', '--private', '--template=other.example/canary/template'],
  ['repo', 'create', 'canary/new', '--private', '--template=template'],
].map(args => [args]))('every repository-name representation refuses host overrides: %j', async args => {
  const getCredential = vi.fn(async () => credential)
  await expect(createGhAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['lock', 'unlock'])('issue %s reports its upstream incompatibility before credential retrieval', async action => {
  const getCredential = vi.fn(async () => credential)
  const adapter = createGhAdapter({ getCredential,
    getSettings: () => ({ writes: { allowWrites: true, operations: [`issue ${action}`] } }) })
  await expect(adapter.prepare(['issue', action, '1', '-R', 'canary/repo'], reference)).rejects.toMatchObject({
    code: 'INVALID_INPUT', message: expect.stringContaining('gh-axi 0.1.44'),
    next: expect.stringContaining('compatible published upstream release'),
  })
  await expect(adapter.prepare(['issue', action, '--help'], reference)).rejects.toMatchObject({
    message: expect.stringContaining('gh 2.101.0 does not export'),
  })
  expect(getCredential).not.toHaveBeenCalled()
  expect(() => ghWritePolicy.update({}, { enabled: true, operations: [`issue ${action}`], expectedRevision: 1 })).toThrow()
})

test.each([
  ['repo', 'edit', '-R', 'canary/repo', '--visibility=private'],
  ['repo', 'edit', '-R', 'canary/repo', '--description=', '--visibility=private'],
  ['pr', 'merge', '1', '-R', 'canary/repo', '--merge'],
  ['pr', 'merge', '1', '-R', 'canary/repo', '--squash'],
  ['pr', 'merge', '1', '-R', 'canary/repo', '--rebase'],
  ['pr', 'merge', '1', '-R', 'canary/repo', '-X', 'squash'],
  ['release', 'create', 'v1', '-R', 'canary/repo', '--body=notes'],
  ['release', 'edit', 'v1', '-R', 'canary/repo', '--body='],
].map(args => [args]))('removed write options stay unavailable: %j', async args => {
  const getCredential = vi.fn(async () => credential)
  const adapter = createGhAdapter({ getCredential,
    getSettings: () => ({ writes: { allowWrites: true, operations: ['repo edit', 'pr merge', 'release create', 'release edit'] } }) })
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['merge', 'squash', 'rebase'])('the primary merge-method flag executes %s', async method => {
  const { result } = executeWrite(await confirmed(['pr', 'merge', '1', '-R', 'canary/repo', `--method=${method}`]))
  expect(result.exitCode).toBe(0)
})

test.each(['issues', 'prs', 'repos', 'commits', 'code'])('audit redacts numeric and textual %s search terms', command => {
  const adapter = createGhAdapter({ getCredential: async () => credential })
  const args = ['search', command, '123456789', 'CANARY-query', '--limit', '1']
  adapter.validateArgs(args)
  expect(redactArguments(args, adapter.sensitiveArguments(args))).toEqual(['search', command, '[redacted]', '[redacted]', '--limit', '[redacted]'])
})

test.each([
  { args: ['--limit', '123', 'search', 'code', '456'], expected: ['--limit', '[redacted]', 'search', 'code', '[redacted]'] },
  { args: ['-R', 'canary/repo', 'issue', 'view', '42'], expected: ['-R', 'canary/repo', 'issue', 'view', '42'] },
  { args: ['issue', '--repo', 'canary/repo', 'view', '42'], expected: ['issue', '--repo', 'canary/repo', 'view', '42'] },
  { args: ['pr', 'view', '42', '-R', 'canary/repo'], expected: ['pr', 'view', '42', '-R', 'canary/repo'] },
  { args: ['discussion', 'view', '42', '-R', 'canary/repo'], expected: ['discussion', 'view', '42', '-R', 'canary/repo'] },
  { args: ['run', 'view', '42', '-R', 'canary/repo'], expected: ['run', 'view', '42', '-R', 'canary/repo'] },
  { args: ['workflow', 'view', '42', '-R', 'canary/repo'], expected: ['workflow', 'view', '42', '-R', 'canary/repo'] },
  { args: ['project', 'view', '42', '--owner=canary'], expected: ['project', 'view', '42', '--owner=[redacted]'] },
  { args: ['release', 'view', '123', '-R', 'canary/repo'], expected: ['release', 'view', '[redacted]', '-R', 'canary/repo'] },
  { args: ['label', 'edit', '123', '-R', 'canary/repo', '--color=abcdef'], expected: ['label', 'edit', '[redacted]', '-R', 'canary/repo', '--color=[redacted]'] },
  { args: ['gist', 'view', '123'], expected: ['gist', 'view', '[redacted]'] },
  { args: ['repo', 'list', '123'], expected: ['repo', 'list', '[redacted]'] },
  { args: ['api', '123'], expected: ['api', '[redacted]'] },
])('audit preserves only actual resource-number positionals in $args', ({ args, expected }) => {
  const adapter = createGhAdapter({ getCredential: async () => credential })
  adapter.validateArgs(args)
  expect(redactArguments(args, adapter.sensitiveArguments(args))).toEqual(expected)
})

test.each([
  { args: ['repo', 'create', 'canary-org/new', '--private'], checkArgs: ['repo', 'list', 'canary-org', '--limit', '100'] },
  { args: ['repo', 'fork', '-R', 'canary-org/source'], checkArgs: ['api', '/repos/canary-org/source/forks?per_page=100'] },
  { args: ['project', 'item-add', '1', '--owner=canary-org', '--url=https://github.com/canary-org/repo/issues/1'],
    checkArgs: ['project', 'item-list', '1', '--owner', 'canary-org', '--limit', '100'] },
  { args: ['project', 'item-create', '1', '--owner=canary-org', '--title=synthetic'],
    checkArgs: ['project', 'item-list', '1', '--owner', 'canary-org', '--limit', '100'] },
  { args: ['project', 'item-edit', '--owner=canary-org', '--id=synthetic-item', '--title=synthetic'],
    checkArgs: ['project', 'list', '--owner', 'canary-org', '--limit', '100'] },
  { args: ['project', 'item-archive', '1', '--owner=canary-org', '--id=synthetic-item'],
    checkArgs: ['project', 'item-list', '1', '--owner', 'canary-org', '--limit', '100'] },
])('write recovery retains the explicit scope for $args', async ({ args, checkArgs }) => {
  const call = await confirmed(args)
  expect(call.write?.checkArgs).toEqual(checkArgs)
  const adapter = createGhAdapter({ getCredential: async () => credential })
  expect((await adapter.prepare(checkArgs, reference)).effect).toBe('read')
})

test.each([
  ['project', 'item-add', '1', '--url=https://github.com/canary/repo/issues/1'],
  ['project', 'item-create', '1', '--title=synthetic'],
  ['project', 'item-edit', '--id=synthetic-item', '--title=synthetic'],
  ['project', 'item-archive', '1', '--id=synthetic-item'],
  ['project', 'item-edit', '--owner=@me', '--id=synthetic-item', '--title=synthetic'],
].map(args => [args]))('project writes require a concrete owner before preview: %j', async args => {
  const getCredential = vi.fn(async () => credential)
  await expect(createGhAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({
    code: 'INVALID_INPUT', next: expect.stringContaining('--owner OWNER'),
  })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each(['--title=synthetic', '--body='])('project item edits bind host-owned recovery context for %s', async edit => {
  const adapter = createGhAdapter({ getCredential: async () => credential,
    getSettings: () => ({ writes: { allowWrites: true, operations: ['project item-edit'] } }) })
  const args = ['project', 'item-edit', '--id=synthetic-item', edit]
  const confirm = (await adapter.prepare([...args, '--owner=canary-org'], reference)).preview!.confirm
  await expect(adapter.prepare([...args, '--owner=other-org', '--confirm', confirm], reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  const call = await adapter.prepare([...args, '--owner=canary-org', '--confirm', confirm], reference)
  const { calls } = executeWrite(call)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('item-edit')
  expect(calls[0].join(' ')).not.toContain('--owner')
})
