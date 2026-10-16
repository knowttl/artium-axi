import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { cliVersion } from '../src/shared/version.js'

test('npm tarball installs an offline standalone client and its embedded skill without server assets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-npm-'))
  try {
    execFileSync(process.execPath, ['scripts/build-npm.mjs'])
    const [packed] = JSON.parse(execFileSync('npm', ['pack', resolve('dist/npm'), '--json', '--pack-destination', directory], { encoding: 'utf8' }))
    expect(packed.files.map((file: { path: string }) => file.path).sort()).toEqual([
      'LICENSE', 'NOTICE', 'README.md', 'bin/artium-axi.mjs', 'package.json', 'skill/artium-axi/SKILL.md',
    ])
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', directory, join(directory, packed.filename)])
    const executable = join(directory, 'node_modules', '.bin', 'artium-axi')
    const env = { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, '.claude') }
    expect(execFileSync(executable, ['--version'], { cwd: directory, env, encoding: 'utf8' })).toBe(`${cliVersion}\n`)
    expect(execFileSync(executable, ['setup', '--host', 'claude'], { cwd: directory, env, encoding: 'utf8' })).toContain('status: installed')
    const skill = readFileSync(join(directory, '.claude', 'skills', 'artium-axi', 'SKILL.md'), 'utf8')
    expect(skill).toContain('artium-axi')
    const metadata = JSON.parse(readFileSync(join(directory, 'node_modules', '@knowttl', 'artium-axi', 'package.json'), 'utf8'))
    expect(metadata).toMatchObject({ name: '@knowttl/artium-axi', version: cliVersion, license: 'MIT',
      bin: { 'artium-axi': 'bin/artium-axi.mjs' } })
    expect(metadata.dependencies).toBeUndefined()
    expect(metadata.scripts).toBeUndefined()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
