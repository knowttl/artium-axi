import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

type Route = { command: string, flags: Record<string, string>, effect: string, operation?: string, stream?: boolean,
  operationId?: string, method?: string, path?: string, sensitiveInputs?: string[] }
type ProxmoxContract = { id: string, callable: boolean, allowtoken?: number, policy: {
  effect: string, transport: string, secrets: string, sensitiveInputs?: string[] } }
type UniFiRoute = { command: string, effect: string, status: string, vendorOperationId: string,
  contracts: { version: string, parameters: { name: string }[], requestBody?: { content: { 'application/json': { schema: { $ref: string } } } } }[] }
const root = new URL('../tools/', import.meta.url)
const read = (tool: string, path: string): string => readFileSync(new URL(`node_modules/@knowttl/${tool}/${path}`, root), 'utf8')
const { catalogue } = await import(new URL('node_modules/@knowttl/unifi-axi/dist/catalogue.js', root).href) as { catalogue: UniFiRoute[] }
const proxmox = JSON.parse(read('proxmox-axi', 'artium-invocations.json')) as { commands: Route[] }
const proxmoxContracts = (JSON.parse(read('proxmox-axi', 'dist/contracts.json')) as { contracts: ProxmoxContract[] }).contracts
const proxmoxWrites = proxmoxContracts.filter(contract => contract.callable && ['write', 'batch'].includes(contract.policy.effect)
  && contract.policy.transport === 'json' && contract.policy.secrets !== 'private-result' && contract.allowtoken !== 0)
const proxmoxWriteOperations = [...new Set(proxmoxWrites.map(contract => contract.id))].sort()
const proxmoxCommands = proxmox.commands.filter(entry => !entry.stream && (entry.effect === 'read'
  ? !['auth', 'config', 'profile'].includes(entry.command.split(' ')[0])
  : entry.operationId && proxmoxWriteOperations.includes(entry.operationId))).map(entry => ({ ...entry,
    sensitiveInputs: [...new Set(proxmoxWrites.filter(contract => contract.id === entry.operationId)
      .flatMap(contract => contract.policy.sensitiveInputs ?? []))],
    flags: { ...entry.flags, ...(entry.effect === 'write' ? { 'protected-input': 'boolean' } : {}) } }))
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
const unsafeOverrides = ['config', 'profile', 'origin', 'token', 'api-key', 'allow-insecure-http', 'session', 'body-file']
const qualifiedGrants: Record<string, string> = { 'network create': 'management', 'network update': 'management',
  'client action': 'action', 'device action': 'action', 'device interfaces ports action': 'action' }
const writeOperations = [...new Set(catalogue.filter(route => route.effect === 'write' && route.status === 'implemented').flatMap(route => {
  const field = qualifiedGrants[route.command]
  const variants = field ? route.contracts.flatMap(contract => {
    const document = JSON.parse(read('unifi-axi', `evidence/sources/network-${contract.version}-openapi.json`)) as {
      components: { schemas: Record<string, { discriminator?: { propertyName: string, mapping: Record<string, string> } }> } }
    const name = contract.requestBody!.content['application/json'].schema.$ref.slice('#/components/schemas/'.length)
      .replaceAll('~1', '/').replaceAll('~0', '~')
    const discriminator = document.components.schemas[name].discriminator
    if (discriminator?.propertyName !== field) throw new Error('UniFi qualified write contract changed')
    return Object.keys(discriminator.mapping).map(value => `${route.vendorOperationId}:${value}`)
  }) : []
  return [route.vendorOperationId, ...variants]
}))].sort()
const specifications = {
  'unifi-axi': { schema: 'dist/axi-credential.schema.json', example: ['info'],
    sources: ['package.json', ...readdirSync(new URL('node_modules/@knowttl/unifi-axi/dist/', root))
      .filter(path => /\.(js|json)$/.test(path)).map(path => `dist/${path}`), 'dist/SKILL.md',
      'evidence/sources/network-10.6.109-openapi.json', 'evidence/sources/network-11.0.97-openapi.json'],
    commands: [{ command: '', flags: { help: 'boolean', site: 'value', full: 'boolean' }, effect: 'read' },
      { command: 'commands', flags: { help: 'boolean' }, effect: 'read' },
      { command: 'doctor', flags: { help: 'boolean', full: 'boolean' }, effect: 'read' },
      ...['write show', 'write reconcile'].map(command => ({ command, flags: { help: 'boolean', 'request-id': 'value' }, effect: 'read' })),
      ...catalogue.filter(entry => entry.status === 'implemented').map(entry => ({
        command: entry.command, operation: entry.vendorOperationId, effect: entry.effect, flags: { help: 'boolean',
          ...Object.fromEntries(entry.contracts[0].parameters.map(parameter => [parameter.name === 'siteId' ? 'site'
            : parameter.name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), 'value'])),
          ...(entry.command === 'site list' ? { site: 'value' } : {}),
          ...(entry.effect === 'read' ? { full: 'boolean' } : { execute: 'boolean', confirm: 'value', 'request-id': 'value' }),
          ...(entry.contracts.some(contract => contract.requestBody) ? { 'body-file': 'value' } : {}) },
      }))] as Route[] },
  'proxmox-axi': { schema: 'axi-credential.schema.json', example: ['get', '/version'],
    sources: ['package.json', 'README.md', 'artium-invocations.json', 'bin/proxmox-axi.mjs',
      ...readdirSync(new URL('node_modules/@knowttl/proxmox-axi/dist/', root))
        .filter(path => /\.(js|json)$/.test(path)).map(path => `dist/${path}`)],
    commands: proxmoxCommands },
}
for (const [tool, spec] of Object.entries(specifications)) {
  const pkg = JSON.parse(read(tool, 'package.json')) as { name: string, version: string }
  if (pins[pkg.name].version !== pkg.version) throw new Error(`${tool} installed version differs from its pin`)
  const overrides = tool === 'unifi-axi' ? [...unsafeOverrides.filter(name => name !== 'body-file'), 'secret-output'] : unsafeOverrides
  const commands = spec.commands.map(entry => ({ command: entry.command, effect: entry.effect,
    ...(entry.operation ? { operation: entry.operation } : {}),
    ...(tool === 'proxmox-axi' ? { ...(entry.operationId ? { operationId: entry.operationId, method: entry.method, path: entry.path } : {}),
      sensitiveInputs: entry.sensitiveInputs ?? [] } : {}),
    flags: Object.fromEntries(Object.entries(entry.flags).filter(([name]) => !overrides.includes(name)
      && !(tool === 'proxmox-axi' && entry.sensitiveInputs?.includes(name.replace(/^api-/, ''))))) }))
  const data = { generatedBy: 'scripts/network-read-inventory.ts', tool, package: pkg.name, version: pkg.version, integrity: pins[pkg.name].integrity,
    sources: [...spec.sources, spec.schema].map(path => ({ path, sha256: createHash('sha256').update(read(tool, path)).digest('hex') })),
    credentialSchema: JSON.parse(read(tool, spec.schema)) as Record<string, unknown>,
    writeOperations: tool === 'unifi-axi' ? writeOperations : proxmoxWriteOperations,
    adapterBoundary: { unsafeOverrides: overrides,
      ...(tool === 'unifi-axi' ? { inputFileFlags: ['body-file'] } : {}),
      nativeWrites: tool === 'unifi-axi' ? 'native preview, exact grants, confirmation and durable request IDs'
        : 'ordinary JSON writes with independent native/host grants, exact single-use preview confirmation and durable journals',
      blockedCommands: ['setup', 'update', 'auth', 'config', 'profile'] },
    commands, discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: spec.example,
      help: tool === 'unifi-axi'
        ? 'UniFi managed reads and native write previews. Run each command with --help for selectors and limits.\nExecution requires administrator Allow writes and exact native operation/variant grants; preview first, then repeat with --execute --confirm <confirmation> --request-id <stable-id>.\nUpload private JSON through --body-file. Use write show/reconcile with the same request ID after uncertainty; never resend automatically.\nLocal configuration, credential overrides, secret export and byte transports are unavailable in hosted execution.\n'
        : 'Proxmox managed reads and ordinary JSON writes. Run each command with --help for selectors and limits.\nWrites require both native profile operations and administrator host operation grants, off by default. Use --preview, then repeat identical inputs with --confirm <confirmation>.\nUse --protected-input with bounded private stdin {api,secrets}; sensitive values require PVE_INPUT_ env SecretRefs and never arguments or host files.\nUse journal show/reconcile <id> and journal-bound task status/log/wait after uncertainty; never resend a consumed confirmation.\nProtected results and memory authentication belong to the next capability slice; managed transfers and duplex streams follow separately and remain unavailable here.\n' } }
  const output = JSON.stringify(data, null, 2) + '\n'
  const target = new URL(`inventories/${tool}.json`, root)
  if (process.argv.includes('--write')) writeFileSync(target, output)
  else if (readFileSync(target, 'utf8') !== output) throw new Error(`${tool} inventory is stale`)
}
