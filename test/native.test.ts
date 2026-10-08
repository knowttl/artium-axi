import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'

test('installed native modules persist data, verify passwords and build executable ESM', () => {
  expect(execFileSync(process.execPath, ['scripts/native-smoke.mjs'], { encoding: 'utf8', timeout: 30_000 }))
    .toContain('SQLite reopen, Argon2 hash/verify and esbuild bundle execution passed')
})
