import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

type Route = { command: string, flags: Record<string, string>, effect: string, stream?: boolean }
type UniFiRoute = { command: string, effect: string, status: string, contracts: { parameters: { name: string }[] }[] }
const root = new URL('../tools/', import.meta.url)
const read = (tool: string, path: string): string => readFileSync(new URL(`node_modules/@knowttl/${tool}/${path}`, root), 'utf8')
const { catalogue } = await import(new URL('node_modules/@knowttl/unifi-axi/dist/catalogue.js', root).href) as { catalogue: UniFiRoute[] }
const proxmox = JSON.parse(read('proxmox-axi', 'artium-invocations.json')) as { commands: Route[] }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
const unsafeOverrides = ['config', 'profile', 'origin', 'token', 'api-key', 'allow-insecure-http', 'session', 'body-file']
const specifications = {
  'unifi-axi': { schema: 'dist/axi-credential.schema.json', example: ['info'],
    sources: ['package.json', ...readdirSync(new URL('node_modules/@knowttl/unifi-axi/dist/', root))
      .filter(path => /\.(js|json)$/.test(path)).map(path => `dist/${path}`), 'dist/SKILL.md',
      'evidence/sources/network-10.6.109-openapi.json', 'evidence/sources/network-11.0.97-openapi.json'],
    commands: [{ command: '', flags: { help: 'boolean', site: 'value' }, effect: 'read' },
      { command: 'commands', flags: { help: 'boolean' }, effect: 'read' },
      { command: 'doctor', flags: { help: 'boolean' }, effect: 'read' },
      ...catalogue.filter(entry => entry.effect === 'read' && entry.status === 'implemented').map(entry => ({
        command: entry.command, effect: 'read', flags: { help: 'boolean',
          ...Object.fromEntries(entry.contracts[0].parameters.map(parameter => [parameter.name === 'siteId' ? 'site'
            : parameter.name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), 'value'])),
          ...(entry.command === 'site list' ? { site: 'value' } : {}) },
      }))] as Route[] },
  'proxmox-axi': { schema: 'axi-credential.schema.json', example: ['get', '/version'],
    sources: ['package.json', 'README.md', 'artium-invocations.json', 'bin/proxmox-axi.mjs',
      ...readdirSync(new URL('node_modules/@knowttl/proxmox-axi/dist/', root))
        .filter(path => /\.(js|json)$/.test(path)).map(path => `dist/${path}`)],
    commands: proxmox.commands.filter(entry => entry.effect === 'read' && !entry.stream
      && !['auth', 'config', 'profile', 'journal'].includes(entry.command.split(' ')[0])) },
}
for (const [tool, spec] of Object.entries(specifications)) {
  const pkg = JSON.parse(read(tool, 'package.json')) as { name: string, version: string }
  if (pins[pkg.name].version !== pkg.version) throw new Error(`${tool} installed version differs from its pin`)
  const commands = spec.commands.map(entry => ({ command: entry.command, effect: 'read',
    flags: Object.fromEntries(Object.entries(entry.flags).filter(([name]) => !unsafeOverrides.includes(name)
      && !(tool === 'proxmox-axi' && name === 'journal'))) }))
  const data = { generatedBy: 'scripts/network-read-inventory.ts', tool, package: pkg.name, version: pkg.version, integrity: pins[pkg.name].integrity,
    sources: [...spec.sources, spec.schema].map(path => ({ path, sha256: createHash('sha256').update(read(tool, path)).digest('hex') })),
    credentialSchema: JSON.parse(read(tool, spec.schema)) as Record<string, unknown>,
    adapterBoundary: { unsafeOverrides, nativeWrites: 'not admitted', blockedCommands: ['setup', 'update', 'auth', 'config', 'profile'] },
    commands, discovery: { commands: commands.map(entry => entry.command).filter(Boolean), example: spec.example,
      help: `${tool} managed reads. Run ${tool} ${spec.example.join(' ')} --help for selectors and limits.\nWrites, local configuration, input files and byte transports are unavailable.\n` } }
  const output = JSON.stringify(data, null, 2) + '\n'
  const target = new URL(`inventories/${tool}.json`, root)
  if (process.argv.includes('--write')) writeFileSync(target, output)
  else if (readFileSync(target, 'utf8') !== output) throw new Error(`${tool} inventory is stale`)
}
