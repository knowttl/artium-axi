import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

interface Command { command: string, operation?: string, effect: string, cost?: string, flags: string[], arguments: { name: string }[], selectors?: string[], outputSchema?: object }
const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/shodan-axi/', root)
const source = (path: string) => new URL(path, packageRoot)
const pkg = JSON.parse(readFileSync(source('package.json'), 'utf8')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pkg.name !== '@knowttl/shodan-axi' || pkg.version !== pins[pkg.name]?.version) throw new Error('Shodan package mismatch')
const upstream = JSON.parse(readFileSync(source('command-inventory.json'), 'utf8')) as { commands: Command[] }
const unsafeOverrides = ['config', 'profile', 'origin', 'auth', 'api-key', 'key', 'token', 'env', 'file', 'input-file', 'result-file', 'filename', 'save', 'write-log', 'body-file']
const admitted = ['OP-001', 'OP-002', 'OP-003', 'OP-004', 'OP-005', 'OP-006', 'OP-007', 'OP-008', 'OP-011', 'OP-012', 'OP-014', 'OP-017', 'OP-018', 'OP-025', 'OP-026', 'OP-029', 'OP-031', 'OP-032', 'OP-033', 'OP-034', 'OP-036', 'OP-039', 'OP-040', 'OP-041', 'OP-042', 'OP-043', 'OP-044', 'OP-045', 'OP-055', 'OP-056', 'OP-059', 'CLI-025']
const booleanFlags = ['--json', '--help', '--history', '--ipv6', '--details', '--full', '--color', '--no-color', '--accept-unknown-cost']
const commands = [...upstream.commands.filter(entry => (entry.effect === 'read' && entry.operation && admitted.includes(entry.operation) && entry.command !== 'doctor'))
  .map(entry => ({ command: entry.command, effect: 'read', operation: entry.operation, arguments: entry.arguments ?? [], ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
    flags: Object.fromEntries(entry.flags.filter(flag => !unsafeOverrides.includes(flag.slice(2)))
      .map(flag => [flag.slice(2), booleanFlags.includes(flag) ? 'boolean' : 'value'])) })),
  { command: 'version', effect: 'read', operation: undefined, arguments: [], flags: { help: 'boolean' } }]
for (const operation of admitted) {
  if (!commands.some(entry => entry.operation === operation)) throw new Error(`Shodan catalogue mismatch: ${operation}`)
}
for (const command of commands) {
  if (command.operation && !['OP-003', 'OP-040'].includes(command.operation) && !('outputSchema' in command && command.outputSchema)) throw new Error(`Shodan output schema missing: ${command.command}`)
}
const ipv6Schema = upstream.commands.find(entry => entry.operation === 'OP-072')?.outputSchema
if (!ipv6Schema) throw new Error('Shodan output schema missing: myip --ipv6')
const countSchema = upstream.commands.find(entry => entry.command === 'count')?.outputSchema as { properties?: { facets?: { properties?: Record<string, object> } } } | undefined
const publicFacets = Object.keys(countSchema?.properties?.facets?.properties ?? {})
if (!publicFacets.length) throw new Error('Shodan count facet schema missing')
const dataSchema = upstream.commands.find(entry => entry.command === 'data list')?.outputSchema as { properties: { items: { items: { anyOf: { required: string[], additionalProperties: boolean }[] } } } } | undefined
const variants = dataSchema?.properties.items.items.anyOf
if (!dataSchema || variants?.length !== 2 || variants.some(item => item.additionalProperties !== false)) throw new Error('Shodan dataset schema mismatch')
const datasetSchemas = ['description', 'size'].map(field => {
  const item = variants.find(entry => entry.required.includes(field))
  if (!item) throw new Error('Shodan dataset variant missing')
  return { ...dataSchema, properties: { ...dataSchema.properties, items: { ...dataSchema.properties.items, items: item } } }
})
const sources = ['package.json', 'command-inventory.json', 'axi-credential.schema.json', 'bin/shodan-axi.js',
  ...readdirSync(source('dist/')).filter(name => name.endsWith('.js')).sort().map(name => `dist/${name}`),
  'skills/shodan-axi/SKILL.md'].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(source(path))).digest('hex') }))
const output = JSON.stringify({ generatedBy: 'scripts/shodan-inventory.ts', tool: 'shodan-axi', package: pkg.name,
  ...pins[pkg.name], sources, credentialSchema: JSON.parse(readFileSync(source('axi-credential.schema.json'), 'utf8')), ipv6Schema, publicFacets, datasetSchemas,
  commands,
  discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: ['info'],
    help: 'Read Shodan account and investigation data with managed credentials. Search and domain lookups consume query credits. Local configuration and writes are unavailable.\n' },
  adapterBoundary: { nativeWrites: 'not admitted', unsafeOverrides } }, null, 2) + '\n'
const destination = new URL('inventories/shodan-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(destination, output)
else if (readFileSync(destination, 'utf8') !== output) throw new Error('Shodan inventory is stale')
console.log(`inventory: shodan-axi ${pkg.version}, ${commands.length} commands`)
