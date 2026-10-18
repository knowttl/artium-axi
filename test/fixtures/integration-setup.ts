import { vi } from 'vitest'

// Endpoint transport is exercised with local sockets in the preflight suite.
// API fixtures never resolve or connect to a production destination.
vi.mock('../../src/server/health/preflight.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/server/health/preflight.js')>(), preflight: vi.fn(async () => {}),
}))

// Integration tests exercise auth flows; local auth unit tests guard production hash cost.
vi.mock('../../src/server/config.js', async importOriginal => {
  const config = await importOriginal<typeof import('../../src/server/config.js')>()
  return { ...config, passwordDefaults: { ...config.passwordDefaults, memoryCost: 1024, timeCost: 1 } }
})
