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
const managedCommands = metadata.commands.filter(command => ['exec', 'execution show'].includes(command.command))
  .map(command => ({ ...command, flags: Object.fromEntries(Object.entries(command.flags).filter(([flag]) => !['connection', 'full'].includes(flag))) }))
const sources = ['package.json', 'axi-credential.schema.json', 'artium-invocations.json', 'README.md',
  ...readdirSync(new URL('dist/', base)).sort().map(name => `dist/${name}`)].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex') }))
const data = { generatedBy: 'scripts/ssh-inventory.ts', tool: 'ssh-axi', package: pkg.name, ...pins[pkg.name], sources,
  credentialSchema: JSON.parse(read('axi-credential.schema.json')) as Record<string, unknown>, commands, managedCommands,
  adapterBoundary: { credentials: 'Dedicated encrypted SSH credentials and caller-filtered ordinary host bindings only.',
    writes: 'Confirmed one-shot execution uses signed preparations and durable claims; Allow writes, writable hosts and caller grants are required. Sudo uses a distinct approved account and credential. Reusable connections and cancellation are not admitted.' },
  requirements: { timeoutMs: 17_000, runtime: 'node' }, discovery: {
    commands: [...commands.filter(route => route.command !== 'home'), ...managedCommands].map(route => route.command), example: ['host', 'list'],
    help: 'Discover granted SSH hosts with host list, host show <host> and doctor <host>.\nDoctor authenticates without remote execution.\nUse exec <host> --command <text> --confirm for arbitrary commands; writes default off and require a writable host and caller grants.\nSudo additionally requires its separate approved account, credential and caller grant.\nA private command-free receipt is saved before submission; execution show without an ID recovers it. No automatic replay.\nCommands have a 1-600 second deadline and retain at most 8192 bytes per output stream for 14 days, encrypted; sanitized command metadata is retained for 90 days.\nAdministrators manage independently verified hosts and encrypted keys at /admin/ssh.\nCredentials, endpoints and trust cannot be overridden in arguments. Reusable connections, cancellation and audit exports remain unavailable.\n' } }
const output = JSON.stringify(data, null, 2) + '\n'
const target = new URL('inventories/ssh-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(target, output)
else if (readFileSync(target, 'utf8') !== output) throw new Error('SSH inventory is stale')
console.log(`inventory: ssh-axi ${pkg.version}, ${commands.length} read routes`)
