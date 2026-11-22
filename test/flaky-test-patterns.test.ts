import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

let directory: string
const checker = resolve('scripts/flaky-test-patterns.ts')
const legacy = 'expect(run).toHaveBeenCalledTimes(1)\nawait new Promise(resolve => setTimeout(resolve, 50))\n'
const callCount = 'call-count assertion: assert the outcome, not how often a collaborator was called'
const fixedSleep = 'fixed sleep: wait for the observable outcome instead'

function write(path: string, text: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true })
  writeFileSync(join(directory, path), text)
}

function git(...args: string[]) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function lint() {
  return spawnSync(process.execPath, ['scripts/flaky-test-patterns.ts'], { cwd: directory, encoding: 'utf8' })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-flaky-'))
  write('.gitignore', 'node_modules\n')
  mkdirSync(join(directory, 'scripts'))
  copyFileSync(checker, join(directory, 'scripts/flaky-test-patterns.ts'))
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
  write('src/server/example.test.ts', 'export {}\n')
  write('src/server/legacy.test.ts', legacy)
  write('src/server/helper.ts', 'export {}\n')
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture baseline')
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

test.each([
  { name: 'a call-count assertion', path: 'src/server/example.test.ts',
    text: 'export {}\nexpect(run).toHaveBeenCalledTimes(2)\n', report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a single-call assertion', path: 'src/server/example.test.ts',
    text: 'export {}\nexpect(run).toHaveBeenCalledOnce()\n', report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a timer-backed promise wait', path: 'src/server/example.test.ts',
    text: 'export {}\nawait new Promise(resolve => setTimeout(resolve, 50))\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a browser timeout wait', path: 'src/server/example.test.ts',
    text: 'export {}\nawait page.waitForTimeout(100)\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'an edit inside an existing call-count assertion', path: 'src/server/legacy.test.ts',
    text: legacy.replace('(1)', '(2)'), report: `src/server/legacy.test.ts:1: ${callCount}` },
  { name: 'a new untracked test file', path: 'test/new.test.ts',
    text: 'expect(run).toHaveBeenCalledTimes(1)\n', report: `test/new.test.ts:1: ${callCount}` },
])('rejects $name', ({ path, text, report }) => {
  write(path, text)
  const result = lint()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(report)
})

test.each([
  { name: 'violations on lines the change leaves alone', path: 'src/server/legacy.test.ts', text: legacy + 'export {}\n' },
  { name: 'a promise wait under a fake clock', path: 'src/server/example.test.ts',
    text: 'vi.useFakeTimers()\nawait new Promise(resolve => setTimeout(resolve, 50))\n' },
  { name: 'timer scheduling that is not awaited', path: 'src/server/example.test.ts',
    text: 'setTimeout(() => finish(), 50)\ntest.setTimeout(5000)\n' },
  { name: 'assertions that do not count calls', path: 'src/server/example.test.ts',
    text: 'expect(run).toHaveBeenCalled()\nexpect(run).toHaveBeenCalledWith(1)\n' },
  { name: 'code outside test files', path: 'src/server/helper.ts', text: 'await new Promise(resolve => setTimeout(resolve, 50))\n' },
])('accepts $name', ({ path, text }) => {
  write(path, text)
  const result = lint()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Flaky-test patterns')
})
