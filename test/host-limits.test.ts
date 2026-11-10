import { beforeEach, expect, test, vi } from 'vitest'

const host = vi.hoisted(() => ({ cpus: 0, memory: 0 }))

vi.mock('node:os', () => ({ availableParallelism: () => host.cpus, totalmem: () => host.memory }))

const { cpuLimit, memoryLimit } = await import(new URL('../scripts/host-limits.mjs', import.meta.url).href)

beforeEach(() => { host.memory = 16 * 2 ** 30 })

test.each([
  [4, 6, '4'],
  [2, 6, '2'],
  [6, 6, '6'],
  [24, 6, '6'],
])('a host with %i CPUs caps a %i CPU request to %s', (cpus, requested, expected) => {
  host.cpus = cpus
  expect(cpuLimit(requested)).toBe(expected)
})

test.each([
  [16384, 6144, '6144m'],
  [6144, 6144, '6144m'],
  [4096, 6144, '4096m'],
  [4096, 256, '256m'],
])('a host with %i MiB caps a %i MiB request to %s', (hostMib, requested, expected) => {
  host.memory = hostMib * 2 ** 20
  expect(memoryLimit(requested)).toBe(expected)
})
