import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { catalogue, mutationOperations } from '../tools/node_modules/@knowttl/hybrid-axi/dist/src/catalogue.js'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/hybrid-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for hybrid-axi')
const unsafeOverrides = ['config', 'profile', 'origin', 'output']
const inputFileFlags = ['file', 'body-file', 'hashes-file']
const blockedCommands = ['setup', 'setup hooks', 'config path', 'profile list', 'hash file', 'report file']
const commands = Object.entries(catalogue).sort(([a], [b]) => a.localeCompare(b)).map(([command, entry]) => ({
  command, effect: blockedCommands.includes(command) ? 'blocked' : entry.effect,
  flags: Object.fromEntries(Object.entries(entry.flags).map(([flag, description]) => [flag.slice(2), description])),
}))
const skill = readFileSync(new URL('skills/hybrid-axi/SKILL.md', packageRoot), 'utf8')
const sources = readdirSync(new URL('dist/src/', packageRoot), { recursive: true }).filter(path => path.endsWith('.js')).sort()
  .map(path => ({ path: `dist/src/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/src/${path}`, packageRoot))).digest('hex') }))
const data = { generatedBy: 'scripts/hybrid-inventory.mjs', tool: 'hybrid-axi', ...pin,
  parserEvidence: 'Published command catalogue, mutation registry and reviewed native parsers and transport gates', sources,
  credentialSchema: JSON.parse(readFileSync(new URL('axi-credential.schema.json', packageRoot), 'utf8')),
  skillSha256: createHash('sha256').update(skill).digest('hex'),
  nativeWriteSettings: { supportedOperations: Object.keys(mutationOperations).filter(name => !name.includes('-download-')).sort() },
  adapterBoundary: { unsafeOverrides, inputFileFlags, blockedCommands,
    inputs: { stdin: 'body-file - only', files: 'uploaded leaves only', downloads: 'not available through artium; use hybrid-axi locally' },
    nativeWrites: 'native preview, operation allow-list, execute, exact confirm and durable journal' },
  discovery: { commands: [...new Set(commands.filter(route => route.effect !== 'blocked').map(route => route.command.split(' ')[0]))],
    example: ['quota'],
    help: 'hybrid-axi quota\nArtium manages the API key and fixed Hybrid Analysis origin. Submissions, YARA mutations and consuming matches are off by default; administrator-enabled operations still require native preview, --execute, exact --confirm and journal. Quick scans transmit the supplied sample or URL as read exceptions. File flags accept uploaded leaves; body-file also accepts explicit stdin (-). Downloads are not available through artium; use hybrid-axi locally.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
for (const [path, contents] of [['inventories/hybrid-axi.json', JSON.stringify(data, null, 2) + '\n'], ['skills/hybrid-axi/SKILL.md', skill]]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) { mkdirSync(new URL('./', destination), { recursive: true }); writeFileSync(destination, contents) }
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: hybrid-axi; review pinned commands and effects')
}
console.log(`inventory: hybrid-axi ${pkg.version}, ${commands.length} commands`)
