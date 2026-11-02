import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const root = new URL('../tools/', import.meta.url)
const base = new URL('node_modules/@knowttl/ssh-axi/', root)
const read = (path: string) => readFileSync(new URL(path, base), 'utf8')
const pkg = JSON.parse(read('package.json')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pins[pkg.name].version !== pkg.version) throw new Error('SSH installed version differs from its pin')
const metadata = JSON.parse(read('artium-invocations.json')) as { revision: number,
  commands: { command: string, arguments: number, flags: Record<string, string>, effect: string }[] }
const commands = metadata.commands.filter(command => ['home', 'host list', 'host show', 'doctor'].includes(command.command))
const sources = ['package.json', 'axi-credential.schema.json', 'artium-invocations.json', 'README.md',
  ...readdirSync(new URL('dist/', base)).sort().map(name => `dist/${name}`)].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex') }))
const data = { generatedBy: 'scripts/ssh-inventory.ts', tool: 'ssh-axi', package: pkg.name, ...pins[pkg.name], sources,
  credentialSchema: JSON.parse(read('axi-credential.schema.json')) as Record<string, unknown>, commands,
  adapterBoundary: { credentials: 'Dedicated encrypted SSH credentials and caller-filtered ordinary host bindings only.',
    writes: 'Execution, sudo, reusable connections and retained execution results are not admitted.' },
  requirements: { timeoutMs: 17_000, runtime: 'node' }, discovery: {
    commands: commands.filter(route => route.command !== 'home').map(route => route.command), example: ['host', 'list'],
    help: 'Discover granted SSH hosts and authenticate without remote execution.\nUse host list, host show <host> or doctor <host>.\nHost keys and literal addresses are approved independently by administrators.\nCredentials are managed privately; configuration overrides, execution, sudo and reusable connections are unavailable.\n' } }
const output = JSON.stringify(data, null, 2) + '\n'
const target = new URL('inventories/ssh-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(target, output)
else if (readFileSync(target, 'utf8') !== output) throw new Error('SSH inventory is stale')
console.log(`inventory: ssh-axi ${pkg.version}, ${commands.length} read routes`)
