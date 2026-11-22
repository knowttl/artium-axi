import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const roots = ['src', 'test']
const fixedSleep = 'fixed sleep: wait for the observable outcome instead'
const callCount = 'call-count assertion: assert the outcome, not how often a collaborator was called'
const failures: string[] = []

function git(args: string[], allowNoMatch = false) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status === 0) return result.stdout
  if (allowNoMatch && result.status === 1) return ''
  throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`)
}

let base = ''
for (const name of ['origin/main', 'main']) {
  const ref = git(['rev-parse', '--verify', '--quiet', name], true).trim()
  if (!ref) continue
  base = git(['merge-base', ref, 'HEAD'], true).trim()
  if (base) break
}
if (!base) throw new Error('flaky-test-patterns: no merge base with origin/main or main')

type LineRange = { start: number, end: number }
const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']
const tracked = git([...diff, '--name-only', '--diff-filter=d', '-z', base, '--', ...roots])
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...roots])
const added = new Map<string, LineRange[]>()
for (const file of tracked.split('\0').filter(file => file.endsWith('.test.ts'))) {
  const patch = git(['--literal-pathspecs', ...diff, '--unified=0', '--inter-hunk-context=0', base, '--', file])
  const ranges: LineRange[] = []
  for (const [, first, length] of patch.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(first)
    const count = length === undefined ? 1 : Number(length)
    if (count) ranges.push({ start, end: start + count - 1 })
  }
  if (ranges.length) added.set(file, ranges)
}
for (const file of untracked.split('\0').filter(file => file.endsWith('.test.ts'))) {
  added.set(file, [{ start: 1, end: Infinity }])
}

function timeoutClock(statement: ts.Node): boolean | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return
  const { expression, arguments: [options] } = statement.expression
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression) ||
      !['vi', 'vitest'].includes(expression.expression.text)) return
  if (expression.name.text === 'useRealTimers') return false
  if (expression.name.text !== 'useFakeTimers') return
  if (!options) return true
  if (!ts.isObjectLiteralExpression(options) || !options.properties.every(ts.isPropertyAssignment)) return false
  const toFake = options.properties.find(property =>
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'toFake')
  if (!toFake) return true
  return ts.isArrayLiteralExpression(toFake.initializer) &&
    toFake.initializer.elements.some(timer => ts.isStringLiteral(timer) && timer.text === 'setTimeout')
}

function resolvesOnTimeout(awaited: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(awaited)) awaited = awaited.expression
  if (!ts.isNewExpression(awaited) || !ts.isIdentifier(awaited.expression) || awaited.expression.text !== 'Promise') return false
  const executor = awaited.arguments?.[0]
  if (!executor || (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor))) return false
  const resolve = executor.parameters[0]?.name
  if (!resolve || !ts.isIdentifier(resolve)) return false

  const namesResolver = (node: ts.Node) => ts.isIdentifier(node) && node.text === resolve.text
  const callsResolver = (node: ts.Node): boolean => !ts.isFunctionLike(node) &&
    ((ts.isCallExpression(node) && namesResolver(node.expression)) || ts.forEachChild(node, callsResolver) === true)
  const schedulesResolution = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'setTimeout') {
      const callback = node.arguments[0]
      if (callback && (namesResolver(callback) ||
          ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callsResolver(callback.body)))) return true
    }
    return ts.forEachChild(node, schedulesResolution) === true
  }
  return schedulesResolution(executor.body)
}

for (const [file, ranges] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1
  const findings: { node: ts.Node, at: number, message: string }[] = []
  const visit = (node: ts.Node, fakeTimeout: boolean): boolean => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (const statement of node.statements) fakeTimeout = visit(statement, fakeTimeout)
      return fakeTimeout
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : ''
      if (name === 'waitForTimeout') findings.push({ node, at: node.getStart(), message: fixedSleep })
      if (ts.isPropertyAccessExpression(callee) && (name === 'toHaveBeenCalledTimes' || name === 'toHaveBeenCalledOnce')) {
        findings.push({ node, at: callee.name.getStart(), message: callCount })
      }
    }
    if (ts.isAwaitExpression(node) && !fakeTimeout && resolvesOnTimeout(node.expression)) {
      findings.push({ node, at: node.getStart(), message: fixedSleep })
    }
    const separateExecution = ts.isFunctionLike(node)
    let stillFake = fakeTimeout
    ts.forEachChild(node, child => {
      if (!visit(child, !separateExecution && fakeTimeout)) stillFake = false
    })
    return timeoutClock(node) ?? (separateExecution ? fakeTimeout : stillFake)
  }
  visit(source, false)
  for (const { node, at, message } of findings) {
    if (ranges.some(({ start, end }) => start <= lineOf(node.end) && end >= lineOf(node.getStart()))) {
      failures.push(`${file}:${lineOf(at)}: ${message}`)
    }
  }
}

if (failures.length) throw new Error(failures.join('\n'))
console.log('Flaky-test patterns: changed tests wait for outcomes and assert behaviour, not call counts')
