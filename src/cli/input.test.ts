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
        files: [{ name: 'query.kql', contentBase64: Buffer.from('Heartbeat').toString('base64') }] })
    expect(reading).not.toHaveBeenCalled()
  } finally { pipe.destroy() }
}, 1000)

test.each([
  ['logs', 'query', '--workspace', 'synthetic'],
  ['rg', 'query', '--limit=1'],
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
  { tool: 'hybrid-axi', args: ['api', '--body-file', '-'], alternative: '--body-file' },
  ...tenable.adapterBoundary.inputFileFlags.map(flag => ({ tool: 'tenable-axi', args: ['asset', 'list', `--${flag}`, '-'], alternative: `--${flag}` })),
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
  const path = join(directory, 'input.json')
  writeFileSync(path, '{}')
  expect(await toolInput('tenable-axi', ['asset', 'list', `--${flag}`, path]))
    .toEqual({ args: ['asset', 'list', `--${flag}`, 'input.json'],
      files: [{ name: 'input.json', contentBase64: Buffer.from('{}').toString('base64') }] })
})

test.each(tenable.adapterBoundary.inputFileFlags)('Tenable reads bounded stdin for --%s -', async flag => {
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['{}']) as typeof process.stdin)
  const args = ['asset', 'list', `--${flag}=-`]
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
