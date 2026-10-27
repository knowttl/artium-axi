import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { catalogue } from '../tools/node_modules/@knowttl/checkpoint-axi/dist/src/catalogue.js'
import { REGIONS } from '../tools/node_modules/@knowttl/checkpoint-axi/dist/src/regions.js'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/checkpoint-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for checkpoint-axi')
const unsafeOverrides = ['config', 'profile', 'origin', 'out']
const inputFileFlags = ['input']
const downloadCommands = ['email download', 'attachment download', 'attachment download-all']
const blockedCommands = ['profile list', 'config path', 'exception clear', ...downloadCommands]
const supportedOperations = ['email.quarantine', 'email.restore',
  ...['phishing-allow', 'phishing-block', 'spam-allow'].flatMap(kind => ['create', 'update', 'remove'].map(action => `exception.${kind}.${action}`)),
  'exception.anomaly.create', 'exception.anomaly.remove',
  ...['create', 'update', 'remove', 'remove-items'].map(action => `exception.click-time.${action}`),
  ...['malware', 'url', 'dlp'].flatMap(kind => ['create', 'update'].map(action => `exception.${kind}.${action}`)),
  'email.download', 'attachment.download', 'attachment.download-all'].sort()
const commands = Object.entries(catalogue).sort(([a], [b]) => a.localeCompare(b)).map(([command, entry]) => ({
  command, effect: blockedCommands.includes(command) ? 'blocked' : Object.hasOwn(entry.flags, 'execute') ? 'write' : 'read',
  flags: entry.flags,
}))
const skill = readFileSync(new URL('skills/checkpoint-axi/SKILL.md', packageRoot), 'utf8')
const sources = readdirSync(new URL('dist/src/', packageRoot), { recursive: true }).filter(path => path.endsWith('.js')).sort()
  .map(path => ({ path: `dist/src/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/src/${path}`, packageRoot))).digest('hex') }))
const data = { generatedBy: 'scripts/checkpoint-inventory.mjs', tool: 'checkpoint-axi', ...pin,
  parserEvidence: 'Published catalogue, fixed regional map and reviewed native parsers, write coordinator and download contracts', sources,
  credentialSchema: JSON.parse(readFileSync(new URL('axi-credential.schema.json', packageRoot), 'utf8')),
  regions: REGIONS, skillSha256: createHash('sha256').update(skill).digest('hex'),
  nativeWriteSettings: { supportedOperations, dynamicOperation: 'event.action.<exact available action name>' },
  adapterBoundary: { unsafeOverrides, inputFileFlags, blockedCommands, downloadCommands,
    inputs: { stdin: 'unsupported', files: 'uploaded private JSON leaves only', downloads: 'authenticated hosted transfers only' },
    nativeWrites: 'native preview, exact operation allow-list, execute, exact confirm and durable journal; ambiguous deletes refused' },
  discovery: { commands: [...new Set(commands.filter(route => route.effect !== 'blocked').map(route => route.command.split(' ')[0]))],
    example: ['email', 'search', '--limit', '1'],
    help: 'checkpoint-axi email search [--limit <n>]\nArtium manages region, client ID and secret. Writes require administrator-enabled exact operations and native preview, --execute and exact --confirm. Upload private JSON with --input. Use artium-axi download for authenticated email and attachment saving with host-owned confirmation; ordinary downloads and local configuration are blocked.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
for (const [path, contents] of [['inventories/checkpoint-axi.json', JSON.stringify(data, null, 2) + '\n'], ['skills/checkpoint-axi/SKILL.md', skill]]) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) { mkdirSync(new URL('./', destination), { recursive: true }); writeFileSync(destination, contents) }
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: checkpoint-axi; review pinned commands and effects')
}
console.log(`inventory: checkpoint-axi ${pkg.version}, ${commands.length} commands`)
