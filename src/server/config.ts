export const toolPaths = {
  'falcon-axi': '/opt/falcon-axi/bin/falcon-axi',
  'vectra-axi': '/opt/tools/node_modules/.bin/vectra-axi',
  'az-axi': '/opt/tools/node_modules/.bin/az-axi',
  'mg-axi': '/opt/tools/node_modules/.bin/mg-axi',
  'ldap-axi': '/opt/tools/node_modules/.bin/ldap-axi',
  'ado-axi': '/opt/tools/node_modules/.bin/ado-axi',
} as const
export const toolSkillPaths = {
  'falcon-axi': '/opt/tools/skills/falcon-axi/SKILL.md',
  'vectra-axi': '/opt/tools/node_modules/@knowttl/vectra-axi/skills/vectra-axi/SKILL.md',
  'az-axi': '/opt/tools/node_modules/@knowttl/az-axi/skills/az-axi/SKILL.md',
  'mg-axi': '/opt/tools/node_modules/@knowttl/mg-axi/skills/mg-axi/SKILL.md',
  'ldap-axi': '/opt/tools/node_modules/@knowttl/ldap-axi/skills/ldap-axi/SKILL.md',
  'ado-axi': '/opt/tools/node_modules/@jeffreyhaen/ado-axi/SKILL.md',
} as const
export const toolCredentialSchemaPaths: Partial<Record<keyof typeof toolPaths, string>> = {
  'falcon-axi': '/opt/falcon-axi/lib/python3.11/site-packages/falcon_axi/axi-credential.schema.json',
  'vectra-axi': '/opt/tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json',
  'az-axi': '/opt/tools/node_modules/@knowttl/az-axi/axi-credential.schema.json',
  'mg-axi': '/opt/tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json',
  'ldap-axi': '/opt/tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json',
} as const
export const runtimePath = '/opt/falcon-axi/bin:/opt/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'
export const serverDefaults = { host: '0.0.0.0', port: 8080, database: '/data/artium.db', temporaryDirectory: '/tmp/artium-calls' } as const
export const passwordDefaults = { memoryCost: 65536, timeCost: 3, parallelism: 1, concurrentHashes: 2 } as const
export const tokenDefaults = { accessMs: 3_600_000, familyMs: 43_200_000, ssoFamilyMs: 28_800_000, passwordChangeMs: 600_000 } as const
export const authDefaults = { windowMs: 900_000, usernameAttempts: 5, addressAttempts: 30, counterKeys: 4096, recentAuthMs: 900_000 } as const
export const browserDefaults = { idleMs: 1_800_000, absoluteMs: 43_200_000 } as const
export const ssoDefaults = { transactionMs: 600_000, pendingLimit: 4096 } as const
export const deviceDefaults = { lifetimeMs: 600_000, intervalMs: 5000, pendingLimit: 4096 } as const
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
