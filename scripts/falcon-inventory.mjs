import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pin = JSON.parse(readFileSync(new URL('../tools/falcon-source.json', import.meta.url), 'utf8'))
const source = process.argv[2]
if (!source) throw new Error('Supply a checkout of the pinned Falcon source')
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin.commit) {
  throw new Error('Falcon source does not match the pin')
}
const parser = join(source, 'falcon_axi/cli.py')
const data = JSON.parse(execFileSync('python3', ['-c', `
import json
from falcon_axi.cli import GLOBAL_FLAGS, GLOBAL_VALUE_FLAGS
from falcon_axi.commands import COMMAND_SPECS
print(json.dumps({ 'globalFlags': GLOBAL_FLAGS, 'commands': {
    name: { 'flags': spec.flags, 'valueFlags': [*GLOBAL_VALUE_FLAGS, *spec.value_flags] }
    for name, spec in COMMAND_SPECS.items()
} }))
`], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: source } }))
const help = execFileSync('python3', ['-c', 'from falcon_axi.cli import help_text; print(help_text("detection list"), end="")'],
  { encoding: 'utf8', env: { ...process.env, PYTHONPATH: source } })
const serverOwned = ['region', 'member-cid']
const blocked = ['allow-unknown-origin', 'no-member-cid', 'config', 'profile']
const blockedCommands = ['setup', 'config', 'profile', 'credentials', 'credential', 'export', 'auth login', 'auth logout']
const inventory = {
  generatedBy: 'scripts/falcon-inventory.mjs', tool: 'falcon-axi', ...pin,
  parser: { path: 'falcon_axi/cli.py', sha256: createHash('sha256').update(readFileSync(parser)).digest('hex'),
    aliases: {}, shortFlags: {}, repeats: 'last value wins', equals: true,
    doubleDash: 'invalid empty flag; not a positional delimiter' },
  flags: data.globalFlags.map(name => ({ name, disposition: serverOwned.includes(name) ? 'server-owned'
    : blocked.includes(name) ? 'blocked' : 'passthrough' })),
  unsafeOverrides: [...serverOwned, ...blocked],
  blockedCommands,
  commands: Object.entries(data.commands).map(([command, spec]) => ({ command,
    flags: Object.fromEntries([...data.globalFlags, ...spec.flags].map(name => [name, spec.valueFlags.includes(name) ? 'value' : 'boolean'])),
    input: 'No file or raw URL input; cursors and queries remain native values' })),
  environment: ['FALCON_AXI_CLIENT_ID', 'FALCON_AXI_CLIENT_SECRET', 'FALCON_AXI_READ_ONLY', 'FALCON_AXI_WRITE_LOG'].map(name => ({ name, disposition: 'injected' }))
    .concat(['FALCON_AXI_MEMBER_CID', 'FALCON_AXI_REGION', 'FALCON_AXI_PROXY_URL', 'FALCON_AXI_CONFIG', 'FALCON_AXI_PROFILE']
      .map(name => ({ name, disposition: 'never injected' }))),
  requirements: { runtime: 'python', timeoutMs: 65_000, temporaryFiles: ['falcon-axi/config.json'],
    nativeWrites: 'RTR read-only command execution requires host permission, profile opt-in and exact confirmation' },
  healthRead: ['auth', 'status'], suggestionFields: ['help'],
  discovery: { commands: [...new Set(Object.keys(data.commands)
    .filter(command => !blockedCommands.includes(command) && !blockedCommands.includes(command.split(' ')[0]))
    .map(command => command.split(' ')[0]))],
    example: ['detection', 'list'], help },
  acceptance: 'Local fake-only evidence; live region, read and search timing remain unverified',
}
const destination = new URL('../tools/inventories/falcon-axi.json', import.meta.url)
const contents = JSON.stringify(inventory, null, 2) + '\n'
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Falcon inventory is out of date')
console.log(`inventory: falcon-axi ${pin.version}, ${inventory.commands.length} commands`)
