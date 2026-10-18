import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { decode, encode } from '@toon-format/toon'
import inventory from '../../../tools/inventories/ado-axi.json' with { type: 'json' }
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { toolView } from '../../cli/views.js'
import { prepareRunJournal } from './run-journal.js'
import { adoCredentialSchema, adoProfile, createAdoAdapter } from './ado.js'

const reference = { id: 'synthetic-ado', tool: 'ado-axi' as const, revision: 1 }
const credential = { org: 'synthetic-org', project: 'Synthetic Project', auth: 'pat', token: 'CANARY-ado-pat' }
const adapter = (allowWrites = false) => createAdoAdapter({ getCredential: async () => ({ ...credential, allowWrites }) })
const argv = (command: string) => command === 'api' ? ['api', '_apis/projects'] : command.split(' ')

test.each(inventory.commands.filter(route => route.effect !== 'blocked'))('classifies $command as $effect', async route => {
  const call = await adapter(true).prepare(argv(route.command), reference)
  expect(call.effect).toBe(route.effect)
  expect(Boolean(call.write)).toBe(route.effect === 'write')
})

test.each(inventory.commands.filter(route => route.effect === 'blocked'))('always blocks $command', async route => {
  await expect(adapter(true).prepare(argv(route.command), reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test.each(inventory.commands.filter(route => route.effect === 'write'))('gates $command with the administrator switch', async route => {
  await expect(adapter().prepare(argv(route.command), reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect((await adapter(true).prepare(argv(route.command), reference)).write?.checkArgs.length).toBeGreaterThan(1)
})

test.each(inventory.commands.filter(route => route.effect !== 'blocked').flatMap(route => {
  const aliases = Object.entries(inventory.aliases).filter(([, group]) => route.command.startsWith(`${group} `))
    .map(([alias]) => route.command.replace(/^\S+/, alias))
  return [...route.aliases, ...aliases].map(command => ({ command, effect: route.effect }))
}))('classifies alias $command as $effect', async ({ command, effect }) => {
  expect((await adapter(true).prepare(argv(command), reference)).effect).toBe(effect)
})

test.each([
  [], ['work-item'], ['pr'], ['pipeline'], ['repo'], ['ref'], ['project'], ['test', '42'],
  ['work-item', 'links', '42'], ['pr', 'thread', '42'], ['pr', 'reviewer', '--help'], ['--help'], ['--version'], ['-v'],
].map(args => [args]))('permits default reads and local help: %j', async args => {
  expect((await adapter().prepare(args, reference)).effect).toBe('read')
})

test.each(['org', 'profile', 'config'].flatMap(flag => [
  [`--${flag}`, 'other', 'project', 'list'], [`--${flag}=other`, 'project', 'list'],
  ['project', `--${flag}=other`, 'list'], ['project', 'list', `--${flag}`, 'other'], ['project', 'list', `--${flag}=other`],
]).map(args => [args]))('refuses managed overrides before fetching a PAT: %j', async args => {
  const getCredential = vi.fn()
  await expect(createAdoAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([
  ['api', 'POST', '_apis/projects'], ['api', 'PATCH', '_apis/projects'], ['api', 'DELETE', '_apis/projects'],
  ['api', 'HEAD', '_apis/projects'], ['api', 'PUT', '_apis/projects'], ['api', 'OPTIONS', '_apis/projects'],
  ['api', '_apis/projects', '--method=post'], ['api', 'GET', '_apis/projects', '--method', 'POST'],
  ['api', '_apis/projects', '--body', '{}'], ['api', '_apis/projects', '--content-type=json'],
  ['api', 'https://dev.azure.com/other/_apis/projects'], ['api', '//dev.azure.com/other/_apis/projects'],
].map(args => [args]))('refuses unsafe api calls with writes enabled: %j', async args => {
  await expect(adapter(true).prepare(args, reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
})

test.each([
  ['api', '_apis/projects'], ['api', 'GET', '_apis/projects'], ['api', 'get', '_apis/projects', '--method=get'],
  ['api', '--method', 'GET', '_apis/projects', '--host', 'vssps', '--no-project'],
].map(args => [args]))('permits only unambiguous api GET calls: %j', async args => {
  expect((await adapter().prepare(args, reference)).effect).toBe('read')
})

test.each([
  ['api', '_apis/projects', '--method=GET', '--method=DELETE'], ['api', '_apis/projects', '--raw', '--raw'],
  ['project', 'list', '--limit'], ['project', 'list', '--unknown'], ['project', 'list', '--body', '{}'],
  ['project', 'list', 'ignored'], ['project', 'list', '--limit=1', '--limit=2'], ['project', 'list', '--full=maybe'],
].map(args => [args]))('refuses malformed or repeated flags: %j', async args => {
  await expect(adapter().prepare(args, reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test.each([{ stdin: '' }, { stdin: '{}' }, { files: [{ name: 'body', contentBase64: 'eA==' }] }])('refuses stdin and files: %j', async input => {
  const getCredential = vi.fn()
  await expect(createAdoAdapter({ getCredential }).prepare(['api', '_apis/projects'], reference, input))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('materializes an isolated PAT profile and registers both raw and Basic credentials', async () => {
  const call = await adapter().prepare(['--project', 'Other Project', 'project', 'list'], reference)
  expect(call.environment).toEqual({ ADO_AXI_CONFIG: 'ado-profile.json', ARTIUM_SECRET_0: credential.token })
  expect(JSON.parse(call.files[0].content as string)).toEqual({ defaultProfile: 'artium', profiles: {
    artium: { org: credential.org, project: credential.project, auth: 'pat', patEnv: 'ARTIUM_SECRET_0' },
  } })
  expect(call.secrets).toEqual([credential.token, Buffer.from(`:${credential.token}`).toString('base64')])
  expect(JSON.stringify(call.files)).not.toContain(credential.token)
  expect(call.args).toEqual(['project', 'list', '--project', 'Other Project'])
})

test.each([
  { ...credential, auth: 'client-secret' }, { ...credential, auth: 'az' }, { ...credential, token: undefined },
  { ...credential, token: '   ' }, { ...credential, token: { env: 'OTHER' } }, { ...credential, org: 'bad/org' },
  { ...credential, clientId: 'synthetic-client' },
])('rejects unsupported credential shapes: %j', async value => {
  expect(adoCredentialSchema.safeParse(value).success).toBe(false)
  await expect(createAdoAdapter({ getCredential: async () => value }).prepare([], reference))
    .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
})

test.each(['https://dev.azure.com/synthetic-org/', 'https://synthetic-org.visualstudio.com', ' synthetic-org '])('normalizes organization input: %s', org => {
  expect(adoProfile.parseInput({ ...credential, org }).value.org).toBe('synthetic-org')
})

test.each(['https://dev.azure.com/synthetic-org/Project', 'https://reader@dev.azure.com/synthetic-org', 'https://dev.azure.com/synthetic-org?other=1'])('rejects ambiguous organization input with a field reason: %s', org => {
  expect(() => adoProfile.parseInput({ ...credential, org })).toThrow('org must be an Azure DevOps organization')
})

test('rejects references for other tools before retrieving a credential', async () => {
  const getCredential = vi.fn()
  await expect(createAdoAdapter({ getCredential }).prepare([], { ...reference, tool: 'az-axi' })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
  expect(getCredential).not.toHaveBeenCalled()
})

test('checks current host settings before retrieving a write credential', async () => {
  const getCredential = vi.fn(async () => ({ ...credential, allowWrites: true }))
  await expect(createAdoAdapter({ getCredential, getSettings: () => ({}) }).prepare(['pr', 'abandon', '42'], reference))
    .rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([['read', true, 'read'], ['read', false, 'read'], ['write', true, 'write'], ['write', false, 'unknown']] as const)(
  'journals host-classified %s with success=%s as %s', async (effect, succeeded, action) => {
    expect(await (await prepareRunJournal({}, 'ado-axi', effect)).action(succeeded)).toBe(action)
  })

test('refuses an absent host classification', async () => {
  await expect(prepareRunJournal({}, 'ado-axi')).rejects.toThrow('Missing host-classified effect')
})

test.each(['--help', 'work-item', 'pr', 'pipeline', 'test', 'repo', 'ref', 'project', 'api', 'doctor'])(
  'rewrites published %s help to managed guidance', command => {
    const args = command === '--help' ? [command] : [command, '--help']
    const result = spawnSync(process.execPath, ['tools/node_modules/@jeffreyhaen/ado-axi/dist/bin/ado-axi.js', ...args], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const output = rewriteSuggestions(result.stdout, 'ado-axi')
    expect(output).toContain('Artium manages the organization')
    expect(output).not.toMatch(/--(?:org|profile|config)\b|ado-axi config|ado-axi update|az (?:CLI )?login|piped stdin|--timeout 1800/)
    expect(output).toContain('artium-axi ado-axi')
    expect(rewriteSuggestions(output, 'ado-axi')).toBe(output)
  })

test('discovery presents a managed example', () => {
  expect(toolView({ name: 'ado-axi', version: '0.4.6', status: 'unconfigured' })).toContain('artium-axi ado-axi project list --limit 1')
})

test.each(['json', 'toon'])('rewrites %s suggestions without touching data fields', format => {
  const document = { body: 'ado-axi config list', help: ['Run `ado-axi project list --org other`',
    'Run `ado-axi config list`', 'Run `az login`', 'Set ADO_AXI_PAT to your PAT'] }
  const original = format === 'json' ? JSON.stringify(document) : encode(document) + '\n'
  const output = rewriteSuggestions(original, 'ado-axi')
  const parsed = (format === 'json' ? JSON.parse(output) : decode(output)) as typeof document
  expect(parsed.body).toBe(document.body)
  expect(parsed.help[0]).toBe('Run `artium-axi ado-axi project list`')
  expect(parsed.help.slice(1)).toEqual(Array(3).fill(expect.stringContaining('Artium manages the organization')))
  expect(rewriteSuggestions(output, 'ado-axi')).toBe(output)
})

test.each(inventory.sources)('requires review when the recorded $path digest changes', source => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-ado-inventory-'))
  try {
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, 'tools/inventories'), { recursive: true })
    symlinkSync(join(process.cwd(), 'tools/node_modules'), join(directory, 'tools/node_modules'), 'dir')
    writeFileSync(join(directory, 'scripts/ado-inventory.mjs'), readFileSync('scripts/ado-inventory.mjs'))
    writeFileSync(join(directory, 'tools/integrity.json'), readFileSync('tools/integrity.json'))
    const changed = { ...inventory, sources: inventory.sources.map(entry => entry.path === source.path ? { ...entry, sha256: '0'.repeat(64) } : entry) }
    writeFileSync(join(directory, 'tools/inventories/ado-axi.json'), JSON.stringify(changed, null, 2) + '\n')
    const result = spawnSync(process.execPath, [join(directory, 'scripts/ado-inventory.mjs')], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Inventory out of date: ado-axi')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
