import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DOMAINS } from '../tools/node_modules/awx-axi/dist/cli.js'
import { createSkillMarkdown } from '../tools/node_modules/awx-axi/dist/skill.js'

const root = new URL('../tools/', import.meta.url)
const packageRoot = new URL('node_modules/awx-axi/', root)
const pkg = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
const pin = JSON.parse(readFileSync(new URL('integrity.json', root), 'utf8'))[pkg.name]
if (pkg.version !== pin.version) throw new Error('Pin mismatch for awx-axi')
// Reviewed against the 0.1.8 domain plans and transport gates. Survey is a GET;
// notification-template test sends a notification and is a write.
const reads = {
  job: 'list show stdout events hosts watch', template: 'list show object-roles survey',
  workflow: 'list show object-roles survey nodes template-nodes template-node', organization: 'list show',
  'system-job-template': 'list show', 'system-job': 'list show events notifications',
  credential: 'list show object-roles', approval: 'list show', 'ad-hoc': 'list show events stdout',
  project: 'list show playbooks updates roles', inventory: 'list show groups hosts sources updates constructed-list constructed-show',
  host: 'list show', group: 'list show', 'inventory-source': 'list show', schedule: 'list show',
  'execution-environment': 'list show', user: 'list show', notification: 'list show',
  'notification-template': 'list show', 'activity-stream': 'list show',
  team: 'list show users projects credentials roles object-roles access-list', role: 'list show parents children users teams',
}
const writeVerbs = /^(?:(?:host-bulk|host|group|source|node|token|credential)-)?(?:create|edit|delete|copy|launch|cancel|relaunch|approve|deny|sync|test|grant|revoke)$|-(?:add|remove|link|unlink|add-approval)$|^group-(?:add|remove)-(?:host|child)$/
const operationalWrites = ['job launch', 'job cancel', 'job relaunch', 'template launch', 'workflow launch',
  'approval approve', 'approval deny', 'project sync', 'inventory sync', 'ad-hoc launch',
  'system-job-template launch', 'system-job cancel', 'notification-template test']
const commands = DOMAINS.flatMap(domain => domain.subcommands.map(route => {
  const read = reads[domain.name]?.split(' ').includes(route.name)
  if (!read && !writeVerbs.test(route.name)) throw new Error(`Unclassified command: ${domain.name} ${route.name}`)
  const command = `${domain.name} ${route.name}`
  return { command, effect: read ? 'read' : operationalWrites.includes(command) ? 'write' : 'blocked',
    flags: { help: 'boolean', ...Object.fromEntries(route.flags
      .filter(flag => flag.name !== 'fields'
        && (command !== 'job stdout' || !['download', 'full', 'ansi'].includes(flag.name))
        && (command !== 'job events' || flag.name !== 'type'))
      .map(flag => [flag.name, flag.takesValue ? 'value' : 'boolean'])) },
    positionals: route.positionals }
}))
for (const command of ['home', 'doctor', 'auth status']) commands.push({ command, effect: 'read', flags: { help: 'boolean' }, positionals: { names: [], required: 0 } })
for (const command of ['auth login', 'auth logout', 'setup', 'config path', 'profile list', 'update']) {
  commands.push({ command, effect: 'blocked', flags: { help: 'boolean' }, positionals: { names: [], required: 0 } })
}
const sources = readdirSync(new URL('dist/', packageRoot), { recursive: true }).filter(path => path.endsWith('.js')).sort()
  .map(path => ({ path: `dist/${path}`, sha256: createHash('sha256').update(readFileSync(new URL(`dist/${path}`, packageRoot))).digest('hex') }))
const skill = createSkillMarkdown()
const data = { generatedBy: 'scripts/awx-inventory.mjs', tool: 'awx-axi', ...pin,
  parserEvidence: 'Published domain registry, reviewed plan effects and transport safety gates', sources,
  credentialSchema: JSON.parse(readFileSync(new URL('axi-credential.schema.json', packageRoot), 'utf8')),
  skillSha256: createHash('sha256').update(skill).digest('hex'),
  adapterBoundary: { unsafeOverrides: ['config', 'profile', 'origin', 'verify-ssl', 'allow-http'],
    blockedCommands: ['auth login', 'auth logout', 'setup', 'config', 'profile', 'update'],
    nativeWrites: 'host-classified', inputs: { stdin: 'unsupported', files: 'unsupported' } },
  discovery: { commands: [...DOMAINS.map(domain => domain.name), 'auth status', 'doctor'],
    example: ['job', 'list', '--limit', '1'],
    help: 'awx-axi job list [--status <s>] [--type <t>] [--failed] [--since <time>] [--limit <n>]\nArtium manages the HTTPS origin and token. Operational writes require administrator allowWrites and --confirm. Configuration, deletion and security writes are blocked. No stdin or files. Use job watch --timeout 50 or less.\n' },
  suggestionFields: ['help'], format: 'TOON', commands }
const outputs = [['inventories/awx-axi.json', JSON.stringify(data, null, 2) + '\n'], ['skills/awx-axi/SKILL.md', skill]]
for (const [path, contents] of outputs) {
  const destination = new URL(path, root)
  if (process.argv.includes('--write')) { mkdirSync(new URL('./', destination), { recursive: true }); writeFileSync(destination, contents) }
  else if (readFileSync(destination, 'utf8') !== contents) throw new Error('Inventory out of date: awx-axi; review pinned commands and effects')
}
console.log(`inventory: awx-axi ${pkg.version}, ${commands.length} commands`)
