import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    maxWorkers: Math.min(8, availableParallelism()),
    // Real password hashing and child processes need headroom under concurrent load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
