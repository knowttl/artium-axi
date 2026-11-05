import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['test/fake-service/shodan-worker.cases.ts'], testTimeout: 120_000 } })
