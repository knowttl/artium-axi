import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

interface Command { command: string, operation?: string, effect: string, flags: string[] }
const root = new URL('../tools/', import.meta.url)
const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR
  ? pathToFileURL(`${process.env.SHODAN_AXI_PACKAGE_DIR.replace(/\/$/, '')}/`)
  : new URL('node_modules/@knowttl/shodan-axi/', root)
const source = (path: string) => new URL(path, packageRoot)
const pkg = JSON.parse(readFileSync(source('package.json'), 'utf8')) as { name: string, version: string }
if (pkg.name !== '@knowttl/shodan-axi' || pkg.version !== '0.1.0') throw new Error('Shodan package mismatch')
const upstream = JSON.parse(readFileSync(source('command-inventory.json'), 'utf8')) as { commands: Command[] }
const unsafeOverrides = ['config', 'profile', 'origin', 'api-key', 'key', 'token', 'env', 'file', 'input-file', 'result-file']
const admitted = new Map([['', 'OP-045'], ['doctor', 'OP-045'], ['info', 'OP-045'], ['account profile', 'OP-039']])
for (const [command, operation] of admitted) {
  if (!upstream.commands.some(entry => entry.command === command && entry.operation === operation && entry.effect === 'read')) throw new Error(`Shodan catalogue mismatch: ${command}`)
}
const commands = [...upstream.commands.filter(entry => admitted.has(entry.command))
  .map(entry => ({ command: entry.command, effect: 'read', operation: admitted.get(entry.command),
    flags: Object.fromEntries(entry.flags.filter(flag => ['--json', '--help'].includes(flag)).map(flag => [flag.slice(2), 'boolean'])) })),
  { command: 'version', effect: 'read', operation: undefined, flags: {} }]
const sources = ['package.json', 'command-inventory.json', 'axi-credential.schema.json', 'bin/shodan-axi.js',
  'dist/cli.js', 'dist/catalogue.js', 'dist/contracts.js', 'dist/credentials.js', 'dist/discovery.js', 'dist/vendor.js',
  'dist/private-file.js', 'dist/errors.js', 'dist/version.js', 'dist/windows-acl.js', 'skills/shodan-axi/SKILL.md'].map(path => ({ path,
  sha256: createHash('sha256').update(readFileSync(source(path))).digest('hex') }))
const output = JSON.stringify({ generatedBy: 'scripts/shodan-inventory.ts', tool: 'shodan-axi', package: pkg.name,
  version: pkg.version, sources, credentialSchema: JSON.parse(readFileSync(source('axi-credential.schema.json'), 'utf8')),
  commands, discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: ['info'],
    help: 'Read Shodan account information with managed credentials. Local configuration and writes are unavailable.\n' },
  adapterBoundary: { nativeWrites: 'not admitted', unsafeOverrides } }, null, 2) + '\n'
const destination = new URL('inventories/shodan-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(destination, output)
else if (readFileSync(destination, 'utf8') !== output) throw new Error('Shodan inventory is stale')
console.log(`inventory: shodan-axi ${pkg.version}, ${commands.length} commands`)
