import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import './ldap-inventory.mjs'
import './ado-inventory.mjs'
import './awx-inventory.mjs'

const root = new URL('../tools/', import.meta.url)
const load = (tool, path) => import(new URL(`node_modules/@knowttl/${tool}/dist/${path}`, root))
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))
const az = await load('az-axi', 'lib/registry.js')
const azArgs = await load('az-axi', 'lib/args.js')
const azConfig = await load('az-axi', 'lib/config.js')
const azReads = await load('az-axi', 'lib/azReadCatalogue.js')
const vectra = await load('vectra-axi', 'src/catalogue.js')
const vectraWrites = await load('vectra-axi', 'src/writes.js')
const mg = await load('mg-axi', 'catalogue.js')
const mgWrites = await load('mg-axi', 'mutations.js')
const mgWriteOperations = await Promise.all([
  ['entra-group-member-add.js', 'GROUP_MEMBER_ADD_OPERATION'],
  ['entra-user-update.js', 'USER_ACCOUNT_UPDATE_OPERATION'],
  ['entra-user-revoke-sessions.js', 'USER_REVOKE_SESSIONS_OPERATION'],
  ['entra-risk-dismiss.js', 'RISKY_USER_DISMISS_OPERATION'],
  ['entra-ca-policy-update.js', 'CA_POLICY_UPDATE_OPERATION'],
].map(async ([path, name]) => (await load('mg-axi', path))[name]))
const azShortFlags = { h: 'help', s: 'subscription', g: 'resource-group', n: 'name',
  l: 'location', w: 'workspace', t: 'timespan', q: 'graph-query' }
const azResources = ['arm', 'graph', 'logs', 'registry', 'storage', 'vault']
const azUnsafeOverrides = ['config', 'profile', 'tenant']
const mgAllowedCommands = ['home', 'doctor', 'entra', 'api get']
const mgUnsafeOverrides = ['config', 'profile', 'tenant', 'client', 'scopes', 'client-secret-env', 'client-secret-file',
  'certificate-key-env', 'certificate-key-file', 'certificate-thumbprint-sha256', 'federated-token-file']
const inventories = {
  'az-axi': az.COMMAND_LEAVES.flatMap(leaf => [leaf.path, ...leaf.aliases ?? []].map(command => {
    const canonical = command === leaf.path && leaf.handlerPath !== undefined
    let flags = { ...azArgs.GLOBAL_FLAG_SCHEMA, ...leaf.flags, ...(canonical ? leaf.canonicalFlags : {}) }
    let flagAliases = command === leaf.path
      ? { ...leaf.canonicalFlagAliases, ...(command === 'graph query' ? { subscription: 'subscriptions' } : {}) }
      : { ...leaf.aliasFlags }
    let shortFlags = Object.fromEntries(Object.entries(azShortFlags)
      .map(([short, name]) => [short, flagAliases[name] ?? name]).filter(([, name]) => Object.hasOwn(flags, name)))
    if (leaf.capability === 'passthrough') {
      const entry = azReads.AZ_READ_CATALOGUE.entries.find(entry => `az ${entry.command}` === command)
      flags = { profile: 'value', config: 'value', full: 'boolean', fields: 'value', help: 'boolean',
        ...Object.fromEntries(entry.arguments.map(argument => [argument.flags[0].slice(2), 'value'])) }
      flagAliases = Object.fromEntries(entry.arguments.flatMap(argument => argument.flags.slice(1)
        .filter(flag => flag.startsWith('--')).map(flag => [flag.slice(2), argument.flags[0].slice(2)])))
      shortFlags = { h: 'help', ...Object.fromEntries(entry.arguments.flatMap(argument => argument.flags
        .filter(flag => !flag.startsWith('--')).map(flag => [flag.slice(1), argument.flags[0].slice(2)]))) }
    }
    return { command, canonicalCommand: leaf.path, handlerCommand: leaf.handlerPath ?? leaf.path,
      tokenResources: leaf.capability !== 'native' || /^(config|setup)\b/.test(leaf.path) ? null
        : leaf.path === 'doctor' ? ['arm', 'logs', 'graph']
        : leaf.path === 'api' ? [] : leaf.path === 'rbac list' ? ['arm', 'graph']
        : leaf.path === 'monitor log-analytics query' ? ['logs']
        : leaf.path.startsWith('storage ') ? ['storage'] : leaf.path.startsWith('keyvault ') ? ['vault']
        : leaf.path.startsWith('acr ') ? ['registry'] : ['arm'],
      effect: leaf.effect, capability: leaf.capability, flags, flagAliases, shortFlags,
      positionalInput: Boolean(leaf.positionalInput && !canonical) }
  })),
  'vectra-axi': Object.entries(vectra.catalogue).map(([command, leaf]) => ({ command,
    flags: Object.fromEntries(Object.entries(leaf.flags).map(([name, flag]) => [name, flag.kind])) })),
  'mg-axi': mg.LEAVES.map(leaf => ({ command: leaf.path,
    flags: { help: 'boolean', ...Object.fromEntries(Object.entries(leaf.flags ?? {})
      .map(([name, flag]) => [name, flag.value ? 'value' : 'boolean'])) },
    positionalInput: leaf.positional ? { ...leaf.positional, required: true } : false })),
}
const environments = {
  'az-axi': {
    native: ['AZ_AXI_CONFIG', 'AZ_AXI_PROFILE', 'AZ_AXI_TENANT_ID', 'AZ_AXI_TENANT', 'AZ_AXI_SUBSCRIPTIONS', 'AZ_AXI_SUBSCRIPTION', 'AZ_AXI_READ_ONLY',
      'AZ_AXI_WRITE_LOG', ...azResources.map(resource => azConfig.tokenEnvFor({}, resource))],
    credentials: azResources.map(resource => ({ profileField: `${resource}Token.env`, transport: 'token value',
      defaultEnvironment: azConfig.tokenEnvFor({}, resource) })),
    sources: ['lib/config.js', 'lib/auth.js', 'lib/writeLog.js'],
  },
  'vectra-axi': {
    native: ['VECTRA_AXI_CONFIG', 'VECTRA_AXI_PROFILE', vectraWrites.READ_ONLY_ENV, vectraWrites.WRITE_LOG_ENV],
    credentials: [{ profileField: 'token.env', transport: 'token value' }, { profileField: 'clientSecret.env', transport: 'client-secret value' },
      { profileField: 'tokenEnv', transport: 'deprecated token value' }, { profileField: 'secretEnv', transport: 'deprecated client-secret value' }],
    sources: ['src/profiles.js', 'src/auth.js', 'src/oauth.js', 'src/writes.js', 'src/private-file.js'],
  },
  'mg-axi': {
    native: ['MG_AXI_CONFIG', 'MG_AXI_PROFILE', mgWrites.READ_ONLY_ENV, mgWrites.WRITE_LOG_ENV, 'AZURE_FEDERATED_TOKEN_FILE'],
    credentials: [{ profileField: 'clientSecret.env', transport: 'client-secret value', defaultEnvironment: 'MG_AXI_CLIENT_SECRET' },
      { profileField: 'privateKey.env', transport: 'private-key value', defaultEnvironment: 'MG_AXI_PRIVATE_KEY' },
      { profileField: 'token.env', transport: 'token or assertion value', defaultEnvironment: 'MG_AXI_TOKEN' }],
    sources: ['profiles.js', 'mutations.js', 'msal-app-provider.js', 'secrets.js', 'private-file.js'],
  },
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

const mgGlobalFlags = [
  { name: '--help', scope: 'bare or after a command; no -h alias' },
  ...['--version', '-v', '-V'].map(name => ({ name, scope: 'bare only' })),
]

for (const [tool, commands] of Object.entries(inventories)) {
  const packageUrl = new URL(`node_modules/@knowttl/${tool}/package.json`, root)
  const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'))
  if (pkg.version !== pins[pkg.name].version) throw new Error(`Pin mismatch for ${tool}`)
  const data = { generatedBy: 'scripts/upstream-inventory.mjs', tool, ...pins[pkg.name],
    parserEvidence: tool === 'mg-axi' ? 'Installed pinned catalogue exports'
      : 'Installed pinned catalogue exports, provisional until adapter acceptance',
    packageManifestSha256: createHash('sha256').update(readFileSync(packageUrl)).digest('hex'),
    environment: environments[tool].native.map(name => tool === 'mg-axi' ? { name } : { name, disposition: tool === 'az-axi'
      ? ['AZ_AXI_CONFIG', 'AZ_AXI_WRITE_LOG', ...azResources.map(resource => azConfig.tokenEnvFor({}, resource))].includes(name)
        ? 'set by server' : 'unsafe override' : 'server-owned' }),
    dynamicCredentialEnvironment: environments[tool].credentials.map(record => tool === 'mg-axi'
      ? record : { ...record, disposition: 'server-owned' }),
    environmentSources: environments[tool].sources.map(path => ({ path: `dist/${path}`,
      sha256: createHash('sha256').update(readFileSync(new URL(`node_modules/@knowttl/${tool}/dist/${path}`, root))).digest('hex') })),
    nativeWriteSettings: { default: 'disabled', ...(tool === 'mg-axi' ? {} : { disposition: 'server-owned' }),
      ...(tool === 'mg-axi' ? { supportedOperations: mgWriteOperations.sort() } : {}),
      ...(tool === 'vectra-axi' ? { supportedOperations: vectra.inventory.operations
        .filter(operation => operation.effect === 'write' && operation.disposition === 'named' && vectra.catalogue[operation.command])
        .map(operation => operation.id).sort() } : {}),
      profileFields: nativeWriteSettings[tool].profileFields, scope: nativeWriteSettings[tool].scope,
      sources: nativeWriteSettings[tool].sources.map(path => ({ path: `dist/${path}`,
        sha256: createHash('sha256').update(readFileSync(new URL(`node_modules/@knowttl/${tool}/dist/${path}`, root))).digest('hex') })) },
    suggestionFields: ['help'], format: 'TOON',
    ...(tool === 'az-axi' ? { discovery: {
      commands: [...new Set(commands.filter(entry => entry.tokenResources !== null).map(entry => entry.command.split(' ')[0]))],
      example: ['sub', 'list'],
      help: az.leafHelp(az.COMMAND_LEAVES.find(leaf => leaf.path === 'account list'), 'sub list')
        .replace(/^Flags: (.*)$/m, (_, flags) => `Flags: ${flags.split(', ')
          .filter(flag => !azUnsafeOverrides.includes(flag.slice(2))).join(', ')}`),
    } } : {}),
    ...(tool === 'vectra-axi' ? { discovery: { commands: [...new Set(commands.map(entry => entry.command.split(' ')[0]))].filter(command => command !== 'setup'),
      example: ['detection', 'list'],
      help: { ...vectra.help('detection list'),
        flags: Object.fromEntries(Object.entries(vectra.help('detection list').flags)
          .filter(([flag]) => !/^--(?:config|profile)\b/.test(flag))),
        combinations: [], examples: ['vectra-axi detection list'] } } } : {}),
    ...(tool === 'mg-axi' ? { discovery: {
      commands: mgAllowedCommands,
      example: ['entra', 'user', 'list'],
      help: mg.leafHelp({ ...mg.LEAVES.find(leaf => leaf.path === 'entra user list'),
        flags: Object.fromEntries(Object.entries(mg.LEAVES.find(leaf => leaf.path === 'entra user list').flags)
          .filter(([name]) => !mgUnsafeOverrides.includes(name))), examples: ['mg-axi entra user list'] }),
    } } : {}),
    ...(tool === 'az-axi' ? { adapterBoundary: {
      unsafeOverrides: azUnsafeOverrides, inputFileFlags: ['file', 'body-file'],
      sensitiveFlags: ['body', 'graph-query', 'analytics-query', 'query', 'note'],
      globalFlags: Object.keys(azArgs.GLOBAL_FLAG_SCHEMA).map(name => ({ name,
        disposition: azUnsafeOverrides.includes(name) ? 'unsafe override' : 'passthrough' })),
      inputs: { stdin: 'input transport', file: 'uploaded leaf only', 'body-file': 'uploaded leaf only',
        api: 'fixed ARM, Logs or Graph origin enforced by pinned client',
        metadata: 'account/vault/registry names and opaque markers enforced by pinned clients' },
      activation: 'Enabled in runtime registry. Unknown write outcomes are not retried; native settings and gates remain enforced.',
      parserSources: ['lib/args.js', 'lib/argv.js', 'lib/router.js'].map(path => ({ path: `dist/${path}`,
        sha256: createHash('sha256').update(readFileSync(new URL(`node_modules/@knowttl/az-axi/dist/${path}`, root))).digest('hex') })),
    } } : {}),
    ...(tool === 'az-axi' ? { tokenResourceSources: ['lib/registry.js', 'lib/client.js', 'lib/principals.js',
      'lib/storageMetadata.js', 'lib/keyvaultMetadata.js', 'lib/acrMetadata.js', 'commands/rbac.js',
      'commands/logs.js', 'commands/doctor.js', 'commands/api.js'].map(path => ({ path: `dist/${path}`,
      sha256: createHash('sha256').update(readFileSync(new URL(`node_modules/@knowttl/az-axi/dist/${path}`, root))).digest('hex') })) } : {}),
    ...(tool === 'vectra-axi' ? { adapterBoundary: {
      blockedCommands: ['setup'],
      unsafeOverrides: ['config', 'profile'], inputFileFlags: ['tags-file', 'ids-file', 'note-file'],
      parser: { aliases: {}, shortFlags: {}, repeats: 'refused', equals: true, doubleDash: 'unknown flag' },
      source: { path: 'dist/src/catalogue.js', sha256: createHash('sha256')
        .update(readFileSync(new URL('node_modules/@knowttl/vectra-axi/dist/src/catalogue.js', root))).digest('hex') },
    } } : {}),
    ...(tool === 'mg-axi' ? { headlessInventory: {
      activation: 'Wired into the production runtime registry. Live Graph authentication, application permissions, consent and deployment remain unverified; enabling Graph on a running installation requires live results and maintainer approval.',
      globalFlags: mgGlobalFlags,
      commonFlags: ['profile', 'api-version'].map(name => ({ name, scope: 'only on leaves declaring it' })),
      credentialEnvironment: ['MG_AXI_CLIENT_SECRET', 'MG_AXI_PRIVATE_KEY'].map(name => ({ name,
        scope: 'default SecretRef holder; a selected profile may name another holder' })),
      parser: { aliases: {}, shortFlags: {}, repeats: 'refused', equals: true,
        doubleDash: 'refused', globalFlagsBeforeCommand: 'refused', unknownFlags: 'refused' },
      schema: 'mg-axi-headless.schema.json',
      sources: ['catalogue.js', 'cli.js', 'profiles.js', 'msal-app-provider.js', 'mutations.js'].map(path => ({
        path: `dist/${path}`, sha256: createHash('sha256')
          .update(readFileSync(new URL(`node_modules/@knowttl/mg-axi/dist/${path}`, root))).digest('hex') })),
    } } : {}),
    ...(tool === 'mg-axi' ? { adapterBoundary: {
      unsafeOverrides: mgUnsafeOverrides,
      allowedCommands: mgAllowedCommands,
      inputs: { stdin: 'cursor - only', files: 'unsupported', cursor: 'opaque token or stdin; never a path',
        api: 'reviewed GET routes only; pinned Graph destination and operation gates retained' },
      sensitiveFlags: ['cursor', 'filter', 'odata', 'conditions', 'grant-controls', 'session-controls', 'display-name'],
      knownOutputScanValues: ['clientSecret and trimmed clientSecret', 'privateKey and normalized PEM'],
      outputScanLimit: 'Upstream-minted Graph tokens and assertions are not available during prepare; live redaction remains unverified.',
      resources: { nodeHeapMiB: 512, reason: 'Pinned 73 MiB operation inventory exceeds the default 128 MiB heap; fake read/write probes measure the bounded adapter allowance.' },
      nativeGates: ['configured writes.allowWrites', 'configured writes.operations', 'v1.0 operation scope',
        '--execute', '--confirm for disruptive writes', 'durable intent before single send', 'durable outcome'],
      parserSources: ['catalogue.js', 'cli.js'].map(path => ({ path: `dist/${path}`, sha256: createHash('sha256')
        .update(readFileSync(new URL(`node_modules/@knowttl/mg-axi/dist/${path}`, root))).digest('hex') })),
    } } : {}),
    flags: [...new Set(commands.flatMap(command => [...Object.keys(command.flags), ...Object.keys(command.flagAliases ?? {})]))].sort()
      .map(name => tool === 'mg-axi' ? { name } : { name, disposition: disposition(name) }), commands }
  const contents = JSON.stringify(data, null, 2) + '\n'
  const destination = new URL(`inventories/${tool}.json`, root)
  if (process.argv[2] === '--write') writeFileSync(destination, contents)
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error(`Inventory out of date: ${fileURLToPath(destination)}`)
  console.log(`inventory: ${tool} ${pkg.version}, ${commands.length} commands`)
}
