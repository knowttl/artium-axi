import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

test('compiles typed module imports into executable Node ESM', () => {
  const directory = mkdtempSync(join(root, '.tmp-toolchain-'))
  try {
    writeFileSync(join(directory, 'value.mts'), 'export const value: number = 42\n')
    writeFileSync(join(directory, 'main.mts'),
      "import { value } from './value.mjs'\nconsole.log(value)\n")
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      extends: join(root, 'tsconfig.json'),
      compilerOptions: { rootDir: directory, outDir: join(directory, 'dist'), types: [] },
      include: ['*.mts'],
    }))

    const compilation = spawnSync(process.execPath,
      [compiler, '--project', join(directory, 'tsconfig.json')], { encoding: 'utf8' })
    expect(compilation.error).toBeUndefined()
    expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0)

    const execution = spawnSync(process.execPath, [join(directory, 'dist', 'main.mjs')],
      { encoding: 'utf8' })
    expect(execution.error).toBeUndefined()
    expect(execution.status, execution.stderr).toBe(0)
    expect(execution.stdout).toBe('42\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('strict compilation rejects null assigned to a string', () => {
  const directory = mkdtempSync(join(root, '.tmp-toolchain-'))
  try {
    writeFileSync(join(directory, 'main.mts'), 'export const value: string = null\n')
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      extends: join(root, 'tsconfig.json'),
      compilerOptions: { rootDir: directory, outDir: join(directory, 'dist'), types: [] },
      include: ['*.mts'],
    }))

    const compilation = spawnSync(process.execPath,
      [compiler, '--project', join(directory, 'tsconfig.json')], { encoding: 'utf8' })
    expect(compilation.error).toBeUndefined()
    expect(compilation.status).toBe(2)
    expect(compilation.stdout).toContain('error TS2322')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
