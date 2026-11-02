import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

type Command = { command: string, flags: Record<string, string> }
type NativeCommand = { name: string, positional?: string }
const root = new URL('../tools/', import.meta.url)
const base = new URL('node_modules/@knowttl/falcon-axi/', root)
const read = (path: string): string => readFileSync(new URL(path, base), 'utf8')
const pkg = JSON.parse(read('package.json')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pins[pkg.name].version !== pkg.version) throw new Error('Falcon installed version differs from its pin')
const native = JSON.parse(read('artium-invocations.json')) as { commands: Command[], globalFlags: string[] }
const metadata = await import(new URL('.typescript-build/src/metadata.js', base).href) as { commands: NativeCommand[] }
const help = JSON.parse(read('.typescript-build/src/help.json')) as Record<string, string>
const unsafeOverrides = ['region', 'member-cid', 'allow-unknown-origin', 'no-member-cid', 'config', 'profile']
const writeCommands = ['search start', 'search stop', 'host usb', 'identity activity', 'malquery search', 'rtr run']
const deferredCommands: string[] = []
const blockedCommands = ['setup', 'config', 'profile', 'credentials', 'credential', 'export', 'auth login', 'auth logout', ...deferredCommands]
const admitted = native.commands.filter(entry => !blockedCommands.includes(entry.command)
  && !blockedCommands.includes(entry.command.split(' ')[0]))
const globalFlags = Object.fromEntries(native.globalFlags.map(name => [name,
  ['help', 'allow-unknown-origin', 'no-member-cid'].includes(name) ? 'boolean' : 'value']))
const commands = [{ command: 'home', flags: globalFlags, effect: 'read', positional: null },
  ...admitted.map(entry => ({ ...entry, effect: writeCommands.includes(entry.command) ? 'write' : 'read',
    positional: metadata.commands.find(command => command.name === entry.command)?.positional ?? null }))]
function files(path: string): string[] {
  return readdirSync(new URL(path, base), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => entry.isDirectory()
    ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`])
}
const sources = ['package.json', 'artium-invocations.json', ...files('.typescript-build'), ...files('native/prebuilds'),
  ...files('skills/falcon-axi')].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, base))).digest('hex') }))
const data = { generatedBy: 'scripts/falcon-inventory.ts', tool: 'falcon-axi', package: pkg.name, ...pins[pkg.name], sources,
  credentialSchema: JSON.parse(read('.typescript-build/src/axi-credential.schema.json')) as Record<string, unknown>,
  skillSha256: sources.find(entry => entry.path === 'skills/falcon-axi/SKILL.md')!.sha256,
  parser: { path: '.typescript-build/src/parser.js', sha256: sources.find(entry => entry.path === '.typescript-build/src/parser.js')!.sha256,
    aliases: {}, shortFlags: {}, repeats: 'last value wins', equals: true, booleanValues: 'refused', doubleDash: 'unknown flag' },
  flags: native.globalFlags.map(name => ({ name, disposition: unsafeOverrides.includes(name) ? 'server-owned' : 'passthrough' })),
  unsafeOverrides, blockedCommands, deferredCommands, commands,
  environment: ['FALCON_AXI_READ_ONLY', 'FALCON_AXI_WRITE_LOG'].map(name => ({ name, disposition: 'injected' })),
  requirements: { runtime: 'node', timeoutMs: 65_000, temporaryFiles: ['falcon-axi/config.json'],
    nativeWrites: 'Exact administrator command grants and FALCON_AXI_READ_ONLY; search/MalQuery lifecycle dispatches natively, RTR retains profile opt-in, restrictions and exact execute/confirm.' },
  healthRead: ['auth', 'status'], suggestionFields: ['help'],
  discovery: { commands: [...new Set(admitted.map(entry => entry.command.split(' ')[0]))], example: ['detection', 'list'],
    help: help['detection list'] },
}
const contents = JSON.stringify(data, null, 2) + '\n'
const destination = new URL('inventories/falcon-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Falcon inventory is stale')
console.log(`inventory: falcon-axi ${pkg.version}, ${commands.length} admitted commands`)
