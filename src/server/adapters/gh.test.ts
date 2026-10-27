import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decode, encode } from '@toon-format/toon'
import { expect, test, vi } from 'vitest'
import inventory from '../../../tools/inventories/gh-axi.json' with { type: 'json' }
import { createGhAdapter, ghCredentialSchema, ghProfile, ghWritePolicy } from './gh.js'
import { Runner } from '../runner/runner.js'
import { toolEndpoints } from '../tool-endpoints.js'
import { prepareRunJournal } from './run-journal.js'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { toolView } from '../../cli/views.js'

const reference = { id: 'synthetic-github', tool: 'gh-axi' as const, revision: 1 }
const credential = { origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' }
const adapter = createGhAdapter({ getCredential: async () => credential })

test.each(inventory.commands)('permits the reviewed $command help route', async route => {
  const args = route.command === 'home' ? ['--help'] : [...route.command.split(' '), '--help']
  expect((await adapter.prepare(args, reference)).effect).toBe('read')
})

test.each([
  ['issue', 'create'], ['issue', 'delete', '1'], ['issue', 'subissue', 'add', '1', '2'],
  ['pr', 'merge', '1', '--admin'], ['secret', 'set', 'NAME'], ['variable', 'set', 'NAME'],
  ['update'], ['setup'], ['stack', 'view'], ['pr', 'checkout', '1'], ['repo', 'clone', 'canary/repo'],
  ['gist', 'clone', '1'], ['run', 'download', '1'], ['release', 'download'], ['run', 'watch', '1'],
  ['pr', 'checks', '1', '-R', 'canary/repo', '--watch'], ['api', '/user', '--hostname', 'other.example'],
  ['api', '/user', '--header=Authorization:other'], ['api', '/user', '--field', 'x=y'],
  ['api', '/user', '--raw-field=x=y'], ['api', '/user', '--input', '/tmp/body'],
  ['api', 'POST', '/repos/canary/repo'], ['api', 'HEAD', '/user'], ['api', '/user', '-X', 'POST'],
  ['api', 'https://other.example/user'], ['api', '//other.example/user'], ['api', 'graphql'],
  ['api', '/graphql?query=mutation'], ['api', '/%67raphql'], ['api', '/repos/../graphql'],
  ['issue', 'view', 'https://other.example/canary/repo/issues/1', '-R', 'canary/repo'],
  ['issue', 'list', '-R', 'other.example/canary/repo'], ['repo', 'view', 'other.example/canary/repo'],
  ['issue', 'list'], ['issue', 'list', '-R', 'canary/repo', '--limit'],
  ['issue', 'list', '-R', 'canary/repo', '--limit=1', '--limit=2'],
  ['issue', 'list', '-R', 'canary/repo', '--bogus'], ['issue', 'list', '-R', 'canary/repo', '--draft'],
  ['issue', 'list', '-R', 'canary/repo', '--help=false'], ['api', '--', '/user'],
].map(args => [args]))('refuses unsafe or invalid arguments before credential retrieval: %j', async args => {
  const getCredential = vi.fn()
  await expect(createGhAdapter({ getCredential }).prepare(args, reference)).rejects.toThrow()
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([{ stdin: '' }, { files: [{ name: 'body', contentBase64: 'eA==' }] }])('refuses input transport %j', async input => {
  await expect(adapter.prepare(['api', '/user'], reference, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
})

test.each([
  { origin: 'https://github.com', name: 'GH_TOKEN', host: 'github.com' },
  { origin: 'https://synthetic.ghe.com', name: 'GH_TOKEN', host: 'synthetic.ghe.com' },
  { origin: 'https://github.example', name: 'GH_ENTERPRISE_TOKEN', host: 'github.example' },
  { origin: 'https://github.example:8443', name: 'GH_ENTERPRISE_TOKEN', host: 'github.example:8443' },
])('injects a private credential for $origin', async ({ origin, name, host }) => {
  const call = await createGhAdapter({ getCredential: async () => ({ ...credential, origin }) }).prepare(['api', '/rate_limit'], reference)
  expect(call.environment[name]).toBe(credential.token)
  expect(call.environment[name === 'GH_TOKEN' ? 'GH_ENTERPRISE_TOKEN' : 'GH_TOKEN']).toBeUndefined()
  expect(call.environment).toMatchObject({ GH_HOST: host, GH_TELEMETRY: '0', GH_PROMPT_DISABLED: '1', GOMEMLIMIT: '256MiB' })
  expect(call.secrets).toEqual([credential.token])
  expect(JSON.stringify({ args: call.args, files: call.files })).not.toContain(credential.token)
  expect(await (await prepareRunJournal(call.environment, 'gh-axi', call.effect)).action(true)).toBe('read')
})

test.each(['ghp_CANARY', 'github_pat_CANARY', 'legacy-CANARY'])('accepts PAT format %s without length assumptions', token => {
  expect(ghCredentialSchema.safeParse({ ...credential, token }).success).toBe(true)
  expect(ghProfile.metadata({ ...credential, token })).toEqual({ origin: credential.origin, auth: 'token' })
})

test.each([
  { ...credential, token: 'gho_CANARY' }, { ...credential, token: 'ghs_CANARY' },
  { ...credential, token: ' ' }, { ...credential, auth: 'device' }, { ...credential, token: { env: 'OTHER' } },
  { ...credential, origin: 'http://github.example' }, { ...credential, origin: 'https://user@github.example' },
  { ...credential, origin: 'https://github.example/api/v3' }, { ...credential, allowWrites: true },
])('rejects unsupported credential shapes: %j', value => {
  expect(ghCredentialSchema.safeParse(value).success).toBe(false)
})

test('exposes the origin and API endpoint for trust inspection', () => {
  expect(toolEndpoints('gh-axi', credential).map(url => url.href)).toEqual(['https://github.com/', 'https://api.github.com/'])
  expect(toolEndpoints('gh-axi', { origin: 'https://github.example:8443' }).map(url => url.href))
    .toEqual(['https://github.example:8443/', 'https://github.example:8443/api/v3'])
  expect(() => ghWritePolicy.update({}, { enabled: true, expectedRevision: 1 })).toThrow()
})

test.each(['api', 'issue', 'pr', 'gist', '--help'])('rewrites published %s help with the managed read boundary', command => {
  const output = spawnSync(process.execPath, ['tools/node_modules/gh-axi/dist/bin/gh-axi.js',
    ...command === '--help' ? ['--help'] : [command, '--help']], { encoding: 'utf8' })
  expect(output.status, output.stderr).toBe(0)
  const rewritten = rewriteSuggestions(output.stdout, 'gh-axi')
  expect(rewritten).toContain('artium-axi gh-axi')
  expect(rewritten).not.toMatch(/gh auth|--hostname|gh-axi (?:setup|update|stack)|--watch/)
})

test('rewrites auth hints without changing resource data', () => {
  const original = { body: 'gh auth login', help: ['Run gh auth login', 'Run gh auth refresh -s repo'] }
  const output = decode(rewriteSuggestions(encode(original), 'gh-axi')) as typeof original
  expect(output.body).toBe(original.body)
  expect(output.help).toEqual(Array(2).fill(expect.stringContaining('administrator to reconnect')))
  expect(toolView({ name: 'gh-axi', version: '0.1.44', status: 'unconfigured' })).toContain('artium-axi gh-axi repo list')
})

test.each(['json', 'toon'])('replaces upstream auth diagnostics in %s output', format => {
  const document = { error: 'GitHub auth required - run gh auth login first', code: 'AUTH_REQUIRED' }
  const output = rewriteSuggestions(format === 'json' ? JSON.stringify(document) : encode(document), 'gh-axi')
  const managed = format === 'json' ? JSON.parse(output) : decode(output)
  expect(managed).toMatchObject({ code: 'AUTH_REQUIRED', help: [expect.stringContaining('administrator to reconnect')] })
  expect(output).not.toContain('gh auth')
})

test('inventory drift fails the executable freshness check', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-gh-inventory-'))
  try {
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, 'tools/inventories'), { recursive: true })
    symlinkSync(resolve('tools/node_modules'), join(directory, 'tools/node_modules'), 'dir')
    copyFileSync('scripts/gh-inventory.mjs', join(directory, 'scripts/gh-inventory.mjs'))
    copyFileSync('tools/integrity.json', join(directory, 'tools/integrity.json'))
    copyFileSync('tools/gh-source.json', join(directory, 'tools/gh-source.json'))
    const changed = structuredClone(inventory)
    changed.sources[0].sha256 = '0'.repeat(64)
    writeFileSync(join(directory, 'tools/inventories/gh-axi.json'), JSON.stringify(changed, null, 2) + '\n')
    const result = spawnSync(process.execPath, [join(directory, 'scripts/gh-inventory.mjs')], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Inventory out of date: gh-axi')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('the Go trust boundary refuses strict pins before starting a child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-gh-pin-'))
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    await expect(runner.run('synthetic-user', process.execPath, ['-e', 'process.exit(0)'], {}, [], {
      systemCaBundle: true, credentialTrust: [{ endpoint: 'https://github.example/', pem: 'synthetic-pem',
        fingerprint: 'synthetic', leafFingerprint: 'synthetic', mode: 'pin' }],
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  } finally { await runner.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})

test.each(['https://github.com', 'https://github.example'])('runs pinned gh-axi through the real runner and fake gh for %s', async origin => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-gh-'))
  const fake = join(directory, 'gh.mjs')
  copyFileSync('test/fixtures/fake-gh.mjs', fake)
  chmodSync(fake, 0o755)
  const runner = await Runner.create(join(directory, 'calls'))
  try {
    const call = await createGhAdapter({ getCredential: async () => ({ ...credential, origin }) }).prepare(['api', '/rate_limit'], reference)
    const result = await runner.run('synthetic-user', process.execPath,
      [resolve('tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...call.args],
      { ...call.environment, GH_BIN: fake }, call.secrets, call.limits, {}, call.files)
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(decode(result.stdout)).toMatchObject({ remaining: 4999, host: new URL(origin).host,
      tokenPresent: true, telemetry: '0', prompts: '1', systemRootsPresent: true, ambientAbsent: true,
      args: ['api', '/rate_limit', '--method', 'GET'] })
    expect(result.stdout + result.stderr).not.toContain(credential.token)
    const read = await adapter.prepare(['issue', 'list', '-R', 'canary/repo', '--limit', '1'], reference)
    const issues = await runner.run('synthetic-user', process.execPath,
      [resolve('tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...read.args], { ...read.environment, GH_BIN: fake },
      read.secrets, read.limits)
    expect(issues.exitCode, issues.stdout + issues.stderr).toBe(0)
    expect(issues.stdout).toContain('0')
    expect(readdirSync(join(directory, 'calls'))).toEqual([])
  } finally { await runner.shutdown(); rmSync(directory, { recursive: true, force: true }) }
})
