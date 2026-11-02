import { watch } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createFalconAdapter } from '../src/server/adapters/falcon.js'
import { Runner } from '../src/server/runner/runner.js'
import { fakeTool } from './fake-tool/tool.js'

const device = 'abcdef0123456789abcdef0123456789'
let directory: string
let runner: Runner
let executable: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'artium-rtr-custody-'))
  executable = join(directory, 'controller.mjs')
  await writeFile(executable, `import ${JSON.stringify(pathToFileURL(fakeTool.args[0]).href)}\n`)
  const native = new URL('../tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/rtr-filesystem.js', import.meta.url).href
  await writeFile(join(directory, 'rtr-filesystem.js'), `export { openRetainedFile } from ${JSON.stringify(native)}\n`)
  runner = await Runner.create(join(directory, 'calls'))
})
afterEach(async () => {
  await runner.shutdown()
  expect((await readdir(join(directory, 'calls'))).filter(name => name.startsWith('artium-call-'))).toEqual([])
  await rm(directory, { recursive: true, force: true })
})
async function limits(target: string) {
  const adapter = createFalconAdapter({ getSettings: () => ({ writes: { allowWrites: true, operations: ['rtr run'] } }),
    getCredential: async () => ({ clientId: 'CANARY-client', clientSecret: 'CANARY-secret', region: 'us-1' }) })
  return (await adapter.prepare(['rtr', 'run', target, '--command', 'ps', '--execute', '--confirm', `${target}:ps`],
    { tool: 'falcon-axi', id: 'synthetic', revision: 1 })).limits
}

test('RTR device custody spans users and case aliases while independent devices remain usable', async () => {
  const controller = new AbortController()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const first = runner.run('actor-1', fakeTool.executable, [executable, 'sleep', '60000'], {}, [],
    { ...await limits(device.toUpperCase()), signal: controller.signal }, {}, [], started)
  await Promise.race([ready, first.then(() => { throw new Error('Fixture exited before readiness') })])
  await expect(runner.run('actor-2', fakeTool.executable, [executable, 'print', 'unexpected'], {}, [], await limits(device)))
    .rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
  const independent = await runner.run('actor-2', fakeTool.executable, [executable, 'print', 'independent'], {}, [], await limits('1'.repeat(32)))
  expect(independent.stdout).toBe('independent')
  controller.abort()
  await expect(first).rejects.toMatchObject({ code: 'CANCELLED' })
})

test('RTR cancellation retains custody through the native ten-second cleanup allowance', async () => {
  const options = await limits(device)
  const controller = new AbortController()
  const readyPath = join(directory, 'ready.json')
  const cleanupPath = join(directory, 'cleanup')
  let watcher!: ReturnType<typeof watch>
  const ready = new Promise<void>(resolve => {
    watcher = watch(directory, (_event, name) => { if (name === 'ready.json') { watcher.close(); resolve() } })
  })
  const result = runner.run('actor-1', fakeTool.executable, [executable, 'cleanup', '10000'], {
    ARTIUM_TEST_READY_FILE: readyPath, ARTIUM_TEST_CLEANUP_FILE: cleanupPath,
  }, [], { ...options, signal: controller.signal })
  try {
    await Promise.race([ready, result.then(() => { throw new Error('Fixture exited before readiness') })])
    controller.abort()
    await expect(runner.run('actor-2', fakeTool.executable, [executable, 'print', 'unexpected'], {}, [], options))
      .rejects.toMatchObject({ code: 'TEMP_UNAVAILABLE' })
    await expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(await readFile(cleanupPath, 'utf8')).toBe('deleted')
    const released = await runner.run('actor-2', fakeTool.executable, [executable, 'print', 'released'], {}, [], options)
    expect(released.stdout).toBe('released')
  } finally { watcher.close() }
}, 20_000)
