import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.each(['scripts/build-fake-service-image.mjs', 'scripts/container-checks.mjs'])(
  '%s requests four CPUs from a four-CPU Docker daemon', script => {
    const directory = mkdtempSync(join(process.cwd(), '.tmp-host-limits-'))
    try {
      const log = join(directory, 'docker.jsonl')
      writeFileSync(join(directory, 'docker'), `#!${process.execPath}\nimport { appendFileSync } from 'node:fs'\nconst args = process.argv.slice(2)\nappendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n')\nif (args[0] === 'info' && args[2] === '{{json .}}') console.log(JSON.stringify({ NCPU: 4, MemTotal: 4 * 2 ** 30 }))\nprocess.exit(args[0] === 'info' || args[0] === 'rm' ? 0 : 1)\n`, { mode: 0o755 })
      const result = spawnSync(process.execPath, [script], {
        env: { ...process.env, ARTIUM_TEST_BUILDER: '', PATH: `${directory}:${process.env.PATH}`, DOCKER_LOG: log },
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

test('Docker daemon memory and CPU limits cap requests', () => {
  const directory = mkdtempSync(join(process.cwd(), '.tmp-host-limits-'))
  try {
    writeFileSync(join(directory, 'docker'), `#!${process.execPath}\nconsole.log(JSON.stringify({ NCPU: 4, MemTotal: 4 * 2 ** 30 }))\n`, { mode: 0o755 })
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import { cpuLimit, memoryLimit } from './scripts/host-limits.mjs'; console.log(JSON.stringify([cpuLimit(6), cpuLimit(2), memoryLimit(6144), memoryLimit(256)]))"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['4', '2', '4096m', '256m'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
