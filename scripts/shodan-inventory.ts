import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

interface Command { command: string, operation?: string, effect: string, flags: string[] }
const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/@knowttl/shodan-axi/', root)
const source = (path: string) => new URL(path, packageRoot)
const pkg = JSON.parse(readFileSync(source('package.json'), 'utf8')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pkg.name !== '@knowttl/shodan-axi' || pkg.version !== pins[pkg.name]?.version) throw new Error('Shodan package mismatch')
const upstream = JSON.parse(readFileSync(source('command-inventory.json'), 'utf8')) as { commands: Command[] }
const unsafeOverrides = ['config', 'profile', 'origin', 'auth', 'api-key', 'key', 'token', 'env', 'file', 'input-file', 'result-file', 'filename', 'save', 'write-log', 'body-file']
const admitted = new Map([['', 'OP-045'], ['doctor', 'OP-045'], ['info', 'OP-045'], ['account profile', 'OP-039']])
for (const [command, operation] of admitted) {
  if (!upstream.commands.some(entry => entry.command === command && entry.operation === operation && entry.effect === 'read')) throw new Error(`Shodan catalogue mismatch: ${command}`)
}
const commands = [...upstream.commands.filter(entry => admitted.has(entry.command))
  .map(entry => ({ command: entry.command, effect: 'read', operation: admitted.get(entry.command),
    flags: Object.fromEntries(entry.flags.filter(flag => ['--json', '--help'].includes(flag)).map(flag => [flag.slice(2), 'boolean'])) })),
  { command: 'version', effect: 'read', operation: undefined, flags: { help: 'boolean' } }]
const sources = ['package.json', 'command-inventory.json', 'axi-credential.schema.json', 'bin/shodan-axi.js',
  ...readdirSync(source('dist/')).filter(name => name.endsWith('.js')).sort().map(name => `dist/${name}`),
  'skills/shodan-axi/SKILL.md'].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(source(path))).digest('hex') }))
const output = JSON.stringify({ generatedBy: 'scripts/shodan-inventory.ts', tool: 'shodan-axi', package: pkg.name,
  ...pins[pkg.name], sources, credentialSchema: JSON.parse(readFileSync(source('axi-credential.schema.json'), 'utf8')),
  commands, discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: ['info'],
    help: 'Read Shodan account information with managed credentials. Local configuration and writes are unavailable.\n' },
  adapterBoundary: { nativeWrites: 'not admitted', unsafeOverrides } }, null, 2) + '\n'
const destination = new URL('inventories/shodan-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(destination, output)
else if (readFileSync(destination, 'utf8') !== output) throw new Error('Shodan inventory is stale')
console.log(`inventory: shodan-axi ${pkg.version}, ${commands.length} commands`)
