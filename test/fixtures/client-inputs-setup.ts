import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject) {
  if (!project.isRootProject()) return
  const directory = mkdtempSync(join(tmpdir(), 'artium-client-inputs-'))
  const cleanup = () => rmSync(directory, { recursive: true, force: true })
  try {
    const staging = join(directory, 'npm')
    execFileSync(process.execPath, ['scripts/build-npm.mjs', staging], { stdio: 'inherit' })
    const [packed] = JSON.parse(execFileSync('npm', ['pack', staging, '--json', '--pack-destination', directory,
      '--offline', '--ignore-scripts', '--cache', join(directory, 'cache')], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    }))
    const bundle = join(staging, 'bin/artium-axi.mjs')
    const tarball = join(directory, packed.filename)
    chmodSync(bundle, 0o444)
    chmodSync(tarball, 0o444)
    project.provide('clientInputs', { bundle, tarball })
    return cleanup
  } catch (error) {
    cleanup()
    throw error
  }
}
