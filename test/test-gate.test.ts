import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { decode } from '@toon-format/toon'
import { afterEach, beforeEach, expect, test } from 'vitest'

let directory: string
let base: string
const selector = resolve('scripts/test-gate.mjs')

function write(path: string, text: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true })
  writeFileSync(join(directory, path), text)
}

function git(...args: string[]) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function plan(...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/test-gate.mjs', '--plan', ...args], { cwd: directory, encoding: 'utf8' })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  return decode(result.stdout) as { mode: string; base: string | null; changed: string[];
    tests: string[]; checks: string[][]; inputSha256: string; reasons: string[] }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-gate-'))
  write('.gitignore', 'node_modules\n')
  write('scripts/errors-reference.mjs', "import { writeFileSync } from 'node:fs'; writeFileSync('checked', 'reference current')\n")
  copyFileSync(selector, join(directory, 'scripts/test-gate.mjs'))
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
  write('docs/guide.md', '# Guide\n')
  write('docs/errors.md', '# Synthetic error reference\n')
  write('docs/awx-parity-matrix.md', '# Synthetic parity matrix\n')
  write('README.md', '# Package\n')
  write('src/server/feature.ts', 'export const value = 1\n')
  write('src/server/bridge.ts', "export { value } from './feature.js'\n")
  write('src/server/feature.test.ts', "import { value } from './bridge.js'\n")
  write('src/server/dynamic.test.ts', "const module = await import('./bridge.js')\n")
  write('src/server/unrelated.test.ts', 'export {}\n')
  write('src/cli/session.ts', 'export const value = 1\n')
  write('src/cli/session.test.ts', "import { value } from './session.js'\n")
  write('src/shared/api.ts', 'export const value = 1\n')
  write('test/cli.test.ts', 'export {}\n')
  write('test/client-package.test.ts', 'export {}\n')
  write('test/npm-package.test.ts', 'export {}\n')
  for (const name of ['api', 'beyondtrust', 'checkpoint', 'cli-auth', 'file-input', 'hybrid',
    'mg-mail-transfers', 'tool-skills', 'transfers']) {
    write(`test/integration/${name}.test.ts`, 'export {}\n')
  }
  write('tools/inventories/example.json', '{}\n')
  write('skill/artium-axi/SKILL.md', '# Runtime skill\n')
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture baseline')
  base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

test('documentation selects only generated-reference validation', () => {
  write('docs/guide.md', '# Updated guide\n')
  expect(plan()).toMatchObject({ mode: 'docs', base, tests: [], checks: [['node', 'scripts/errors-reference.mjs']] })
})

test.each([
  { path: 'docs/awx-parity-matrix.md', checks: [['node', 'scripts/errors-reference.mjs'], ['node', 'scripts/awx-parity.mjs']] },
  { path: 'docs/errors.md', checks: [['node', 'scripts/errors-reference.mjs']] },
])('changing $path selects its freshness checker without runtime tests', ({ path, checks }) => {
  write(path, '# Stale generated reference\n')
  expect(plan()).toMatchObject({ mode: 'docs', tests: [], checks })
})

test.each([
  { path: 'docs/awx-parity-matrix.md', checks: [['node', 'scripts/errors-reference.mjs'], ['node', 'scripts/awx-parity.mjs']] },
  { path: 'docs/errors.md', checks: [['node', 'scripts/errors-reference.mjs']] },
])('deleting $path selects its freshness checker without runtime tests', ({ path, checks }) => {
  unlinkSync(join(directory, path))
  expect(plan()).toMatchObject({ mode: 'docs', tests: [], checks })
})

test.each([
  ['src/cli/session.ts', 'export const value = 2\n'],
  ['skill/artium-axi/SKILL.md', '# Updated runtime guidance\n'],
])('%s retains all bundle consumers and installed-package journeys', (path, content) => {
  write(path, content)
  expect(plan()).toMatchObject({ mode: 'affected', tests: [
    'src/cli/session.test.ts', 'test/cli.test.ts', 'test/client-package.test.ts',
    'test/integration/api.test.ts', 'test/integration/beyondtrust.test.ts', 'test/integration/checkpoint.test.ts',
    'test/integration/cli-auth.test.ts', 'test/integration/file-input.test.ts', 'test/integration/hybrid.test.ts',
    'test/integration/mg-mail-transfers.test.ts', 'test/integration/tool-skills.test.ts',
    'test/integration/transfers.test.ts', 'test/npm-package.test.ts',
  ] })
})

test('server changes include transitive re-exports, dynamic imports and public API journeys', () => {
  write('src/server/feature.ts', 'export const value = 2\n')
  expect(plan()).toMatchObject({ mode: 'affected', tests: [
    'src/server/dynamic.test.ts', 'src/server/feature.test.ts', 'test/cli.test.ts',
    'test/integration/api.test.ts', 'test/integration/beyondtrust.test.ts', 'test/integration/checkpoint.test.ts',
    'test/integration/cli-auth.test.ts', 'test/integration/file-input.test.ts', 'test/integration/hybrid.test.ts',
    'test/integration/mg-mail-transfers.test.ts', 'test/integration/tool-skills.test.ts',
    'test/integration/transfers.test.ts',
  ] })
})

test.each(['src/shared/api.ts', 'pnpm-lock.yaml', 'tools/inventories/example.json',
  'src/server/store/migrations/001.sql', 'test/fixtures/input.json', 'unowned.txt',
  '.github/workflows/release.yml', 'package.json', 'scripts/build-cli.mjs'])(
  '%s requires the full suite', path => {
    write(path, '{"changed":true}\n')
    expect(plan()).toMatchObject({ mode: 'full', checks: [
      ['node', 'scripts/errors-reference.mjs'], ['node', 'scripts/upstream-inventory.mjs'],
      ['node', 'scripts/mg-headless-schema.mjs'], ['pnpm', 'lint'], ['pnpm', 'exec', 'vitest', 'run'],
    ] })
  })

test('README changes retain the installed-package journeys without server tests', () => {
  write('README.md', '# Updated package documentation\n')
  expect(plan()).toMatchObject({ mode: 'affected', tests: ['test/client-package.test.ts', 'test/npm-package.test.ts'],
    checks: [['node', 'scripts/errors-reference.mjs'], ['pnpm', 'exec', 'vitest', 'run',
      'test/client-package.test.ts', 'test/npm-package.test.ts']] })
})

test('staged, unstaged and untracked inputs all contribute to selection and identity', () => {
  write('docs/guide.md', '# Staged guide\n')
  git('add', 'docs/guide.md')
  write('src/cli/session.ts', 'export const value = 2\n')
  const initial = plan()
  write('test/new.test.ts', 'export {}\n')
  expect(plan()).toMatchObject({ mode: 'affected', changed: ['docs/guide.md', 'src/cli/session.ts', 'test/new.test.ts'],
    tests: expect.arrayContaining(['test/new.test.ts']) })
  expect(plan().inputSha256).not.toBe(initial.inputSha256)
})

test('deleted runtime input falls back instead of losing old graph edges', () => {
  unlinkSync(join(directory, 'src/server/feature.ts'))
  expect(plan()).toMatchObject({ mode: 'full', reasons: ['deleted runtime input: src/server/feature.ts'] })
})

test('missing base falls back instead of accepting documentation-only evidence', () => {
  write('docs/guide.md', '# Guide changed\n')
  expect(plan('--base', 'missing-revision')).toMatchObject({ mode: 'full', base: null,
    reasons: ['missing or ambiguous ancestor base'] })
})

test('non-ancestor base falls back', () => {
  write('docs/guide.md', '# Future guide\n')
  git('add', '.')
  git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Future fixture')
  const future = git('rev-parse', 'HEAD')
  git('checkout', '--quiet', base)
  expect(plan('--base', future)).toMatchObject({ mode: 'full', base: null })
})

test('empty selection requires the full suite', () => {
  expect(plan()).toMatchObject({ mode: 'full', reasons: ['empty affected selection'] })
})

test('multiple merge bases fall back instead of choosing one arbitrarily', () => {
  const tree = git('rev-parse', `${base}^{tree}`)
  const left = git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    'commit-tree', tree, '-p', base, '-m', 'Left')
  const right = git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    'commit-tree', tree, '-p', base, '-m', 'Right')
  const local = git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    'commit-tree', tree, '-p', left, '-p', right, '-m', 'Local merge')
  const remote = git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    'commit-tree', tree, '-p', right, '-p', left, '-m', 'Remote merge')
  git('update-ref', 'HEAD', local)
  git('update-ref', 'refs/remotes/origin/main', remote)
  expect(plan()).toMatchObject({ mode: 'full', base: null, reasons: ['missing or ambiguous ancestor base'] })
})

test('release and periodic full override includes otherwise unrelated tests', () => {
  write('docs/guide.md', '# Guide changed\n')
  expect(plan('--full')).toMatchObject({ mode: 'full', reasons: ['explicit full suite'],
    tests: expect.arrayContaining(['src/server/unrelated.test.ts']) })
})

test('the executable runs the selected reference check', () => {
  write('docs/guide.md', '# Guide changed\n')
  const result = spawnSync(process.execPath, ['scripts/test-gate.mjs'], { cwd: directory, encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(readFileSync(join(directory, 'checked'), 'utf8')).toBe('reference current')
})

test('a failing selected check stops the gate with its exit status', () => {
  write('scripts/errors-reference.mjs', 'process.exit(17)\n')
  git('add', 'scripts/errors-reference.mjs')
  git('-c', 'user.name=Synthetic Developer', '-c', 'user.email=developer@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Failing boundary fixture')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  write('docs/guide.md', '# Guide changed\n')
  const result = spawnSync(process.execPath, ['scripts/test-gate.mjs'], { cwd: directory, encoding: 'utf8' })
  expect(result.status).toBe(17)
})

test('unknown flags fail before execution', () => {
  const result = spawnSync(process.execPath, ['scripts/test-gate.mjs', '--typo'], { cwd: directory, encoding: 'utf8' })
  expect(result.status).toBe(2)
  expect(decode(result.stdout)).toMatchObject({ error: "Unknown option '--typo'" })
})
