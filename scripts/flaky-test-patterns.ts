import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const fixedSleep = 'fixed sleep: wait for the observable outcome instead'
const callCount = 'call-count assertion: assert the outcome, not how often a collaborator was called'
const countMethods = new Set(['toHaveBeenCalledTimes', 'toBeCalledTimes', 'callCount'])
const singleCallMethods = new Set(['toHaveBeenCalledOnce', 'toHaveBeenCalledExactlyOnceWith', 'calledOnceWith'])
const countProperties = new Set(['calledOnce', 'calledTwice', 'calledThrice'])
const failures = new Set<string>()

function git(args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status === 0) return result.stdout
  throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`)
}

function lintBase() {
  const selected = process.env.ARTIUM_AXI_LINT_BASE
  if (selected === '') return null
  if (selected !== undefined) {
    const commit = git(['rev-parse', '--verify', '--end-of-options', `${selected}^{commit}`]).trim()
    git(['merge-base', '--is-ancestor', commit, 'HEAD'])
    return commit
  }
  const merged = spawnSync('git', ['-C', root, 'merge-base', '--all', 'HEAD', 'refs/remotes/origin/main'], { encoding: 'utf8' })
  const bases = merged.status === 0 ? merged.stdout.trim().split('\n') : []
  return bases.length === 1 ? bases[0] : null
}

const base = lintBase()

const isBrowserFile = (file: string) => /^test\/browser\/[^/]+\.(?:mjs|ts)$/.test(file)
const isTestFile = (file: string) => /^(?:src|test)\/.*\.test\.ts$/s.test(file) || isBrowserFile(file)

type LineRange = { start: number, end: number }
const wholeFile = [{ start: 1, end: Infinity }]
const diff = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']
const added = new Map<string, LineRange[]>()

if (base !== null) {
  const tracked = git([...diff, '--name-status', '--diff-filter=d', '-z', base]).split('\0')
  for (let index = 0; index < tracked.length - 1;) {
    const status = tracked[index++]
    const count = status.startsWith('R') ? 2 : 1
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
}
const fullFiles = git(['ls-files', ...(base === null ? ['--cached'] : []), '--others', '--exclude-standard', '-z', '--', 'src', 'test'])
for (const file of fullFiles.split('\0').filter(isTestFile)) {
  if (existsSync(join(root, file))) added.set(file, wholeFile)
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

function clockChange(expression: ts.Expression | undefined): boolean | undefined {
  if (!expression) return
  let value = unwrap(expression)
  if (ts.isAwaitExpression(value)) value = unwrap(value.expression)
  return ts.isCallExpression(value) ? timeoutClock(value) : undefined
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
  const isTimer = (node: ts.Node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node)) return false
    const callee = unwrap(node.expression)
    return ts.isIdentifier(callee) ? callee.text === 'setTimeout' :
      isProperty(callee, 'setTimeout') && ts.isIdentifier(callee.expression) &&
      ['window', 'globalThis'].includes(callee.expression.text)
  }
  const localCallback = (callback: ts.Expression) => {
    if (inlineCallback(callback)) return callback
    if (!ts.isIdentifier(callback)) return
    for (let scope = callback.parent; scope !== executor; scope = scope.parent) {
      if (!ts.isBlock(scope)) continue
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === callback.text) {
          return statement
        }
        if (!ts.isVariableStatement(statement)) continue
        const local = statement.declarationList.declarations.find(({ name }) => ts.isIdentifier(name) && name.text === callback.text)
        if (local) return inlineCallback(local.initializer) ? local.initializer : undefined
      }
    }
  }
  type Bindings = ReadonlyMap<string, ts.Expression | undefined>
  const visiting = new Set<ts.Node>()
  const settles = (callback: ts.Expression, args: readonly (ts.Expression | undefined)[],
    match: (value: ts.Expression | undefined) => boolean, inTimer: boolean): boolean => {
    if (namesResolver(callback)) return match(args[0])
    const local = localCallback(callback)
    if (!local?.body || visiting.has(local)) return false
    const bindings = new Map<string, ts.Expression | undefined>()
    local.parameters.forEach(({ name }, index) => {
      if (ts.isIdentifier(name)) bindings.set(name.text, args[index])
    })
    visiting.add(local)
    const result = visitsSettlement(local.body, match, inTimer, bindings)
    visiting.delete(local)
    return result
  }
  const visitsSettlement = (node: ts.Node, match: (value: ts.Expression | undefined) => boolean,
    inTimer: boolean, bindings?: Bindings): boolean => {
    if (isTimer(node) || ts.isFunctionLike(node)) return false
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map(argument => {
        const value = unwrap(argument)
        return ts.isIdentifier(value) && bindings?.has(value.text) ? bindings.get(value.text) : value
      })
      if (settles(unwrap(node.expression), args, match, inTimer)) return true
    }
    if (!inTimer && (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        node.arguments?.some(argument => settles(unwrap(argument), [], match, inTimer))) return true
    return ts.forEachChild(node, child => visitsSettlement(child, match, inTimer, bindings)) === true
  }

  let failureDeadline = false
  const successFromTimer = (value: ts.Expression | undefined) => {
    if (value?.kind !== ts.SyntaxKind.FalseKeyword) return true
    failureDeadline = true
    return false
  }
  const schedulesResolution = (node: ts.Node): boolean => {
    if (ts.isFunctionLike(node)) return false
    if (isTimer(node) && node.arguments[0]) {
      return settles(unwrap(node.arguments[0]), node.arguments.slice(2).map(unwrap), successFromTimer, true)
    }
    return ts.forEachChild(node, schedulesResolution) === true
  }
  return schedulesResolution(executor.body) || failureDeadline &&
    !visitsSettlement(executor.body, value => !value || value.kind === ts.SyntaxKind.TrueKeyword, false)
}

function rootName(node: ts.Expression): string | undefined {
  while (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node)) node = node.expression
  if (ts.isIdentifier(node)) return node.text
}

function isProperty(node: ts.Expression, name: string): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.name.text === name
}

function enclosingParens(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
  return expression
}

function isPageEval(callee: ts.Expression): boolean {
  return isProperty(callee, 'eval') && rootName(callee) === 'page'
}

function runnerWaitsFor(callback: ts.Node | undefined): boolean {
  if (!inlineCallback(callback)) return false
  let argument = enclosingParens(callback)
  const member = argument.parent
  if (ts.isPropertyAccessExpression(member) && member.expression === argument && member.name.text === 'toString') {
    const serialized = member.parent
    if (!ts.isCallExpression(serialized) || serialized.expression !== member || serialized.arguments.length) return false
    argument = enclosingParens(serialized)
    while (ts.isBinaryExpression(argument.parent) && argument.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      argument = enclosingParens(argument.parent)
    }
    return ts.isCallExpression(argument.parent) && argument.parent.arguments[0] === argument && isPageEval(argument.parent.expression)
  }
  if (!ts.isCallExpression(argument.parent) || !argument.parent.arguments.includes(argument)) return false
  const callee = argument.parent.expression
  const name = rootName(callee)
  if (name && ['test', 'it', 'before', 'after', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach'].includes(name)) return true
  if (!ts.isPropertyAccessExpression(callee)) return false
  return isPageEval(callee) ||
    (name === 'context' && ['before', 'after', 'beforeEach', 'afterEach'].includes(callee.name.text))
}

function countAssertion(matcher: ts.PropertyAccessExpression): ts.Node | undefined {
  const name = matcher.name.text
  const call = ts.isCallExpression(matcher.parent) && matcher.parent.expression === matcher ? matcher.parent : undefined
  if (!call && !countProperties.has(name)) return
  let target = matcher.expression
  let negated = false
  while (ts.isPropertyAccessExpression(target)) {
    negated ||= target.name.text === 'not'
    target = target.expression
  }
  if (!ts.isCallExpression(target) || rootName(target.expression) !== 'expect' || !target.arguments[0]) return
  const mock = unwrap(target.arguments[0])
  if (call) {
    const scalarLength = isProperty(mock, 'length')
    const list = scalarLength ? unwrap(mock.expression) : mock
    if ((scalarLength || ['toHaveLength', 'length', 'lengthOf'].includes(name)) &&
        isProperty(list, 'calls') && isProperty(unwrap(list.expression), 'mock')) return call
    if (!countMethods.has(name) && !singleCallMethods.has(name) && !countProperties.has(name)) return
    if (['toHaveBeenCalledExactlyOnceWith', 'calledOnceWith'].includes(name) && !negated &&
        isOneOutputLine(call.arguments[0]) && isOutputSpy(mock)) return
  }
  return call ?? matcher
}

function isOneOutputLine(value: ts.Expression | undefined): boolean {
  if (!value) return false
  value = unwrap(value)
  if (ts.isStringLiteralLike(value)) return /^[^\r\n]+\r?\n$/.test(value.text)
  if (!ts.isTemplateExpression(value)) return false
  return value.templateSpans.every(({ expression }) =>
    ts.isCallExpression(expression) && isProperty(expression.expression, 'stringify') &&
    rootName(expression.expression) === 'JSON' && expression.arguments.length === 1) &&
    /^[^\r\n]+\r?\n$/.test(value.head.text + value.templateSpans.map(span => `x${span.literal.text}`).join(''))
}

function isOutputSpy(target: ts.Expression): boolean {
  let call = ts.isIdentifier(target) ? constInitializer(target) : target
  while (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
    if (!call.expression.name.text.startsWith('mock')) break
    call = call.expression.expression
  }
  if (!call || !ts.isCallExpression(call) || !isProperty(call.expression, 'spyOn') ||
      !['vi', 'vitest'].includes(rootName(call.expression) ?? '')) return false
  const [stream, method] = call.arguments
  return !!stream && ts.isPropertyAccessExpression(stream) && ['stdout', 'stderr'].includes(stream.name.text) &&
    ts.isIdentifier(stream.expression) && stream.expression.text === 'process' &&
    !!method && ts.isStringLiteral(method) && method.text === 'write'
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
  inspectBrowserScripts = false, evaluateSource = false) {
  const first = source.statements[0]
  const evaluated = evaluateSource && first && ts.isExpressionStatement(first) ? unwrap(first.expression) : undefined
  const evaluatedCallback = evaluated && ts.isCallExpression(evaluated) ? unwrap(evaluated.expression) : evaluated
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
    if (ts.isConditionalExpression(expression)) {
      inspectScript(expression.whenTrue)
      inspectScript(expression.whenFalse)
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
    if (ts.isStringLiteral(template)) {
      const definition = template.getSourceFile()
      const at = template.getStart(definition)
      inspect(ts.createSourceFile('browser-script.js', template.text, ts.ScriptTarget.Latest, true),
        (_, _first, _end, _at, message) => report(definition, at, template.end, at, message))
      return
    }
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

  const inspectQuotedEval = (argument: ts.Expression) => {
    const literals: { node: ts.StringLiteralLike, start: number, end: number }[] = []
    let text = '('
    const append = (value: ts.Expression) => {
      const expression = unwrap(value)
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        append(expression.left)
        append(expression.right)
      } else if (ts.isStringLiteralLike(expression)) {
        const start = text.length
        text += expression.text
        literals.push({ node: expression, start, end: text.length })
      } else {
        text += '0'
      }
    }
    append(argument)
    if (!literals.length) return
    inspect(ts.createSourceFile('page-eval.js', text + '\n)', ts.ScriptTarget.Latest, true), (_, first, end, _at, message) => {
      for (const literal of literals) {
        if (literal.start < end && first < literal.end) mark(literal.node, message)
      }
    }, false, true)
  }

  const mark = (node: ts.Node, message: string, at = node.getStart(source)) => report(source, node.getStart(source), node.end, at, message)
  const awaitsCallback = (callback: ts.Node | undefined) =>
    callback !== undefined && (callback === evaluatedCallback || runnerWaitsFor(callback))
  const visitCallback = (callback: Callback, fakeTimeout: boolean): boolean => {
    const after = visit(callback.body, fakeTimeout)
    return ts.isBlock(callback.body) ? after : clockChange(callback.body) ?? after
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
      if (isPageEval(callee) && node.arguments[0]) inspectQuotedEval(node.arguments[0])
      if (inspectBrowserScripts && ts.isIdentifier(callee)) {
        const [first, second] = node.arguments
        const command = first && ts.isArrayLiteralExpression(first) ? first.elements[0] : undefined
        const script = name === 'browser' ? first : name === 'chrome' && command && ts.isStringLiteral(command) && command.text === 'run' ? second : undefined
        if (script) inspectScript(script)
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const assertion = countAssertion(node)
      if (assertion) mark(assertion, callCount, node.name.getStart(source))
    }
    let waited: ts.Expression | undefined
    if (ts.isAwaitExpression(node)) {
      waited = node.expression
    } else if (ts.isReturnStatement(node) && node.expression) {
      if (awaitsCallback(ts.findAncestor(node.parent, ts.isFunctionLike))) waited = node.expression
    } else if (ts.isArrowFunction(node.parent) && node.parent.body === node && !ts.isBlock(node.parent.body) &&
        awaitsCallback(node.parent)) {
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
    const change = ts.isExpressionStatement(node) || ts.isReturnStatement(node) ? clockChange(node.expression) : undefined
    return change ?? (separateExecution ? fakeTimeout : stillFake)
  }

  type TestHooks = { setup: Callback[], cleanup: Callback[] }
  type RunSuite = (clock: boolean, hooks: TestHooks) => boolean
  const applyHooks = (clock: boolean, hooks: Callback[]) => hooks.reduce((active, hook) => visitCallback(hook, active), clock)
  const collectSuite = (statements: ts.NodeArray<ts.Statement>, clock: boolean): { clock: boolean, run: RunSuite } => {
    const hooks = { beforeAll: [] as Callback[], beforeEach: [] as Callback[], afterEach: [] as Callback[], afterAll: [] as Callback[] }
    const entries: RunSuite[] = []
    for (const statement of statements) {
      const call = ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : undefined
      const name = call && rootName(call.expression)
      const callback = call?.arguments.find(inlineCallback)
      if (call && callback) {
        if (name === 'beforeAll' || name === 'beforeEach' || name === 'afterEach' || name === 'afterAll') {
          hooks[name].push(callback)
          continue
        }
        if (name === 'test' || name === 'it') {
          entries.push(checkRegistration(registration(call), (active, { setup, cleanup }) =>
            applyHooks(visitCallback(callback, applyHooks(active, setup)), cleanup)))
          continue
        }
        if (name === 'describe' || name === 'suite') {
          const execution = registration(call)
          if (ts.isBlock(callback.body)) {
            const inner = collectSuite(callback.body.statements, clock)
            if (execution.rows) clock &&= inner.clock
            entries.push(checkRegistration(execution, inner.run))
          } else {
            const collected = visitCallback(callback, clock)
            if (execution.rows) clock &&= collected
          }
          continue
        }
      }
      clock = visit(statement, clock)
    }
    hooks.afterEach.reverse()
    hooks.afterAll.reverse()
    return { clock, run(active, inherited) {
      active = applyHooks(active, hooks.beforeAll)
      const testHooks = { setup: [...inherited.setup, ...hooks.beforeEach], cleanup: [...hooks.afterEach, ...inherited.cleanup] }
      for (const entry of entries) active = entry(active, testHooks) && active
      return applyHooks(active, hooks.afterAll)
    } }
  }

  function checkRegistration({ skipped, rows }: ReturnType<typeof registration>, run: RunSuite): RunSuite {
    return (clock, hooks) => {
      const after = run(clock, hooks)
      if (skipped || rows === 0) return clock
      if (rows > 1 && clock && !after) run(false, hooks)
      return after
    }
  }

  function registration(call: ts.CallExpression) {
    let skipped = call.arguments.some(argument => ts.isObjectLiteralExpression(argument) && argument.properties.some(property =>
      ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      ['skip', 'todo'].includes(property.name.text) && unwrap(property.initializer).kind === ts.SyntaxKind.TrueKeyword))
    let rows = 1
    let callee = call.expression
    while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
      if (ts.isPropertyAccessExpression(callee) && ['skip', 'todo'].includes(callee.name.text)) skipped = true
      if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.arguments[0]) {
        const argument = unwrap(callee.arguments[0])
        const modifier = callee.expression.name.text
        if (modifier === 'each' || modifier === 'for') {
          const table = ts.isAsExpression(argument) ? unwrap(argument.expression) : argument
          rows = ts.isArrayLiteralExpression(table) && !table.elements.some(ts.isSpreadElement) ? table.elements.length : 2
        }
        skipped ||= modifier === 'skipIf' && argument.kind === ts.SyntaxKind.TrueKeyword ||
          modifier === 'runIf' && argument.kind === ts.SyntaxKind.FalseKeyword
      }
      callee = callee.expression
    }
    return { skipped, rows }
  }

  const suite = collectSuite(source.statements, false)
  suite.run(suite.clock, { setup: [], cleanup: [] })
}

for (const file of new Set([...added.keys(), ...browserSources.keys()])) {
  inspect(browserSources.get(file) ?? readSource(file), (definition, first, last, at, message) => {
    const lineOf = (position: number) => definition.getLineAndCharacterOfPosition(position).line + 1
    if (added.get(definition.fileName)?.some(({ start, end }) => start <= lineOf(last) && end >= lineOf(first))) {
      failures.add(`${definition.fileName}:${lineOf(at)}: ${message}`)
    }
  }, isBrowserFile(file))
}

const report = [...failures].sort().join('\n')
if (base === null) {
  console.log(`Flaky-test patterns: no baseline, checked all in-scope tests in advisory mode with ${failures.size} finding(s)${report && `\n${report}`}`)
} else {
  if (failures.size) throw new Error(report)
  console.log('Flaky-test patterns: changed tests wait for outcomes and assert behaviour, not call counts')
}
