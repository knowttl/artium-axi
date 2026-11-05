import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/fake-service/shodan-sessions.cases.ts'],
    globalSetup: ['test/fixtures/client-inputs-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
