import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const fixedSleep = 'fixed sleep: wait for the observable outcome instead'
const callCount = 'call-count assertion: assert the outcome, not how often a collaborator was called'
const countMatchers = new Set(['toHaveBeenCalledTimes', 'toBeCalledTimes', 'toHaveBeenCalledOnce'])
const failures = new Set<string>()

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
const wholeFile = [{ start: 1, end: Infinity }]
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
  if (paths.length === 2 && !isTestFile(paths[0])) {
    added.set(file, wholeFile)
    continue
  }
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
  added.set(file, wholeFile)
}

const browserSources = new Map<string, ts.SourceFile>()
if ([...added.keys()].some(isBrowserFile)) {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'test/browser'])
  for (const file of new Set(files.split('\0').filter(isBrowserFile))) {
    if (existsSync(join(root, file))) browserSources.set(file, readSource(file))
  }
}

function readSource(file: string) {
  return ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
}

function timeoutClock(call: ts.CallExpression): boolean | undefined {
  const { expression, arguments: [options] } = call
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression) ||
      !['vi', 'vitest'].includes(expression.expression.text)) return
  if (expression.name.text === 'useRealTimers') return false
  if (expression.name.text !== 'useFakeTimers') return
  if (!options) return true
  if (!ts.isObjectLiteralExpression(options) || !options.properties.every(ts.isPropertyAssignment)) return false
  const toFake = options.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'toFake')
  if (!toFake) return true
  return ts.isArrayLiteralExpression(toFake.initializer) &&
    (toFake.initializer.elements.length === 0 ||
      toFake.initializer.elements.some(timer => ts.isStringLiteral(timer) && timer.text === 'setTimeout'))
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

function runnerWaitsFor(callback: ts.Node | undefined): boolean {
  if (!inlineCallback(callback) || !ts.isCallExpression(callback.parent) ||
      !callback.parent.arguments.includes(callback)) return false
  const callee = callback.parent.expression
  const name = rootName(callee)
  if (name && ['test', 'it', 'before', 'after', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(name)) return true
  if (!ts.isPropertyAccessExpression(callee)) return false
  return (name === 'page' && callee.name.text === 'eval') ||
    (name === 'context' && ['before', 'after', 'beforeEach', 'afterEach'].includes(callee.name.text))
}

function countsMockCalls(matcher: ts.PropertyAccessExpression): boolean {
  if (!['toHaveLength', 'length', 'lengthOf'].includes(matcher.name.text)) return false
  let target = matcher.expression
  while (ts.isPropertyAccessExpression(target)) target = target.expression
  if (!ts.isCallExpression(target) || rootName(target.expression) !== 'expect' || !target.arguments[0]) return false
  const calls = unwrap(target.arguments[0])
  return ts.isPropertyAccessExpression(calls) && calls.name.text === 'calls' &&
    ts.isPropertyAccessExpression(calls.expression) && calls.expression.name.text === 'mock'
}

function variableBinding(statements: ts.NodeArray<ts.Statement>, name: string, exported = false) {
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement) ||
        (exported && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) continue
    const binding = statement.declarationList.declarations.find(declaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === name)
    if (binding) return binding
  }
}

function constInitializer(identifier: ts.Identifier): ts.Expression | undefined {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(({ name }) => ts.isIdentifier(name) && name.text === identifier.text)) return
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
    const binding = variableBinding(scope.statements, identifier.text)
    if (binding) return binding.parent.flags & ts.NodeFlags.Const ? binding.initializer : undefined
    if (!ts.isSourceFile(scope)) continue
    for (const statement of scope.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.startsWith('./')) continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      const imported = bindings.elements.find(({ name }) => name.text === identifier.text)
      if (!imported) continue
      const module = browserSources.get(join(dirname(scope.fileName), statement.moduleSpecifier.text))
      const declaration = module && variableBinding(module.statements, (imported.propertyName ?? imported.name).text, true)
      if (declaration && declaration.parent.flags & ts.NodeFlags.Const) return declaration.initializer
    }
  }
}

type Callback = ts.ArrowFunction | ts.FunctionExpression

function inspect(source: ts.SourceFile, report: (file: ts.SourceFile, start: number, end: number, at: number, message: string) => void,
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

  const visitedScripts = new Set<ts.Expression>()
  const inspectScript = (value: ts.Expression): void => {
    const expression = unwrap(value)
    if (visitedScripts.has(expression)) return
    visitedScripts.add(expression)
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      inspectScript(expression.left)
      inspectScript(expression.right)
      return
    }
    if (ts.isIdentifier(expression)) {
      const initializer = constInitializer(expression)
      if (initializer) inspectScript(initializer)
      return
    }
    const builder = ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      ? constInitializer(expression.expression) : undefined
    const template = inlineCallback(builder) && !ts.isBlock(builder.body) ? unwrap(builder.body) : expression
    if (!ts.isNoSubstitutionTemplateLiteral(template) && !ts.isTemplateExpression(template)) return
    const definition = template.getSourceFile()
    const start = template.getStart(definition) + 1
    let text = definition.text.slice(start, template.end - 1)
    if (ts.isTemplateExpression(template)) {
      let from = template.head.end - 2
      for (const span of template.templateSpans) {
        const fragment = unwrap(span.expression)
        if (inlineCallback(builder) && ts.isCallExpression(expression) && ts.isIdentifier(fragment)) {
          const index = builder.parameters.findIndex(({ name }) => ts.isIdentifier(name) && name.text === fragment.text)
          inspectScript(expression.arguments[index] ?? fragment)
        } else {
          inspectScript(fragment)
        }
        const to = span.literal.getStart(definition) + 1
        text = text.slice(0, from - start) + '0' + definition.text.slice(from + 1, to).replace(/[^\r\n]/g, ' ') + text.slice(to - start)
        from = span.literal.end - 2
      }
    }
    inspect(ts.createSourceFile('browser-script.js', text, ts.ScriptTarget.Latest, true),
      (_, first, end, at, message) => report(definition, first + start, end + start, at + start, message))
  }

  const mark = (node: ts.Node, message: string, at = node.getStart(source)) => report(source, node.getStart(source), node.end, at, message)
  const visitCallback = (callback: Callback, fakeTimeout: boolean): boolean => {
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
        if (script) inspectScript(script)
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const { text: name } = node.name
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined
      if (call && (countMatchers.has(name) || countsMockCalls(node))) mark(call, callCount, node.name.getStart(source))
    }
    let waited: ts.Expression | undefined
    if (ts.isAwaitExpression(node)) {
      waited = node.expression
    } else if (ts.isReturnStatement(node) && node.expression) {
      if (runnerWaitsFor(ts.findAncestor(node.parent, ts.isFunctionLike))) waited = node.expression
    } else if (ts.isArrowFunction(node.parent) && node.parent.body === node && !ts.isBlock(node.parent.body) &&
        runnerWaitsFor(node.parent)) {
      waited = node.parent.body
    }
    if (waited && !fakeTimeout) {
      const awaited = unwrap(waited)
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

  type RunSuite = (clock: boolean, setup: Callback[]) => void
  const collectSuite = (statements: ts.NodeArray<ts.Statement>, clock: boolean): { clock: boolean, run: RunSuite } => {
    const beforeAll: Callback[] = []
    const beforeEach: Callback[] = []
    const entries: RunSuite[] = []
    const applyHooks = (clock: boolean, hooks: Callback[]) => hooks.reduce((active, hook) => visitCallback(hook, active), clock)
    for (const statement of statements) {
      const call = ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined
      const name = call && rootName(call.expression)
      const callback = call?.arguments.find(inlineCallback)
      if (callback) {
        if (name === 'beforeAll' || name === 'beforeEach') {
          (name === 'beforeAll' ? beforeAll : beforeEach).push(callback)
          continue
        }
        if (name === 'test' || name === 'it') {
          entries.push((clock, setup) => visitCallback(callback, applyHooks(clock, setup)))
          continue
        }
        if (name === 'describe' || name === 'suite') {
          if (ts.isBlock(callback.body)) {
            const inner = collectSuite(callback.body.statements, clock)
            clock = inner.clock
            entries.push(inner.run)
          } else {
            clock = visitCallback(callback, clock)
          }
          continue
        }
      }
      clock = visit(statement, clock)
    }
    return { clock, run(active, inheritedSetup) {
      const suiteClock = applyHooks(active, beforeAll)
      const setup = [...inheritedSetup, ...beforeEach]
      for (const entry of entries) entry(suiteClock, setup)
    } }
  }
  const suite = collectSuite(source.statements, false)
  suite.run(suite.clock, [])
}

for (const file of new Set([...added.keys(), ...browserSources.keys()])) {
  inspect(browserSources.get(file) ?? readSource(file), (definition, first, last, at, message) => {
    const lineOf = (position: number) => definition.getLineAndCharacterOfPosition(position).line + 1
    if (added.get(definition.fileName)?.some(({ start, end }) => start <= lineOf(last) && end >= lineOf(first))) {
      failures.add(`${definition.fileName}:${lineOf(at)}: ${message}`)
    }
  }, isBrowserFile(file))
}

if (failures.size) throw new Error([...failures].sort().join('\n'))
console.log('Flaky-test patterns: changed tests wait for outcomes and assert behaviour, not call counts')
