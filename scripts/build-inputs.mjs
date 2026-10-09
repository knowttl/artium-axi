import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export function digest(paths) {
  const hash = createHash('sha256')
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.build-evidence.json') continue
      const file = join(path, entry.name)
      if (entry.isDirectory()) visit(file)
      else {
        hash.update(JSON.stringify(file))
        hash.update(JSON.stringify(statSync(file).mode))
        hash.update(createHash('sha256').update(readFileSync(file)).digest())
      }
    }
  }
  for (const path of paths) {
    hash.update(JSON.stringify(path))
    if (path.endsWith('/')) visit(path)
    else {
      hash.update(JSON.stringify(statSync(path).mode))
      hash.update(createHash('sha256').update(readFileSync(path)).digest())
    }
  }
  return hash.digest('hex')
}

export function buildInputs() {
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    inputs: digest(['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vitest.config.ts',
      'src/', 'test/', 'scripts/', 'tools/', 'bin/', 'skill/', 'Dockerfile', '.dockerignore',
      'node_modules/zod/', 'node_modules/typescript/', 'node_modules/esbuild/']),
    node: process.version,
  }
}
