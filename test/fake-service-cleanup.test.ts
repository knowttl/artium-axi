import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const docker = vi.hoisted(() => ({
  resources: new Set<string>(),
  removed: [] as string[],
  attempted: '',
  failure: '',
  partial: false,
}))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: (_bin: string, args: string[]) => {
    const result = { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'run' || (args[0] === 'network' && args[1] === 'create')) {
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
      result.stdout = args.includes('--version') ? 'v22.0.0' : 'synthetic-container'
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
      result.stdout = '[{"NetworkSettings":{"Networks":{"synthetic":{"IPAddress":"192.0.2.1"}}}}]'
    } else if (args[0] === 'image' && args[1] === 'inspect') {
      result.status = docker.failure === 'builder' ? 1 : 0
    }
    return result
  },
  spawn: () => {
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
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

const harness = new URL('../scripts/fake-services.mjs', import.meta.url).href
const builder = new URL('../scripts/build-fake-service-image.mjs', import.meta.url).href

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
