import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fakeTool } from '../../../test/fake-tool/tool.js'
import { runtimePath } from '../config.js'
import { run } from './runner.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-runner-test-'))
  vi.stubEnv('TMPDIR', root)
})
afterEach(async () => {
  try {
    expect(await readdir(root)).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

const fake = (args: string[], environment = {}, secrets: string[] = []) =>
  run(fakeTool.executable, [...fakeTool.args, ...args], environment, secrets)

test('public runner preserves fake-tool streams, nonzero exit status and result flags', async () => {
  const result = await fake(['upstream', 'az-axi', 'error'])
  expect(result.stdout).toContain('error:')
  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(1)
  expect(result.durationMs).toBeGreaterThan(0)
  expect(result.outputBytes).toEqual({ stdout: Buffer.byteLength(result.stdout), stderr: Buffer.byteLength(result.stderr) })
  expect(result.timedOut).toBe(false)
  expect(result.truncated).toEqual({ stdout: false, stderr: false })
})

test('security shell metacharacters remain literal arguments', async () => {
  const args = ['$(touch escaped)', '; touch escaped', '> escaped', '*', 'a b', '"quoted"']
  expect((await fake(['print', ...args])).stdout).toBe(args.join(' '))
})

test.each([
  {},
  {
    XDG_CONFIG_HOME: '/synthetic/config', XDG_CACHE_HOME: '/synthetic/cache',
    XDG_DATA_HOME: '/synthetic/data', XDG_STATE_HOME: '/synthetic/state',
    XDG_RUNTIME_DIR: '/synthetic/runtime',
  },
])('security environment contains only adapter values and fixed runtime paths: %j', async (adapterPaths) => {
  vi.stubEnv('ARTIUM_PARENT_ONLY', 'CANARY-parent')
  const result = await fake(['env'], { ...adapterPaths, ADAPTER_SETTING: 'synthetic', PATH: '/incorrect', HOME: '/incorrect', TMPDIR: '/incorrect' })
  const environment = JSON.parse(result.stdout)
  const directory = environment.HOME
  expect(environment).toEqual({
    ...adapterPaths,
    ADAPTER_SETTING: 'synthetic', PATH: runtimePath, HOME: directory, TMPDIR: directory,
  })
  expect(directory.startsWith(join(root, 'artium-call-'))).toBe(true)
  await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('security simultaneous calls have private working directories and remove tool-created files', async () => {
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync('tool-cache', 'synthetic');
    console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME,
      mode: fs.statSync('.').mode & 0o777, files: fs.readdirSync('.') }));
  `
  const results = await Promise.all([
    run(process.execPath, ['-e', script], {}, []),
    run(process.execPath, ['-e', script], {}, []),
  ])
  const directories = results.map(result => JSON.parse(result.stdout))
  expect(directories[0].cwd).not.toBe(directories[1].cwd)
  for (const directory of directories) {
    expect(directory.cwd).toBe(directory.home)
    expect(directory.mode).toBe(0o700)
    expect(directory.files).toEqual(['tool-cache'])
    await expect(stat(directory.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

test('Linux child runs in its own process group', async () => {
  const script = `
    const fields = require('node:fs').readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
    console.log(JSON.stringify({ pid: process.pid, group: Number(fields[2]) }));
  `
  const result = await run(process.execPath, ['-e', script], {}, [])
  const child = JSON.parse(result.stdout)
  expect(child.group).toBe(child.pid)
})

test('completed child preserves both output streams', async () => {
  const result = await run(process.execPath, ['-e', "process.stdout.write('stdout'); process.stderr.write('stderr')"], {}, [])
  expect(result.stdout).toBe('stdout')
  expect(result.stderr).toBe('stderr')
  expect(result.exitCode).toBe(0)
})

test('capture preserves an upstream UTF-8 byte order mark', async () => {
  expect((await fake(['print', '\uFEFFsynthetic'])).stdout).toBe('\uFEFFsynthetic')
})

test.each(['stdout', 'stderr'] as const)('security captures at most 4 MiB while draining %s', async (stream) => {
  const result = await fake([stream, String(4 * 1024 * 1024 + 17)])
  expect(result[stream]).toBe('x'.repeat(4 * 1024 * 1024))
  expect(result.outputBytes[stream]).toBe(4 * 1024 * 1024 + 17)
  expect(result.truncated[stream]).toBe(true)
  expect(result.truncated[stream === 'stdout' ? 'stderr' : 'stdout']).toBe(false)
})

test.each(['stdout', 'stderr'] as const)('UTF-8 decoding preserves split bytes in %s', async (stream) => {
  expect((await fake(['split', 'safe-☃', '6', stream]))[stream]).toBe('safe-☃')
})

test.each([0, 5, 6, 7, 8])('retention at byte %i does not split a UTF-8 character', async (cap) => {
  const result = await run(fakeTool.executable, [...fakeTool.args, 'print', 'safe-☃'], {}, [], { outputBytesPerStream: cap })
  expect(result.stdout).toBe(cap === 0 ? '' : cap === 8 ? 'safe-☃' : 'safe-')
  expect(result.outputBytes.stdout).toBe(8)
  expect(result.truncated.stdout).toBe(cap < 8)
})

test.each(['raw', 'base64', 'base64url', 'url'])('security rejects fake-tool %s canary output', async (form) => {
  await expect(fake(['leak', form], { ARTIUM_TEST_CANARY: 'CANARY+/=' }, ['CANARY+/=']))
    .rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT', source: 'artium-axi' })
})

test.each(['stdout', 'stderr'] as const)('security rejects boundary-split secrets in %s', async (stream) => {
  await expect(fake(['split', 'CANARY-split', '5', stream], {}, ['CANARY-split']))
    .rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
})

test.each(['stdout', 'stderr'] as const)('security discards both streams for a secret after the %s cap', async (stream) => {
  const script = `
    process.stdout.write('safe stdout');
    process.stderr.write('safe stderr');
    process.${stream}.write('x'.repeat(4 * 1024 * 1024));
    process.${stream}.write(process.env.ARTIUM_TEST_CANARY);
  `
  const failure = await run(process.execPath, ['-e', script], { ARTIUM_TEST_CANARY: 'CANARY-hidden' }, ['CANARY-hidden'])
    .catch(error => error)
  expect(failure.code).toBe('SECRET_IN_OUTPUT')
  expect(failure).not.toHaveProperty('stdout')
  expect(failure).not.toHaveProperty('stderr')
  expect(String(failure)).not.toContain('CANARY-hidden')
})

test('failed executable lookup removes the directory and returns a safe error', async () => {
  await expect(run(join(root, 'missing'), [], {}, []))
    .rejects.toMatchObject({ code: 'SPAWN_FAILED', source: 'artium-axi' })
})

test('synchronous spawn failure removes the directory', async () => {
  await expect(run('invalid\0executable', [], {}, [])).rejects.toThrow()
})

test('signal termination removes the directory without inventing an exit code', async () => {
  await expect(fake(['signal'])).rejects.toMatchObject({ code: 'PROCESS_SIGNAL' })
})
