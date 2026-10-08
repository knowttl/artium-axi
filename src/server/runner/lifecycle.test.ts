import { watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fakeTool } from '../../../test/fake-tool/tool.js'
import { Runner } from './runner.js'

let fixture: string
let root: string
let runner: Runner
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'artium-lifecycle-test-'))
  root = join(fixture, 'calls')
  runner = await Runner.create(root)
})
afterEach(async () => {
  await runner.shutdown()
  try {
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

// Watch before spawning, so the test waits for actual readiness rather than elapsed time.
function start(mode: string, options = {}, args: string[] = []) {
  const path = join(fixture, 'ready.json')
  let watcher: ReturnType<typeof watch>
  let rejectReady: (error: unknown) => void
  const ready = new Promise<{ parent: number, child?: number, bytes?: number }>((resolve, reject) => {
    rejectReady = reject
    watcher = watch(fixture, async (_event, name) => {
      if (name !== 'ready.json') return
      watcher.close()
      try { resolve(JSON.parse(await readFile(path, 'utf8'))) } catch (error) { reject(error) }
    })
  })
  const result = runner.run('synthetic-user', fakeTool.executable, [...fakeTool.args, mode, ...args], { ARTIUM_TEST_READY_FILE: path }, [], options)
  const settled = result.catch(error => {
    watcher.close()
    rejectReady(error)
    return error
  })
  return { ready, result: settled }
}

async function state(pid: number): Promise<string | undefined> {
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[0] }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

test('security timeout terminates an ordinary descendant and reaps the leader', async () => {
  const call = start('child', { timeoutMs: 1000 })
  const pids = await call.ready
  expect((await call.result).code).toBe('TIMEOUT')
  expect(await state(pids.parent)).toBeUndefined()
  expect([undefined, 'Z']).toContain(await state(pids.child!))
}, 10_000)

test('security disconnect cancellation escalates to SIGKILL when SIGTERM is ignored', async () => {
  const controller = new AbortController()
  const call = start('sleep', { signal: controller.signal }, ['60000', 'ignore-term'])
  const pids = await call.ready
  controller.abort()
  expect((await call.result).code).toBe('CANCELLED')
  expect(await state(pids.parent)).toBeUndefined()
})

test('shutdown cancels an active child, reaps it and refuses further admission', async () => {
  const call = start('sleep', {}, ['60000'])
  const pids = await call.ready
  await runner.shutdown()
  expect((await call.result).code).toBe('CANCELLED')
  expect(await state(pids.parent)).toBeUndefined()
  await expect(runner.run('synthetic-user', fakeTool.executable, fakeTool.args, {}, []))
    .rejects.toMatchObject({ code: 'RUNNER_CLOSED' })
})

test('normal leader exit still terminates surviving group descendants', async () => {
  const call = start('child-exit')
  const pids = await call.ready
  expect((await call.result).exitCode).toBe(0)
  expect(await state(pids.parent)).toBeUndefined()
  expect([undefined, 'Z']).toContain(await state(pids.child!))
})

test.each(['ignore', 'pipes'])('escaped sessions remain outside containment without holding cancellation open: %s', async mode => {
  const controller = new AbortController()
  const call = start('descendant', { signal: controller.signal }, mode === 'pipes' ? ['pipes'] : [])
  const pids = await call.ready
  try {
    controller.abort()
    expect((await call.result).code).toBe('CANCELLED')
    expect(await state(pids.parent)).toBeUndefined()
    expect(await state(pids.child!)).not.toBeUndefined()
    expect(await state(pids.child!)).not.toBe('Z')
  } finally {
    process.kill(-pids.child!, 'SIGKILL')
  }
})

test('startup removes abandoned call directories and symlinks without following them', async () => {
  await runner.shutdown()
  const outside = join(fixture, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'synthetic')
  await mkdir(join(root, 'artium-call-abandoned'))
  await writeFile(join(root, 'artium-call-abandoned', 'cache'), 'synthetic')
  await symlink(outside, join(root, 'artium-call-link'))
  runner = await Runner.create(root)
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('synthetic')
  expect(await readdir(root)).toEqual([])
})

test('security resident buffers can exceed the Node heap bound and require a container bound', async () => {
  const controller = new AbortController()
  const call = start('memory', { signal: controller.signal }, ['192'])
  const allocated = await call.ready
  controller.abort()
  expect(allocated.bytes).toBe(192 * 1024 * 1024)
  expect((await call.result).code).toBe('CANCELLED')
})

test('third user call and ninth global call are refused immediately without a queue', async () => {
  const calls = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd'].map(user =>
    runner.run(user, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, []).catch(error => error))
  await expect(runner.run('a', fakeTool.executable, fakeTool.args, {}, [])).rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
  await expect(runner.run('e', fakeTool.executable, fakeTool.args, {}, [])).rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
  await runner.shutdown()
  expect((await Promise.all(calls)).map(result => result.code)).toEqual(Array(8).fill('CANCELLED'))
})
