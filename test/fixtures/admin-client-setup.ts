import { execFileSync } from 'node:child_process'
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject) {
  if (!project.isRootProject()) return
  execFileSync(process.execPath, ['scripts/build-admin-client.mjs'], { stdio: 'inherit' })
}
