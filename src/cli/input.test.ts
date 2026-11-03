import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import tenable from '../../tools/inventories/tenable-axi.json' with { type: 'json' }
import { inputLimits } from '../shared/api.js'
import { toolInput } from './input.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-input-'))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test('Technitium uploads typed inputs and local configuration bytes without forwarding local paths', async () => {
  const config = join(directory, 'technitium.config')
  const path = join(directory, 'technitium.json')
  const bytes = Buffer.from(' { "opaque": "CANARY-private" }\r\n')
  writeFileSync(config, bytes, { mode: 0o600 })
  writeFileSync(path, JSON.stringify({ parameters: { name: 'synthetic-app', config: { file: config } } }), { mode: 0o600 })
  const request = await toolInput('technitium-axi', ['app', 'config', 'set', '--input-file=' + path])
  expect(request.args).toEqual(['app', 'config', 'set', '--input-file', 'input.json'])
  expect(JSON.parse(Buffer.from(request.files![0].contentBase64, 'base64').toString('utf8'))).toEqual({
    parameters: { name: 'synthetic-app', config: { file: 'config.bin' } }, secrets: {},
  })
  expect(Buffer.from(request.files![1].contentBase64, 'base64')).toEqual(bytes)
})

test('Technitium local operation SecretRefs become explicit private input values', async () => {
  const secret = join(directory, 'technitium-secret')
  const path = join(directory, 'technitium-secret.json')
  writeFileSync(secret, 'CANARY-exact-secret\n', { mode: 0o600 })
  writeFileSync(path, JSON.stringify({ parameters: { user: 'synthetic-user', pass: { file: secret } } }), { mode: 0o600 })
  const request = await toolInput('technitium-axi', ['admin', 'user', 'create', '--input-file', path])
  expect(JSON.parse(Buffer.from(request.files![0].contentBase64, 'base64').toString('utf8'))).toEqual({
    parameters: { user: 'synthetic-user', pass: { env: 'TECHNITIUM_INPUT_FILE_0' } },
    secrets: { TECHNITIUM_INPUT_FILE_0: 'CANARY-exact-secret\n' },
  })
  expect(request.args).toEqual(['admin', 'user', 'create', '--input-file', 'input.json'])
})

test.each(['user', 'pass', 'totp'])('Technitium refuses create-token acquisition field %s before resolving its SecretRef', async field => {
  const path = join(directory, `technitium-acquisition-${field}.json`)
  writeFileSync(path, JSON.stringify({ parameters: { tokenName: 'synthetic-token', [field]: { file: '/unavailable/private-file' } } }), { mode: 0o600 })
  await expect(toolInput('technitium-axi', ['user', 'create-token', '--input-file', path])).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test('Gitea uploads opaque attachment bytes with a managed leaf', async () => {
  const path = join(directory, 'asset.bin')
  const bytes = Buffer.from([0, 255, 13, 10])
  writeFileSync(path, bytes)
  expect(await toolInput('gitea-axi', ['issue', 'upload', '42', '--file=' + path])).toEqual({ args: ['issue', 'upload', '42', '--file=asset.bin'],
    files: [{ name: 'asset.bin', size: bytes.length, contentBase64: bytes.toString('base64') }] })
})
test('Gitea secret stdin remains a separate payload', async () => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['CANARY-protected-value']) as typeof process.stdin)
  const args = ['secret', 'set', 'SYNTHETIC', '--input', '-']
  expect(await toolInput('gitea-axi', args)).toEqual({ args, stdin: 'CANARY-protected-value' })
})
test('Gitea binary upload flags refuse unsupported stdin', async () => {
  await expect(toolInput('gitea-axi', ['issue', 'upload', '42', '--file', '-'])).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test.each(['--notes-file', '-F'])('Gitea uploads a release file selected by %s', async flag => {
  const path = join(directory, 'notes.md')
  writeFileSync(path, 'Synthetic release notes')
  expect(await toolInput('gitea-axi', ['release', 'edit', 'v1', flag, path])).toEqual({
    args: ['release', 'edit', 'v1', '--notes-file', 'notes.md'],
    files: [{ name: 'notes.md', size: 23, contentBase64: Buffer.from('Synthetic release notes').toString('base64') }],
  })
})
test('Gitea uploads inline short file selectors', async () => {
  const path = join(directory, 'inline.md')
  writeFileSync(path, 'Synthetic notes')
  expect(await toolInput('gitea-axi', ['release', 'edit', 'v1', '-F' + path])).toEqual({
    args: ['release', 'edit', 'v1', '--notes-file=inline.md'],
    files: [{ name: 'inline.md', size: 15, contentBase64: Buffer.from('Synthetic notes').toString('base64') }],
  })
})
test.each([
  { cluster: '-dF', options: ['--draft'], inline: true },
  { cluster: '-pF', options: ['--prerelease'], inline: true },
  { cluster: '-dpF', options: ['--draft', '--prerelease'], inline: false },
])('Gitea preserves release options when uploading $cluster (R1)', async ({ cluster, options, inline }) => {
  const path = join(directory, 'cluster.md')
  writeFileSync(path, 'Synthetic notes')
  const prefix = ['release', 'create', 'v1', '--repo', 'example/project']
  const suffix = ['--allow-write', 'repoCreateRelease', '--preview']
  expect(await toolInput('gitea-axi', [...prefix, ...(inline ? [cluster + path] : [cluster, path]), ...suffix])).toEqual({
    args: [...prefix, ...options, ...(inline ? ['--notes-file=cluster.md'] : ['--notes-file', 'cluster.md']), ...suffix],
    files: [{ name: 'cluster.md', size: 15, contentBase64: Buffer.from('Synthetic notes').toString('base64') }],
  })
})
test('Gitea preserves clustered release options with explicit stdin (R1)', async () => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['Synthetic notes']) as typeof process.stdin)
  expect(await toolInput('gitea-axi', ['release', 'create', 'v1', '-dpF-'])).toEqual({
    args: ['release', 'create', 'v1', '--draft', '--prerelease', '--notes-file=-'], stdin: 'Synthetic notes',
  })
})
test('Gitea explicit stdin works when help is false', async () => {
  const args = ['issue', 'edit', '42', '--body-file=-', '--help=false']
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['Synthetic body']) as typeof process.stdin)
  expect(await toolInput('gitea-axi', args)).toEqual({ args, stdin: 'Synthetic body' })
})
test.each([
  ['issue', 'create', '--body=--input=missing.json', '--label', 'one', '--label', 'two'],
  ['release', 'edit', 'v1', '-Fmissing.md', '--help'],
])('Gitea consumes only file option tokens: %j', async (...args) => {
  expect(await toolInput('gitea-axi', args)).toEqual({ args })
})

test.each([
  ['credential', 'create', 'Synthetic', '--inputs-file'],
  ['inventory', 'host-create', 'synthetic-host', '--variables'],
  ['notification-template', 'edit', '42', '--configuration-file'],
  ['notification-template', 'create', 'Synthetic', '--configuration-file'],
  ['notification-template', 'create', 'Synthetic', '--config-file'],
  ['notification-template', 'edit', '42', '--config-file'],
  ['notification-template', 'create', 'Synthetic', '--messages-file'],
  ['notification-template', 'edit', '42', '--messages-file'],
])('AWX uploads exact caller bytes through %j', async (...prefix) => {
  const path = join(directory, 'awx-input.yml')
  const content = 'password: CANARY-upload\r\nkey: é\n'
  writeFileSync(path, content)
  const structured = prefix.at(-1) === '--variables'
  const result = await toolInput('awx-axi', [...prefix, `${structured ? '@' : ''}${path}`])
  expect(result).toEqual({ args: [...prefix, 'awx-input.yml'],
    files: [{ name: 'awx-input.yml', size: Buffer.byteLength(content), contentBase64: Buffer.from(content).toString('base64') }] })
})

test.each([
  ['credential', 'edit', '42', '--inputs-file', '-'],
  ['user', 'edit', '42', '--password-file', '-'],
])('AWX preserves explicit stdin for %j', async (...args) => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['CANARY-stdin\r\né\n']) as typeof process.stdin)
  expect(await toolInput('awx-axi', args)).toEqual({ args, stdin: 'CANARY-stdin\r\né\n' })
})

test.each(['create', 'update'])('mail rule %s uploads a local file as the fixed rule.json leaf', async action => {
  const path = join(directory, 'local-rule.json')
  const text = '{"isEnabled":true}'
  writeFileSync(path, text)
  expect(await toolInput('mg-axi', ['mail', 'rule', action, `--file=${path}`])).toEqual({
    args: ['mail', 'rule', action, '--file=rule.json'],
    files: [{ name: 'rule.json', size: Buffer.byteLength(text), contentBase64: Buffer.from(text).toString('base64') }],
  })
})

test.each([
  ['--file', '-'], ['--file', '../rule.json'], ['--file', 'missing.json', '--file', 'extra.json'],
])('mail rule upload refuses unsupported input %j', async (...flags) => {
  await expect(toolInput('mg-axi', ['mail', 'rule', 'create', ...flags])).rejects.toBeDefined()
})

test('mail rule help does not read a local file', async () => {
  const args = ['mail', 'rule', 'update', '--file', 'missing.json', '--help']
  expect(await toolInput('mg-axi', args)).toEqual({ args })
})

test('mail rule upload enforces the byte cap before an API request', async () => {
  const path = join(directory, 'large-rule.json')
  writeFileSync(path, 'x'.repeat(65537))
  await expect(toolInput('mg-axi', ['mail', 'rule', 'create', '--file', path])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test.each([
  ['gist', 'create', '--filename=synthetic.txt', '--secret'],
  ['gist', 'edit', 'abc123', '--filename', 'synthetic.txt', '--confirm=synthetic-confirm'],
])('GitHub captures explicit gist content for %j', async (...args) => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['synthetic content']) as typeof process.stdin)
  expect(await toolInput('gh-axi', args)).toEqual({ args, stdin: 'synthetic content' })
})

test.each([
  ['gist', 'create', '--filename=synthetic.txt', '--secret', '--help'],
  ['gist', 'edit', 'abc123', '--desc=synthetic'], ['issue', 'list', '-R', 'canary/repo'],
])('GitHub leaves unrelated stdin unread for %j', async (...args) => {
  const pipe = new PassThrough()
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as unknown as typeof process.stdin)
  const reading = vi.spyOn(pipe, Symbol.asyncIterator)
  try {
    expect(await toolInput('gh-axi', args)).toEqual({ args })
    expect(reading).not.toHaveBeenCalled()
  } finally { pipe.destroy() }
})

test.each([
  ['logs', 'query', '--workspace', 'synthetic', 'Heartbeat | count'],
  ['rg', 'query', '--limit', '1', 'Resources | count'],
  ['--subscription', 'synthetic', 'rg', 'query', '--full', 'true', 'Resources'],
  ['graph', 'query', 'Resources'],
  ['monitor', 'log-analytics', 'query', 'Heartbeat'],
  ['graph', 'query', '--graph-query', 'Resources'],
  ['graph', 'query', '--graph-query=Resources'],
  ['graph', 'query', '-q', 'Resources'],
  ['graph', 'query', '-q=Resources'],
  ['monitor', 'log-analytics', 'query', '--analytics-query', 'Heartbeat'],
  ['monitor', 'log-analytics', 'query', '--analytics-query=Heartbeat'],
  ['api', 'POST', '/synthetic', '--body', '{}'],
  ['api', 'POST', '/synthetic', '--body={}'],
  ['api', 'POST', '/synthetic', '--data', '{}'],
  ['api', 'POST', '/synthetic', '--data={}'],
  ['logs', 'query', '--', 'Heartbeat'],
  ['rg', 'query', 'Resources', '--'],
  ['logs', 'query', 'Resources', '--'],
  ['graph', 'query', 'Resources', '--'],
  ['monitor', 'log-analytics', 'query', 'Heartbeat', '--'],
  ['rg', 'query', '--subscription', 'synthetic', 'Resources'],
  ['logs', 'query', '--fields', 'name', 'Heartbeat'],
  ['api', '--fields', 'name', 'POST', '/synthetic', '--body', '{}'],
  ['logs', 'query', '-'],
].map(args => ({ args })))('Azure explicit input leaves an open pipe unread: $args', async ({ args }) => {
  const pipe = new PassThrough()
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as unknown as typeof process.stdin)
  const reading = vi.spyOn(pipe, Symbol.asyncIterator)
  try {
    expect(await toolInput('az-axi', args)).toEqual({ args })
    expect(reading).not.toHaveBeenCalled()
  } finally { pipe.destroy() }
}, 1000)

test.each([
  ['logs', 'query', '--file'],
  ['rg', 'query', '--file'],
  ['graph', 'query', '--file'],
  ['monitor', 'log-analytics', 'query', '--file'],
  ['api', 'POST', '/synthetic', '--body-file'],
])('Azure uploads a file without reading an open stdin pipe: %j', async (...prefix) => {
  const path = join(directory, 'query.kql')
  writeFileSync(path, 'Heartbeat')
  const pipe = new PassThrough()
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as unknown as typeof process.stdin)
  const reading = vi.spyOn(pipe, Symbol.asyncIterator)
  try {
    expect(await toolInput('az-axi', [...prefix, path]))
      .toEqual({ args: [...prefix, 'query.kql'],
        files: [{ name: 'query.kql', size: 9, contentBase64: Buffer.from('Heartbeat').toString('base64') }] })
    expect(reading).not.toHaveBeenCalled()
  } finally { pipe.destroy() }
}, 1000)

test.each([
  ['logs', 'query', '--workspace', 'synthetic'],
  ['rg', 'query', '--limit=1'],
  ['rg', 'query', '--'],
  ['logs', 'query', '--'],
  ['api'],
  ['api', 'POST', '/synthetic'],
  ['graph', 'query', '--first', '1'],
  ['graph', 'query', '--first=1'],
  ['graph', 'query', '--subscriptions', 'sub-a', 'sub-b'],
  ['graph', 'query', '--subscription', 'sub-a', 'sub-b'],
  ['graph', 'query', '-s', 'sub-a', 'sub-b'],
  ['graph', 'query', '-s=sub-a'],
  ['graph', 'query', '--fields', 'id', 'name'],
  ['graph', 'query', '--management-groups', 'group-a', 'group-b'],
  ['graph', 'query', '--subscriptions=sub-a', '--fields', 'id', 'name', '--full', 'false'],
  ['monitor', 'log-analytics', 'query', '--subscription', 'sub-a', 'sub-b'],
  ['monitor', 'log-analytics', 'query', '-s', 'sub-a', 'sub-b'],
  ['monitor', 'log-analytics', 'query', '--fields', 'id', 'name'],
  ['graph', 'query', '--first', '-1'],
])(
  'Azure reads piped input when only flag values were supplied: %j', async (...args) => {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['Heartbeat']) as typeof process.stdin)
    expect(await toolInput('az-axi', args)).toEqual({ args, stdin: 'Heartbeat' })
  })

test.each([
  { tool: 'az-axi', args: ['logs', 'query'], alternative: '--file' },
  { tool: 'az-axi', args: ['rg', 'query'], alternative: '--file' },
  { tool: 'az-axi', args: ['graph', 'query'], alternative: '--file' },
  { tool: 'az-axi', args: ['monitor', 'log-analytics', 'query'], alternative: '--file' },
  { tool: 'az-axi', args: ['api', 'POST', '/synthetic'], alternative: '--data' },
  { tool: 'hybrid-axi', args: ['hunting', 'yara', 'create', '--body-file', '-'], alternative: '--body-file' },
  ...tenable.adapterBoundary.inputFileFlags.map(flag => ({ tool: 'tenable-axi', args: [...tenable.commands.find(route => Object.hasOwn(route.flags, flag))!.command.split(' '), `--${flag}`, '-'], alternative: `--${flag}` })),
])('$tool fails at the stdin deadline: $args', async ({ tool, args, alternative }) => {
  vi.useFakeTimers()
  const pipe = new PassThrough()
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as unknown as typeof process.stdin)
  const rejected = expect(toolInput(tool, args)).rejects.toMatchObject({ code: 'INVALID_INPUT',
    message: expect.stringContaining(`no stdin EOF after 5 s; close stdin or pass ${alternative}`) })
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(pipe.destroyed).toBe(true)
})

test('Azure accepts closed empty stdin', async () => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([]) as typeof process.stdin)
  expect(await toolInput('az-axi', ['logs', 'query'])).toEqual({ args: ['logs', 'query'] })
})

test.each(tenable.adapterBoundary.inputFileFlags)('Tenable uploads only declared --%s inputs', async flag => {
  const command = tenable.commands.find(route => Object.hasOwn(route.flags, flag))!.command.split(' ')
  const path = join(directory, 'input.json')
  writeFileSync(path, '{}')
  expect(await toolInput('tenable-axi', [...command, `--${flag}`, path]))
    .toEqual({ args: [...command, `--${flag}`, 'input.json'],
      files: [{ name: 'input.json', size: 2, contentBase64: Buffer.from('{}').toString('base64') }] })
})

test.each(tenable.adapterBoundary.inputFileFlags)('Tenable reads bounded stdin for --%s -', async flag => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['{}']) as typeof process.stdin)
  const args = [...tenable.commands.find(route => Object.hasOwn(route.flags, flag))!.command.split(' '), `--${flag}=-`]
  expect(await toolInput('tenable-axi', args)).toEqual({ args, stdin: '{}' })
})

test('Tenable refuses files above the existing upload limit', async () => {
  const path = join(directory, 'large.json')
  writeFileSync(path, Buffer.alloc(inputLimits.fileBytes + 1))
  await expect(toolInput('tenable-axi', ['asset', 'list', '--filter-file', path]))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('Tenable refuses stdin above the existing byte limit', async () => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([Buffer.alloc(inputLimits.stdinBytes + 1)]) as typeof process.stdin)
  await expect(toolInput('tenable-axi', ['asset', 'list', '--filter-file', '-']))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('Tenable leaves undeclared paths untouched', async () => {
  const args = ['asset', 'list', '--query', '/missing/input.json']
  expect(await toolInput('tenable-axi', args)).toEqual({ args })
})
