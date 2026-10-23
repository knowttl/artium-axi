import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { catalogue, mutationOperations } from '../tools/node_modules/@knowttl/tenable-axi/dist/src/catalogue.js'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/tenable-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for tenable-axi')
const unsafeOverrides = ['config', 'profile', 'origin', 'output']
const inputFileFlags = ['filter-file', 'body-file', 'ids-file', 'asset-ids-file', 'tag-ids-file']
const blockedCommands = ['setup hooks', 'config path', 'profile list', 'hook', 'export attack download', 'export inventory download']
const commands = Object.entries(catalogue).sort(([a], [b]) => a.localeCompare(b)).map(([command, entry]) => ({
  command, effect: blockedCommands.includes(command) ? 'blocked' : Object.hasOwn(entry.flags, 'execute') ? 'write' : 'read',
  flags: entry.flags,
}))
const skill = readFileSync(new URL('skills/tenable-axi/SKILL.md', packageRoot), 'utf8')
const sources = readdirSync(new URL('dist/src/', packageRoot), { recursive: true }).filter(path => path.endsWith('.js')).sort()
  .map(path => ({ path: `dist/src/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/src/${path}`, packageRoot))).digest('hex') }))
const data = { generatedBy: 'scripts/tenable-inventory.mjs', tool: 'tenable-axi', ...pin,
  parserEvidence: 'Published command catalogue, mutation registry and reviewed native parsers and transport gates', sources,
  credentialSchema: JSON.parse(readFileSync(new URL('axi-credential.schema.json', packageRoot), 'utf8')),
  skillSha256: createHash('sha256').update(skill).digest('hex'),
  nativeWriteSettings: { supportedOperations: Object.keys(mutationOperations).sort() },
  adapterBoundary: { unsafeOverrides, inputFileFlags, blockedCommands,
    inputs: { stdin: 'explicit file flag with - only', files: 'uploaded leaves only', downloads: 'unsupported' },
    nativeWrites: 'native preview, operation allow-list, execute, exact confirm and durable journal' },
  discovery: { commands: [...new Set(commands.filter(route => route.effect !== 'blocked').map(route => route.command.split(' ')[0]))],
    example: ['card', 'list', '--limit', '1'],
    help: 'tenable-axi card list [--limit <n>]\nArtium manages both API keys and the fixed https://cloud.tenable.com origin. Writes and export-job creation require administrator-enabled operations, preview, --execute and exact --confirm. File inputs accept uploaded leaves or explicit stdin (-). Downloads and local configuration are blocked.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
for (const [path, contents] of [['inventories/tenable-axi.json', JSON.stringify(data, null, 2) + '\n'], ['skills/tenable-axi/SKILL.md', skill]]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) { mkdirSync(new URL('./', destination), { recursive: true }); writeFileSync(destination, contents) }
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: tenable-axi; review pinned commands and effects')
}
console.log(`inventory: tenable-axi ${pkg.version}, ${commands.length} commands`)
