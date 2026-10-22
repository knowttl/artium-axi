import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { decode, encode } from '@toon-format/toon'
import { homeDiagnostic } from '../../../tools/node_modules/awx-axi/dist/commands/home.js'
import { rawRegion } from '../../../tools/node_modules/awx-axi/dist/core/output.js'
import { jobDomain } from '../../../tools/node_modules/awx-axi/dist/domains/job/index.js'
import inventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import { toolAllowsWrites } from '../../shared/api.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { toolFailure } from '../health/diagnostic.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { createAwxAdapter, awxCredentialSchema, awxProfile } from './awx.js'

// Load the published runtime without resolving its declarations through pnpm's symlink.
const errorsModule = '../../../tools/node_modules/awx-axi/dist/core/errors.js'
const { AwxAxiError, formatError } = await import(errorsModule)

const credential = { origin: 'https://controller.example', token: 'CANARY-awx-token' }
const reference = { id: 'synthetic-awx', tool: 'awx-axi' as const, revision: 1 }
const adapter = (allowWrites = false) => createAwxAdapter({ getCredential: async () => ({ ...credential, allowWrites }) })
const fixedSchemaLists = ['job', 'template', 'workflow', 'organization', 'system-job-template', 'system-job',
  'credential', 'ad-hoc', 'project', 'schedule', 'execution-environment', 'user', 'notification',
  'notification-template', 'activity-stream', 'team', 'role']

test.each(inventory.commands.filter(route => route.effect === 'blocked'))('$command is refused regardless of write access', async route => {
  await expect(adapter().prepare(route.command.split(' '), reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  await expect(adapter(true).prepare(route.command.split(' '), reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test.each(inventory.commands.filter(route => route.effect === 'write'))('$command requires the operational write switch', async route => {
  const args = [...route.command.split(' '), ...route.positionals.names.slice(0, route.positionals.required).map(() => '42'), '--confirm']
  await expect(adapter().prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  const call = await adapter(true).prepare(args, reference)
  expect(call.effect).toBe('write')
  expect(call.environment).toMatchObject({ AWX_AXI_READ_ONLY: 'false', ARTIUM_SECRET_0: credential.token })
  expect(call.environment).not.toHaveProperty('AWX_AXI_ALLOW_CONFIG_WRITES')
  expect(call.environment).not.toHaveProperty('AWX_AXI_ALLOW_DELETES')
  expect(call.environment).not.toHaveProperty('AWX_AXI_ALLOW_SECURITY_WRITES')
  expect(call.environment).not.toHaveProperty('AWX_AXI_WRITE_LOG')
  expect(call.write?.checkArgs).toBeDefined()
})

test('a dry-run remains a read even when confirm is present', async () => {
  const call = await adapter().prepare(['job', 'cancel', '42', '--confirm', '--dry-run'], reference)
  expect(call.effect).toBe('read')
  expect(call.write).toBeUndefined()
})

test.each(fixedSchemaLists)('%s list refuses unsupported field projection', command => {
  expect(() => adapter().validateArgs([command, 'list', '--fields', 'id,name'])).toThrow()
  expect(() => adapter().validateArgs([command, 'list', '--fields=id,name'])).toThrow()
})

test('job events refuses the ignored run type selector', () => {
  expect(() => adapter().validateArgs(['job', 'events', '42', '--type', 'workflow'])).toThrow()
  expect(() => adapter().validateArgs(['job', 'events', '42', '--type=workflow'])).toThrow()
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
  const call = await adapter(true).prepare([...args, '--confirm'], reference)
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
  ['job', 'stdout', '42', '--full'], ['job', 'stdout', '42', '--ansi'],
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
  const result = spawnSync(process.execPath, ['tools/node_modules/awx-axi/dist/bin/awx-axi.js', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('artium-axi awx-axi')
  expect(help).not.toMatch(/--(?:origin|profile|config|verify-ssl)|auth login|\bupdate\b/)
})

test('managed job stdout help advertises implemented output modes', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/awx-axi/dist/bin/awx-axi.js', 'job', 'stdout', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('artium-axi awx-axi job stdout <id> [--tail <n> | --lines <a-b>]')
  expect(help).not.toMatch(/--(?:download|full|ansi)\b/)
})

test.each(fixedSchemaLists)('%s list help advertises fixed output without field projection', command => {
  const result = spawnSync(process.execPath, ['tools/node_modules/awx-axi/dist/bin/awx-axi.js', command, 'list', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain(`artium-axi awx-axi ${command} list`)
  expect(help).not.toContain('--fields')
})

test('job events help omits the ignored run type selector', () => {
  const result = spawnSync(process.execPath, ['tools/node_modules/awx-axi/dist/bin/awx-axi.js', 'job', 'events', '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain('artium-axi awx-axi job events <id>')
  expect(help).not.toContain('--type')
})

test('oversized job stdout suggests managed events instead of a download', async () => {
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
  expect(output).not.toMatch(/--(?:download|full|ansi)\b/)
})

test.each(inventory.discovery.commands.filter(command => !['auth status', 'doctor'].includes(command)))('%s noun-level help lists only managed commands', async command => {
  const call = await adapter().prepare([command, '--help'], reference)
  const result = spawnSync(process.execPath, ['tools/node_modules/awx-axi/dist/bin/awx-axi.js', ...call.args], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const help = rewriteSuggestions(result.stdout, 'awx-axi')
  expect(help).toContain(`artium-axi awx-axi ${command} list`)
  expect(help).not.toMatch(/artium-axi awx-axi \S+ (?:create|edit|delete|credential-add)\b/)
})

test.each(['auth status', 'doctor'])('%s published help uses managed credential guidance', async command => {
  const call = await adapter().prepare([...command.split(' '), '--help'], reference)
  const result = spawnSync(process.execPath, ['tools/node_modules/awx-axi/dist/bin/awx-axi.js', ...call.args], { encoding: 'utf8' })
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
  const output = rawRegion({ header, label: 'stdout', body, help })
  const expected = rawRegion({ header, label: 'stdout', body, help: help.map(value => value.replace('`awx-axi', '`artium-axi awx-axi')) })
  const rewritten = rewriteSuggestions(output, 'awx-axi')
  expect(rewritten).toBe(expected)
  expect(rewriteSuggestions(rewritten, 'awx-axi')).toBe(expected)
  expect(rewriteSuggestions(output, 'awx-axi', true)).toBe(output)
})
