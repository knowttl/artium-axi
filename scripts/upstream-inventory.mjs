import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = new URL('../tools/', import.meta.url)
const load = (tool, path) => import(new URL(`node_modules/@knowttl/${tool}/dist/${path}`, root))
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))
const az = await load('az-axi', 'lib/registry.js')
const azArgs = await load('az-axi', 'lib/args.js')
const vectra = await load('vectra-axi', 'src/catalogue.js')
const mg = await load('mg-axi', 'catalogue.js')
const inventories = {
  'az-axi': az.COMMAND_LEAVES.map(leaf => ({ command: leaf.path, aliases: leaf.aliases ?? [],
    effect: leaf.effect, capability: leaf.capability,
    flags: { ...azArgs.GLOBAL_FLAG_SCHEMA, ...leaf.flags, ...leaf.canonicalFlags, ...leaf.handlerFlags },
    flagAliases: { ...leaf.aliasFlags, ...leaf.canonicalFlagAliases }, positionalInput: leaf.positionalInput ?? false })),
  'vectra-axi': Object.entries(vectra.catalogue).map(([command, leaf]) => ({ command,
    flags: Object.fromEntries(Object.entries(leaf.flags).map(([name, flag]) => [name, flag.kind])) })),
  'mg-axi': mg.LEAVES.map(leaf => ({ command: leaf.path,
    flags: Object.fromEntries(Object.entries(leaf.flags ?? {}).map(([name, flag]) => [name, flag.value ? 'value' : 'boolean'])) })),
}
const environments = {
  'az-axi': ['CONFIG', 'PROFILE', 'TENANT', 'SUBSCRIPTION', 'READ_ONLY', 'WRITE_LOG',
    'ARM_TOKEN', 'GRAPH_TOKEN', 'LOGS_TOKEN', 'REGISTRY_TOKEN', 'STORAGE_TOKEN', 'VAULT_TOKEN'],
  'vectra-axi': ['CONFIG', 'PROFILE', 'READ_ONLY', 'WRITE_LOG'],
  'mg-axi': ['CONFIG', 'READ_ONLY', 'WRITE_LOG', 'CLIENT_SECRET'],
}
const nativeWriteSettings = {
  'az-axi': {
    profileFields: { allowWrites: 'boolean', subscriptions: 'string[]' },
    scope: { configuredField: 'subscriptions', resolvedField: 'writeSubscriptions',
      rule: 'Copied from configured subscriptions before flag or environment read-scope overrides; unscoped writes denied' },
    sources: ['lib/config.js', 'lib/gates.js'],
  },
  'vectra-axi': {
    profileFields: { 'writes.allowWrites': 'boolean', 'writes.operations': 'string[]' },
    scope: { configuredField: 'writes.operations', resolvedField: 'scope.operations',
      rule: 'Explicit nonempty operation allowlist, snapshotted by the mutation coordinator for QUX and RUX' },
    sources: ['src/profiles.js', 'src/writes.js'],
  },
  'mg-axi': {
    profileFields: { 'writes.allowWrites': 'boolean', 'writes.operations': 'string[]' },
    scope: { configuredField: 'writes.operations', resolvedField: 'scope.operations',
      rule: 'Explicit nonempty operation allowlist, snapshotted by the mutation coordinator for delegated and application profiles' },
    sources: ['profiles.js', 'mutations.js'],
  },
}
const disposition = name => ['config', 'profile', 'tenant', 'token-env', 'client-secret-env',
  'certificate-key-env', 'certificate-key-file', 'certificate-thumbprint', 'ca-bundle'].includes(name) ? 'server-owned'
  : name.endsWith('-file') || ['file', 'body', 'input', 'out', 'output', 'cursor'].includes(name) ? 'input/output transport review'
  : 'passthrough candidate'

for (const [tool, commands] of Object.entries(inventories)) {
  const packageUrl = new URL(`node_modules/@knowttl/${tool}/package.json`, root)
  const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'))
  if (pkg.version !== pins[pkg.name].version) throw new Error(`Pin mismatch for ${tool}`)
  const prefix = tool.replaceAll('-', '_').toUpperCase()
  const data = { generatedBy: 'scripts/upstream-inventory.mjs', tool, ...pins[pkg.name],
    parserEvidence: 'Installed pinned catalogue exports, provisional until adapter acceptance',
    packageManifestSha256: createHash('sha256').update(readFileSync(packageUrl)).digest('hex'),
    environment: environments[tool].map(name => ({ name: `${prefix}_${name}`, disposition: 'server-owned' })),
    dynamicCredentialEnvironment: 'Profiles may name credential variables. Server creates and owns those names.',
    nativeWriteSettings: { default: 'disabled', disposition: 'server-owned',
      profileFields: nativeWriteSettings[tool].profileFields, scope: nativeWriteSettings[tool].scope,
      sources: nativeWriteSettings[tool].sources.map(path => ({ path: `dist/${path}`,
        sha256: createHash('sha256').update(readFileSync(new URL(`node_modules/@knowttl/${tool}/dist/${path}`, root))).digest('hex') })) },
    suggestionFields: ['help'], format: 'TOON',
    flags: [...new Set(commands.flatMap(command => Object.keys(command.flags)))].sort()
      .map(name => ({ name, disposition: disposition(name) })), commands }
  const contents = JSON.stringify(data, null, 2) + '\n'
  const destination = new URL(`inventories/${tool}.json`, root)
  if (process.argv[2] === '--write') writeFileSync(destination, contents)
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error(`Inventory out of date: ${fileURLToPath(destination)}`)
  console.log(`inventory: ${tool} ${pkg.version}, ${commands.length} commands`)
}
