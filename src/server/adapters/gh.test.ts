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
import { hostedStatus } from './hosted-status.js'

const reference = { id: 'synthetic-github', tool: 'gh-axi' as const, revision: 1 }
const credential = { origin: 'https://github.com', auth: 'token', token: 'CANARY-github-token' }
const adapter = createGhAdapter({ getCredential: async () => credential })

test.each(inventory.commands)('permits the reviewed $command help route', async route => {
  const args = [...route.command.split(' '), '--help']
  expect((await adapter.prepare(args, reference)).effect).toBe('read')
})

test.each([
  ['issue', 'create'], ['issue', 'delete', '1'], ['issue', 'subissue', 'add', '1', '2'],
  ['project', 'delete', '1', '--owner', 'canary'],
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
  ['issue', 'list', '-R', 'canary/repo', '--search', 'urgent'],
  ['issue', 'list', '-R', 'canary/repo', '--search=urgent'],
  ['pr', 'list', '-R', 'canary/repo', '--search', 'urgent'],
  ['pr', 'list', '-R', 'canary/repo', '--search=urgent'],
  ['pr', 'diff', '1', '-R', 'canary/repo', '--patch'],
  ['gist', 'view', '1', '--raw'], ['pr', 'checks', '1', '-R', 'canary/repo', '--fail-fast'],
  ['repo', 'view'], ['repo', 'view', 'canary/repo'], ['repo', 'view', 'canary/repo', '-R', 'canary/repo'],
].map(args => [args]))('refuses unsafe or invalid arguments before credential retrieval: %j', async args => {
  const getCredential = vi.fn()
  await expect(createGhAdapter({ getCredential }).prepare(args, reference)).rejects.toThrow()
  expect(getCredential).not.toHaveBeenCalled()
})

test.each([[], ['home'], ['-R', 'canary/repo'], ['home', '-R', 'canary/repo'], ['home', '--help']].map(args => [args]))
  ('refuses the unverified dashboard before credential retrieval: %j', async args => {
    const getCredential = vi.fn()
    await expect(createGhAdapter({ getCredential }).prepare(args, reference)).rejects.toMatchObject({
      code: 'INVALID_INPUT', message: expect.stringContaining('converts failed reads into successful empty results'),
      next: expect.stringContaining('issue list -R OWNER/NAME'),
    })
    expect(getCredential).not.toHaveBeenCalled()
  })

test('requires explicit repository selection for repo view', async () => {
  const call = await adapter.prepare(['repo', 'view', '-R', 'canary/repo'], reference)
  expect(call.args).toEqual(['repo', 'view', '--repo=canary/repo'])
})

test('forwards PR field selections through the pinned upstream', async () => {
  const output = await executeHostedGh(['pr', 'view', '1', '-R', 'canary/repo', '--fields', 'number,title,mergeStateStatus,body'])
  expect(decode(output.stdout)).toMatchObject({ pull_request: {
    number: 1, title: 'canary PR', mergeStateStatus: 'BEHIND', body: 'Keep gh-axi pr update-branch in resource content.',
  } })
})

test.each([
  ['repo', 'list'], ['gist', 'list'], ['gist', 'view', '1'], ['search', 'repos', 'widget'], ['api', '/user'],
].map(args => [args]))('refuses ineffective repository selectors for %j', async args => {
  const getCredential = vi.fn()
  const scoped = createGhAdapter({ getCredential })
  expect(() => scoped.validateArgs([...args, '-R', 'canary/repo'])).toThrow()
  await expect(scoped.prepare([...args, '--repo', 'canary/repo'], reference)).rejects.toThrow()
  await expect(scoped.prepare([...args, '--repo=canary/repo'], reference)).rejects.toThrow()
  expect(getCredential).not.toHaveBeenCalled()
  expect((await adapter.prepare(args, reference)).effect).toBe('read')
  const call = await adapter.prepare([...args, '--help'], reference)
  const help = decode(hostedStatus('gh-axi', call.invocation, result).stdout) as { commands: string[] }
  expect(help.commands).toHaveLength(1)
  expect(help.commands[0]).not.toMatch(/-R |--repo\b/)
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

test.each(['api', 'issue', 'pr', 'gist', '--help', 'discussion view'])('rewrites published %s help with the managed read boundary', async command => {
  const args = command === '--help' ? ['--help'] : [...command.split(' '), '--help']
  const output = spawnSync(process.execPath, ['tools/node_modules/gh-axi/dist/bin/gh-axi.js',
    ...args], { encoding: 'utf8' })
  expect(output.status, output.stderr).toBe(0)
  const call = await adapter.prepare(args, reference)
  const rewritten = rewriteSuggestions(hostedStatus('gh-axi', call.invocation, { ...result, stdout: output.stdout }).stdout, 'gh-axi')
  expect(rewritten).toContain('artium-axi gh-axi')
  expect(rewritten).not.toMatch(/gh auth|--hostname|gh-axi (?:setup|update|stack)|--watch/)
})

test.each([
  { args: ['discussion', 'view', '--help'], syntax: 'discussion view', flags: ['--comments', '--limit <value>', '--order <value>'] },
  { args: ['api', '--help'], syntax: 'api [GET] <relative-path>', flags: ['--jq <value>', '--template <value>', '--full'] },
])('exposes reviewed command help for $syntax', async ({ args, syntax, flags }) => {
  const call = await adapter.prepare(args, reference)
  const output = hostedStatus('gh-axi', call.invocation, result)
  const document = decode(output.stdout) as { commands: string[] }
  expect(document.commands).toHaveLength(1)
  expect(document.commands[0]).toContain(`artium-axi gh-axi ${syntax}`)
  expect(document.commands[0]).toEqual(expect.stringContaining(flags[0]))
  expect(document.commands[0]).toEqual(expect.stringContaining(flags[1]))
  expect(document.commands[0]).toEqual(expect.stringContaining(flags[2]))
})

test('preserves resource help fields', () => {
  const original = { body: 'gh auth login', help: ['Run gh auth login', 'Run gh auth refresh -s repo'] }
  const output = decode(rewriteSuggestions(encode(original), 'gh-axi')) as typeof original
  expect(output.body).toBe(original.body)
  expect(output.help).toEqual(original.help)
  expect(toolView({ name: 'gh-axi', version: '0.1.45', status: 'unconfigured' })).toContain('artium-axi gh-axi repo list')
})

test.each([
  { format: 'json', code: 'AUTH_REQUIRED', stream: 'stdout' },
  { format: 'toon', code: 'AUTH_REQUIRED', stream: 'stderr' },
  { format: 'json', code: 'FORBIDDEN', stream: 'stderr' },
  { format: 'toon', code: 'FORBIDDEN', stream: 'stdout' },
  { format: 'json', code: 'UNKNOWN', stream: 'stdout' },
  { format: 'json', code: 'UNKNOWN', stream: 'stderr' },
  { format: 'toon', code: 'UNKNOWN', stream: 'stdout' },
  { format: 'toon', code: 'UNKNOWN', stream: 'stderr' },
] as const)('replaces upstream $code diagnostics in $format $stream', ({ format, code, stream }) => {
  const document = { error: code === 'UNKNOWN' ? 'gh: Bad credentials (HTTP 401)' : 'GitHub auth required - run gh auth login first', code }
  const serialized = format === 'json' ? JSON.stringify(document) : encode(document) + '\nhelp[1]:\n  Run gh auth login'
  const output = hostedStatus('gh-axi', { command: 'api', help: false }, { ...result, exitCode: 1, [stream]: serialized })[stream]
  const managed = format === 'json' ? JSON.parse(output) : decode(output)
  expect(managed).toMatchObject({ code, help: [expect.stringContaining('administrator to reconnect')] })
  expect(output).not.toContain('gh auth')
})

const result = { stdout: '', stderr: '', exitCode: 0, durationMs: 1, outputBytes: { stdout: 0, stderr: 0 },
  timedOut: false, truncated: { stdout: false, stderr: false } }

test.each([
  'A resource body\nusage: gh-axi api [<method>] <path>',
  JSON.stringify({ code: 'FORBIDDEN', error: 'resource data', help: ['gh auth login'] }),
  encode({ code: 'AUTH_REQUIRED', error: 'resource data', help: ['gh auth login'] }),
  'help[1]:\n  Run `gh-axi issue create`\n',
  encode({ code: 'UNKNOWN', error: 'gh: Bad credentials (HTTP 401)' }),
])('preserves successful API resource content: %s', async stdout => {
  const call = await adapter.prepare(['api', '/repos/canary/repo/issues/1', '--jq', '.body'], reference)
  const hosted = hostedStatus('gh-axi', call.invocation, { ...result, stdout, stderr: stdout })
  expect(rewriteSuggestions(hosted.stdout, 'gh-axi')).toBe(stdout)
  expect(rewriteSuggestions(hosted.stderr, 'gh-axi')).toBe(stdout)
})

test('hosts issue-list suggestions without advertising writes', async () => {
  const output = await executeHostedGh(['issue', 'list', '-R', 'canary/repo'])
  expect(output.stdout).toContain('artium-axi gh-axi issue list --state closed -R canary/repo')
  expect(output.stdout).not.toContain('issue create')
})

test('hosts a truncated PR diff recovery suggestion without advertising review writes', async () => {
  const output = await executeHostedGh(['pr', 'diff', '1', '-R', 'canary/repo'])
  expect(output.stdout).toContain('artium-axi gh-axi pr diff 1 --full -R canary/repo')
  expect(output.stdout).not.toContain('pr review')
})

test('keeps PR merge status without advertising a blocked branch update', async () => {
  const output = await executeHostedGh(['pr', 'view', '1', '-R', 'canary/repo'])
  const document = decode(output.stdout.split(/\nhelp\[\d+\]:/)[0]) as { pull_request: { merge_state: string, body: string } }
  expect(document.pull_request.merge_state).toContain('behind')
  expect(document.pull_request.merge_state).not.toContain('update-branch')
  expect(document.pull_request.body).toBe('Keep gh-axi pr update-branch in resource content.')
})

test('keeps release page counts without advertising an unscoped repository read', async () => {
  const output = await executeHostedGh(['release', 'list', '-R', 'canary/repo', '--limit', '1'])
  expect(output.stdout).toContain('count: 1 (showing first 1)\n')
  expect(output.stdout).not.toContain('gh-axi repo view')
  expect(output.stdout).toContain('canary release')
})

test('guides a revoked PAT failure from pinned upstream to an administrator', async () => {
  const output = await executeHostedGh(['api', '/canary-unauthorized'], 1)
  expect(decode(output.stdout)).toMatchObject({ code: 'UNKNOWN',
    help: [expect.stringContaining('Artium administrator to reconnect')] })
  expect(output.exitCode).toBe(1)
})

test.each(['stdout', 'stderr'] as const)('hosts every native suggestion block on %s', stream => {
  const original = 'data: first\nhelp[2]:\n  Run `gh-axi pr view 1 -R canary/repo`\n  Run `gh-axi pr merge 1 -R canary/repo`\nmore: second\nhelp[2]:\n  Run `gh-axi pr checks 1 -R canary/repo --watch`\n  Run `gh-axi run list -R canary/repo`\n'
  const output = hostedStatus('gh-axi', { command: 'pr view', help: false }, { ...result, [stream]: original })[stream]
  expect(output).toContain('artium-axi gh-axi pr view 1 -R canary/repo')
  expect(output).toContain('artium-axi gh-axi run list -R canary/repo')
  expect(output).toContain('data: first')
  expect(output).toContain('more: second')
  expect(output).not.toMatch(/pr merge|--watch/)
})

async function executeHostedGh(args: string[], expectedExitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'artium-gh-read-'))
  try {
    const fake = join(directory, 'gh.mjs')
    copyFileSync('test/fixtures/fake-gh.mjs', fake)
    chmodSync(fake, 0o755)
    const call = await adapter.prepare(args, reference)
    const child = spawnSync(process.execPath, [resolve('tools/node_modules/gh-axi/dist/bin/gh-axi.js'), ...call.args], {
      cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, ...call.environment,
        GH_BIN: fake, TMPDIR: directory },
    })
    expect(child.status, child.stdout + child.stderr).toBe(expectedExitCode)
    return hostedStatus('gh-axi', call.invocation, { ...result, exitCode: expectedExitCode, stdout: child.stdout, stderr: child.stderr })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test.each([
  ['--job', '456', '--conclusion', 'failure'],
  ['--job=456', '--conclusion=failure'],
])('preserves run job and conclusion selections: %j', async (...flags) => {
  const output = await executeHostedGh(['run', 'view', '123', '-R', 'canary/repo', ...flags])
  expect(decode(output.stdout)).toMatchObject({ job: { id: 456, conclusion: 'failure' } })
  expect(output.stdout).not.toContain('successful-job')
})

test('preserves a conclusion filter without a job selector', async () => {
  const output = await executeHostedGh(['run', 'view', '123', '-R', 'canary/repo', '--conclusion=failure'])
  expect(output.stdout).toContain('failed-job')
  expect(output.stdout).not.toContain('successful-job')
})

test('preserves an unfiltered run view', async () => {
  const output = await executeHostedGh(['run', 'view', '123', '-R', 'canary/repo'])
  expect(output.stdout).toContain('failed-job')
  expect(output.stdout).toContain('successful-job')
})

test.each(['--log', '--verbose', '--log-failed'])('returns an honest hosted tail for %s', async mode => {
  const output = await executeHostedGh(['run', 'view', '123', '-R', 'canary/repo', '--job=456', mode])
  const document = decode(output.stdout) as { run_log: { output: string }, help: string[] }
  expect(document.run_log).toMatchObject({ truncated: true, original_length: expect.any(Number) })
  expect(document.run_log).not.toHaveProperty('full_log')
  expect(document.run_log.output).toContain('"--job","456"')
  expect(document.help).toEqual(['Log output is truncated to its tail. The complete log is unavailable through Artium.'])
})

test('preserves a short run log', async () => {
  const output = await executeHostedGh(['run', 'view', '124', '-R', 'canary/repo', '--log'])
  expect(decode(output.stdout)).toMatchObject({ run_log: { truncated: false, output: expect.stringContaining('xxxxxxxxxx') } })
})

test.each(['issues', 'prs', 'repos', 'commits', 'code'])('forwards separate %s search qualifiers', async command => {
  const output = await executeHostedGh(['search', command, 'is:open', 'label:bug', '--owner', 'canary'])
  expect(output.stdout).toContain('is:open|label:bug')
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
