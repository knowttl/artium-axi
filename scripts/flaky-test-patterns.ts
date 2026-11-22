import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const roots = ['src', 'test']
const fixedSleep = 'fixed sleep: wait for the observable outcome instead'
const callCount = 'call-count assertion: assert the outcome, not how often a collaborator was called'
const failures: string[] = []

function git(...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : ''
}

const base = ['origin/main', 'main'].map(name => git('merge-base', name, 'HEAD').trim()).find(Boolean)
if (!base) throw new Error('flaky-test-patterns: no merge base with origin/main or main')

const added = new Map<string, Set<number>>()
let path: string | undefined
let line = 0
let inHunk = false
for (const text of git('diff', '--unified=0', '--no-color', '--no-renames', base, '--', ...roots).split('\n')) {
  if (text.startsWith('diff --git ')) {
    path = undefined
    inHunk = false
  } else if (!inHunk && text.startsWith('+++ ')) {
    path = text.startsWith('+++ b/') ? text.slice(6) : undefined
  } else if (text.startsWith('@@') && path) {
    inHunk = true
    line = Number(/^@@ -\S+ \+(\d+)/.exec(text)![1])
  } else if (inHunk && text.startsWith('+') && path) {
    if (!added.has(path)) added.set(path, new Set())
    added.get(path)!.add(line++)
  }
}
for (const untracked of git('ls-files', '--others', '--exclude-standard', '-z', '--', ...roots).split('\0').filter(Boolean)) {
  const count = readFileSync(join(root, untracked), 'utf8').split('\n').length
  added.set(untracked, new Set(Array.from({ length: count }, (_, index) => index + 1)))
}

for (const [file, lines] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
  if (!file.endsWith('.test.ts')) continue
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1
  let fakeClock = false
  const findings: { node: ts.Node, at: number, message: string }[] = []
  const timerWaits: ts.AwaitExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : ''
      if (name === 'useFakeTimers') fakeClock = true
      if (name === 'waitForTimeout') findings.push({ node, at: node.getStart(), message: fixedSleep })
      if (ts.isPropertyAccessExpression(callee) && (name === 'toHaveBeenCalledTimes' || name === 'toHaveBeenCalledOnce')) {
        findings.push({ node, at: callee.name.getStart(), message: callCount })
      }
    }
    if (ts.isAwaitExpression(node)) {
      let waited: ts.Expression = node.expression
      while (ts.isParenthesizedExpression(waited)) waited = waited.expression
      if (ts.isNewExpression(waited) && ts.isIdentifier(waited.expression) && waited.expression.text === 'Promise') {
        let schedules = false
        const search = (child: ts.Node) => {
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'setTimeout') schedules = true
          ts.forEachChild(child, search)
        }
        search(waited)
        if (schedules) timerWaits.push(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!fakeClock) for (const node of timerWaits) findings.push({ node, at: node.getStart(), message: fixedSleep })
  for (const { node, at, message } of findings) {
    if ([...lines].some(changed => changed >= lineOf(node.getStart()) && changed <= lineOf(node.end))) {
      failures.push(`${file}:${lineOf(at)}: ${message}`)
    }
  }
}

if (failures.length) throw new Error(failures.join('\n'))
console.log('Flaky-test patterns: changed tests wait for outcomes and assert behaviour, not call counts')
