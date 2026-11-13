import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { decode, encode } from '@toon-format/toon'
import { homeDiagnostic } from '../../../tools/node_modules/@knowttl/awx-axi/dist/commands/home.js'
import { rawRegion } from '../../../tools/node_modules/@knowttl/awx-axi/dist/core/output.js'
import { redactResult } from '../../../tools/node_modules/@knowttl/awx-axi/dist/core/redact.js'
import { jobDomain } from '../../../tools/node_modules/@knowttl/awx-axi/dist/domains/job/index.js'
import { main } from '../../../tools/node_modules/@knowttl/awx-axi/dist/cli.js'
import { RecordedTransport } from '../../../tools/node_modules/@knowttl/awx-axi/dist/core/transport.js'
import inventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import { toolAllowsWrites } from '../../shared/api.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { toolFailure } from '../health/diagnostic.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { createAwxAdapter, awxCredentialSchema, awxProfile } from './awx.js'

// Load the published runtime without resolving its declarations through pnpm's symlink.
const errorsModule = '../../../tools/node_modules/@knowttl/awx-axi/dist/core/errors.js'
const { AwxAxiError, formatError } = await import(errorsModule)

const credential = { origin: 'https://controller.example', token: 'CANARY-awx-token' }
const reference = { id: 'synthetic-awx', tool: 'awx-axi' as const, revision: 1 }
const adapter = (allowWrites = false, allowConfigurationWrites = false, allowDeletes = false) => createAwxAdapter({ getCredential: async () => ({ ...credential, allowWrites, allowConfigurationWrites, allowDeletes }) })
test.each(['--dry-run', '--confirm'])('raw mutation %s requires the tenant write setting', async flag => {
  await expect(adapter().prepare(['api', 'post', 'jobs/42/cancel/', flag], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  const call = await adapter(true, false, true).prepare(['api', 'post', 'jobs/42/cancel/', flag], reference)
  expect(call.environment.AWX_AXI_READ_ONLY).toBe('false')
})

test('ordinary AWX writes never receive the delete switch without the separate grant', async () => {
  const call = await adapter(true).prepare(['organization', 'create', 'Synthetic organization', '--confirm'], reference)
  expect(call.environment).toMatchObject({ AWX_AXI_READ_ONLY: 'false', AWX_AXI_ALLOW_CONFIG_WRITES: '1' })
  expect(call.environment).not.toHaveProperty('AWX_AXI_ALLOW_DELETES')
})

test.each([
  { settings: { allowWrites: true }, credential: { allowWrites: true, allowDeletes: true } },
  { settings: { allowWrites: true, allowDeletes: true }, credential: { allowWrites: true } },
])('AWX deletes require agreement between current and resolved settings: $settings', async ({ settings, credential: grants }) => {
  const managed = createAwxAdapter({ getSettings: () => settings, getCredential: async () => ({ ...credential, ...grants }) })
  await expect(managed.prepare(['organization', 'delete', '42', '--confirm'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED',
    next: expect.stringContaining('Allow destructive deletes') })
})
const fixedSchemaLists = ['job', 'template', 'workflow', 'organization', 'system-job-template', 'system-job',
  'credential', 'ad-hoc', 'project', 'schedule', 'execution-environment', 'user', 'notification',
  'notification-template', 'activity-stream', 'team', 'role']

test.each(['notification', 'notification-template'].flatMap(group => [
  { group, flags: ['--limit', '1'], ids: [41], stop: 'row-budget', truncated: true, pages: 1 },
  { group, flags: ['--all', '--max-rows', '2'], ids: [41, 42], stop: 'complete', truncated: false, pages: 2 },
]))('$group reads preserve pagination with writes disabled: $flags', async ({ group, flags, ids, stop, truncated, pages }) => {
  const call = await adapter().prepare([group, 'list', ...flags], reference)
  const route = group === 'notification' ? 'notifications/' : 'notification_templates/'
  const transport = new RecordedTransport([
    { status: 200, body: { count: 2, next: `/api/v2/${route}?page=2`, results: [{ id: 41, name: 'Synthetic first', status: 'successful' }] } },
    { status: 200, body: { count: 2, next: null, results: [{ id: 42, name: 'Synthetic second', status: 'pending' }] } },
  ], { readOnly: true })
  let stdout = ''
  await main({ argv: call.args, env: call.environment, createTransport: () => transport,
    stdout: { write: chunk => { stdout += chunk } } })
  const output = decode(stdout) as Record<string, unknown>
  const label = group === 'notification' ? 'notifications' : 'notification-templates'
  expect(output[label]).toEqual(ids.map(id => expect.objectContaining({ id })))
  expect(output).toMatchObject({ pagination: { stop, truncated, pages } })
})

test.each(['create', 'edit'].flatMap(operation => ['configuration-file', 'config-file', 'messages-file'].map(flag => ({ operation, flag }))))(
  'notification-template $operation --$flag keeps uploaded bytes out of process arguments', async ({ operation, flag }) => {
    const content = '{"token":"CANARY-notification-input"}'
    const call = await adapter(true, false, true).prepare(['notification-template', operation, '42', `--${flag}`, 'notification.json', '--confirm'], reference,
      { files: [{ name: 'notification.json', contentBase64: Buffer.from(content).toString('base64') }] })
    expect(call.args.join(' ')).not.toContain('CANARY-')
    expect(call.fileArguments?.map(index => call.args[index])).toEqual(['notification.json'])
    expect(call.limits?.privateOutput?.fields).toMatchObject({
      [flag === 'messages-file' ? 'messages' : 'notification_configuration']: '[structured input redacted, 37 bytes]',
    })
  },
)

test.each([
  'https://CANARY-user@scm.example/repo',
  'https://git:CANARY-password@scm.example/repo',
  'https://git:%43ANARY-password@scm.example/repo',
  'https://scm.example/repo?token=CANARY-secret',
  'https://scm.example/repo?token=%43ANARY-secret',
  "https://scm.example/repo?token='CANARY-secret",
  'https://scm.example/repo?%74oken=CANARY-secret',
  'https://scm.example/repo?api_key=CANARY-secret',
  'https://scm.example/repo#access_token=CANARY-secret',
  'https://scm.example/repo#CANARY-secret',
  'https://scm.example/repo#100%',
].flatMap(url => ['create', 'edit'].flatMap(verb => ['--dry-run', '--confirm'].flatMap(action => [
  { url, args: ['project', verb, '42', '--scm-url', url, action], input: {} },
  { url, args: ['project', verb, '42', `--scm-url=${url}`, action], input: {} },
  { url, args: ['project', verb, '42', '--scm-url', 'scm.txt', action], input: {
    files: [{ name: 'scm.txt', contentBase64: Buffer.from(url).toString('base64') }] } },
]))))('rejects secret-bearing SCM input before execution: $args', async ({ args, input }) => {
  await expect(adapter(true, false, true).prepare(args, reference, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT',
    next: expect.stringContaining('credential create/edit --inputs-file') })
})

test.each(['post', 'put', 'patch'].flatMap(method => ['--dry-run', '--confirm'].flatMap(action => [
  { method, action, body: { scm_url: 'https://scm.example/repo?token=CANARY-secret' } },
  { method, action, body: { nested: [{ scm_url: 'https://user@scm.example/repo' }] } },
  { method, action, body: { scm_url: 'https://scm.example/repo#fragment' } },
])))('raw $method $action rejects unsafe SCM URLs before dispatch', async ({ method, action, body }) => {
  const file = { name: 'body.json', contentBase64: Buffer.from(JSON.stringify(body)).toString('base64') }
  await expect(adapter(true, false, true).prepare(['api', method, 'projects/42/', '--body-file=body.json', action], reference, { files: [file] }))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test.each(['project create', 'project edit', 'job stdout', 'ad-hoc stdout'])('%s help explains SCM credentials and retained-log scope', command => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', ...command.split(' '), '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('credential create/edit --inputs-file')
  expect(help).toContain('Already-retained AWX logs from URLs set outside Artium are AWX-held data')
})

test.each([
  { args: ['schedule', 'edit', '42', '--extra-vars', '@/etc/hosts', '--dry-run'], input: {} },
  { args: ['schedule', 'edit', '42', '--extra-vars', 'vars.json', '--dry-run'], input: {
    files: [{ name: 'vars.json', contentBase64: Buffer.from('@/etc/hosts').toString('base64') }] } },
  { args: ['credential', 'edit', '42', '--inputs-file', '/etc/hosts', '--dry-run'], input: {} },
  { args: ['team', 'credential-create', '42', '--inputs-file', '-', '--dry-run'], input: { stdin: '{}' } },
  { args: ['job', 'list'], input: { stdin: 'CANARY-unrequested-stdin' } },
])('refuses server paths and undeclared stdin: $args', async ({ args, input }) => {
  await expect(adapter(true, false, true).prepare(args, reference, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test.each(inventory.commands.filter(route => route.effect === 'blocked' && route.command !== 'auth logout'))('$command retains the managed client-local boundary', async route => {
  await expect(adapter().prepare(route.command.split(' '), reference)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not yet supported') })
  await expect(adapter(true, false, true).prepare(route.command.split(' '), reference)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not yet supported') })
})

test('managed logout directs callers to explicit upstream PAT revocation', async () => {
  await expect(adapter(true, false, true).prepare(['auth', 'logout'], reference)).rejects.toMatchObject({ code: 'INVALID_INPUT',
    next: expect.stringContaining('user token-revoke <numeric-token-id> --dry-run') })
})

test('token creation help describes protected delivery through the managed client', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', 'user', 'token-create', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('authenticated GET by the same caller')
  expect(help).toContain('Save within five minutes')
})

test.each(inventory.commands.filter(route => route.effect !== 'blocked').flatMap(route => Object.keys(route.flags)
  .filter(name => name.endsWith('-file'))
  .map(flag => ({ command: route.command, flag, required: route.positionals.required }))))('$command --$flag requires secure input', async ({ command, flag, required }) => {
  await expect(adapter(true, false, true).prepare([...command.split(' '), ...Array<string>(required).fill('42'), `--${flag}`, 'CANARY-input', '--confirm'], reference))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test.each(inventory.commands.filter(route => ['write', 'configuration-write'].includes(route.effect)))('$command requires the single tenant write switch', async route => {
  const args = [...route.command.split(' '), ...route.positionals.names.slice(0, route.positionals.required).map(() => '42'), '--confirm']
  await expect(adapter().prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  const call = await adapter(true, false, true).prepare(args, reference)
  expect(call.effect).toBe('write')
  expect(call.environment).toMatchObject({ AWX_AXI_READ_ONLY: 'false', ARTIUM_SECRET_0: credential.token })
  expect(call.environment).toMatchObject({ AWX_AXI_ALLOW_CONFIG_WRITES: '1', AWX_AXI_ALLOW_DELETES: '1', AWX_AXI_ALLOW_SECURITY_WRITES: '1' })
  expect(call.environment).not.toHaveProperty('AWX_AXI_WRITE_LOG')
  expect(call.write?.checkArgs).toBeDefined()
})

test.each(['post', 'put', 'patch', 'delete'])('api %s provides resource reconciliation guidance and keeps the uploaded body private', async method => {
  const body = { name: 'body.json', contentBase64: Buffer.from('{"name":"CANARY-api-body"}').toString('base64') }
  const call = await adapter(true, false, true).prepare(['api', method, 'labels/7/', ...method === 'delete' ? [] : ['--body-file', 'body.json'], '--confirm'], reference,
    method === 'delete' ? {} : { files: [body] })
  expect(call.write).toEqual({ operation: `api ${method}`, target: 'managed resource', checkArgs: [],
    afterCheck: 'Inspect the resource targeted or created by the request before retrying; it may differ from the mutation URL' })
  expect(call.args.join(' ')).not.toContain('CANARY-')
  expect(call.fileArguments?.map(index => call.args[index])).toEqual(method === 'delete' ? [] : ['body.json'])
})

test.each([['post', 'labels/', 'POST'], ['delete', 'labels/7/', 'DELETE']])('api %s %s reaches the controller under the gates Artium derives from the single write switch', async (method, path, verb) => {
  const call = await adapter(true, false, true).prepare(['api', method, path, '--confirm'], reference)
  const transport = new RecordedTransport([{ status: 200, body: { id: 7 } }], { env: call.environment })
  await main({ argv: call.args.slice(4), env: call.environment, createTransport: () => transport, stdout: { write: () => {} } })
  expect(transport.requests).toMatchObject([{ method: verb, route: path }])
})

test('native raw bulk job launch is rejected before a controller request', async () => {
  const call = await adapter(true, false, true).prepare(['api', 'post', 'bulk/job_launch/', '--confirm'], reference)
  const transport = new RecordedTransport([], { env: call.environment })
  let output = ''
  await main({ argv: call.args.slice(4), env: call.environment, createTransport: () => transport,
    stdout: { write: chunk => { output += chunk } } })
  expect(output).toContain('refuses bulk/job_launch/')
  expect(transport.requests).toEqual([])
})

test.each([['api', 'post', 'labels/'], ['api', 'delete', 'labels/7/']])('%s %s without confirm or dry-run is refused', async (...args) => {
  await expect(adapter(true, false, true).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test('an authorized dry-run remains a read even when confirm is present', async () => {
  const call = await adapter(true, false, true).prepare(['job', 'cancel', '42', '--confirm', '--dry-run'], reference)
  expect(call.effect).toBe('read')
  expect(call.write).toBeUndefined()
})

test.each(inventory.commands.filter(route => ['write', 'configuration-write'].includes(route.effect) && !route.command.startsWith('api ')))('$command previews require write access and ignore the legacy configuration grant', async route => {
  const args = [...route.command.split(' '), ...route.positionals.names.slice(0, route.positionals.required).map(() => '42'), '--dry-run']
  await expect(adapter().prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  await expect(adapter(false, true).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect((await adapter(true, false, true).prepare(args, reference)).effect).toBe('read')
})

test.each(inventory.commands.filter(route => route.effect === 'read'))('$command remains available without write access', async route => {
  const args = [...route.command.split(' '), ...route.positionals.names.slice(0, route.positionals.required).map(() => '42')]
  expect((await adapter().prepare(args, reference)).effect).toBe('read')
})

test.each(inventory.commands.filter(route => route.effect !== 'read'))('$command help remains readable without write access', async route => {
  expect((await adapter().prepare([...route.command.split(' '), '--help'], reference)).effect).toBe('read')
})

test('batch host inspection is admitted without write authority', async () => {
  const call = await adapter().prepare(['host', 'inspect', '501,601', '--inventory', '11'], reference)
  expect(call.args).toEqual(['host', 'inspect', '501,601', '--inventory=11'])
  expect(call.effect).toBe('read')
  expect(call.environment.AWX_AXI_READ_ONLY).toBe('true')
  expect(call.write).toBeUndefined()
})

test.each(inventory.commands.filter(route => route.effect === 'configuration-write').map(route => route.command))('%s managed help describes configuration authority and excludes blocked input', async command => {
  const call = await adapter().prepare([...command.split(' '), '--help'], reference)
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', ...call.args], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain(`artium-axi awx-axi ${command}`)
  expect(help).toContain('--confirm')
  expect(help).toContain('--dry-run')
  expect(help).toContain('allowWrites and --confirm')
  expect(help).toContain(`AWX must authorize ${command}`)
})

test.each([
  { command: 'workflow node-link', requirement: '--on <success|failure|always> --to <node-id>' },
  { command: 'template notification-add', requirement: 'started, success, or error' },
  { command: 'workflow notification-add', requirement: 'started, success, error, or approval' },
  { command: 'project notification-add', requirement: 'started, success, or error' },
  { command: 'project create', requirement: '--scm-url' },
  { command: 'project edit', requirement: '--scm-url' },
  { command: 'inventory source-notification-add', requirement: 'started, success, or error' },
  ...['schedule create', 'schedule edit'].flatMap(command => [
    { command, requirement: 'ask_inventory_on_launch' }, { command, requirement: 'ask_limit_on_launch' },
    { command, requirement: 'ask_tags_on_launch' }, { command, requirement: 'ask_skip_tags_on_launch' },
  ]),
])('$command managed help retains $requirement', ({ command, requirement }) => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', ...command.split(' '), '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(rewriteSuggestions(result.stdout, 'awx-axi')).toContain(requirement)
})

test.each([
  { command: 'template edit', group: 'template' }, { command: 'workflow edit', group: 'workflow' },
  { command: 'project edit', group: 'project' }, { command: 'inventory edit', group: 'inventory' },
  { command: 'inventory host-edit', group: 'host' }, { command: 'inventory group-edit', group: 'group' },
  { command: 'inventory source-edit', group: 'inventory-source' }, { command: 'schedule edit', group: 'schedule' },
  { command: 'organization edit', group: 'organization' }, { command: 'credential edit', group: 'credential' },
  { command: 'execution-environment edit', group: 'execution-environment' }, { command: 'team edit', group: 'team' },
  { command: 'notification-template edit', group: 'notification-template' },
])('$command recovery covers both rename outcomes', async ({ command, group }) => {
  const call = await adapter(true, false, true).prepare([...command.split(' '), 'Old', '--name', 'New', '--confirm'], reference)
  expect(call.write?.checkArgs).toEqual([group, 'list', '--limit', '100'])
  const recovery = await adapter().prepare(call.write!.checkArgs, reference)
  expect(recovery.effect).toBe('read')
  expect(recovery.args).toEqual([group, 'list', '--limit=100'])
})

test('user rename recovery covers both usernames', async () => {
  const call = await adapter(true, false, true).prepare(['user', 'edit', 'old-user', '--username', 'new-user', '--confirm'], reference)
  expect(call.write?.checkArgs).toEqual(['user', 'list', '--limit', '100'])
  expect((await adapter().prepare(call.write!.checkArgs, reference)).effect).toBe('read')
})

test('token revocation recovery does not treat the token ID as a user ID', async () => {
  const call = await adapter(true, false, true).prepare(['user', 'token-revoke', '42', '--confirm'], reference)
  expect(call.write?.checkArgs).toEqual(['user', 'list', '--limit', '100'])
  expect((await adapter().prepare(call.write!.checkArgs, reference)).effect).toBe('read')
})

test.each(fixedSchemaLists)('%s list passes the pinned fields flag through as a read', async command => {
  for (const flags of [['--fields', 'id,name'], ['--fields=id,name']]) {
    const call = await adapter().prepare([command, 'list', ...flags], reference)
    expect(call).toMatchObject({ args: [command, 'list', '--fields=id,name'], effect: 'read' })
  }
})

test.each([['--type', 'workflow'], ['--type=workflow']])('job events passes the pinned run type selector through as a read: %s', async (...flags) => {
  const call = await adapter().prepare(['job', 'events', '42', ...flags], reference)
  expect(call).toMatchObject({ args: ['job', 'events', '42', '--type=workflow'], effect: 'read' })
})

test('job events preserves implemented filters', async () => {
  const call = await adapter().prepare(['job', 'events', '42', '--failed', '--host', 'synthetic', '--task', 'setup', '--limit', '10'], reference)
  expect(call.args).toEqual(['job', 'events', '42', '--failed', '--host=synthetic', '--task=setup', '--limit=10'])
  expect(call.effect).toBe('read')
})

test.each([
  ['job', 'launch', '42'], ['template', 'launch', '42'], ['workflow', 'launch', '42'],
  ['ad-hoc', 'launch'], ['system-job-template', 'launch', '42'], ['job', 'relaunch', '42'],
  ...['job', 'workflow', 'project-update', 'inventory-update', 'ad-hoc', 'system', 'all'].map(type => ['job', 'relaunch', '42', '--type', type]),
])('new-run recovery includes every run type for %j', async (...args) => {
  const call = await adapter(true, false, true).prepare([...args, '--confirm'], reference)
  expect(call.write?.checkArgs).toEqual(['job', 'list', '--type', 'all', '--limit', '100'])
  const recovery = await adapter().prepare(call.write!.checkArgs, reference)
  expect(recovery.effect).toBe('read')
  expect(recovery.args).toEqual(['job', 'list', '--type=all', '--limit=100'])
})

test('managed credentials inject a token SecretRef without persisting the secret', async () => {
  const call = await adapter().prepare(['job', 'list', '--limit=1'], reference)
  expect(call.args).toEqual(['job', 'list', '--limit=1'])
  expect(JSON.parse(call.files[0].content as string)).toEqual({ version: 1, defaultProfile: 'artium', profiles: {
    artium: { origin: credential.origin, token: { env: 'ARTIUM_SECRET_0' } },
  } })
  expect(call.environment.AWX_AXI_READ_ONLY).toBe('true')
  expect(call.environment).not.toHaveProperty('AWX_AXI_WRITE_LOG')
  expect(call.secrets).toContain(credential.token)
  expect(awxProfile.metadata(credential)).toEqual({ origin: credential.origin })
  expect(toolEndpoints('awx-axi', credential).map(url => url.origin)).toEqual([credential.origin])
  expect(toolAllowsWrites('awx-axi', {})).toBe(false)
})

test('pinned job list requests newest jobs first within the managed row limit', async () => {
  const call = await adapter().prepare(['job', 'list', '--limit', '1'], reference)
  expect(call.args).toEqual(['job', 'list', '--limit=1'])
  const plan = jobDomain.subcommands.find(route => route.name === 'list')!.plan({ args: [], flags: { limit: '1' },
    context: { env: {}, createTransport: () => { throw new Error('Unexpected network access') } } })
  expect(plan.next()).toMatchObject({ done: false, value: { kind: 'readPaged',
    route: { path: 'unified_jobs/', query: { order_by: '-id' } }, limit: { all: false, maxRows: 1 } } })
})

test('password sign-in parses as host input and is not prepared as a controller credential', async () => {
  const input = { origin: 'https://controller.example', signIn: 'password', username: 'synthetic-awx', password: 'CANARY-awx-password' }
  expect(awxCredentialSchema.safeParse(input).success).toBe(true)
  expect(awxProfile.metadata(input)).not.toHaveProperty('password')
  expect(awxCredentialSchema.safeParse({ origin: 'https://controller.example', token: 'CANARY-awx-token', username: 'synthetic-awx' }).success).toBe(false)
  const managed = createAwxAdapter({ getCredential: async () => input })
  await expect(managed.prepare(['job', 'list'], reference)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})

test.each([
  { origin: 'http://controller.example', token: 'CANARY-token' },
  { origin: 'https://controller.example/path', token: 'CANARY-token' },
  { origin: 'https://controller.example', token: { stored: true } },
  { origin: 'https://controller.example', verifySsl: false, token: 'CANARY-token' },
  { origin: 'https://controller.example', allowHttp: true, token: 'CANARY-token' },
  { origin: 'https://controller.example' },
])('unsafe or incomplete credential $origin is refused', value => {
  expect(awxCredentialSchema.safeParse(value).success).toBe(false)
})

test.each([
  ['--origin', 'https://other.example', 'job', 'list'], ['job', 'list', '--config=other'],
  ['job', 'list', '--verify-ssl=false'], ['job', 'list', '--profile=other'],
  ['job', 'list', '--limit', '1', '--limit', '2'], ['job', 'list', '--unknown'],
  ['template', 'launch', '42', '--extra-vars', '@server.json'],
  ['template', 'launch', '42', '--credential-passwords-file', '/server.json'],
  ['job', 'stdout', '42', '--download', './42.log'],
  ['job', 'stdout', '42', '--download=./42.log'],
].map(args => ({ args })))('unsafe arguments are refused: $args', ({ args }) => {
  expect(() => adapter().validateArgs(args)).toThrow()
})

test('the stored write switch is checked before loading secrets', async () => {
  let read = false
  const managed = createAwxAdapter({ getSettings: () => ({}), getCredential: async () => { read = true; return credential } })
  await expect(managed.prepare(['job', 'cancel', '42', '--confirm'], reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(read).toBe(false)
})

test.each([
  { output: 'code: TLS_UNTRUSTED\nerror: certificate could not be verified', code: 'UPSTREAM_TLS_FAILED', stage: 'TLS' },
  { output: 'code: CONTROLLER_UNREACHABLE\nerror: controller could not be reached', code: 'UPSTREAM_NETWORK_FAILED', stage: 'TCP' },
  { output: 'code: AUTH_REQUIRED\nerror: controller rejected the credential', code: 'UPSTREAM_AUTH_FAILED', stage: 'authentication' },
])('AWX diagnostics classify $code', ({ output, code, stage }) => {
  expect(toolFailure(output, '', 1, 'awx-axi')).toMatchObject({ code, diagnostic: { stage } })
})

test('managed help replaces standalone login and TLS bypass advice', () => {
  const output = rewriteSuggestions('error: rejected\ncode: AUTH_REQUIRED\nhelp[2]:\n  - "Run `awx-axi auth login` to store a token"\n  - "Set AWX_AXI_VERIFY_SSL=false for the env profile"\n', 'awx-axi')
  expect(output).toContain('Ask an administrator')
  expect(output).not.toMatch(/auth login|VERIFY_SSL/)
})

test('published AWX top-level help advertises managed commands without selectors or update', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('artium-axi awx-axi')
  expect(help).not.toMatch(/--(?:origin|profile|config|verify-ssl)|auth login|\bupdate\b/)
})

test('managed job stdout help advertises every output mode with a managed download', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', 'job', 'stdout', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('artium-axi awx-axi job stdout <id> [--tail <n> | --lines <a-b>] [--full] [--download <name>]')
  expect(help).toContain('protected result')
  expect(help).not.toMatch(/--download <path>|--download \.\//)
})

test('job list help advertises the fields flag the pinned help documents', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', 'job', 'list', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(rewriteSuggestions(result.stdout, 'awx-axi')).toContain('artium-axi awx-axi job list [--status <s>]')
  expect(rewriteSuggestions(result.stdout, 'awx-axi')).toContain('[--fields <fields>]')
})

test('oversized job stdout suggests the managed download or failing events', async () => {
  const plan = jobDomain.subcommands.find(route => route.name === 'stdout')!.plan({ args: ['42'], flags: { type: 'job' },
    context: { env: {}, createTransport: () => { throw new Error('Unexpected network access') } } })
  plan.next()
  const error = await Promise.resolve().then(() => plan.next({
    status: 200, content: '', rangeStart: 0, rangeEnd: 0, absoluteEnd: 0, tooLarge: true,
    sizeBytes: 2 * 1024 * 1024, displayLimitBytes: 1024 * 1024,
  })).catch(error => error)
  const result = formatError(error)
  expect(result.exitCode).toBe(1)
  const output = rewriteSuggestions(result.output, 'awx-axi')
  expect(decode(output)).toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
  expect(output).toContain('artium-axi awx-axi job events 42 --failed')
  expect(output).toContain('artium-axi awx-axi job stdout 42 --download 42.log')
})

test.each(inventory.discovery.commands.filter(command => !['auth status', 'doctor'].includes(command)))('%s noun-level help lists only managed commands', async command => {
  const call = await adapter().prepare([command, '--help'], reference)
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', ...call.args], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain(`artium-axi awx-axi ${command === 'api' ? 'api get' : `${command} list`}`)
  if (command === 'inventory') expect(help).toContain('artium-axi awx-axi inventory host-bulk-create')
})

test.each(['auth status', 'doctor'])('%s published help uses managed credential guidance', async command => {
  const call = await adapter().prepare([...command.split(' '), '--help'], reference)
  const result = spawnSync(process.execPath, ['tools/node_modules/@knowttl/awx-axi/dist/bin/awx-axi.js', ...call.args], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain(`artium-axi awx-axi ${command}`)
  expect(help).toContain('Artium manages the controller origin, verified TLS and token.')
  expect(help).not.toMatch(/auth (?:login|logout)|AWX_AXI_|--(?:config|profile|origin|verify-ssl|allow-http)/)
})

test.each([
  { field: 'job', outcome: '42 already finished (successful), nothing to cancel (no-op)' },
  { field: 'approval', outcome: '42 already approved (no-op)' },
  { field: 'approval', outcome: '42 already denied (no-op)' },
])('$outcome survives help rewriting', ({ field, outcome }) => {
  const output = encode({ [field]: outcome, help: [`Run \`awx-axi ${field} list\` for details`] }) + '\n'
  const rewritten = rewriteSuggestions(output, 'awx-axi')
  expect(decode(rewritten)).toMatchObject({ [field]: outcome })
  expect(rewritten).toContain(`artium-axi awx-axi ${field} list`)
})

test.each([
  ['AUTH_REQUIRED', 'authentication required', 'Ask an administrator to update the managed credential'],
  ['FORBIDDEN', 'dashboard access denied', 'Run `artium-axi awx-axi auth status` to check configuration and access'],
  ['CONTROLLER_UNREACHABLE', 'controller unreachable', 'Run `artium-axi awx-axi auth status` to check configuration and access'],
  ['TLS_UNTRUSTED', 'controller certificate could not be verified', 'Run `artium-axi awx-axi auth status` to check configuration and access'],
  ['PROFILE_MISSING', 'controller configuration required', 'Run `artium-axi awx-axi auth status` to check configuration and access'],
  ['CONFIG_INVALID', 'controller configuration required', 'Run `artium-axi awx-axi auth status` to check configuration and access'],
  ['UNKNOWN', 'dashboard unavailable', 'Run `artium-axi awx-axi auth status` to check configuration and access'],
])('%s dashboard diagnostics preserve the problem with managed recovery', (code, problem, recovery) => {
  const output = homeDiagnostic(new AwxAxiError('Synthetic failure', code))
  const rewritten = rewriteSuggestions(output, 'awx-axi')
  expect(rewritten).toBe(`awx: ${problem}; ${recovery}\n`)
  expect(rewriteSuggestions(rewritten, 'awx-axi')).toBe(rewritten)
  expect(rewriteSuggestions(output, 'awx-axi', true)).toBe(output)
})

test.each(['job', 'ad-hoc'])('%s stdout rewrites only the generated footer', noun => {
  const body = 'ordinary log line\nRun `awx-axi job list`\nhelp[2]: raw log help\nawx: authentication required; Run `awx-axi auth login` to configure credentials\n'
  const header = { [noun === 'job' ? 'job_stdout' : 'ad_hoc_stdout']: { id: 42, lines: '1-4 of 4' } }
  const help = [
    `Run \`awx-axi ${noun} stdout 42 --lines 1-200\` to read from the start`,
    `Run \`awx-axi ${noun} events 42\` for event-level detail`,
  ]
  const output = redactResult(rawRegion({ header, label: 'stdout', body, help })) as string
  const expected = redactResult(rawRegion({ header, label: 'stdout', body, help: help.map(value => value.replace('`awx-axi', '`artium-axi awx-axi')) })) as string
  const rewritten = rewriteSuggestions(output, 'awx-axi')
  expect(rewritten).toBe(expected)
  expect(rewriteSuggestions(rewritten, 'awx-axi')).toBe(expected)
  expect(rewriteSuggestions(output, 'awx-axi', true)).toBe(output)
})

test.each([
  { command: ['job', 'watch', '42'], timeout: '--timeout=50' },
  { command: ['job', 'launch', '42', '--wait', '--confirm'], timeout: '--timeout=50' },
  { command: ['job', 'watch', '42', '--timeout', '7'], timeout: '--timeout=7' },
])('waits are bounded by the runner lifetime: $command', async ({ command, timeout }) => {
  const call = await adapter(true, false, true).prepare(command, reference)
  expect(call.args.filter(arg => arg.startsWith('--timeout'))).toEqual([timeout])
})

test.each(['0', '51', '600', '3600', '1e1', '-1', 'soon'])('a wait of --timeout %s is refused with resume guidance', async timeout => {
  await expect(adapter(true, false, true).prepare(['job', 'watch', '42', '--timeout', timeout], reference)).rejects.toMatchObject({
    code: 'INVALID_INPUT', message: 'Waits last from 1 to 50 seconds.', next: expect.stringContaining('job watch') })
  await expect(adapter(true, false, true).prepare(['project', 'sync', '42', '--wait', '--timeout', timeout, '--confirm'], reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('an approval timeout is not a wait and keeps its own value', async () => {
  const call = await adapter(true, false, true).prepare(['workflow', 'node-add-approval', '42', '--name', 'Synthetic', '--timeout', '3600', '--confirm'], reference)
  expect(call.args).toContain('--timeout=3600')
})

test.each([
  { flags: ['--download', '../42.log'] },
  { flags: ['--download', '/tmp/42.log'] },
  { flags: ['--download', '.hidden'] },
  { flags: ['--download', 'a'.repeat(65)] },
  { flags: ['--download', '42.log', '--tail', '5'] },
  { flags: ['--download', '42.log', '--lines', '1-2'] },
  { flags: ['--download', '42.log', '--full'] },
  { flags: ['--download', '42.log', '--ansi'] },
])('stdout download refuses caller-selected paths and range flags: $flags', async ({ flags }) => {
  await expect(adapter().prepare(['job', 'stdout', '42', ...flags], reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('stdout download is a read delivered as a managed protected result without a caller path', async () => {
  const call = await adapter().prepare(['job', 'stdout', '42', '--download', '42.log'], reference)
  expect(call).toMatchObject({ protectedResult: { source: 'file', operation: 'stdout-download', flag: '--artium-result' } })
  expect(call.args).toContain('--download=42.log')
})
