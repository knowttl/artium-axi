import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { encode } from '@toon-format/toon'
import ts from 'typescript'

const help = 'node scripts/test-gate.mjs [--base <commit>] [--plan] [--full]\n' +
  'Select local checks against the unique merge base with origin/main.\n' +
  '--base <commit>  Use an explicit ancestor instead.\n' +
  '--plan           Print selection and input identity without running checks.\n' +
  '--full           Require the full suite (releases and weekly local validation).\n' +
  'Examples: pnpm test:gate; pnpm test:gate --plan; pnpm test:gate --full'

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trimEnd() : null
}

// The graph covers imports, including re-exports and literal dynamic imports.
// Runtime files and compiled entry points are owned explicitly below.
function affectedTests(root, files, changed) {
  const dependents = new Map()
  const options = { moduleResolution: ts.ModuleResolutionKind.NodeNext, resolveJsonModule: true, allowJs: true }
  for (const file of files.filter(file => /\.(?:ts|mjs)$/.test(file) && existsSync(resolve(root, file)))) {
    const path = resolve(root, file)
    for (const imported of ts.preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue
      const resolved = ts.resolveModuleName(imported.fileName, path, options, ts.sys).resolvedModule
      // Text-loader assets have no TypeScript module resolution.
      const dependency = relative(root, resolved?.resolvedFileName ?? resolve(dirname(path), imported.fileName))
      if (!dependents.has(dependency)) dependents.set(dependency, new Set())
      dependents.get(dependency).add(file)
    }
  }
  const affected = new Set(changed)
  for (const file of affected) for (const dependent of dependents.get(file) ?? []) affected.add(dependent)
  return [...affected].filter(file => file.endsWith('.test.ts') && files.includes(file))
}

function selectGate(root, { base, full = false } = {}) {
  const tracked = git(root, ['ls-files', '-z'])
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (tracked === null || untracked === null) throw new Error('Cannot enumerate repository inputs')
  const files = [...new Set((tracked + '\0' + untracked).split('\0').filter(Boolean))].sort()
  const head = git(root, ['rev-parse', '--verify', 'HEAD'])
  const bases = base === undefined
    ? git(root, ['merge-base', '--all', 'HEAD', 'refs/remotes/origin/main'])?.split('\n')
    : git(root, ['rev-parse', '--verify', `${base}^{commit}`])?.split('\n')
  const selectedBase = bases?.length === 1 && git(root, ['merge-base', '--is-ancestor', bases[0], 'HEAD']) !== null
    ? bases[0] : null
  const diff = selectedBase === null ? null : git(root, ['diff', '--name-only', '--no-renames', '-z', selectedBase, '--'])
  const changed = [...new Set(((diff ?? '') + '\0' + untracked).split('\0').filter(Boolean))].sort()
  const hash = createHash('sha256').update(process.version)
  for (const file of files) {
    const bytes = existsSync(resolve(root, file)) ? readFileSync(resolve(root, file)) : null
    hash.update(JSON.stringify([file, bytes?.length ?? null]) + '\n')
    if (bytes) hash.update(bytes)
  }
  const tests = files.filter(file => /^(src|test)\/.*\.test\.ts$/.test(file))
  const selected = new Set(affectedTests(root, files, changed))
  const reasons = []
  let runtime = false
  const add = predicate => tests.filter(predicate).forEach(file => selected.add(file))
  const packages = () => add(file => /^test\/(?:npm-package|client-package)\.test\.ts$/.test(file))
  const cli = () => {
    add(file => file.startsWith('src/cli/') || /^test\/cli(?:[.-])/.test(file))
    add(file => /^test\/integration\/(?:api|beyondtrust|checkpoint|cli-auth|file-input|hybrid|mg-mail-transfers|tool-skills|transfers)\.test\.ts$/.test(file))
    packages()
  }
  if (full) reasons.push('explicit full suite')
  if (selectedBase === null || diff === null) reasons.push('missing or ambiguous ancestor base')
  for (const file of changed) {
    if (file.startsWith('docs/') && file.endsWith('.md') || file === 'CONTRIBUTING.md' || file === 'AGENTS.md') continue
    if (file === 'README.md' || file === 'LICENSE') { packages(); continue }
    runtime = true
    if (!existsSync(resolve(root, file))) { reasons.push(`deleted runtime input: ${file}`); continue }
    if (file.startsWith('skill/')) { cli(); continue }
    if (/^(src|test)\/.*\.test\.ts$/.test(file)) continue
    if (file.startsWith('src/cli/') && file.endsWith('.ts')) { cli(); continue }
    if (file.startsWith('src/server/') && file.endsWith('.ts') &&
      !/^src\/server\/(?:config|app)\.ts$/.test(file) && file !== 'src/server/adapters/types.ts') {
      add(test => test.startsWith('test/integration/'))
      add(test => test === 'test/cli.test.ts' || test === 'test/tool-skills.test.ts')
      continue
    }
    // Inventories, schemas, dynamic fixtures, migrations, scripts, shared API,
    // toolchain and packaging configuration deliberately fail closed.
    reasons.push(`full-suite owner or unknown path: ${file}`)
  }
  if (!reasons.length && (changed.length === 0 || runtime && selected.size === 0)) reasons.push('empty affected selection')
  const mode = reasons.length ? 'full' : selected.size ? 'affected' : 'docs'
  const checks = [['node', 'scripts/errors-reference.mjs']]
  if (mode === 'full' || runtime) checks.push(['node', 'scripts/upstream-inventory.mjs'],
    ['node', 'scripts/mg-headless-schema.mjs'], ['pnpm', 'lint'])
  const selectedTests = mode === 'full' ? tests : [...selected].sort()
  if (selectedTests.length) checks.push(['pnpm', 'exec', 'vitest', 'run', ...(mode === 'full' ? [] : selectedTests)])
  return { mode, reasons: reasons.length ? reasons : [mode === 'docs' ? 'documentation and generated references' : 'import dependents and explicit runtime owners'],
    base: selectedBase, head, inputSha256: hash.digest('hex'), node: process.version, changed, tests: selectedTests, checks }
}

function main() {
  let values
  try {
    ;({ values } = parseArgs({ options: { base: { type: 'string' }, plan: { type: 'boolean' },
      full: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true, allowPositionals: false }))
  } catch (error) {
    console.log(encode({ error: error.message, help: [help] }))
    return 2
  }
  if (values.help) { console.log(help); return 0 }
  const root = process.cwd()
  const plan = selectGate(root, values)
  console.log(encode(plan))
  if (values.plan) return 0
  for (const [command, ...args] of plan.checks) {
    const started = performance.now()
    const result = spawnSync(command, args, { cwd: root, stdio: ['inherit', 2, 2] })
    console.log(encode({ check: [command, ...args], exit: result.status, seconds: (performance.now() - started) / 1000 }))
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main() }
  catch (error) {
    console.log(encode({ error: error.message, help: ['Run pnpm test for the full suite; repair the selector before delivery.'] }))
    process.exitCode = 1
  }
}
