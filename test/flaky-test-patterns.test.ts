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
  write('src/server/helper.ts', legacy)
  write('test/browser/example.ts', "import { fragment as script } from './fragment.mjs'\nbrowser(`${script}`)\n")
  write('test/browser/fragment.mjs', 'export const fragment = `\n  await page.open(base)\n`\n')
  git('init', '--quiet')
  git('config', 'core.quotePath', 'true')
  git('add', '.')
  git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture baseline')
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

test.each<{ name: string, path: string, text: string, report: string | string[], absent?: string, staged?: boolean, noPrefix?: boolean }>([
  { name: 'a call-count assertion', path: 'src/server/example.test.ts',
    text: 'export {}\nexpect(run).toHaveBeenCalledTimes(2)\n', report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a single-call assertion', path: 'src/server/example.test.ts',
    text: 'export {}\nexpect(run).toHaveBeenCalledOnce()\n', report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'an exact length check on a mock call list', path: 'src/server/example.test.ts',
    text: 'expect(run.mock.calls).toHaveLength(1)\n', report: `src/server/example.test.ts:1: ${callCount}` },
  { name: 'a direct assertion on the number of stream writes', path: 'src/server/example.test.ts',
    text: "const output = vi.spyOn(process.stderr, 'write')\nexpect(output.mock.calls.length).toBe(1)\n",
    report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'the toBeCalledTimes alias', path: 'src/server/example.test.ts',
    text: 'export {}\nexpect(run).toBeCalledTimes(2)\n', report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'an exact single-call assertion', path: 'src/server/example.test.ts',
    text: 'expect(run).toHaveBeenCalledExactlyOnceWith(1)\n', report: `src/server/example.test.ts:1: ${callCount}` },
  { name: 'a stream spy count greater than one', path: 'src/server/example.test.ts',
    text: "const output = vi.spyOn(process.stderr, 'write')\nexpect(output.mock.calls).toHaveLength(2)\n",
    report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a bare stream spy length', path: 'src/server/example.test.ts',
    text: "const output = vi.spyOn(process.stderr, 'write')\nexpect(output.mock.calls).toHaveLength(1)\n",
    report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a multiline stream write', path: 'src/server/example.test.ts',
    text: "const output = vi.spyOn(process.stdout, 'write')\nexpect(output).toHaveBeenCalledExactlyOnceWith('one\\ntwo\\n')\n",
    report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a negated stream spy count', path: 'src/server/example.test.ts',
    text: "const output = vi.spyOn(process.stdout, 'write')\nexpect(output).not.toHaveBeenCalledOnce()\n",
    report: `src/server/example.test.ts:2: ${callCount}` },
  { name: 'a timer-backed promise wait', path: 'src/server/example.test.ts',
    text: 'export {}\nawait new Promise(resolve => setTimeout(resolve, 50))\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a timer-backed wait qualified with globalThis', path: 'src/server/example.test.ts',
    text: 'await new Promise(resolve => globalThis.setTimeout(resolve, 50))\n', report: `src/server/example.test.ts:1: ${fixedSleep}` },
  { name: 'a timer callback that resolves the promise', path: 'src/server/example.test.ts',
    text: 'export {}\nawait new Promise(done => setTimeout(() => { done() }, 50))\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a timer-only wait with a false result', path: 'src/server/example.test.ts',
    text: 'await new Promise(resolve => setTimeout(() => resolve(false), 50))\n', report: `src/server/example.test.ts:1: ${fixedSleep}` },
  { name: 'a timer-only wait settled through a helper', path: 'src/server/example.test.ts',
    text: 'await new Promise(resolve => { const finish = value => resolve(value); setTimeout(() => finish(false), 50) })\n',
    report: `src/server/example.test.ts:1: ${fixedSleep}` },
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
  { name: 'a test registered before the module restores real timers', path: 'src/server/example.test.ts',
    text: "vi.useFakeTimers()\ntest('real', () => new Promise(done => setTimeout(done, 50)))\nvi.useRealTimers()\n",
    report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a timeout after restoring a setup hook clock', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers())\ntest('restored', async () => {\n  vi.useRealTimers()\n  await new Promise(done => setTimeout(done, 50))\n})\n",
    report: `src/server/example.test.ts:4: ${fixedSleep}` },
  { name: 'a timeout in a sibling test with real timers', path: 'src/server/example.test.ts',
    text: "test('fake', async () => {\n  vi.useFakeTimers()\n  await new Promise(done => setTimeout(done, 50))\n  vi.useRealTimers()\n})\ntest('real', async () => {\n  await new Promise(done => setTimeout(done, 50))\n})\n",
    report: `src/server/example.test.ts:7: ${fixedSleep}`, absent: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a real timer after per-test cleanup', path: 'src/server/example.test.ts',
    text: "beforeAll(() => vi.useFakeTimers())\nafterEach(() => vi.useRealTimers())\ntest('first', () => {})\ntest('second', () => new Promise(done => setTimeout(done, 50)))\n",
    report: `src/server/example.test.ts:4: ${fixedSleep}` },
  { name: 'a real timer after a skipped setup test', path: 'src/server/example.test.ts',
    text: "test('setup', { skip: true }, () => { vi.useFakeTimers() })\ntest('wait', () => new Promise(done => setTimeout(done, 50)))\n",
    report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a real timer after a skipped setup suite', path: 'src/server/example.test.ts',
    text: "describe('setup', { skip: true }, () => { beforeAll(() => vi.useFakeTimers()); test('setup', () => {}) })\ntest('wait', () => new Promise(done => setTimeout(done, 50)))\n",
    report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a real timer after nested suite cleanup', path: 'src/server/example.test.ts',
    text: "vi.useFakeTimers()\ndescribe('first', () => {\n  test('first', () => {})\n  afterAll(() => vi.useRealTimers())\n})\ntest('second', async () => { await new Promise(done => setTimeout(done, 50)) })\n",
    report: `src/server/example.test.ts:6: ${fixedSleep}` },
  { name: 'a real timer on the second table row', path: 'src/server/example.test.ts',
    text: "beforeAll(() => vi.useFakeTimers())\nafterEach(() => vi.useRealTimers())\ntest.each([1, 2])('row %s', () => new Promise(done => setTimeout(done, 50)))\n",
    report: `src/server/example.test.ts:3: ${fixedSleep}` },
  { name: 'a browser timeout wait', path: 'src/server/example.test.ts',
    text: 'export {}\nawait page.waitForTimeout(100)\n', report: `src/server/example.test.ts:2: ${fixedSleep}` },
  { name: 'a fixed wait in an interpolated browser script', path: 'test/browser/example.ts',
    text: 'browser(`\n  if (${\n    condition\n  }) await page.eval(async () => { await new Promise(done => setTimeout(done, 50)) })\n`)\n',
    report: `test/browser/example.ts:4: ${fixedSleep}` },
  { name: 'a fixed wait in a named browser script', path: 'test/browser/example.ts',
    text: 'const script = `\n  await new Promise(done => setTimeout(done, 50))\n`\nbrowser(script)\n',
    report: `test/browser/example.ts:2: ${fixedSleep}` },
  { name: 'a fixed wait in an interpolated browser fragment', path: 'test/browser/example.ts',
    text: 'const delay = `\n  await new Promise(done => setTimeout(done, 50))\n`\nconst script = `${delay}\n  await page.open(base)\n`\nbrowser(script)\n',
    report: `test/browser/example.ts:2: ${fixedSleep}` },
  { name: 'a fixed wait in a quoted browser fragment', path: 'test/browser/example.ts',
    text: "const delay = '(\\u0061wait new Promise(done => setTimeout(done, 50)), true)'\nbrowser(`check(${delay}, 'result')`)\n",
    report: `test/browser/example.ts:1: ${fixedSleep}` },
  { name: 'fixed waits in both branches of a conditional browser fragment', path: 'test/browser/example.ts',
    text: 'browser(`\n  ${condition ? `await new Promise(done => setTimeout(done, 50));`\n    : `await new Promise(done => setTimeout(done, 60));`}\n`)\n',
    report: [`test/browser/example.ts:2: ${fixedSleep}`, `test/browser/example.ts:3: ${fixedSleep}`] },
  { name: 'a fixed wait passed through a browser script builder', path: 'test/browser/example.ts',
    text: 'const compose = (script: string) => `await page.open(base); ${script}`\nbrowser(compose(`\n  await new Promise(done => setTimeout(done, 50))\n`))\n',
    report: `test/browser/example.ts:3: ${fixedSleep}` },
  { name: 'fixed waits on both sides of a browser script concatenation', path: 'test/browser/example.ts',
    text: 'const compose = (script: string) => `await page.open(base); ${script}`\nchrome(["run"], compose(`\n  await new Promise(done => setTimeout(done, 50))\n`) + `\n  await new Promise(done => setTimeout(done, 60))\n`)\n',
    report: [`test/browser/example.ts:3: ${fixedSleep}`, `test/browser/example.ts:5: ${fixedSleep}`] },
  { name: 'a changed browser fragment with an unchanged importing caller', path: 'test/browser/fragment.mjs',
    text: 'export const fragment = `\n  await new Promise(done => setTimeout(done, 50))\n`\n',
    report: `test/browser/fragment.mjs:2: ${fixedSleep}` },
  { name: 'a timer returned by page.eval', path: 'test/browser/example.ts',
    text: 'browser(`\n  await page.eval(() => new Promise(done => setTimeout(done, 50)))\n`)\n',
    report: `test/browser/example.ts:2: ${fixedSleep}` },
  { name: 'a timer returned by page.eval in a browser source file', path: 'test/browser/example.mjs',
    text: 'await page.eval(() => new Promise(done => setTimeout(done, 50)))\n',
    report: `test/browser/example.mjs:1: ${fixedSleep}` },
  { name: 'a window timer returned from a quoted page.eval callback', path: 'test/browser/example.ts',
    text: "browser(`\n  await page.eval('() => new Promise(done => window.setTimeout(done, 50))')\n`)\n",
    report: `test/browser/example.ts:2: ${fixedSleep}` },
  { name: 'a timer returned from a concatenated quoted page.eval script', path: 'test/browser/example.ts',
    text: "browser(`\n  await page.eval('(() => { const files = [' + \${JSON.stringify(files)}\n    + ']; return new Promise(done => setTimeout(done, 50)); })()')\n`)\n",
    report: `test/browser/example.ts:3: ${fixedSleep}`, absent: 'test/browser/example.ts:2:' },
  { name: 'a serialized timer returned by page.eval in an imported fragment', path: 'test/browser/fragment.mjs',
    text: "export const fragment = `\n  await page.eval('() => (' + (() => {\n    return new Promise(done => setTimeout(done, 50));\n  }).toString() + ')()');\n`\n",
    report: `test/browser/fragment.mjs:3: ${fixedSleep}` },
  { name: 'a serialized timer from an expression body', path: 'test/browser/example.ts',
    text: "browser(`\n  await page.eval('() => (' + (() => new Promise(done => setTimeout(done, 50))).toString() + ')()');\n`)\n",
    report: `test/browser/example.ts:2: ${fixedSleep}` },
  { name: 'a timer returned from a browser setup hook', path: 'test/browser/example.mjs',
    text: "import { setTimeout as delay } from 'node:timers/promises'\nbefore(() => delay(50))\n",
    report: `test/browser/example.mjs:2: ${fixedSleep}` },
  { name: 'a timer returned from a browser test cleanup hook', path: 'test/browser/example.ts',
    text: 'test("close", context => { context.after(() => { return new Promise(done => setTimeout(done, 50)) }) })\n',
    report: `test/browser/example.ts:1: ${fixedSleep}` },
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
  for (const diagnostic of [report].flat()) expect(result.stderr).toContain(diagnostic)
  if (absent) expect(result.stderr).not.toContain(absent)
})

test.each([
  { name: 'violations on lines the change leaves alone', path: 'src/server/legacy.test.ts', text: legacy + 'export {}\n' },
  { name: 'a promise wait under the default fake clock', path: 'src/server/example.test.ts',
    text: "test('advance time', async () => {\n  vi.useFakeTimers()\n  await new Promise(done => setTimeout(done, 50))\n})\n" },
  { name: 'a promise wait with setTimeout explicitly faked', path: 'src/server/example.test.ts',
    text: "vi.useFakeTimers({ toFake: ['setTimeout'] })\nawait new Promise(done => setTimeout(done, 50))\n" },
  { name: 'a test registered before the module enables virtual time', path: 'src/server/example.test.ts',
    text: "test('advance', async () => {\n  void vi.advanceTimersByTimeAsync(50)\n  await new Promise(done => setTimeout(done, 50))\n})\nvi.useFakeTimers()\n" },
  { name: 'a returned virtual wait under beforeAll in a nested suite', path: 'src/server/example.test.ts',
    text: "beforeAll(() => vi.useFakeTimers())\ndescribe('nested', () => {\n  test('advance', () => {\n    void vi.advanceTimersByTimeAsync(50)\n    return new Promise(done => setTimeout(done, 50))\n  })\n})\n" },
  { name: 'a virtual wait in cleanup before the clock is restored', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers())\nafterEach(() => vi.useRealTimers())\nafterEach(() => {\n  void vi.advanceTimersByTimeAsync(50)\n  return new Promise(done => setTimeout(done, 50))\n})\ntest('first', () => {})\ntest('second', () => {})\n" },
  { name: 'a virtual wait under an enclosing setup hook', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))\ndescribe('suite', () => {\n  test('advance time', async () => {\n    const tick = vi.advanceTimersByTimeAsync(50)\n    await new Promise(done => setTimeout(done, 50))\n    await tick\n  })\n})\n" },
  { name: 'a local fake clock with an empty timer list', path: 'src/server/example.test.ts',
    text: 'vi.useFakeTimers({ toFake: [] })\nvoid vi.advanceTimersByTimeAsync(50)\nawait new Promise(done => setTimeout(done, 50))\n' },
  { name: 'a returned timer under a fake setup clock with an empty list', path: 'src/server/example.test.ts',
    text: "beforeEach(() => vi.useFakeTimers({ toFake: [] }))\ntest('advance time', () => {\n  void vi.advanceTimersByTimeAsync(50)\n  return new Promise(done => setTimeout(done, 50))\n})\n" },
  { name: 'an event wait with a failure deadline', path: 'src/server/example.test.ts',
    text: "await new Promise((resolve, reject) => {\n  const deadline = setTimeout(() => reject(new Error('not ready')), 500)\n  child.once('spawn', () => { clearTimeout(deadline); resolve() })\n})\n" },
  { name: 'an observer wait with a false deadline result', path: 'test/browser/example.ts',
    text: 'browser(`\n  await page.eval(() => new Promise(resolve => {\n    const observer = new MutationObserver(() => resolve(true));\n    const deadline = setTimeout(() => resolve(false), 500);\n    observer.observe(document.body, { childList: true });\n  }));\n`)\n' },
  { name: 'an observer that resolves without a value', path: 'test/browser/example.ts',
    text: 'browser(`\n  await page.eval(() => new Promise(resolve => {\n    const observer = new MutationObserver(() => resolve());\n    const deadline = window.setTimeout(() => resolve(false), 500);\n    observer.observe(document.body, { childList: true });\n  }));\n`)\n' },
  { name: 'an observer and deadline that share a settlement helper', path: 'test/browser/example.ts',
    text: 'browser(`\n  await page.eval(() => new Promise(resolve => {\n    const finish = value => resolve(value);\n    const observer = new MutationObserver(() => finish(true));\n    const deadline = setTimeout(() => finish(false), 500);\n    observer.observe(document.body, { childList: true });\n  }));\n`)\n' },
  ...["test.skip('cleanup', () => vi.useRealTimers())", "test('cleanup', { skip: true }, () => vi.useRealTimers())",
    "describe.skip('cleanup', () => { afterAll(() => vi.useRealTimers()); test('one', () => {}) })",
    "test.skipIf(process.platform !== 'win32')('cleanup', () => vi.useRealTimers())",
    "describe.runIf(process.platform === 'win32')('cleanup', () => { afterAll(() => vi.useRealTimers()); test('one', () => {}) })",
    "test.each([])('cleanup', () => vi.useRealTimers())"].map(cleanup => ({
    name: `virtual time after ${cleanup}`, path: 'src/server/example.test.ts',
    text: `beforeAll(() => vi.useFakeTimers())\n${cleanup}\ntest('advance', () => {\n  void vi.advanceTimersByTimeAsync(50)\n  return new Promise(done => setTimeout(done, 50))\n})\n`,
  })),
  { name: 'an event wait with a named rejection callback', path: 'src/server/example.test.ts',
    text: "await new Promise((resolve, reject) => {\n  const expired = () => reject(new Error('not ready'))\n  const deadline = setTimeout(expired, 500)\n  child.once('spawn', () => { clearTimeout(deadline); resolve() })\n})\n" },
  { name: 'timer scheduling that is not awaited', path: 'src/server/example.test.ts',
    text: 'setTimeout(() => finish(), 50)\ntest.setTimeout(5000)\n' },
  { name: 'assertions that do not count calls', path: 'src/server/example.test.ts',
    text: 'expect(run).toHaveBeenCalled()\nexpect(run).toHaveBeenCalledWith(1)\n' },
  { name: 'a one-line stdout contract', path: 'src/server/example.test.ts',
    text: "const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)\nexpect(output).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(record)}\\n`)\n" },
  { name: 'an uninvoked Vitest matcher', path: 'src/server/example.test.ts',
    text: 'const assertCount = expect(run).toHaveBeenCalledTimes\n' },
  { name: 'an ordinary output length assertion', path: 'src/server/example.test.ts',
    text: 'expect(records).toHaveLength(1)\n' },
  { name: 'page.eval calls in an ordinary Vitest file', path: 'src/server/example.test.ts',
    text: `await page.eval(() => new Promise(done => setTimeout(done, 50)))
await page.eval('() => (' + (() => new Promise(done => setTimeout(done, 50))).toString() + ')()')
await page.eval('() => new Promise(done => setTimeout(done, 50))')
` },
  { name: 'code outside test files', path: 'src/server/helper.ts', text: 'await new Promise(resolve => setTimeout(resolve, 50))\n' },
])('accepts $name', ({ path, text }) => {
  write(path, text)
  const result = lint()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Flaky-test patterns')
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

test('checks a file renamed into test scope', () => {
  const path = 'src/server/helper.test.ts'
  git('mv', 'src/server/helper.ts', path)
  const result = lint()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${path}:2: ${fixedSleep}`)
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

test('lists findings in every in-scope test without failing when no baseline exists, even with a local main', () => {
  git('update-ref', 'refs/heads/main', git('rev-parse', 'HEAD'))
  git('update-ref', '-d', 'refs/remotes/origin/main')
  const result = lint()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('advisory mode')
  expect(result.stdout).toContain(`src/server/legacy.test.ts:1: ${callCount}`)
})
