import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const fixedSleep = 'fixed sleep: wait for the observable outcome instead'
const callCount = 'call-count assertion: assert the outcome, not how often a collaborator was called'
const countMatchers = new Set(['toHaveBeenCalledTimes', 'toBeCalledTimes', 'toHaveBeenCalledOnce', 'toHaveBeenCalledExactlyOnceWith'])
const chaiCountMatchers = new Set(['callCount', 'calledOnce', 'calledOnceWith', 'calledTwice', 'calledThrice'])
const failures: string[] = []

function git(args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status === 0) return result.stdout
  throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`)
}

const bases = git(['merge-base', '--all', 'HEAD', 'refs/remotes/origin/main']).trim().split('\n')
if (bases.length !== 1) throw new Error('flaky-test-patterns: expected a unique merge base with origin/main')
const [base] = bases

const isBrowserFile = (file: string) => /^test\/browser\/[^/]+\.(?:mjs|ts)$/.test(file)
const isTestFile = (file: string) => /^(?:src|test)\/.*\.test\.ts$/s.test(file) || isBrowserFile(file)

type LineRange = { start: number, end: number }
const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']
const tracked = git([...diff, '--name-status', '--diff-filter=d', '-z', base]).split('\0')
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'test'])
const added = new Map<string, LineRange[]>()
for (let index = 0; index < tracked.length - 1;) {
  const status = tracked[index++]
  const count = /^[RC]/.test(status) ? 2 : 1
  const paths = tracked.slice(index, index + count)
  index += count
  const file = paths.at(-1)!
  if (!isTestFile(file)) continue
  const patch = git(['--literal-pathspecs', ...diff, '--unified=0', '--inter-hunk-context=0', base, '--', ...paths])
  const ranges: LineRange[] = []
  for (const [, first, length] of patch.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(first)
    const count = length === undefined ? 1 : Number(length)
    if (count) ranges.push({ start, end: start + count - 1 })
  }
  if (ranges.length) added.set(file, ranges)
}
for (const file of untracked.split('\0').filter(isTestFile)) {
  added.set(file, [{ start: 1, end: Infinity }])
}

function timeoutClock(call: ts.CallExpression): boolean | undefined {
  const { expression, arguments: [options] } = call
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

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  return expression
}

function inlineCallback(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

function resolvesOnTimeout(awaited: ts.Expression): boolean {
  if (!ts.isNewExpression(awaited) || !ts.isIdentifier(awaited.expression) || awaited.expression.text !== 'Promise') return false
  const executor = awaited.arguments?.[0]
  if (!inlineCallback(executor)) return false
  const resolve = executor.parameters[0]?.name
  if (!resolve || !ts.isIdentifier(resolve)) return false

  const namesResolver = (node: ts.Node) => ts.isIdentifier(node) && node.text === resolve.text
  const callsResolver = (node: ts.Node): boolean => !ts.isFunctionLike(node) &&
    ((ts.isCallExpression(node) && namesResolver(node.expression)) || ts.forEachChild(node, callsResolver) === true)
  const resolves = (callback: ts.Expression) => {
    if (namesResolver(callback)) return true
    if (inlineCallback(callback)) return callsResolver(callback.body)
    if (!ts.isIdentifier(callback)) return false
    for (let scope = callback.parent; scope !== executor; scope = scope.parent) {
      if (!ts.isBlock(scope)) continue
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === callback.text) {
          return !!statement.body && callsResolver(statement.body)
        }
        if (!ts.isVariableStatement(statement)) continue
        const local = statement.declarationList.declarations.find(({ name }) => ts.isIdentifier(name) && name.text === callback.text)
        if (local) return inlineCallback(local.initializer) && callsResolver(local.initializer.body)
      }
    }
    return false
  }
  const schedulesResolution = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'setTimeout') {
      const callback = node.arguments[0]
      if (callback && resolves(unwrap(callback))) return true
    }
    return ts.forEachChild(node, schedulesResolution) === true
  }
  return schedulesResolution(executor.body)
}

function rootName(node: ts.Expression): string | undefined {
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) node = node.expression
  if (ts.isIdentifier(node)) return node.text
}

function inspect(source: ts.SourceFile, report: (start: number, end: number, at: number, message: string) => void,
  inspectBrowserScripts = false) {
  const promiseTimers = new Set<string>()
  const timerModules = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !['node:timers/promises', 'timers/promises'].includes(statement.moduleSpecifier.text) || !statement.importClause) continue
    const { name, namedBindings } = statement.importClause
    if (name) timerModules.add(name.text)
    if (namedBindings && ts.isNamespaceImport(namedBindings)) timerModules.add(namedBindings.name.text)
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const binding of namedBindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'setTimeout') promiseTimers.add(binding.name.text)
      }
    }
  }

  const mark = (node: ts.Node, message: string, at = node.getStart(source)) => report(node.getStart(source), node.end, at, message)
  const visitCallback = (callback: ts.ArrowFunction | ts.FunctionExpression, fakeTimeout: boolean): boolean => {
    const after = visit(callback.body, fakeTimeout)
    return (ts.isCallExpression(callback.body) ? timeoutClock(callback.body) : undefined) ?? after
  }
  const visit = (node: ts.Node, fakeTimeout: boolean): boolean => {
    if (ts.isBlock(node)) {
      for (const statement of node.statements) fakeTimeout = visit(statement, fakeTimeout)
      return fakeTimeout
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : ''
      if (name === 'waitForTimeout') mark(node, fixedSleep)
      if (inspectBrowserScripts && ts.isIdentifier(callee)) {
        const [first, second] = node.arguments
        const command = first && ts.isArrayLiteralExpression(first) ? first.elements[0] : undefined
        const script = name === 'browser' ? first : name === 'chrome' && command && ts.isStringLiteral(command) && command.text === 'run' ? second : undefined
        if (script && (ts.isNoSubstitutionTemplateLiteral(script) || ts.isTemplateExpression(script))) {
          const start = script.getStart(source) + 1
          let text = source.text.slice(start, script.end - 1)
          if (ts.isTemplateExpression(script)) {
            let from = script.head.end - 2
            for (const span of script.templateSpans) {
              const to = span.literal.getStart(source) + 1
              text = text.slice(0, from - start) + '0' + source.text.slice(from + 1, to).replace(/[^\r\n]/g, ' ') + text.slice(to - start)
              from = span.literal.end - 2
            }
          }
          inspect(ts.createSourceFile('browser-script.js', text, ts.ScriptTarget.Latest, true),
            (first, end, at, message) => report(first + start, end + start, at + start, message))
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const { text: name } = node.name
      if (countMatchers.has(name) || (chaiCountMatchers.has(name) && rootName(node.expression) === 'expect')) {
        const assertion = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : node
        mark(assertion, callCount, node.name.getStart(source))
      }
    }
    if (ts.isAwaitExpression(node) && !fakeTimeout) {
      const awaited = unwrap(node.expression)
      const callee = ts.isCallExpression(awaited) ? unwrap(awaited.expression) : undefined
      const promiseTimer = callee && (ts.isIdentifier(callee) ? promiseTimers.has(callee.text) :
        ts.isPropertyAccessExpression(callee) && callee.name.text === 'setTimeout' &&
        ts.isIdentifier(callee.expression) && timerModules.has(callee.expression.text))
      if (promiseTimer || resolvesOnTimeout(awaited)) mark(node, fixedSleep)
    }
    const separateExecution = ts.isFunctionLike(node)
    let stillFake = fakeTimeout
    ts.forEachChild(node, child => {
      if (!visit(child, !separateExecution && fakeTimeout)) stillFake = false
    })
    const change = ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) ? timeoutClock(node.expression) : undefined
    return change ?? (separateExecution ? fakeTimeout : stillFake)
  }

  const visitSuite = (statements: ts.NodeArray<ts.Statement>, inheritedClock: boolean): void => {
    const registrations = new Map<ts.Statement, { name: string, callback: ts.ArrowFunction | ts.FunctionExpression }>()
    let testClock = inheritedClock
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
      const { expression, arguments: args } = statement.expression
      const name = rootName(expression)
      const callback = args.find(inlineCallback)
      if (!name || !callback || !['beforeEach', 'test', 'it', 'describe', 'suite'].includes(name)) continue
      registrations.set(statement, { name, callback })
      if (name === 'beforeEach') testClock = visitCallback(callback, testClock)
    }
    let fakeTimeout = false
    for (const statement of statements) {
      const registration = registrations.get(statement)
      if (!registration) {
        fakeTimeout = visit(statement, fakeTimeout)
        continue
      }
      const { name, callback } = registration
      if (name === 'beforeEach') continue
      if ((name === 'describe' || name === 'suite') && ts.isBlock(callback.body)) visitSuite(callback.body.statements, testClock)
      else visitCallback(callback, testClock)
    }
  }
  visitSuite(source.statements, false)
}

for (const [file, ranges] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1
  const reported = new Set<string>()
  inspect(source, (first, last, at, message) => {
    if (ranges.some(({ start, end }) => start <= lineOf(last) && end >= lineOf(first))) {
      reported.add(`${file}:${lineOf(at)}: ${message}`)
    }
  }, isBrowserFile(file))
  failures.push(...reported)
}

if (failures.length) throw new Error(failures.join('\n'))
console.log('Flaky-test patterns: changed tests wait for outcomes and assert behaviour, not call counts')
