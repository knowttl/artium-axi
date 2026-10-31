import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: Math.min(8, availableParallelism()),
    // Real password hashing and child processes need headroom under concurrent load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ['test/fixtures/client-inputs-setup.ts'],
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        exclude: [...configDefaults.exclude, 'test/integration/**'] } },
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.test.ts'],
        setupFiles: ['test/fixtures/integration-setup.ts'] } },
    ],
  },
})
