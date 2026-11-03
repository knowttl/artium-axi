import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

interface Command { command: string, effect: string, operation?: string, flags: string[], arguments: { flag: string }[] }
const root = new URL('../tools/', import.meta.url)
const source = (path: string) => new URL(`node_modules/@knowttl/technitium-axi/${path}`, root)
const pkg = JSON.parse(readFileSync(source('package.json'), 'utf8')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pkg.version !== pins[pkg.name].version) throw new Error('Technitium pin mismatch')
const upstream = JSON.parse(readFileSync(source('command-inventory.json'), 'utf8')) as { commands: Command[] }
const { readContracts } = await import(source('dist/read-contracts.js').href) as { readContracts: { id: string, kind: string }[] }
const { writeContracts } = await import(source('dist/write-contracts.js').href) as {
  writeContracts: { id: string, command: string, path: string, secrets?: string[] }[] }
const credentialSchema = JSON.parse(readFileSync(source('axi-credential.schema.json'), 'utf8'))
const writeOperations = (credentialSchema.properties.writes.properties.operations.items.enum as string[]).filter(id => id !== 'OP-002')
const unsafeOverrides = ['config', 'profile', 'origin', 'token', 'api-key', 'allow-insecure-http', 'result-file', 'reconcile-profile']
const values = ['--fields', '--max-bytes', '--max-requests', '--max-pages', '--max-elapsed-ms', '--input-file', '--confirm', '--reconcile']
const commands = [{ command: '', flags: { help: 'boolean', version: 'boolean', json: 'boolean' } as Record<string, string>, effect: 'read', operation: undefined },
  ...upstream.commands.filter(entry => entry.operation !== 'OP-002' && (entry.effect === 'read' || writeContracts.some(contract => contract.id === entry.operation)
    || ['schema', 'inventory', 'auth status'].includes(entry.command)))
    .map(entry => ({ command: entry.command, effect: entry.effect, operation: entry.operation,
      nativeInput: writeContracts.some(contract => contract.id === entry.operation),
      resultSource: entry.operation && entry.operation !== 'OP-001'
        ? readContracts.some(contract => contract.id === entry.operation && contract.kind !== 'json') ? 'file' : 'projection' : undefined,
      flags: Object.fromEntries(entry.flags.filter(flag => !unsafeOverrides.includes(flag.slice(2)))
        .map(flag => [flag.slice(2), [...values, ...entry.arguments.map(parameter => parameter.flag)].includes(flag) ? 'value' : 'boolean'])) }))]
const sources = ['package.json', 'README.md', 'command-inventory.json', 'axi-credential.schema.json', 'bin/technitium-axi.js',
  'dist/cli.js', 'dist/catalogue.js', 'dist/read-contracts.js', 'dist/archive-contract.js', 'dist/reads.js', 'dist/vendor.js',
  'dist/credentials.js', 'dist/private-file.js', 'dist/errors.js', 'dist/write-contracts.js', 'dist/writes.js', 'dist/configuration.js',
  'dist/cluster.js', 'dist/routing.js'].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(source(path))).digest('hex') }))
const output = JSON.stringify({ generatedBy: 'scripts/technitium-inventory.ts', tool: 'technitium-axi', package: pkg.name,
  ...pins[pkg.name], sources, credentialSchema, writeOperations, writeContracts: writeContracts.filter(contract => contract.id !== 'OP-002')
    .map(({ id, command, path, secrets }) => ({ id, command, path, secrets: secrets ?? [] })),
  commands, discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: ['status'],
    help: 'Managed Technitium reads and native writes. Run artium-axi technitium-axi <command> --help for selectors.\nAuthenticated results are private and single-use. Writes require host Write permission, an exact native grant, preview and exact confirmation.\nLogin acquisition, explicit create-token acquisition, alternate reconciliation profiles and local configuration are unavailable.\n' },
  adapterBoundary: { nativeWrites: 'Independent host and native grants; native confirmation and durable host journals.', inputFileFlags: ['input-file'], unsafeOverrides } }, null, 2) + '\n'
const destination = new URL('inventories/technitium-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(destination, output)
else if (readFileSync(destination, 'utf8') !== output) throw new Error('Technitium inventory is stale')
console.log(`inventory: technitium-axi ${pkg.version}, ${commands.length} commands`)
