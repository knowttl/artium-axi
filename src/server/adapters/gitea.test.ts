import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { expect, test } from 'vitest'
import { rewriteSuggestions } from '../../cli/rewrite.js'
import { createGiteaAdapter, giteaProfile } from './gitea.js'

const adapter = createGiteaAdapter({ getCredential: async () => ({
  origin: 'https://forge.example', tokenOrigin: 'https://forge.example', token: 'CANARY-gitea-token',
}) })
const reference = { id: 'synthetic', tool: 'gitea-axi', revision: 1 } as const
const native = join(process.cwd(), 'tools/node_modules/@knowttl/gitea-axi/dist/cli.js')

test.each([
  { origin: 'http://forge.example', tokenOrigin: 'http://forge.example' },
  { origin: 'https://forge.example/path', tokenOrigin: 'https://forge.example/path' },
  { origin: 'https://forge.example', tokenOrigin: 'https://other.example' },
  { origin: 'https://forge.example', tokenOrigin: 'https://forge.example', allowInsecureHttp: true },
])('Gitea credential input refuses unsafe binding or policy: %j', identity => {
  expect(giteaProfile.credentialSchema.safeParse({ ...identity, token: 'CANARY-gitea-token' }).success).toBe(false)
})

test.each([
  ['api', 'repos/search?q=hello%20world'],
  ['api', 'GET', 'repos/search?q=100%25'],
  ['api', 'repos/search?q=hello%5Cworld', '--method', 'GET'],
  ['api', 'repos/search?q=hello?world'],
])('Gitea metadata reads preserve query values: %j', async (...args) => {
  adapter.validateArgs(args)
  const call = await adapter.prepare(args, reference)
  expect(call.args.slice(1)).toEqual(args)
  expect(call.invocation).toEqual({ command: 'api', help: false })
})

test.each([
  { path: 'repos/search?q=hello%20world&to%6ben=CANARY-forbidden', code: 'FLAG_BLOCKED' },
  { path: 'repos/search?q=hello?world&password=CANARY-forbidden', code: 'FLAG_BLOCKED' },
  { path: 'repos/hello%20world', code: 'INVALID_INPUT' },
  { path: 'repos/100%25', code: 'INVALID_INPUT' },
  { path: 'repos/hello%5Cworld', code: 'INVALID_INPUT' },
  { path: 'repos/%2e%2e/search', code: 'INVALID_INPUT' },
  { path: 'repos/example%2fproject', code: 'INVALID_INPUT' },
  { path: 'repos/search?q=hello#fragment', code: 'INVALID_INPUT' },
])('Gitea metadata validation retains pathname and secret boundaries: $path', ({ path, code }) => {
  expect(() => adapter.validateArgs(['api', path])).toThrow(expect.objectContaining({ code }))
})

test.each([
  ['-R', 'example/project'], ['-Rexample/project'], ['--repo', 'example/project'],
])('Gitea dashboard selectors reach native help: %j', async (...selector) => {
  const args = [...selector, '--help']
  adapter.validateArgs(args)
  const call = await adapter.prepare(args, reference)
  const output = decode(execFileSync(process.execPath, [native, ...call.args.slice(1)], { encoding: 'utf8' }))
  expect(output).toMatchObject({ command: 'gitea-axi dashboard' })
  expect(call.invocation).toEqual({ command: 'home', help: true })
})

test.each([
  { group: 'repo', children: ['repo view', 'repo list', 'repo create', 'repo edit', 'repo fork'] },
  { group: 'org', children: ['org view'] },
  { group: 'issue', children: ['issue download', 'issue list', 'issue view', 'issue upload', 'issue create', 'issue edit', 'issue close', 'issue reopen', 'issue comment', 'issue delete', 'issue pin', 'issue unpin'] },
  { group: 'pr', children: ['pr download', 'pr list', 'pr view', 'pr checks', 'pr diff', 'pr upload', 'pr create', 'pr edit', 'pr close', 'pr reopen', 'pr comment', 'pr update-branch', 'pr merge', 'pr review'] },
  { group: 'release', children: ['release download', 'release list', 'release view', 'release upload', 'release create', 'release edit', 'release delete'] },
  { group: 'run', children: ['run list'] },
  { group: 'secret', children: ['secret list', 'secret set', 'secret delete'] },
  { group: 'variable', children: ['variable list', 'variable set', 'variable delete'] },
  { group: 'label', children: ['label list', 'label create', 'label edit', 'label delete'] },
  { group: 'write', children: ['write reconcile'] },
  { group: 'search', children: ['search issues', 'search prs', 'search repos', 'search commits'] },
])('Gitea $group help retains its group and only admitted children', async ({ group, children }) => {
  const args = [group, '--help']
  adapter.validateArgs(args)
  const call = await adapter.prepare(args, reference)
  const output = execFileSync(process.execPath, [native, ...call.args.slice(1)], { encoding: 'utf8' })
  const command = `artium-axi gitea-axi ${group}`
  expect(call.invocation).toEqual({ command: group, help: true })
  expect(decode(rewriteSuggestions(output, 'gitea-axi', false, call.invocation)))
    .toMatchObject({ command, commands: children, usage: `${command} [flags]`, examples: [`${command} --help`] })
  expect(JSON.parse(rewriteSuggestions(JSON.stringify(decode(output)), 'gitea-axi', false, call.invocation)))
    .toMatchObject({ command, commands: children })
})

test.each([
  ['issue'], ['issue', '--help=false'], ['issue', '--help', '--repo', 'example/project'],
  ['workflow', '--help'], ['-x'], ['-R'], ['-R', 'example/project', '--repo', 'other/project'],
])('Gitea rejects unsupported groups and invalid root flags: %j', (...args) => {
  expect(() => adapter.validateArgs(args)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test.each(['synthetic', '--help'])('Gitea refuses unavailable code search: %s', async argument => {
  const args = ['search', 'code', argument]
  expect(() => adapter.validateArgs(args)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('Gitea root discovery omits unavailable code search', async () => {
  const call = await adapter.prepare(['--help'], reference)
  const output = execFileSync(process.execPath, [native, ...call.args.slice(1)], { encoding: 'utf8' })
  const document = decode(rewriteSuggestions(output, 'gitea-axi', false, call.invocation)) as { commands: string[] }
  expect(document.commands).not.toContain('search code')
  expect(document.commands).toContain('search repos')
})

test.each([
  { watch: '--watch', timeout: '1' }, { watch: '--watch=true', timeout: '50' },
])('Gitea checks watch accepts bounded timeout $timeout', async ({ watch, timeout }) => {
  const args = ['pr', 'checks', '42', '--repo', 'example/project', watch, '--timeout', timeout]
  adapter.validateArgs(args)
  const call = await adapter.prepare(args, reference)
  expect(call.args.slice(1)).toEqual(args)
  expect(call.limits.timeoutMs).toBe(60_000)
})

test.each(['51', '120', '3600', '0', '-1', '1.5', 'NaN', 'Infinity'])('Gitea rejects watch timeouts outside the host budget: %s', async timeout => {
  const args = ['pr', 'checks', '42', '--repo', 'example/project', '--watch', `--timeout=${timeout}`]
  expect(() => adapter.validateArgs(args)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

test('Gitea checks reads without watching retain the host deadline', async () => {
  const args = ['pr', 'checks', '42', '--repo', 'example/project', '--watch=false']
  const call = await adapter.prepare(args, reference)
  expect(call.args.slice(1)).toEqual(args)
  expect(call.limits.timeoutMs).toBe(60_000)
})

test('Gitea checks help publishes the admitted watch timeout in TOON and JSON', async () => {
  const call = await adapter.prepare(['pr', 'checks', '--help'], reference)
  const output = execFileSync(process.execPath, [native, ...call.args.slice(1)], { encoding: 'utf8' })
  const expected = { command: 'artium-axi gitea-axi pr checks', flags: { watch: 'boolean', timeout: 'value (1-50 seconds; requires --watch)' } }
  expect(decode(rewriteSuggestions(output, 'gitea-axi', false, call.invocation))).toMatchObject(expected)
  expect(JSON.parse(rewriteSuggestions(JSON.stringify(decode(output)), 'gitea-axi', false, call.invocation))).toMatchObject(expected)
})
