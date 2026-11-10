export const toolPaths = {
  'ssh-axi': '/opt/tools/node_modules/@knowttl/ssh-axi/dist/hosted.js',
  'kubernetes-axi': '/opt/tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js',
  'technitium-axi': '/opt/tools/node_modules/@knowttl/technitium-axi/bin/technitium-axi.js',
  'shodan-axi': '/opt/tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js',
  'gitea-axi': '/opt/tools/node_modules/@knowttl/gitea-axi/dist/cli.js',
  'unifi-axi': '/opt/tools/node_modules/@knowttl/unifi-axi/dist/bin.js',
  'proxmox-axi': '/opt/tools/node_modules/@knowttl/proxmox-axi/bin/proxmox-axi.mjs',
  'gh-axi': '/opt/tools/node_modules/.bin/gh-axi',
  'checkpoint-axi': '/opt/tools/node_modules/.bin/checkpoint-axi',
  'beyondtrust-axi': '/opt/tools/node_modules/.bin/beyondtrust-axi',
  'hybrid-axi': '/opt/tools/node_modules/.bin/hybrid-axi',
  'tenable-axi': '/opt/tools/node_modules/.bin/tenable-axi',
  'awx-axi': '/opt/tools/node_modules/.bin/awx-axi',
  'falcon-axi': '/opt/tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/bin.js',
  'vectra-axi': '/opt/tools/node_modules/.bin/vectra-axi',
  'az-axi': '/opt/tools/node_modules/.bin/az-axi',
  'mg-axi': '/opt/tools/node_modules/.bin/mg-axi',
  'ldap-axi': '/opt/tools/node_modules/.bin/ldap-axi',
  'ado-axi': '/opt/tools/node_modules/.bin/ado-axi',
} as const
export const toolSkillPaths = {
  'ssh-axi': '/opt/tools/node_modules/@knowttl/ssh-axi/README.md',
  'kubernetes-axi': '/opt/tools/node_modules/@knowttl/kubernetes-axi/skills/kubernetes-axi/SKILL.md',
  'technitium-axi': '/opt/tools/node_modules/@knowttl/technitium-axi/README.md',
  'shodan-axi': '/opt/tools/node_modules/@knowttl/shodan-axi/skills/shodan-axi/SKILL.md',
  'gitea-axi': '/opt/tools/node_modules/@knowttl/gitea-axi/generated/SKILL.md',
  'unifi-axi': '/opt/tools/node_modules/@knowttl/unifi-axi/dist/SKILL.md',
  'proxmox-axi': '/opt/tools/node_modules/@knowttl/proxmox-axi/README.md',
  'gh-axi': '/opt/tools/node_modules/gh-axi/skills/gh-axi/SKILL.md',
  'checkpoint-axi': '/opt/tools/skills/checkpoint-axi/SKILL.md',
  'beyondtrust-axi': '/opt/tools/skills/beyondtrust-axi/SKILL.md',
  'hybrid-axi': '/opt/tools/skills/hybrid-axi/SKILL.md',
  'tenable-axi': '/opt/tools/skills/tenable-axi/SKILL.md',
  'awx-axi': '/opt/tools/skills/awx-axi/SKILL.md',
  'falcon-axi': '/opt/tools/node_modules/@knowttl/falcon-axi/skills/falcon-axi/SKILL.md',
  'vectra-axi': '/opt/tools/node_modules/@knowttl/vectra-axi/skills/vectra-axi/SKILL.md',
  'az-axi': '/opt/tools/node_modules/@knowttl/az-axi/skills/az-axi/SKILL.md',
  'mg-axi': '/opt/tools/node_modules/@knowttl/mg-axi/skills/mg-axi/SKILL.md',
  'ldap-axi': '/opt/tools/node_modules/@knowttl/ldap-axi/skills/ldap-axi/SKILL.md',
  'ado-axi': '/opt/tools/node_modules/@knowttl/ado-axi/SKILL.md',
} as const
export const toolCredentialSchemaPaths = {
  'ssh-axi': undefined,
  'kubernetes-axi': '/opt/tools/node_modules/@knowttl/kubernetes-axi/axi-credential.schema.json',
  'technitium-axi': '/opt/tools/node_modules/@knowttl/technitium-axi/axi-credential.schema.json',
  'shodan-axi': '/opt/tools/node_modules/@knowttl/shodan-axi/axi-credential.schema.json',
  'gitea-axi': '/opt/tools/node_modules/@knowttl/gitea-axi/axi-credential.schema.json',
  'unifi-axi': '/opt/tools/node_modules/@knowttl/unifi-axi/dist/axi-credential.schema.json',
  'proxmox-axi': '/opt/tools/node_modules/@knowttl/proxmox-axi/axi-credential.schema.json',
  'gh-axi': undefined,
  'checkpoint-axi': '/opt/tools/node_modules/@knowttl/checkpoint-axi/axi-credential.schema.json',
  'beyondtrust-axi': '/opt/tools/node_modules/@knowttl/beyondtrust-axi/axi-credential.schema.json',
  'hybrid-axi': '/opt/tools/node_modules/@knowttl/hybrid-axi/axi-credential.schema.json',
  'tenable-axi': '/opt/tools/node_modules/@knowttl/tenable-axi/axi-credential.schema.json',
  'awx-axi': '/opt/tools/node_modules/@knowttl/awx-axi/axi-credential.schema.json',
  'falcon-axi': '/opt/tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/axi-credential.schema.json',
  'vectra-axi': '/opt/tools/node_modules/@knowttl/vectra-axi/axi-credential.schema.json',
  'az-axi': '/opt/tools/node_modules/@knowttl/az-axi/axi-credential.schema.json',
  'mg-axi': '/opt/tools/node_modules/@knowttl/mg-axi/axi-credential.schema.json',
  'ldap-axi': '/opt/tools/node_modules/@knowttl/ldap-axi/axi-credential.schema.json',
  'ado-axi': undefined,
} as const
export const runtimePath = '/opt/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'
export const adoPathPrefix = '/opt/artium/libexec/ado-axi'
export const serverDefaults = { host: '0.0.0.0', port: 8080, database: '/data/artium.db', temporaryDirectory: '/tmp/artium-calls' } as const
export const passwordDefaults = { memoryCost: 65536, timeCost: 3, parallelism: 1, concurrentHashes: 2 } as const
export const tokenDefaults = { accessMs: 3_600_000, familyMs: 43_200_000, ssoFamilyMs: 28_800_000, passwordChangeMs: 600_000 } as const
export const authDefaults = { windowMs: 900_000, usernameAttempts: 5, addressAttempts: 30, counterKeys: 4096, recentAuthMs: 900_000 } as const
export const browserDefaults = { idleMs: 1_800_000, absoluteMs: 43_200_000 } as const
export const ssoDefaults = { transactionMs: 600_000, pendingLimit: 4096 } as const
export const deviceDefaults = { lifetimeMs: 600_000, intervalMs: 5000, pendingLimit: 4096 } as const
export const healthDefaults = { intervalMs: 900_000, retryMs: 60_000, tickMs: 10_000, backgroundCalls: 2, actor: 'system:tool-health' } as const
export const protectedResultLimits = { bytes: 4 * 1024 * 1024, perUser: 4, total: 16, lifetimeMs: 5 * 60 * 1000 } as const
export const runnerLimits = {
  globalCalls: 8,
  userCalls: 4,
  admissionWaitMs: 3000,
  timeoutMs: 60_000,
  terminationGraceMs: 2_000,
  outputBytesPerStream: 4 * 1024 * 1024,
  floodBytes: 64 * 1024 * 1024,
  nodeHeapMiB: 128,
  pythonAddressSpaceBytes: 512 * 1024 * 1024,
} as const
