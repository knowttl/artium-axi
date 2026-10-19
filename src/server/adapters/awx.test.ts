import { expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { decode, encode } from '@toon-format/toon'
import inventory from '../../../tools/inventories/awx-axi.json' with { type: 'json' }
import { toolAllowsWrites } from '../../shared/api.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { toolFailure } from '../health/diagnostic.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { createAwxAdapter, awxCredentialSchema, awxProfile } from './awx.js'

const credential = { origin: 'https://controller.example', token: 'CANARY-awx-token' }
const reference = { id: 'synthetic-awx', tool: 'awx-axi' as const, revision: 1 }
const adapter = (allowWrites = false) => createAwxAdapter({ getCredential: async () => ({ ...credential, allowWrites }) }, '/tmp/awx-writes.log')

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
  expect(call.write?.checkArgs).toBeDefined()
})

test('a dry-run remains a read even when confirm is present', async () => {
  const call = await adapter().prepare(['job', 'cancel', '42', '--confirm', '--dry-run'], reference)
  expect(call.effect).toBe('read')
  expect(call.write).toBeUndefined()
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
  expect(call.secrets).toContain(credential.token)
  expect(awxProfile.metadata(credential)).toEqual({ origin: credential.origin })
  expect(toolEndpoints('awx-axi', credential).map(url => url.origin)).toEqual([credential.origin])
  expect(toolAllowsWrites('awx-axi', {})).toBe(false)
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
].map(args => ({ args })))('unsafe arguments are refused: $args', ({ args }) => {
  expect(() => adapter().validateArgs(args)).toThrow()
})

test('the stored write switch is checked before loading secrets', async () => {
  let read = false
  const managed = createAwxAdapter({ getSettings: () => ({}), getCredential: async () => { read = true; return credential } }, '/tmp/awx-writes.log')
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
