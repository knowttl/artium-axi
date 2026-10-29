import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { catalogue } from '../tools/node_modules/@knowttl/beyondtrust-axi/dist/src/catalogue.js'
import { identityWrites } from '../tools/node_modules/@knowttl/beyondtrust-axi/dist/src/identity-writes.js'
import { downloads } from '../tools/node_modules/@knowttl/beyondtrust-axi/dist/src/downloads.js'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/beyondtrust-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for beyondtrust-axi')
const unsafeOverrides = ['config', 'profile', 'out']
const inputFileFlags = ['file']
const downloadCommands = Object.keys(downloads)
const blockedCommands = ['profile list', 'config path', ...downloadCommands]
const commands = Object.entries(catalogue).sort(([a], [b]) => a.localeCompare(b)).map(([command, entry]) => ({
  command, effect: blockedCommands.includes(command) ? 'blocked' : Object.hasOwn(entry.flags, 'execute') ? 'write' : 'read',
  flags: entry.flags,
}))
const supportedOperations = [...commands.filter(route => route.effect === 'write').map(route => identityWrites[route.command]?.operation ?? route.command.replaceAll(' ', '.')),
  'policy.delete.force', ...downloadCommands.map(command => command.replaceAll(' ', '.'))].sort()
const skill = readFileSync(new URL('skills/beyondtrust-axi/SKILL.md', packageRoot), 'utf8')
const sources = readdirSync(new URL('dist/src/', packageRoot), { recursive: true }).filter(path => path.endsWith('.js')).sort()
  .map(path => ({ path: `dist/src/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/src/${path}`, packageRoot))).digest('hex') }))
const data = { generatedBy: 'scripts/beyondtrust-inventory.mjs', tool: 'beyondtrust-axi', ...pin,
  parserEvidence: 'Published catalogue and reviewed native parsers, write coordinator, delete gates and download contracts', sources,
  credentialSchema: JSON.parse(readFileSync(new URL('axi-credential.schema.json', packageRoot), 'utf8')),
  skillSha256: createHash('sha256').update(skill).digest('hex'),
  nativeWriteSettings: { supportedOperations },
  adapterBoundary: { unsafeOverrides, inputFileFlags, blockedCommands, downloadCommands,
    inputs: { stdin: 'unsupported', files: 'uploaded private leaves only, fixed input filename', downloads: 'authenticated hosted transfers only' },
    nativeWrites: 'native preview, exact operation allow-list, execute, exact confirm and durable journal; deletes additionally require allowDeletes and confirm-delete' },
  discovery: { commands: [...new Set(commands.filter(route => route.effect !== 'blocked').map(route => route.command.split(' ')[0]))],
    example: ['computer', 'list', '--limit', '1'],
    help: 'beyondtrust-axi computer list [--limit <n>]\nArtium manages host, client ID and secret. Writes require administrator-selected exact operations, native preview, --execute and exact --confirm. Deletes additionally require Allow deletes and --confirm-delete. Upload private files with --file. Use artium-axi download for authenticated saving.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
for (const [path, contents] of [['inventories/beyondtrust-axi.json', JSON.stringify(data, null, 2) + '\n'], ['skills/beyondtrust-axi/SKILL.md', skill]]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) { mkdirSync(new URL('./', destination), { recursive: true }); writeFileSync(destination, contents) }
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: beyondtrust-axi')
}
console.log(`inventory: beyondtrust-axi ${pkg.version}, ${commands.length} commands`)
