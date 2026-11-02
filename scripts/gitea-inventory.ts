import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

type Flag = { type: 'boolean' | 'string', short?: string, gap?: string }
type Command = { path: string[], effect: string, flags: Record<string, Flag> }
type Route = { path: string, method: string, operation: string, effect: string }
const root = new URL('../tools/', import.meta.url)
const read = (path: string): string => readFileSync(new URL(`node_modules/@knowttl/gitea-axi/${path}`, root), 'utf8')
const pkg = JSON.parse(read('package.json')) as { name: string, version: string }
const pins = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8')) as Record<string, { version: string, integrity: string }>
if (pins[pkg.name].version !== pkg.version) throw new Error('Gitea installed version differs from its pin')
const inventory = JSON.parse(read('generated/host-inventory.json')) as { commands: Command[] }
const unsafeOverrides = ['config', 'profile', 'hostname', 'origin', 'token', 'api-key', 'password', 'authorization', 'allow-insecure-http',
  'allow-write', 'preview', 'confirm', 'field', 'raw-field', 'input', 'header']
const commands = inventory.commands.filter(entry => entry.effect === 'read'
  && !['auth', 'profile', 'config', 'write', 'workflow'].includes(entry.path[0])
  && !(entry.path[0] === 'run' && entry.path[1] !== 'list')).map(entry => ({ command: entry.path.join(' '), effect: 'read',
    flags: Object.fromEntries(Object.entries(entry.flags).filter(([name, flag]) => !unsafeOverrides.includes(name) && !flag.gap)
      .map(([name, flag]) => [name, flag.type === 'boolean' ? 'boolean' : 'value'])),
    shortFlags: Object.fromEntries(Object.entries(entry.flags).filter(([name, flag]) => flag.short && !unsafeOverrides.includes(name) && !flag.gap)
      .map(([name, flag]) => [flag.short!, name])) }))
const sources = ['package.json', 'axi-credential.schema.json', 'README.md', 'generated/SKILL.md', 'generated/host-inventory.json',
  'generated/routes.json', 'generated/capabilities.json', 'schemas/vendor.json', 'schemas/responses.json', 'schemas/catalogue.json',
  ...readdirSync(new URL('node_modules/@knowttl/gitea-axi/dist/', root)).filter(path => path.endsWith('.js')).map(path => `dist/${path}`)]
const data = { generatedBy: 'scripts/gitea-inventory.ts', tool: 'gitea-axi', package: pkg.name, ...pins[pkg.name],
  sources: sources.map(path => ({ path, sha256: createHash('sha256').update(read(path)).digest('hex') })),
  credentialSchema: JSON.parse(read('axi-credential.schema.json')) as Record<string, unknown>,
  apiRoutes: (JSON.parse(read('generated/routes.json')) as Route[]).map(({ path, method, operation, effect }) => ({ path, method, operation, effect })),
  adapterBoundary: { unsafeOverrides, nativeWrites: 'not admitted', blockedCommands: ['auth', 'profile', 'config', 'write', 'setup', 'update'] },
  commands: [{ command: '', effect: 'read', flags: { help: 'boolean', repo: 'value' }, shortFlags: { R: 'repo' } }, ...commands],
  discovery: { commands: commands.map(entry => entry.command), example: ['repo', 'view', '--repo', '<owner/name>'],
    help: 'Gitea managed reads. Repository reads require --repo OWNER/NAME.\nRaw api accepts GET and classified metadata paths only.\nWrites, local workflows, configuration overrides and attachment transfers are unavailable.\n' } }
const output = JSON.stringify(data, null, 2) + '\n'
const target = new URL('inventories/gitea-axi.json', root)
if (process.argv.includes('--write')) writeFileSync(target, output)
else if (readFileSync(target, 'utf8') !== output) throw new Error('Gitea inventory is stale')
