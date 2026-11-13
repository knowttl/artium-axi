import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const { DOMAINS } = await import(new URL('../tools/node_modules/@knowttl/awx-axi/dist/cli.js', import.meta.url).href)
const parity = JSON.parse(readFileSync(new URL('../tools/inventories/awx-axi-parity.json', import.meta.url), 'utf8'))
const noWrites = `data:text/javascript,${encodeURIComponent(`import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.writeFileSync = () => {};
fs.mkdirSync = () => {};
syncBuiltinESMExports();`)}`

test.each([
  { kind: 'command', mutation: 'domain.subcommands.push({ ...route, name: "synthetic-parity-command" })', name: 'job synthetic-parity-command' },
  { kind: 'flag', mutation: 'route.flags.push({ name: "synthetic-parity-flag", takesValue: false, description: "Synthetic flag" })', name: 'job list --synthetic-parity-flag' },
  { kind: 'existing flag on a new command', mutation: 'route.flags.push({ name: "confirm", takesValue: false, description: "Synthetic flag" })', name: 'job list --confirm' },
])('the offline local freshness gate rejects an unreviewed upstream $kind', ({ mutation, name }) => {
  const registry = new URL('../tools/node_modules/@knowttl/awx-axi/dist/cli.js', import.meta.url).href
  const preload = `import { DOMAINS } from ${JSON.stringify(registry)};
const domain = DOMAINS.find(item => item.name === 'job');
const route = domain.subcommands.find(item => item.name === 'list');
${mutation};`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/upstream-inventory.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(name)
  expect(result.stderr).toContain('support decision')
  expect(result.stderr).toContain('tools/inventories/awx-axi-parity.json')
})

test('inventory regeneration checks decisions before writing AWX artifacts', () => {
  const registry = new URL('../tools/node_modules/@knowttl/awx-axi/dist/cli.js', import.meta.url).href
  const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DOMAINS } from ${JSON.stringify(registry)};
DOMAINS.find(item => item.name === 'job').subcommands.find(item => item.name === 'list').flags.push({ name: 'synthetic-parity-flag', takesValue: false, description: 'Synthetic' });
const write = fs.writeFileSync;
fs.writeFileSync = function(path, ...args) {
  if (/\\/(inventories\\/awx-axi\\.json|skills\\/awx-axi\\/SKILL\\.md)$/.test(String(path))) throw new Error('AWX artifact written before decision');
  return write.call(this, path, ...args);
};
syncBuiltinESMExports();`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/upstream-inventory.mjs', import.meta.url)), '--write'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('job list --synthetic-parity-flag')
  expect(result.stderr).toContain('support decision')
})

test('inventory regeneration checks the reviewed surface before writing AWX artifacts', () => {
  const registry = new URL('../tools/node_modules/@knowttl/awx-axi/dist/cli.js', import.meta.url).href
  const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DOMAINS } from ${JSON.stringify(registry)};
DOMAINS.find(item => item.name === 'job').subcommands.find(item => item.name === 'list').flags.push({ name: 'confirm', takesValue: false, description: 'Synthetic' });
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const contents = read.call(this, path, ...args);
  if (!String(path).endsWith('/tools/inventories/awx-axi-parity.json')) return contents;
  const data = JSON.parse(contents);
  data.commands.find(item => item.command === 'job list').flags.push(data.commands.find(item => item.command === 'job cancel').flags.find(flag => flag.name === 'confirm'));
  return JSON.stringify(data);
};
const write = fs.writeFileSync;
fs.writeFileSync = function(path, ...args) {
  if (/\\/(inventories\\/awx-axi(?:-parity)?\\.json|skills\\/awx-axi\\/SKILL\\.md|docs\\/awx-parity-matrix\\.md)$/.test(String(path))) throw new Error('AWX artifact written before parity check');
  return write.call(this, path, ...args);
};
syncBuiltinESMExports();`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/upstream-inventory.mjs', import.meta.url)), '--write'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Unreviewed AWX surface change')
})

test.each([{ args: [] }, { args: ['--write'] }])('parity requires review when executable bytes change in mode $args', ({ args }) => {
  const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const contents = read.call(this, path, ...args);
  if (String(path).endsWith('/dist/commands/auth.js')) return Buffer.concat([contents, Buffer.from('\\n')]);
  return contents;
};
syncBuiltinESMExports();`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url)), ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('upstream executable surface changed; re-review support decisions')
})

test.each([
  { kind: 'top-level command', file: '/dist/cli.js', from: 'auth, profile list, config path, doctor, setup', to: 'auth, profile list, config path, doctor, setup, synthetic-parity-command', name: 'synthetic-parity-command', args: [] },
  { kind: 'auth flag', file: '/dist/commands/auth.js', from: '--allow-http opts this profile', to: '--synthetic-parity-flag and --allow-http opts this profile', name: 'auth login --synthetic-parity-flag', args: [] },
  { kind: 'auth flag during regeneration', file: '/dist/commands/auth.js', from: '--allow-http opts this profile', to: '--synthetic-parity-flag and --allow-http opts this profile', name: 'auth login --synthetic-parity-flag', args: ['--write'] },
  { kind: 'setup subcommand', file: '/dist/commands/setup.js', from: 'usage: awx-axi setup hooks', to: 'usage: awx-axi setup hooks|synthetic', name: 'setup synthetic', args: [] },
  { kind: 'global flag with a digit', file: '/dist/cli.js', from: 'globals: "--config <path>', to: 'globals: "--config2 <path>, --config <path>', name: 'global --config2', args: [] },
  { kind: 'auth subcommand with digits and hyphens', file: '/dist/commands/auth.js', from: 'auth login|status|logout', to: 'auth login|status|logout|login-2', name: 'auth login-2', args: [] },
])('parity rejects an unreviewed upstream $kind', ({ file, from, to, name, args }) => {
  const preload = `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith(${JSON.stringify(file)})) result.source = result.source.toString().replace(${JSON.stringify(from)}, ${JSON.stringify(to)});
  return result;
} });`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url)), ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(name)
  expect(result.stderr).toContain('support decision')
})

test('auth examples do not assign flags to logout', () => {
  const preload = `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith('/dist/commands/auth.js')) {
    const source = result.source.toString();
    const example = 'awx-axi auth login --profile production';
    if (!source.includes(example)) throw new Error('Auth example fixture not found');
    result.source = source.replace(example, 'awx-axi auth login --example-only');
    process.stderr.write('Auth example fixture applied\\n');
  }
  return result;
} });`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(0)
  expect(result.stderr).toContain('Auth example fixture applied')
})

test.each([
  { kind: 'auth', file: '/dist/commands/auth.js', from: '--allow-http opts this profile', to: '--synthetic-flag and --synthetic-flag, --allow-http opts this profile', name: 'auth login --synthetic-flag' },
  { kind: 'setup', file: '/dist/commands/setup.js', from: 'hooks    install session-start hooks', to: 'hooks    install --synthetic-flag and --synthetic-flag session-start hooks', name: 'setup hooks --synthetic-flag' },
])('repeated $kind flag mentions request one decision', ({ file, from, to, name }) => {
  const preload = `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith(${JSON.stringify(file)})) result.source = result.source.toString().replace(${JSON.stringify(from)}, ${JSON.stringify(to)});
  return result;
} });`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr.split(name)).toHaveLength(2)
  expect(result.stderr).toContain('support decision')
})

test('repeated global flag mentions generate one row', () => {
  const preload = `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith('/node_modules/@knowttl/awx-axi/dist/cli.js')) {
    const source = result.source.toString();
    if (!source.includes('globals: "--config <path>')) throw new Error('Global help fixture not found');
    result.source = source.replace('globals: "--config <path>', 'globals: "--config <path>, --config <path>');
  }
  return result;
} });`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('4 selection globals')
})

test('setup flags belong only to their documented subcommand', () => {
  const preload = `import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const contents = read.call(this, path, ...args);
  if (!String(path).endsWith('/tools/inventories/awx-axi-parity.json')) return contents;
  const data = JSON.parse(contents);
  data.commands.push({ ...data.commands.find(item => item.command === 'setup hooks'), command: 'setup synthetic' });
  return JSON.stringify(data);
};
syncBuiltinESMExports();
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith('/dist/commands/setup.js')) result.source = result.source.toString()
    .replace('usage: awx-axi setup hooks', 'usage: awx-axi setup hooks|synthetic')
    .replace('const SUBCOMMANDS = ["hooks"]', 'const SUBCOMMANDS = ["hooks", "synthetic"]')
    .replace('hooks    install session-start hooks for Claude Code, Codex, and OpenCode', 'hooks    install --hooks-only\\n  synthetic    another command');
  return result;
} });`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('setup hooks --hooks-only')
  expect(result.stderr).not.toContain('setup synthetic --hooks-only')
})

test.each([
  { kind: 'domain flag', mutation: "data.commands.find(item => item.command === 'job list').flags.find(flag => flag.name === 'limit').status = ''", name: 'job list --limit' },
  { kind: 'local flag', mutation: "data.commands.find(item => item.command === 'auth login').flags = [{ name: 'allow-http' }]", name: 'auth login --allow-http' },
  { kind: 'global flag', mutation: "data.globals = data.globals.map(flag => flag.name === 'config' ? { name: flag.name } : flag)", name: 'global --config' },
  { kind: 'domain flag without explanation', mutation: "const flag = data.commands.find(item => item.command === 'job list').flags.find(item => item.name === 'limit'); delete flag.reason; delete flag.requiredAdminControl", name: 'job list --limit' },
  { kind: 'local flag without explanation', mutation: "const flag = data.commands.find(item => item.command === 'auth login').flags.find(item => item.name === 'allow-http'); delete flag.reason; delete flag.requiredAdminControl", name: 'auth login --allow-http' },
  { kind: 'global flag without explanation', mutation: "const flag = data.globals.find(item => item.name === 'config'); delete flag.reason; delete flag.requiredAdminControl", name: 'global --config' },
  ...['effect', 'targetSlice', 'authorization', 'takesValue'].map(field => ({ kind: `local flag without ${field}`, mutation: `delete data.commands.find(item => item.command === 'auth login').flags.find(flag => flag.name === 'allow-http').${field}`, name: 'auth login --allow-http' })),
  ...['effect', 'targetSlice', 'authorization'].map(field => ({ kind: `global flag without ${field}`, mutation: `delete data.globals.find(flag => flag.name === 'config').${field}`, name: 'global --config' })),
].flatMap(item => [[], ['--write']].map(args => ({ ...item, args }))))('parity rejects an incomplete $kind decision', ({ mutation, name, args }) => {
  const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const contents = read.call(this, path, ...args);
  if (!String(path).endsWith('/tools/inventories/awx-axi-parity.json')) return contents;
  const data = JSON.parse(contents);
  ${mutation};
  return JSON.stringify(data);
};
syncBuiltinESMExports();`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url)), ...args], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('support decision')
  expect(result.stderr).toContain(name)
})

test.each([
  { kind: 'command', mutation: "data.commands.find(item => item.command === 'job list').status = 'blocked'", name: 'job list' },
  { kind: 'command flag', mutation: "data.commands.find(item => item.command === 'job list').flags.find(flag => flag.name === 'limit').status = 'blocked'", name: 'job list --limit' },
  { kind: 'global flag', mutation: "data.globals.find(flag => flag.name === 'config').status = 'blocked'", name: 'config' },
])('regeneration rejects a conflicting recorded $kind decision', ({ mutation, name }) => {
  const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const contents = read.call(this, path, ...args);
  if (!String(path).endsWith('/tools/inventories/awx-axi-parity.json')) return contents;
  const data = JSON.parse(contents);
  ${mutation};
  return JSON.stringify(data);
};
syncBuiltinESMExports();`
  const result = spawnSync(process.execPath, ['--import', noWrites, '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    fileURLToPath(new URL('../scripts/awx-parity.mjs', import.meta.url)), '--write'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('support decisions differ')
  expect(result.stderr).toContain(name)
})

type Flag = { name: string; takesValue: boolean; description: string }
type Command = { command: string; flags: Flag[]; positionals: { names: string[]; required: number } }
type Domain = { name: string; subcommands: (Omit<Command, 'command'> & { name: string })[] }

test('AWX parity public artifact covers every pinned domain command, flag and positional contract', () => {
  const expected = (DOMAINS as Domain[]).flatMap(domain => domain.subcommands.map(route => ({
    command: `${domain.name} ${route.name}`,
    flags: [{ name: 'help', takesValue: false, description: 'Command help' }, ...route.flags],
    positionals: route.positionals,
  })))
  const domains = new Set((DOMAINS as Domain[]).map(domain => domain.name))
  const actual = (parity.commands as Command[]).filter(route => domains.has(route.command.split(' ')[0]))
    .map(route => ({ command: route.command,
      flags: route.flags.map(({ name, takesValue, description }) => ({ name, takesValue, description })),
      positionals: route.positionals }))
  expect(actual).toEqual(expected)
})

type Decision = { command: string; status: string; effect: string; authorization: string; canonicalCommand?: string; flags: (Flag & { status: string })[] }
const inventory = JSON.parse(readFileSync(new URL('../tools/inventories/awx-axi.json', import.meta.url), 'utf8')) as
  { commands: { command: string; effect: string; flags: Record<string, string> }[] }
const decisions = parity.commands as Decision[]
const aliases = parity.aliases as Decision[]

test('every pinned command has one reviewed decision and every alias maps to a canonical equivalent', () => {
  expect(decisions).toHaveLength(220)
  expect(new Set(decisions.map(decision => decision.command)).size).toBe(220)
  expect(aliases).toHaveLength(27)
  for (const alias of aliases) {
    const canonical = decisions.find(decision => decision.command === alias.canonicalCommand)
    expect(canonical, alias.command).toBeDefined()
    expect(alias).toMatchObject({ status: 'managed equivalent', effect: canonical!.effect, authorization: canonical!.authorization })
    expect(alias.flags.map(flag => flag.name)).toEqual(canonical!.flags.map(flag => flag.name))
  }
})

test('the pinned inventory router resolves every reviewed alias spelling', async () => {
  const inventoryDomain = (DOMAINS as { name: string; run: (args: string[], context: unknown) => Promise<unknown> }[]).find(domain => domain.name === 'inventory')!
  const context = { createTransport: () => { throw new Error('REACHED_TRANSPORT') }, env: {}, selection: {} }
  for (const alias of aliases) {
    const failure = await inventoryDomain.run(alias.command.split(' ').slice(1), context).then(() => '', (error: Error) => error.message)
    expect(failure, alias.command).not.toMatch(/unknown subcommand/i)
  }
})

const associations = [
  { domain: 'organization', resource: 'organizations', kind: 'user', flag: 'user', route: 'users' },
  { domain: 'organization', resource: 'organizations', kind: 'admin', flag: 'user', route: 'admins' },
  { domain: 'organization', resource: 'organizations', kind: 'team', flag: 'team', route: 'teams' },
  { domain: 'organization', resource: 'organizations', kind: 'galaxy-credential', flag: 'credential', route: 'galaxy_credentials' },
  { domain: 'organization', resource: 'organizations', kind: 'instance-group', flag: 'instance-group', route: 'instance_groups' },
  { domain: 'organization', resource: 'organizations', kind: 'execution-environment', flag: 'execution-environment', route: 'execution_environments' },
  { domain: 'organization', resource: 'organizations', kind: 'notification-template', flag: 'notification-template', route: 'notification_templates' },
  { domain: 'team', resource: 'teams', kind: 'user', flag: 'user', route: 'users' },
  { domain: 'inventory', resource: 'inventory_sources', kind: 'source-credential', flag: 'credential', route: 'credentials' },
  { domain: 'template', resource: 'job_templates', kind: 'credential', flag: 'credential', route: 'credentials' },
  { domain: 'template', resource: 'job_templates', kind: 'label', flag: 'label', route: 'labels' },
  { domain: 'template', resource: 'job_templates', kind: 'instance-group', flag: 'instance-group', route: 'instance_groups' },
  { domain: 'workflow', resource: 'workflow_job_templates', kind: 'label', flag: 'label', route: 'labels' },
  { domain: 'workflow', resource: 'workflow_job_template_nodes', kind: 'node-credential', flag: 'credential', route: 'credentials' },
  { domain: 'workflow', resource: 'workflow_job_template_nodes', kind: 'node-label', flag: 'label', route: 'labels' },
  { domain: 'workflow', resource: 'workflow_job_template_nodes', kind: 'node-instance-group', flag: 'instance-group', route: 'instance_groups' },
  { domain: 'schedule', resource: 'schedules', kind: 'credential', flag: 'credential', route: 'credentials' },
  { domain: 'schedule', resource: 'schedules', kind: 'label', flag: 'label', route: 'labels' },
  { domain: 'schedule', resource: 'schedules', kind: 'instance-group', flag: 'instance-group', route: 'instance_groups' },
]

const requestCases = [
  ...associations.flatMap(({ domain, resource, kind, flag, route }) => ['add', 'remove'].map(operation => ({
    domain, args: [`${kind}-${operation}`, '42', `--${flag}`, '7'], method: 'POST', path: `${resource}/42/${route}/`,
    body: operation === 'remove' ? { id: 7, disassociate: true } : { id: 7 },
  }))),
  ...['host', 'child'].flatMap(kind => ['add', 'remove'].map(operation => ({
    domain: 'inventory', args: [`group-${operation}-${kind}`, '42', `--${kind}`, '7'], method: 'POST',
    path: `groups/42/${kind === 'host' ? 'hosts' : 'children'}/`,
    body: operation === 'remove' ? { id: 7, disassociate: true } : { id: 7 },
  }))),
  ...['user', 'team'].flatMap(subject => ['grant', 'revoke'].map(operation => ({
    domain: 'role', args: [operation, '42', `--${subject}`, '7'], method: 'POST', path: `roles/42/${subject}s/`,
    body: operation === 'revoke' ? { id: 7, disassociate: true } : { id: 7 },
  }))),
  ...['success', 'failure', 'always'].flatMap(edge => ['link', 'unlink'].map(operation => ({
    domain: 'workflow', args: [`node-${operation}`, '42', '--to', '43', '--on', edge], method: 'POST',
    path: `workflow_job_template_nodes/42/${edge}_nodes/`,
    body: operation === 'unlink' ? { id: 43, disassociate: true } : { id: 43 },
  }))),
  ...[
    { domain: 'organization', resource: 'organizations', events: [['started', 'started'], ['success', 'success'], ['error', 'error'], ['approval', 'approvals']] },
    { domain: 'template', resource: 'job_templates', events: [['started', 'started'], ['success', 'success'], ['error', 'error']] },
    { domain: 'workflow', resource: 'workflow_job_templates', events: [['started', 'started'], ['success', 'success'], ['error', 'error'], ['approval', 'approvals']] },
    { domain: 'project', resource: 'projects', events: [['started', 'started'], ['success', 'success'], ['error', 'error']] },
  ].flatMap(({ domain, resource, events }) => events.flatMap(([event, route]) => ['add', 'remove'].map(operation => ({
    domain, args: [`notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
    method: 'POST', path: `${resource}/42/notification_templates_${route}/`,
    body: operation === 'remove' ? { id: 7, disassociate: true } : { id: 7 },
  })))),
  ...['started', 'success', 'error'].flatMap(event => ['add', 'remove'].map(operation => ({
    domain: 'inventory', args: [`source-notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
    method: 'POST', path: `inventory_sources/42/notification_templates_${event}/`,
    body: operation === 'remove' ? { id: 7, disassociate: true } : { id: 7 },
  }))),
  { domain: 'organization', args: ['create', 'Synthetic organization', '--description', 'Synthetic'], method: 'POST', path: 'organizations/',
    body: { name: 'Synthetic organization', description: 'Synthetic' } },
  { domain: 'organization', args: ['edit', '42', '--name', 'Synthetic organization'], method: 'PATCH', path: 'organizations/42/',
    body: { name: 'Synthetic organization' } },
  { domain: 'template', args: ['create', 'Synthetic template', '--inventory', '7', '--project', '8', '--playbook', 'synthetic.yml'],
    method: 'POST', path: 'job_templates/', body: { name: 'Synthetic template', inventory: 7, project: 8, playbook: 'synthetic.yml' } },
  { domain: 'template', args: ['edit', '42', '--name', 'Synthetic template'], method: 'PATCH', path: 'job_templates/42/',
    body: { name: 'Synthetic template' } },
  { domain: 'workflow', args: ['create', 'Synthetic workflow', '--organization', '7', '--extra-vars', '{"mode":"synthetic","count":2}'],
    method: 'POST', path: 'workflow_job_templates/', body: { name: 'Synthetic workflow', organization: 7, extra_vars: '{"mode":"synthetic","count":2}' } },
  { domain: 'workflow', args: ['edit', '42', '--extra-vars', '{"mode":"synthetic","count":2}'],
    method: 'PATCH', path: 'workflow_job_templates/42/', body: { extra_vars: '{"mode":"synthetic","count":2}' } },
  { domain: 'workflow', args: ['node-create', '42', '--template', '8', '--inventory', '7', '--extra-vars', '{"mode":"synthetic"}', '--scm-branch', 'synthetic', '--job-type', 'check', '--job-tags', 'connectivity', '--skip-tags', 'updates', '--verbosity', '2'],
    method: 'POST', path: 'workflow_job_templates/42/workflow_nodes/', body: { unified_job_template: 8, inventory: 7, extra_data: { mode: 'synthetic' }, scm_branch: 'synthetic', job_type: 'check', job_tags: 'connectivity', skip_tags: 'updates', verbosity: 2 } },
  { domain: 'workflow', args: ['node-edit', '42', '--template', '8', '--inventory', '7', '--extra-vars', '{"mode":"synthetic"}', '--scm-branch', 'synthetic', '--job-type', 'check', '--job-tags', 'connectivity', '--skip-tags', 'updates', '--verbosity', '2'],
    method: 'PATCH', path: 'workflow_job_template_nodes/42/', body: { unified_job_template: 8, inventory: 7, extra_data: { mode: 'synthetic' }, scm_branch: 'synthetic', job_type: 'check', job_tags: 'connectivity', skip_tags: 'updates', verbosity: 2 } },
  { domain: 'credential', args: ['create', 'Synthetic credential', '--credential-type', '7', '--organization', '8'],
    method: 'POST', path: 'credentials/', body: { name: 'Synthetic credential', credential_type: 7, inputs: {}, organization: 8 } },
  { domain: 'credential', args: ['edit', '42', '--name', 'Updated credential', '--credential-type', '7'],
    method: 'PATCH', path: 'credentials/42/', body: { name: 'Updated credential', credential_type: 7 } },
  { domain: 'team', args: ['credential-create', '42', '--name', 'Synthetic credential', '--credential-type', '7'],
    method: 'POST', path: 'teams/42/credentials/', body: { name: 'Synthetic credential', credential_type: 7, inputs: {} } },
  { domain: 'notification-template', args: ['create', 'Synthetic notification', '--organization', '7', '--notification-type', 'webhook'],
    method: 'POST', path: 'notification_templates/', body: { name: 'Synthetic notification', organization: 7, notification_type: 'webhook', notification_configuration: {} } },
  { domain: 'notification-template', args: ['edit', '42', '--name', 'Updated notification', '--notification-type', 'webhook'],
    method: 'PATCH', path: 'notification_templates/42/', body: { name: 'Updated notification', notification_type: 'webhook' } },
  { domain: 'schedule', args: ['create', 'Synthetic schedule', '--template', '7', '--rrule', 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY', '--inventory', '8', '--limit', 'synthetic-host', '--job-tags', 'configure,verify', '--skip-tags', 'restart'],
    method: 'POST', path: 'schedules/', body: { name: 'Synthetic schedule', unified_job_template: 7, rrule: 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY', inventory: 8, limit: 'synthetic-host', job_tags: 'configure,verify', skip_tags: 'restart' } },
  { domain: 'schedule', args: ['edit', '42', '--name', 'Synthetic schedule', '--template', '7', '--inventory', '8', '--limit', 'synthetic-host', '--job-tags', 'configure,verify', '--skip-tags', 'restart'], method: 'PATCH', path: 'schedules/42/',
    body: { name: 'Synthetic schedule', unified_job_template: 7, inventory: 8, limit: 'synthetic-host', job_tags: 'configure,verify', skip_tags: 'restart' } },
  { domain: 'inventory', args: ['create', 'Synthetic inventory', '--organization', '7'], method: 'POST', path: 'inventories/',
    body: { name: 'Synthetic inventory', organization: 7 } },
  { domain: 'inventory', args: ['edit', '42', '--name', 'Updated inventory'], method: 'PATCH', path: 'inventories/42/',
    body: { name: 'Updated inventory' } },
  { domain: 'inventory', args: ['host-create', 'synthetic-host', '--inventory', '7'], method: 'POST', path: 'hosts/',
    body: { name: 'synthetic-host', inventory: 7 } },
  { domain: 'inventory', args: ['host-edit', '42', '--name', 'updated-host'], method: 'PATCH', path: 'hosts/42/',
    body: { name: 'updated-host' } },
  { domain: 'inventory', args: ['group-create', 'Synthetic group', '--inventory', '7'], method: 'POST', path: 'inventories/7/groups/',
    body: { name: 'Synthetic group' } },
  { domain: 'inventory', args: ['group-edit', '42', '--name', 'Updated group'], method: 'PATCH', path: 'groups/42/',
    body: { name: 'Updated group' } },
  { domain: 'inventory', args: ['source-create', 'Synthetic source', '--inventory', '7', '--source', 'scm', '--source-project', '8', '--credential', '9', '--source-vars', '{"region":"synthetic"}', '--update-on-launch'],
    method: 'POST', path: 'inventory_sources/', body: { name: 'Synthetic source', inventory: 7, source: 'scm', source_project: 8, credential: 9, source_vars: '{"region":"synthetic"}', update_on_launch: true } },
  { domain: 'inventory', args: ['source-edit', '42', '--source', 'scm', '--source-project', '8', '--credential', '9', '--source-vars', '{"region":"synthetic"}', '--no-update-on-launch'],
    method: 'PATCH', path: 'inventory_sources/42/', body: { source: 'scm', source_project: 8, credential: 9, source_vars: '{"region":"synthetic"}', update_on_launch: false } },
  { domain: 'user', args: ['create', '--username', 'synthetic-person', '--first-name', 'Synthetic', '--last-name', 'Person', '--email', 'synthetic@example.test', '--is-superuser'], method: 'POST', path: 'users/',
    body: { username: 'synthetic-person', first_name: 'Synthetic', last_name: 'Person', email: 'synthetic@example.test', is_superuser: true } },
  { domain: 'user', args: ['edit', '42', '--username', 'synthetic-person', '--first-name', 'Synthetic', '--last-name', 'Person', '--email', 'synthetic@example.test', '--no-superuser'], method: 'PATCH', path: 'users/42/',
    body: { username: 'synthetic-person', first_name: 'Synthetic', last_name: 'Person', email: 'synthetic@example.test', is_superuser: false } },
  { domain: 'team', args: ['create', '--name', 'Synthetic team', '--organization', '7', '--description', 'Synthetic operators'],
    method: 'POST', path: 'teams/', body: { name: 'Synthetic team', organization: 7, description: 'Synthetic operators' } },
  { domain: 'team', args: ['edit', '42', '--name', 'Synthetic team', '--organization', '7', '--description', 'Synthetic operators'],
    method: 'PATCH', path: 'teams/42/', body: { name: 'Synthetic team', organization: 7, description: 'Synthetic operators' } },
  { domain: 'project', args: ['create', 'Synthetic project', '--organization', '7', '--scm-type', 'git', '--scm-url', 'https://scm.example/repo', '--credential', '9'],
    method: 'POST', path: 'projects/', body: { name: 'Synthetic project', organization: 7, scm_type: 'git', scm_url: 'https://scm.example/repo', credential: 9 } },
  { domain: 'project', args: ['edit', '42', '--name', 'Updated project', '--organization', '7', '--scm-type', 'git', '--scm-url', 'https://scm.example/repo', '--credential', '9'],
    method: 'PATCH', path: 'projects/42/', body: { name: 'Updated project', organization: 7, scm_type: 'git', scm_url: 'https://scm.example/repo', credential: 9 } },
  { domain: 'execution-environment', args: ['create', 'Synthetic environment', '--image', 'registry.example/runner:stable', '--organization', '7', '--credential', '9', '--pull', 'always'],
    method: 'POST', path: 'execution_environments/', body: { name: 'Synthetic environment', image: 'registry.example/runner:stable', organization: 7, credential: 9, pull: 'always' } },
  { domain: 'execution-environment', args: ['edit', '42', '--image', 'registry.example/runner:stable', '--organization', '7', '--credential', '9', '--pull', 'always'],
    method: 'PATCH', path: 'execution_environments/42/', body: { image: 'registry.example/runner:stable', organization: 7, credential: 9, pull: 'always' } },
]

test.each(requestCases)('AWX $domain $args builds the controller request', async ({ domain, args, method, path, body }) => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const transport = {
    get: async (path: string) => {
      expect(path).toBe('job_templates/7/')
      return { status: 200, body: { ask_inventory_on_launch: true, ask_limit_on_launch: true, ask_tags_on_launch: true, ask_skip_tags_on_launch: true } }
    },
    post: async (path: string, body: unknown) => { calls.push({ method: 'POST', path, body }); return { status: 200, body: { id: 42 } } },
    patch: async (path: string, body: unknown) => { calls.push({ method: 'PATCH', path, body }); return { status: 200, body: { id: 42 } } },
  }
  const selected = (DOMAINS as { name: string; run: (args: string[], context: unknown) => Promise<unknown> }[]).find(item => item.name === domain)!
  await selected.run([...args, '--confirm'], { createTransport: () => transport, env: {}, selection: {} })
  expect(calls).toEqual([{ method, path, body }])
})

test('every flag decision matches the Artium route schema', () => {
  const routes = new Map(inventory.commands.map(route => [route.command, route]))
  const domains = new Set((DOMAINS as Domain[]).map(domain => domain.name))
  for (const decision of decisions.filter(decision => domains.has(decision.command.split(' ')[0]))) {
    const route = routes.get(decision.command)
    expect(route, decision.command).toBeDefined()
    for (const flag of decision.flags) {
      const accepted = Object.hasOwn(route!.flags, flag.name)
      if (flag.status === 'supported') expect(accepted, `${decision.command} --${flag.name}`).toBe(true)
      else expect(['managed equivalent', 'not applicable', 'blocked'], `${decision.command} --${flag.name}`).toContain(flag.status)
    }
    for (const name of Object.keys(route!.flags)) expect(decision.flags.map(flag => flag.name), decision.command).toContain(name)
  }
})
