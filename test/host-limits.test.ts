import { beforeEach, expect, test, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

test.each(['scripts/build-fake-service-image.mjs', 'scripts/container-checks.mjs'])(
  '%s requests four CPUs on a four-CPU host', script => {
    const directory = mkdtempSync(join(process.cwd(), '.tmp-host-limits-'))
    try {
      const preload = join(directory, 'host.mjs')
      const log = join(directory, 'docker.jsonl')
      writeFileSync(preload, "import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.availableParallelism = () => 4; syncBuiltinESMExports()")
      writeFileSync(join(directory, 'docker'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs'\nappendFileSync(process.env.DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.exit(process.argv[2] === 'info' || process.argv[2] === 'rm' ? 0 : 1)\n`, { mode: 0o755 })
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, ARTIUM_TEST_BUILDER: '', NODE_OPTIONS: `--import=${preload}`, PATH: `${directory}:${process.env.PATH}`, DOCKER_LOG: log },
        encoding: 'utf8', timeout: 120_000,
      })
      expect(result.error).toBeUndefined()
      const requests: string[][] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const run = requests.find(args => args[0] === 'run')!
      expect(run[run.indexOf('--cpus') + 1]).toBe('4')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000,
)
