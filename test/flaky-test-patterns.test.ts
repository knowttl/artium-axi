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

function lint(env = process.env) {
  return spawnSync(process.execPath, ['scripts/flaky-test-patterns.ts'], { cwd: directory, encoding: 'utf8', env })
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
  git('config', 'core.quotePath', 'true')
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
  ...['toBeCalledTimes(2)', 'toHaveBeenCalledExactlyOnceWith(1)', 'to.have.callCount(2)', 'to.have.been.calledOnce', 'to.have.been.calledOnceWith(1)']
    .map(matcher => ({ name: matcher, path: 'src/server/example.test.ts',
      text: `export {}\nexpect(run).${matcher}\n`, report: `src/server/example.test.ts:2: ${callCount}` })),
  { name: 'a timer-backed promise wait', path: 'src/server/example.test.ts',
    text: 'export {}\nawait new Promise(resolve => setTimeout(resolve, 50))\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a timer callback that resolves the promise', path: 'src/server/example.test.ts',
    text: 'export {}\nawait new Promise(done => setTimeout(() => { done() }, 50))\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a named timer callback that resolves the promise', path: 'src/server/example.test.ts',
    text: 'export {}\nawait new Promise(done => { const finish = () => done(); setTimeout(finish, 50) })\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'an aliased promise timer', path: 'src/server/example.test.ts',
    text: "import { setTimeout as delay } from 'node:timers/promises'\nawait delay(50)\n", report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a timer promise returned by an expression-bodied test', path: 'src/server/example.test.ts',
    text: "test('waits', () => new Promise(done => setTimeout(done, 50)))\n", report: `src/server/example.test.ts:1: ${fixedSleep}` },
  { name: 'a promise timer returned explicitly by a test', path: 'src/server/example.test.ts',
    text: "import { setTimeout as delay } from 'node:timers/promises'\ntest('waits', () => {\n  return delay(50)\n})\n",
    report: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a namespaced promise timer', path: 'test/browser/example.mjs',
    text: "import * as timers from 'node:timers/promises'\nawait timers.setTimeout(50)\n", report: `test/browser/example.mjs:2: ${fixedSleep}` },
  { name: 'a timeout under an interval-only fake clock', path: 'src/server/example.test.ts',
    text: "test('intervals', async () => {\n  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })\n  await new Promise(done => setTimeout(done, 50))\n})\n",
    report: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a timeout with an interval-only setup hook', path: 'src/server/example.test.ts',
    text: "beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })\ntest('intervals', async () => {\n  await new Promise(done => setTimeout(done, 50))\n})\n",
    report: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a timeout after restoring real timers', path: 'src/server/example.test.ts',
    text: 'vi.useFakeTimers()\nvi.useRealTimers()\nawait new Promise(done => setTimeout(done, 50))\n',
    report: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a timeout after restoring a setup hook clock', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers())\ntest('restored', async () => {\n  vi.useRealTimers()\n  await new Promise(done => setTimeout(done, 50))\n})\n",
    report: `src/server/example.test.ts:4: ${fixedSleep}` },
  { name: 'a timeout in a sibling test with real timers', path: 'src/server/example.test.ts',
    text: "test('fake', async () => {\n  vi.useFakeTimers()\n  await new Promise(done => setTimeout(done, 50))\n  vi.useRealTimers()\n})\ntest('real', async () => {\n  await new Promise(done => setTimeout(done, 50))\n})\n",
    report: `src/server/example.test.ts:7: ${fixedSleep}`, absent: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a browser timeout wait', path: 'src/server/example.test.ts',
    text: 'export {}\nawait page.waitForTimeout(100)\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a fixed wait in an interpolated browser script', path: 'test/browser/example.ts',
    text: 'browser(`\n  if (${\n    condition\n  }) await page.eval(async () => { await new Promise(done => setTimeout(done, 50)) })\n`)\n',
    report: `test/browser/example.ts:4: ${fixedSleep}` },
  { name: 'an edit inside an existing call-count assertion', path: 'src/server/legacy.test.ts',
    text: legacy.replace('(1)', '(2)'), report: `src/server/legacy.test.ts:1: ${callCount}` },
  { name: 'a new untracked test file', path: 'test/new.test.ts',
    text: 'expect(run).toHaveBeenCalledTimes(1)\n', report: `test/new.test.ts:1: ${callCount}` },
  { name: 'a staged test file with a quoted path', path: 'test/café.test.ts', staged: true,
    text: 'export {}\nexpect(run).toHaveBeenCalledTimes(1)\n', report: `test/café.test.ts:2: ${callCount}` },
  { name: 'a tracked change when Git omits path prefixes', path: 'src/server/example.test.ts', noPrefix: true,
    text: 'export {}\nexpect(run).toHaveBeenCalledTimes(1)\n', report: `src/server/example.test.ts:2: ${callCount}` },
])('rejects $name', ({ path, text, report, staged, noPrefix, absent }) => {
  write(path, text)
  if (staged) git('add', '--', path)
  if (noPrefix) git('config', 'diff.noprefix', 'true')
  const result = lint()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(report)
  if (absent) expect(result.stderr).not.toContain(absent)
})

test.each([
  { name: 'violations on lines the change leaves alone', path: 'src/server/legacy.test.ts', text: legacy + 'export {}\n' },
  { name: 'a promise wait under the default fake clock', path: 'src/server/example.test.ts',
    text: "test('advance time', async () => {\n  vi.useFakeTimers()\n  await new Promise(done => setTimeout(done, 50))\n})\n" },
  { name: 'a promise wait with setTimeout explicitly faked', path: 'src/server/example.test.ts',
    text: "vi.useFakeTimers({ toFake: ['setTimeout'] })\nawait new Promise(done => setTimeout(done, 50))\n" },
  { name: 'a virtual wait under an enclosing setup hook', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))\ndescribe('suite', () => {\n  test('advance time', async () => {\n    const tick = vi.advanceTimersByTimeAsync(50)\n    await new Promise(done => setTimeout(done, 50))\n    await tick\n  })\n})\n" },
  { name: 'a local fake clock with an empty timer list', path: 'src/server/example.test.ts',
    text: 'vi.useFakeTimers({ toFake: [] })\nvoid vi.advanceTimersByTimeAsync(50)\nawait new Promise(done => setTimeout(done, 50))\n' },
  { name: 'a returned timer under a fake setup clock with an empty list', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers({ toFake: [] }))\ntest('advance time', () => {\n  void vi.advanceTimersByTimeAsync(50)\n  return new Promise(done => setTimeout(done, 50))\n})\n" },
  { name: 'an event wait with a failure deadline', path: 'src/server/example.test.ts',
    text: "await new Promise((resolve, reject) => {\n  const deadline = setTimeout(() => reject(new Error('not ready')), 500)\n  child.once('spawn', () => { clearTimeout(deadline); resolve() })\n})\n" },
  { name: 'an event wait with a named rejection callback', path: 'src/server/example.test.ts',
    text: "await new Promise((resolve, reject) => {\n  const expired = () => reject(new Error('not ready'))\n  const deadline = setTimeout(expired, 500)\n  child.once('spawn', () => { clearTimeout(deadline); resolve() })\n})\n" },
  { name: 'timer scheduling that is not awaited', path: 'src/server/example.test.ts',
    text: 'setTimeout(() => finish(), 50)\ntest.setTimeout(5000)\n' },
  { name: 'assertions that do not count calls', path: 'src/server/example.test.ts',
    text: 'expect(run).toHaveBeenCalled()\nexpect(run).toHaveBeenCalledWith(1)\n' },
  { name: 'an uninvoked Vitest matcher', path: 'src/server/example.test.ts',
    text: 'const assertCount = expect(run).toHaveBeenCalledTimes\n' },
  { name: 'code outside test files', path: 'src/server/helper.ts', text: 'await new Promise(resolve => setTimeout(resolve, 50))\n' },
])('accepts $name', ({ path, text }) => {
  write(path, text)
  const result = lint()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Flaky-test patterns')
})

test('allows a public output count without suppressing the next assertion', () => {
  const path = 'src/server/example.test.ts'
  write(path, [
    'test("persists one line", () => {',
    '  // flaky-test-patterns: allow-call-count The public audit stream emits one persisted JSON line per record.',
    '  expect(stdout).toHaveBeenCalledExactlyOnceWith("one line\\n")',
    '  expect(prepare).toHaveBeenCalledTimes(1)',
    '})',
  ].join('\n'))
  const result = lint()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${path}:4: ${callCount}`)
  expect(result.stderr).not.toContain(`${path}:3: ${callCount}`)
})

test('fails when Git cannot enumerate tracked changes', () => {
  const index = join(directory, 'bad-index')
  write('bad-index', 'invalid Git index\n')
  const result = lint({ ...process.env, GIT_INDEX_FILE: index })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('index file')
})

test('accepts a pure rename of a legacy test', () => {
  git('mv', 'src/server/legacy.test.ts', 'src/server/renamed.test.ts')
  const result = lint()
  expect(result.status, result.stderr).toBe(0)
})

test('reports changed lines at a renamed test destination', () => {
  const renamed = 'src/server/renamed.test.ts'
  git('mv', 'src/server/legacy.test.ts', renamed)
  write(renamed, legacy + 'expect(run).toBeCalledTimes(2)\n')
  const result = lint()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${renamed}:3: ${callCount}`)
  expect(result.stderr).not.toContain(`${renamed}:1:`)
  expect(result.stderr).not.toContain(`${renamed}:2:`)
})

test('requires origin/main even when a local main exists', () => {
  git('update-ref', 'refs/heads/main', git('rev-parse', 'HEAD'))
  git('update-ref', '-d', 'refs/remotes/origin/main')
  const result = lint()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('refs/remotes/origin/main')
})
