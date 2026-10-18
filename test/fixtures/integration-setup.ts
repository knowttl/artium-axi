import { vi } from 'vitest'

// Integration tests exercise auth flows; local auth unit tests guard production hash cost.
vi.mock('../../src/server/config.js', async importOriginal => {
  const config = await importOriginal<typeof import('../../src/server/config.js')>()
  return { ...config, passwordDefaults: { ...config.passwordDefaults, memoryCost: 1024, timeCost: 1 } }
})
