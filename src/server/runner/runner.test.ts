import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fakeTool } from '../../../test/fake-tool/tool.js'
import { runtimePath } from '../config.js'
import { Runner } from './runner.js'

let root: string
let runner: Runner
const run = (...args: Parameters<Runner['run']> extends [string, ...infer Rest] ? Rest : never) => runner.run('synthetic-user', ...args)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-runner-test-'))
  runner = await Runner.create(root)
})
afterEach(async () => {
  await runner.shutdown()
  try {
    expect(await readdir(root)).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

const fake = (args: string[], environment = {}, secrets: string[] = []) =>
  run(fakeTool.executable, [...fakeTool.args, ...args], environment, secrets)

test('trusted adapter heap allowance overrides caller environment options', async () => {
  const result = await run(process.execPath, ['-e', 'console.log(process.env.NODE_OPTIONS)'],
    { NODE_OPTIONS: '--max-old-space-size=2048' }, [], { nodeHeapMiB: 512 })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('--max-old-space-size=512\n')
})

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

test('adapter files are private, readable beside the profile and cleaned after execution', async () => {
  const script = `const fs = require('node:fs'); console.log(JSON.stringify({
    profile: fs.readFileSync('profile.json', 'utf8'), ca: [...fs.readFileSync('ca.pem')],
    mode: fs.statSync('profile.json').mode & 0o777, cwdMode: fs.statSync('.').mode & 0o777
  }));`
  const result = await run(process.execPath, ['-e', script], {}, [], {}, {}, [
    { name: 'profile.json', content: '{"synthetic":true}' }, { name: 'ca.pem', content: Uint8Array.of(1, 2, 3) },
  ])
  expect(JSON.parse(result.stdout)).toEqual({ profile: '{"synthetic":true}', ca: [1, 2, 3], mode: 0o600, cwdMode: 0o700 })
  expect(await readdir(root)).toEqual([])
})

test.each(['', '.', '..', '../profile.json', '/data/profile.json', 'inputs/profile.json', 'profile\\file'])
  ('adapter file name %j is refused and cleaned', async name => {
    await expect(run(process.execPath, ['-e', 'process.exit(0)'], {}, [], {}, {}, [{ name, content: 'synthetic' }]))
      .rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  })

test('duplicate adapter files cannot replace an existing profile', async () => {
  await expect(run(process.execPath, ['-e', 'process.exit(0)'], {}, [], {}, {}, [
    { name: 'profile.json', content: 'first' }, { name: 'profile.json', content: 'second' },
  ])).rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
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
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory,
    XDG_STATE_HOME: directory, XDG_RUNTIME_DIR: directory, NODE_OPTIONS: '--max-old-space-size=128',
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

test.each(['stdout', 'stderr'] as const)('security stops a 64 MiB %s flood without returning captured output', async stream => {
  const failure = await fake([stream, String(65 * 1024 * 1024)]).catch(error => error)
  expect(failure).toMatchObject({ code: 'OUTPUT_LIMIT', source: 'artium-axi' })
  expect(failure).not.toHaveProperty('stdout')
  expect(failure).not.toHaveProperty('stderr')
}, 20_000)

test('security flood stop counts stdout and stderr together', async () => {
  const script = `process.stdout.write(Buffer.alloc(32 * 1024 * 1024)); process.stderr.write(Buffer.alloc(32 * 1024 * 1024))`
  await expect(run(process.execPath, ['-e', script], {}, [])).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
}, 20_000)

test('security Node heap exhaustion ends the call without captured diagnostics', async () => {
  const script = `const retained = Array.from({ length: 24 }, () => Array(1024 * 1024).fill(1)); console.log(retained.length)`
  await expect(run(process.execPath, ['-e', script], { NODE_OPTIONS: '--max-old-space-size=2048' }, []))
    .rejects.toMatchObject({ code: 'PROCESS_SIGNAL' })
}, 10_000)

test('security explicit Python runtime refuses a 600 MiB allocation', async () => {
  const script = `import resource\nprint(resource.getrlimit(resource.RLIMIT_AS))\ntry:\n bytearray(600 * 1024 * 1024)\nexcept MemoryError:\n print('memory refused')`
  const result = await run('/usr/bin/python3', ['-c', script], {}, [], { runtime: 'python' })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toBe('(536870912, 536870912)\nmemory refused\n')
})

test('already cancelled calls create no child and release admission slots', async () => {
  await expect(run(fakeTool.executable, fakeTool.args, {}, [], { signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ code: 'CANCELLED' })
  expect((await fake(['print', 'ready'])).stdout).toBe('ready')
})
