export const toolPaths = {
  'falcon-axi': '/opt/falcon-axi/bin/falcon-axi',
  'vectra-axi': '/opt/tools/node_modules/.bin/vectra-axi',
  'az-axi': '/opt/tools/node_modules/.bin/az-axi',
} as const
export const runtimePath = '/opt/falcon-axi/bin:/opt/tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'
export const serverDefaults = { host: '0.0.0.0', port: 8080, database: '/data/artium.db', temporaryDirectory: '/tmp/artium-calls' } as const
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
