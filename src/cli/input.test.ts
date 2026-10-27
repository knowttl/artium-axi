import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import tenable from '../../tools/inventories/tenable-axi.json' with { type: 'json' }
import { inputLimits } from '../shared/api.js'
import { toolInput } from './input.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-input-'))
afterEach(() => vi.restoreAllMocks())
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  ['logs', 'query', '--workspace', 'synthetic', 'Heartbeat | count'],
  ['rg', 'query', '--limit', '1', 'Resources | count'],
  ['--subscription', 'synthetic', 'rg', 'query', '--full', 'true', 'Resources'],
  ['api', 'GET', '/synthetic'],
  ['logs', 'query', '--', 'Heartbeat'],
].map(args => ({ args })))('Azure positional input leaves an open pipe unread: $args', async ({ args }) => {
  const pipe = new PassThrough()
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as unknown as typeof process.stdin)
  const reading = vi.spyOn(pipe, Symbol.asyncIterator)
  try {
    expect(await toolInput('az-axi', args)).toEqual({ args })
    expect(reading).not.toHaveBeenCalled()
  } finally { pipe.destroy() }
}, 1000)

test('Azure uploads a file without reading an open stdin pipe', async () => {
  const path = join(directory, 'query.kql')
  writeFileSync(path, 'Heartbeat')
  const pipe = new PassThrough()
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(pipe as unknown as typeof process.stdin)
  const reading = vi.spyOn(pipe, Symbol.asyncIterator)
  try {
    expect(await toolInput('az-axi', ['logs', 'query', '--file', path, '--workspace', 'synthetic']))
      .toEqual({ args: ['logs', 'query', '--file', 'query.kql', '--workspace', 'synthetic'],
        files: [{ name: 'query.kql', contentBase64: Buffer.from('Heartbeat').toString('base64') }] })
    expect(reading).not.toHaveBeenCalled()
  } finally { pipe.destroy() }
}, 1000)

test.each([['logs', 'query', '--workspace', 'synthetic'], ['rg', 'query', '--limit=1'], ['api']])(
  'Azure reads piped input when only flag values were supplied: %j', async (...args) => {
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from(['Heartbeat']) as typeof process.stdin)
    expect(await toolInput('az-axi', args)).toEqual({ args, stdin: 'Heartbeat' })
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
