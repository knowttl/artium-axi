import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))

test.each([
  ['az-axi', 'dist/bin/az-axi.js', '0.1.14', ['sub', 'list']],
  ['vectra-axi', 'bin/vectra-axi.js', '0.1.13', ['detection', 'list']],
  ['mg-axi', 'dist/bin/mg-axi.js', '0.1.18', ['entra', 'user', 'list']],
])('pinned %s exposes its version, help and usage errors without credentials', (tool, bin, version, command) => {
  const home = mkdtempSync(join(root, '.tmp-upstream-'))
  const executable = join(root, 'tools/node_modules/@knowttl', tool, bin)
  const run = (args: string[]) => spawnSync(process.execPath, [executable, ...args], {
    encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, timeout: 3000,
  })
  try {
    const actualVersion = run(['--version'])
    expect(actualVersion.status, actualVersion.stderr).toBe(0)
    expect(actualVersion.stdout.trim()).toBe(version)
    const help = run([...command, '--help'])
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain(tool)
    const invalid = run([...command, '--synthetic-unknown-flag'])
    expect(invalid.status, invalid.stderr).toBe(2)
    expect(invalid.stdout).toContain('synthetic-unknown-flag')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
