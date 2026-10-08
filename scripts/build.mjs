import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { buildInputs, digest } from './build-inputs.mjs'

const started = performance.now()
const inputs = buildInputs()
const stamp = 'dist/.build-evidence.json'
let reusable = false
try {
  const previous = JSON.parse(readFileSync(stamp, 'utf8'))
  reusable = JSON.stringify(previous.inputs) === JSON.stringify(inputs) && previous.output === digest(['dist/'])
} catch { /* A missing or damaged build must be rebuilt. */ }
if (reusable) {
  console.log(`build: reused ${inputs.head} inputs=${inputs.inputs} elapsedMs=${Math.round(performance.now() - started)}`)
} else {
  rmSync('dist', { recursive: true, force: true })
  for (const script of ['node_modules/typescript/bin/tsc', 'scripts/build-cli.mjs']) {
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${script} failed`)
    if (script.endsWith('/tsc')) cpSync('src/server/store/migrations', 'dist/src/server/store/migrations', { recursive: true })
  }
  if (JSON.stringify(buildInputs()) !== JSON.stringify(inputs)) throw new Error('Build inputs changed during compilation')
  writeFileSync(stamp, JSON.stringify({ inputs, output: digest(['dist/']) }))
  console.log(`build: ${inputs.head} inputs=${inputs.inputs} elapsedMs=${Math.round(performance.now() - started)}`)
}
