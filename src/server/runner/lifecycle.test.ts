import { watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { runnerLimits } from '../config.js'
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
  vi.useRealTimers()
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
  const result = runner.run('synthetic-user', fakeTool.executable, [...fakeTool.args, mode, ...args], {
    ARTIUM_TEST_READY_FILE: path, ARTIUM_TEST_CLEANUP_FILE: join(fixture, 'cleanup'),
  }, [], options)
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

test.each(['disconnect', 'shutdown', 'timeout'])('%s allows cleanup beyond the default termination grace', async cause => {
  const controller = new AbortController()
  const call = start('cleanup', { terminationGraceMs: 12_000, signal: controller.signal,
    timeoutMs: cause === 'timeout' ? 1_000 : 60_000 })
  const pids = await call.ready
  if (cause === 'disconnect') controller.abort()
  if (cause === 'shutdown') await runner.shutdown()
  expect((await call.result).code).toBe(cause === 'timeout' ? 'TIMEOUT' : 'CANCELLED')
  expect(await readFile(join(fixture, 'cleanup'), 'utf8')).toBe('deleted')
  expect(await state(pids.parent)).toBeUndefined()
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

// TD-058: exercise admission through real child calls; only the wait clock is fake.
function occupy(users: string[]) {
  return users.map(user => {
    const controller = new AbortController()
    const result = runner.run(user, fakeTool.executable, [...fakeTool.args, 'sleep', '60000'], {}, [],
      { signal: controller.signal }).catch(error => error)
    return { controller, result }
  })
}

function print(user = 'a', signal?: AbortSignal) {
  return runner.run(user, fakeTool.executable, [...fakeTool.args, 'print', 'admitted'], {}, [], { signal })
}

test('fourth concurrent user call succeeds', async () => {
  occupy(['a', 'a', 'a'])
  await expect(print())
    .resolves.toMatchObject({ exitCode: 0, stdout: 'admitted' })
})

test('fifth call waits and runs when a slot frees within the bound', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const calls = occupy(['a', 'a', 'a', 'a'])
  const pending = print()
  await vi.advanceTimersByTimeAsync(runnerLimits.admissionWaitMs - 1)
  calls[0].controller.abort()
  await expect(calls[0].result).resolves.toMatchObject({ code: 'CANCELLED' })
  await expect(pending).resolves.toMatchObject({ stdout: 'admitted' })
})

test.each([
  { name: 'fifth user call', users: ['a', 'a', 'a', 'a'], user: 'a' },
  { name: 'ninth global call across users', users: ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b'], user: 'c' },
])('$name is refused only when its queue wait expires', async ({ users, user }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  occupy(users)
  let outcome = 'waiting'
  const pending = print(user).then(() => { outcome = 'admitted' }, error => { outcome = error.code })
  await vi.advanceTimersByTimeAsync(runnerLimits.admissionWaitMs - 1)
  expect(outcome).toBe('waiting')
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(outcome).toBe('TOO_MANY_CALLS')
})

test('cancelled queued call releases no active slot and the next waiter can run', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const calls = occupy(['a', 'a', 'a', 'a'])
  const controller = new AbortController()
  const cancelled = print('a', controller.signal).catch(error => error)
  controller.abort()
  await expect(cancelled).resolves.toMatchObject({ code: 'CANCELLED' })
  const next = print().catch(error => error)
  await vi.advanceTimersByTimeAsync(runnerLimits.admissionWaitMs)
  await expect(next).resolves.toMatchObject({ code: 'TOO_MANY_CALLS' })
  const admitted = print()
  calls[0].controller.abort()
  await expect(admitted).resolves.toMatchObject({ stdout: 'admitted' })
})

test('queued calls retain arrival order across users', async () => {
  const calls = occupy(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b'])
  const order: string[] = []
  const first = runner.run('a', fakeTool.executable, [...fakeTool.args, 'print', 'first'], {}, [], {}, {}, [],
    () => { order.push('first') })
  const second = runner.run('c', fakeTool.executable, [...fakeTool.args, 'print', 'second'], {}, [], {}, {}, [],
    () => { order.push('second') })
  calls[0].controller.abort()
  await expect(first).resolves.toMatchObject({ stdout: 'first' })
  await expect(second).resolves.toMatchObject({ stdout: 'second' })
  expect(order[0]).toBe('first')
})

test('shutdown rejects queued calls without spawning them', async () => {
  occupy(['a', 'a', 'a', 'a'])
  const queued = print().catch(error => error)
  await runner.shutdown()
  await expect(queued).resolves.toMatchObject({ code: 'RUNNER_CLOSED' })
  await expect(print()).rejects.toMatchObject({ code: 'RUNNER_CLOSED' })
})
