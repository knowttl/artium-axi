import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const docker = vi.hoisted(() => ({
  resources: new Set<string>(),
  removed: [] as string[],
  attempted: '',
  failure: '',
  partial: false,
  images: new Set<string>(),
  built: [] as string[],
  used: [] as string[],
  removedImages: [] as string[],
  exportedImage: '',
  orchestration: false,
  commands: [] as string[],
  walking: undefined as EventEmitter | undefined,
  walkingStarted: undefined as (() => void) | undefined,
  runnerStatus: 0,
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: (bin: string, args: string[], options: { timeout?: number }) => {
    const result = { status: 0, stdout: '', stderr: '' }
    if (bin === process.execPath) {
      const image = args[args.indexOf('--runner') + 1]
      if (!args.includes('--runner') || !image) {
        return { ...result, status: 1, stderr: 'Missing runner image tag' }
      }
      docker.built.push(image)
      if (docker.failure === 'slow-builder' && options.timeout) {
        return { ...result, status: null, error: new Error('Synthetic enclosing build timeout') }
      }
      if (docker.failure !== 'runner-build' || docker.partial) docker.images.add(image)
      if (docker.failure === 'runner-build') return { ...result, status: 1, stderr: 'Synthetic build failure' }
    } else if (args[0] === 'run' || (args[0] === 'network' && args[1] === 'create')) {
      if (args.includes('test/runner/probe.mjs')) docker.used.push(args[args.indexOf('node') - 1])
      const kind = args[0] === 'run' ? 'container' : 'network'
      const name = kind === 'container' ? args[args.indexOf('--name') + 1] : args.at(-1)!
      const resource = `${kind}:${name}`
      if ((docker.failure === 'builder' && name.startsWith('artium-test-build-')) ||
          (docker.failure.startsWith(`${kind}:`) && name.endsWith(`-${docker.failure.split(':')[1]}`))) {
        docker.attempted = resource
        if (docker.partial) docker.resources.add(resource)
        return { ...result, status: null, error: new Error('Synthetic Docker creation timeout') }
      }
      docker.resources.add(resource)
      if (args.includes('--rm')) docker.resources.delete(resource)
      result.stdout = args.includes('--version') ? 'v24.0.0' : 'synthetic-container'
    } else if (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm')) {
      const kind = args[0] === 'rm' ? 'container' : 'network'
      const resource = `${kind}:${args.at(-1)}`
      docker.removed.push(resource)
      if (!docker.resources.delete(resource)) {
        return { ...result, status: 1, stderr: kind === 'container'
          ? 'No such container' : `network ${args.at(-1)} not found` }
      }
    } else if (args[0] === 'network' && args[1] === 'inspect') {
      result.stdout = '[{"Internal":true}]'
    } else if (args[0] === 'inspect') {
      result.stdout = args.includes('--format')
        ? JSON.stringify({ 'artium-test.root': new URL('../', import.meta.url).pathname, 'artium-test.token': 'synthetic-task-token' })
        : '[{"NetworkSettings":{"Networks":{"synthetic":{"IPAddress":"192.0.2.1"}}}}]'
    } else if (args[0] === 'image' && args[1] === 'inspect') {
      result.status = args[2].startsWith('artium-test-runner-')
        ? Number(!docker.images.has(args[2])) : docker.failure === 'builder' ? 1 : 0
    } else if (args[0] === 'image' && args[1] === 'rm') {
      docker.removedImages.push(args[2])
      if (!docker.images.delete(args[2])) return { ...result, status: 1, stderr: 'No such image' }
    } else if (args[0] === 'exec' && args.includes('--output')) {
      docker.exportedImage = args[args.indexOf('--output') + 1].split('name=')[1].split(',')[0]
    } else if (args[0] === 'load') {
      docker.images.add(docker.exportedImage)
    }
    return result
  },
  spawn: (bin: string, args: string[]) => {
    if (docker.orchestration) {
      const child = new EventEmitter()
      if (bin === 'docker' && args[0] === 'run') docker.resources.add(`container:${args[args.indexOf('--name') + 1]}`)
      if (bin === process.execPath) docker.commands.push(args[0])
      if (args[0] === 'scripts/walking-skeleton.mjs') {
        docker.walking = child
        docker.walkingStarted!()
      } else {
        queueMicrotask(() => child.emit('close', args[0] === 'scripts/runner-container-check.mjs' ? docker.runnerStatus : 0))
      }
      return child
    }
    const logs = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
    logs.stdout = new EventEmitter()
    logs.kill = () => { queueMicrotask(() => logs.emit('close')) }
    queueMicrotask(() => logs.stdout.emit('data', Buffer.from('artium-test-ready 443')))
    return logs
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  docker.resources.clear()
  docker.removed = []
  docker.attempted = ''
  docker.failure = ''
  docker.partial = false
  docker.images.clear()
  docker.built = []
  docker.used = []
  docker.removedImages = []
  docker.exportedImage = ''
  docker.orchestration = false
  docker.commands = []
  docker.walking = undefined
  docker.walkingStarted = undefined
  docker.runnerStatus = 0
})

const originalArgv = process.argv
afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  process.argv = originalArgv
  vi.unstubAllEnvs()
})

const harness = new URL('../scripts/fake-services.mjs', import.meta.url).href
const builder = new URL('../scripts/build-fake-service-image.mjs', import.meta.url).href
const runnerHarness = new URL('../scripts/runner-container-check.mjs', import.meta.url).href
const containerHarness = new URL('../scripts/container-checks.mjs', import.meta.url).href

test.each([
  [harness, 'container:version', true],
  [harness, 'network:inside', true],
  [harness, 'network:outside', true],
  [harness, 'container:service', true],
  [harness, 'container:outside', true],
  [harness, 'container:client', true],
  [harness, 'network:inside', false],
  [builder, 'builder', true],
  [builder, 'builder', false],
] as const)('%s cleans attempted %s with partial creation %s', async (script, failure, partial) => {
  docker.partial = partial
  docker.failure = failure
  await import(script)
  expect(process.exitCode).toBe(1)
  expect(docker.attempted).not.toBe('')
  expect(docker.removed).toContain(docker.attempted)
  expect(docker.resources.size).toBe(0)
})

test('runner checks use separate images and preserve an unrelated image', async () => {
  const unrelated = 'artium-test-runner-s09-10'
  docker.images.add(unrelated)
  await import(runnerHarness)
  vi.resetModules()
  await import(runnerHarness)
  expect(process.exitCode).toBeUndefined()
  expect(docker.built).toHaveLength(2)
  expect(new Set(docker.built).size).toBe(2)
  expect(docker.used).toEqual(docker.built.flatMap(image => [image, image]))
  expect(docker.removedImages).toEqual(docker.built)
  expect([...docker.images]).toEqual([unrelated])
  expect(docker.resources.size).toBe(0)
})

test.each([false, true])('runner build failure cleans only its image with partial load %s', async partial => {
  const unrelated = 'artium-test-runner-s09-10'
  docker.images.add(unrelated)
  docker.failure = 'runner-build'
  docker.partial = partial
  await import(runnerHarness)
  expect(process.exitCode).toBe(1)
  expect(docker.removedImages).toEqual(docker.built)
  expect(docker.used).toEqual([])
  expect([...docker.images]).toEqual([unrelated])
})

test('runner builder loads the caller supplied image tag', async () => {
  const image = 'artium-test-runner-s09-10-synthetic'
  process.argv = [process.execPath, 'scripts/build-fake-service-image.mjs', '--runner', image]
  await import(builder)
  expect(process.exitCode).toBeUndefined()
  expect([...docker.images]).toEqual([image])
  expect(docker.resources.size).toBe(0)
})

test('runner builder loads the caller supplied image tag and retains its task cache', async () => {
  const image = 'artium-test-runner-s09-10-synthetic'
  const cache = 'artium-test-build-00000000-0000-0000-0000-000000000000'
  vi.stubEnv('ARTIUM_TEST_BUILDER', cache)
  vi.stubEnv('ARTIUM_TEST_BUILD_TOKEN', 'synthetic-task-token')
  docker.resources.add(`container:${cache}`)
  process.argv = [process.execPath, 'scripts/build-fake-service-image.mjs', '--runner', image]
  await import(builder)
  expect(process.exitCode).toBeUndefined()
  expect([...docker.images]).toEqual([image])
  expect([...docker.resources]).toEqual([`container:${cache}`])
})

test('runner waits for a slow builder to finish before probing and cleaning up', async () => {
  docker.failure = 'slow-builder'
  await import(runnerHarness)
  expect(process.exitCode).toBeUndefined()
  expect(docker.built).toHaveLength(1)
  expect(docker.used).toEqual([docker.built[0], docker.built[0]])
  expect(docker.removedImages).toEqual(docker.built)
  expect(docker.images.size).toBe(0)
  expect(docker.resources.size).toBe(0)
})

test.each([0, 1])('container phases overlap and wait before cleanup when runner exits %s', async status => {
  docker.orchestration = true
  docker.runnerStatus = status
  const walkingStarted = new Promise<void>(resolve => { docker.walkingStarted = resolve })
  const checks = import(containerHarness)
  await walkingStarted
  try {
    expect(docker.commands).toEqual([
      'scripts/build.mjs', 'scripts/runner-container-check.mjs', 'scripts/walking-skeleton.mjs',
      'scripts/build-fake-service-image.mjs', 'scripts/build-fake-service-image.mjs',
    ])
    expect(docker.resources.size).toBe(1)
    expect(docker.removed).toEqual([])
  } finally {
    docker.walking!.emit('close', 0)
    await checks
  }
  expect(process.exitCode).toBe(status === 0 ? undefined : 1)
  expect(docker.resources.size).toBe(0)
})
