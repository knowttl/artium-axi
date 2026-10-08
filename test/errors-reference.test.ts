import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

test('pnpm check refuses a stale generated error reference', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-errors-'))
  const execute = promisify(execFile)
  try {
    for (const path of ['scripts', 'src/shared', 'docs']) mkdirSync(join(directory, path), { recursive: true })
    for (const path of ['scripts/errors-reference.mjs', 'src/shared/errors.ts', 'docs/errors.md', 'package.json']) {
      copyFileSync(path, join(directory, path))
    }
    symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
    const reference = join(directory, 'docs/errors.md')
    const committed = readFileSync(reference, 'utf8')
    await execute(process.execPath, ['scripts/errors-reference.mjs', '--write'], { cwd: directory })
    expect(readFileSync(reference, 'utf8')).toBe(committed)
    writeFileSync(reference, `${committed}Synthetic stale reference.\n`)
    await expect(execute('pnpm', ['check'], { cwd: directory })).rejects.toMatchObject({ code: 1,
      stderr: expect.stringContaining('docs/errors.md is stale. Run pnpm errors:generate.') })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
