import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { parse } from 'yaml'

const pins = JSON.parse(readFileSync('tools/package.json', 'utf8')).dependencies as Record<string, string>
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'artium-pins-'))
  writeFileSync(join(directory, 'npm'), `#!${process.execPath}
const [view, name] = process.argv.slice(2)
const latest = JSON.parse(process.env.FAKE_NPM_LATEST)[name]
if (view !== 'view' || latest === undefined) { console.error('npm error 404 ' + name); process.exit(1) }
console.log(latest)
`)
  chmodSync(join(directory, 'npm'), 0o755)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function run(latest: Record<string, string>) {
  return spawnSync(process.execPath, ['scripts/pin-freshness.mjs'], { encoding: 'utf8',
    env: { PATH: `${directory}:${process.env.PATH}`, FAKE_NPM_LATEST: JSON.stringify(latest) } })
}

test('the scheduled workflow runs the freshness check with read-only access', () => {
  const workflow = parse(readFileSync('.github/workflows/pin-freshness.yml', 'utf8')) as {
    on: { schedule: { cron: string }[] }, permissions: Record<string, string>,
    jobs: Record<string, { steps: { run?: string }[] }> }
  expect(workflow.on.schedule).toHaveLength(1)
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.jobs['pin-freshness'].steps.map(step => step.run)).toContain('node scripts/pin-freshness.mjs')
})

test('current pins pass', () => {
  const result = run(pins)
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain(`${Object.keys(pins).length} pins checked, 0 stale`)
})

test('a published release newer than its pin fails and names the package', () => {
  const result = run({ ...pins, 'axi-sdk-js': '0.1.14' })
  expect(result.status).toBe(1)
  expect(result.stdout).toContain(`stale pin: axi-sdk-js is pinned at ${pins['axi-sdk-js']}, npm latest is 0.1.14`)
  expect(result.stdout).toContain('1 stale')
})

test('an unreachable registry fails instead of reporting current pins', () => {
  const { 'axi-sdk-js': _, ...partial } = pins
  const result = run(partial)
  expect(result.status).not.toBe(0)
  expect(result.stdout).not.toContain('pins checked')
})
