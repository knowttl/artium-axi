import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { test } from 'vitest'

test('runner enforces mixed certificate trust across tool families', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.mixed-trust-'))
  try {
    const entry = join(directory, 'check.mjs')
    await build({ entryPoints: ['test/fixtures/mixed-trust-check.ts'], outfile: entry,
      bundle: true, platform: 'node', format: 'esm', packages: 'external' })
    await promisify(execFile)(process.execPath, [entry], { timeout: 120_000 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 130_000)
