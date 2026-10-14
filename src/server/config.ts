export const toolPaths = {
  'falcon-axi': '/opt/falcon-axi/bin/falcon-axi',
  'vectra-axi': '/opt/tools/node_modules/.bin/vectra-axi',
  'az-axi': '/opt/tools/node_modules/.bin/az-axi',
  'mg-axi': '/opt/tools/node_modules/.bin/mg-axi',
  'ldap-axi': '/opt/tools/node_modules/.bin/ldap-axi',
} as const
export const toolCredentialSchemaPaths = {
  'falcon-axi': '/opt/falcon-axi/lib/python3.11/site-packages/falcon_axi/axi-credential.schema.json',
  'vectra-axi': '/opt/tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json',
  'az-axi': '/opt/tools/node_modules/@knowttl/az-axi/axi-credential.schema.json',
  'mg-axi': '/opt/tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json',
  'ldap-axi': '/opt/tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json',
} as const
export const runtimePath = '/opt/falcon-axi/bin:/opt/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'
export const serverDefaults = { host: '0.0.0.0', port: 8080, database: '/data/artium.db', temporaryDirectory: '/tmp/artium-calls' } as const
export const passwordDefaults = { memoryCost: 65536, timeCost: 3, parallelism: 1, concurrentHashes: 2 } as const
export const tokenDefaults = { accessMs: 3_600_000, familyMs: 43_200_000, passwordChangeMs: 600_000 } as const
export const authDefaults = { windowMs: 900_000, usernameAttempts: 5, addressAttempts: 30, counterKeys: 4096, recentAuthMs: 900_000 } as const
export const browserDefaults = { idleMs: 1_800_000, absoluteMs: 43_200_000 } as const
export const healthDefaults = { intervalMs: 900_000, actor: 'system:tool-health' } as const
export const runnerLimits = {
  globalCalls: 8,
  userCalls: 2,
  timeoutMs: 60_000,
  terminationGraceMs: 2_000,
  outputBytesPerStream: 4 * 1024 * 1024,
  floodBytes: 64 * 1024 * 1024,
  nodeHeapMiB: 128,
  pythonAddressSpaceBytes: 512 * 1024 * 1024,
} as const
