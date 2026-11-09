import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const { DOMAINS } = await import(new URL('../tools/node_modules/awx-axi/dist/cli.js', import.meta.url).href)
const parity = JSON.parse(readFileSync(new URL('../tools/inventories/awx-axi-parity.json', import.meta.url), 'utf8'))

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
  expect(decisions).toHaveLength(215)
  expect(new Set(decisions.map(decision => decision.command)).size).toBe(215)
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
  ...[
    { domain: 'organization', resource: 'organizations', events: [['started', 'started'], ['success', 'success'], ['error', 'error'], ['approval', 'approvals']] },
    { domain: 'template', resource: 'job_templates', events: [['started', 'started'], ['success', 'success'], ['error', 'error']] },
    { domain: 'workflow', resource: 'workflow_job_templates', events: [['started', 'started'], ['success', 'success'], ['error', 'error'], ['approval', 'approvals']] },
  ].flatMap(({ domain, resource, events }) => events.flatMap(([event, route]) => ['add', 'remove'].map(operation => ({
    domain, args: [`notification-${operation}`, '42', '--event', event, '--notification-template', '7'],
    method: 'POST', path: `${resource}/42/notification_templates_${route}/`,
    body: operation === 'remove' ? { id: 7, disassociate: true } : { id: 7 },
  })))),
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
  { domain: 'schedule', args: ['create', 'Synthetic schedule', '--template', '7', '--rrule', 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY'],
    method: 'POST', path: 'schedules/', body: { name: 'Synthetic schedule', unified_job_template: 7, rrule: 'DTSTART:20270101T000000Z RRULE:FREQ=DAILY' } },
  { domain: 'schedule', args: ['edit', '42', '--name', 'Synthetic schedule'], method: 'PATCH', path: 'schedules/42/',
    body: { name: 'Synthetic schedule' } },
]

test.each(requestCases)('AWX $domain $args builds the controller request', async ({ domain, args, method, path, body }) => {
  const calls: { method: string; path: string; body: unknown }[] = []
  const transport = {
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
      else expect(['managed equivalent', 'not applicable'], `${decision.command} --${flag.name}`).toContain(flag.status)
    }
    for (const name of Object.keys(route!.flags)) expect(decision.flags.map(flag => flag.name), decision.command).toContain(name)
  }
})
