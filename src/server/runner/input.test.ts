import { mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { inputLimits, runSuccessSchema } from '../../shared/api.js'
import { writeInput } from './input.js'
import { Runner } from './runner.js'

let root: string
let runner: Runner
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-input-test-'))
  runner = await Runner.create(root)
})
afterEach(async () => {
  await runner.shutdown()
  try {
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
const run = (args: string[], input = {}) => runner.run('synthetic-user', process.execPath, args, {}, [], {}, input)
const file = { name: 'payload.json', contentBase64: Buffer.from('synthetic ☃').toString('base64') }

test('public runner delivers uploaded bytes through only reviewed argument positions and cleans up', async () => {
  const script = `const fs = require('node:fs'); const path = require('node:path'); const uploaded = process.argv[1]; console.log(JSON.stringify({ uploaded, literal: process.argv[2], content: fs.readFileSync(uploaded, 'utf8'), mode: fs.statSync(uploaded).mode & 0o777, directoryMode: fs.statSync(path.dirname(uploaded)).mode & 0o777 }));`
  const result = await run(['-e', script, file.name, file.name], { files: [file], fileArguments: [2] })
  const received = JSON.parse(result.stdout)
  expect(received).toEqual({ uploaded: expect.stringMatching(/artium-call-.*\/inputs\/payload.json$/), literal: file.name, content: 'synthetic ☃', mode: 0o600, directoryMode: 0o700 })
  await expect(stat(received.uploaded)).rejects.toMatchObject({ code: 'ENOENT' })
  const { timedOut: _, ...response } = result
  expect(runSuccessSchema.parse({ source: 'az-axi', ...response })).toMatchObject({ exitCode: 0 })
})

test('public runner writes the bounded UTF-8 stdin and closes it', async () => {
  const stdin = 'é'.repeat(inputLimits.stdinBytes / 2)
  const result = await run(['-e', "process.stdin.pipe(process.stdout)"], { stdin })
  expect(result.stdout).toBe(stdin)
  expect(result.outputBytes.stdout).toBe(inputLimits.stdinBytes)
})

test('omitted stdin still provides EOF', async () => {
  expect((await run(['-e', "process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"])).stdout).toBe('eof\n')
})

test('child may exit without reading supplied stdin', async () => {
  expect((await run(['-e', 'process.exit(2)'], { stdin: 'x'.repeat(inputLimits.stdinBytes) })).exitCode).toBe(2)
})

test.each([
  { files: [{ ...file, name: '../outside' }] },
  { files: [file, file] },
  { files: [{ ...file, contentBase64: 'invalid' }] },
  { stdin: 'x'.repeat(inputLimits.stdinBytes + 1) },
  { environment: { CANARY: 'synthetic' } },
])('security invalid transport creates no child or call directory', async input => {
  await expect(run(['-e', "require('node:fs').writeFileSync('child-started', '')"], input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await readdir(root)).toEqual([])
})

test.each(['/synthetic/server-file', '../payload.json', 'missing.json'])('security reviewed file argument cannot access server path %s', name => {
  return expect(run(['-e', 'process.exit(0)', name], { files: [file], fileArguments: [2] })).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test('security transport refuses a pre-existing inputs symlink without touching its destination', async () => {
  const directory = await mkdtemp(join(root, 'owned-'))
  const destination = await mkdtemp(join(root, 'destination-'))
  try {
    await symlink(destination, join(directory, 'inputs'))
    await expect(writeInput(directory, [], { files: [file] })).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
    expect(await readdir(destination)).toEqual([])
  } finally {
    await rm(directory, { recursive: true })
    await rm(destination, { recursive: true })
  }
})

test('uploaded files are cleaned up when executable lookup fails', async () => {
  await expect(runner.run('synthetic-user', join(root, 'missing'), [], {}, [], {}, { files: [file] })).rejects.toMatchObject({ code: 'SPAWN_FAILED' })
  expect(await readdir(root)).toEqual([])
})

test('timeout cleans uploaded files and pending stdin', async () => {
  await expect(runner.run('synthetic-user', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, [], { timeoutMs: 100 }, { files: [file], stdin: 'x'.repeat(inputLimits.stdinBytes) })).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(await readdir(root)).toEqual([])
})
