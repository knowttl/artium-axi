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
import ast, json, sys
tree = ast.parse(open(sys.argv[1]).read())
values = {}
for node in tree.body:
    names = [target.id for target in node.targets if isinstance(target, ast.Name)] if isinstance(node, ast.Assign) else [node.target.id] if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) else []
    for name in names:
        if name in ('GLOBAL_FLAGS', 'COMMAND_FLAGS', 'VALUE_FLAGS'):
            values[name] = ast.literal_eval(node.value.args[0] if isinstance(node.value, ast.Call) else node.value)
print(json.dumps({ 'globalFlags': values['GLOBAL_FLAGS'], 'commands': values['COMMAND_FLAGS'], 'valueFlags': sorted(values['VALUE_FLAGS']) }))
`, parser], { encoding: 'utf8' }))
const serverOwned = ['region', 'member-cid']
const blocked = ['allow-unknown-origin', 'no-member-cid', 'profile']
const inventory = {
  generatedBy: 'scripts/falcon-inventory.mjs', tool: 'falcon-axi', ...pin,
  parser: { path: 'falcon_axi/cli.py', sha256: createHash('sha256').update(readFileSync(parser)).digest('hex'),
    aliases: {}, shortFlags: {}, repeats: 'last value wins', equals: true,
    doubleDash: 'invalid empty flag; not a positional delimiter' },
  flags: data.globalFlags.map(name => ({ name, disposition: serverOwned.includes(name) ? 'server-owned'
    : blocked.includes(name) ? 'blocked' : 'passthrough' })),
  unsafeOverrides: [...serverOwned, ...blocked],
  blockedCommands: ['login', 'setup', 'config', 'profile', 'credentials', 'credential', 'export', 'auth login', 'auth logout'],
  commands: Object.entries(data.commands).map(([command, flags]) => ({ command,
    flags: Object.fromEntries([...data.globalFlags, ...flags].map(name => [name, data.valueFlags.includes(name) ? 'value' : 'boolean'])),
    input: 'No file or raw URL input; cursors and queries remain native values' })),
  environment: ['FALCON_CLIENT_ID', 'FALCON_CLIENT_SECRET'].map(name => ({ name, disposition: 'injected' }))
    .concat(['FALCON_MEMBER_CID', 'FALCON_BASE_URL', 'FALCON_PROXY_URL', 'FALCON_AXI_CREDENTIALS_FILE']
      .map(name => ({ name, disposition: 'never injected' }))),
  requirements: { runtime: 'python', timeoutMs: 60_000, temporaryFiles: [], nativeWrites: 'read-only upstream design' },
  healthRead: ['auth', 'status'], suggestionFields: ['help'],
  acceptance: 'Local fake-only evidence; live region, read and search timing remain unverified',
}
const destination = new URL('../tools/inventories/falcon-axi.json', import.meta.url)
const contents = JSON.stringify(inventory, null, 2) + '\n'
if (process.argv.includes('--write')) writeFileSync(destination, contents)
else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Falcon inventory is out of date')
console.log(`inventory: falcon-axi ${pin.version}, ${inventory.commands.length} commands`)
