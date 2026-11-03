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
const unsafeOverrides = ['config', 'profile', 'origin', 'token', 'api-key', 'allow-insecure-http', 'result-file', 'input-file']
const values = ['--fields', '--max-bytes', '--max-requests', '--max-pages', '--max-elapsed-ms']
const commands = [{ command: '', flags: { help: 'boolean', version: 'boolean', json: 'boolean' } as Record<string, string>, effect: 'read', operation: undefined },
  ...upstream.commands.filter(entry => entry.effect === 'read' || ['schema', 'inventory', 'auth status'].includes(entry.command))
    .map(entry => ({ command: entry.command, effect: 'read', operation: entry.operation,
      resultSource: entry.operation && entry.operation !== 'OP-001'
        ? readContracts.some(contract => contract.id === entry.operation && contract.kind !== 'json') ? 'file' : 'projection' : undefined,
      flags: Object.fromEntries(entry.flags.filter(flag => !unsafeOverrides.includes(flag.slice(2)))
        .map(flag => [flag.slice(2), [...values, ...entry.arguments.map(parameter => parameter.flag)].includes(flag) ? 'value' : 'boolean'])) }))]
const sources = ['package.json', 'README.md', 'command-inventory.json', 'axi-credential.schema.json', 'bin/technitium-axi.js',
  'dist/cli.js', 'dist/catalogue.js', 'dist/read-contracts.js', 'dist/archive-contract.js', 'dist/reads.js', 'dist/vendor.js',
  'dist/credentials.js', 'dist/private-file.js', 'dist/errors.js'].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(source(path))).digest('hex') }))
const output = JSON.stringify({ generatedBy: 'scripts/technitium-inventory.ts', tool: 'technitium-axi', package: pkg.name,
  ...pins[pkg.name], sources, credentialSchema: JSON.parse(readFileSync(source('axi-credential.schema.json'), 'utf8')),
  commands, discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: ['status'],
    help: 'Managed Technitium reads. Run artium-axi technitium-axi <command> --help for selectors.\nAuthenticated reads return a protected result reference; retrieve it once with the same identity and current credential.\nWrites and local configuration are unavailable.\n' },
  adapterBoundary: { nativeWrites: 'Published native writes are not admitted by the host; reads remain forced read-only.', unsafeOverrides } }, null, 2) + '\n'
const destination = new URL('inventories/technitium-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(destination, output)
else if (readFileSync(destination, 'utf8') !== output) throw new Error('Technitium inventory is stale')
console.log(`inventory: technitium-axi ${pkg.version}, ${commands.length} commands`)
