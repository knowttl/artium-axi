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
  { origin: 'https://forge.example', tokenOrigin: 'https://forge.example', writes: { allowWrites: true, operations: ['issue.create'] } },
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
  { group: 'repo', children: ['repo view', 'repo list'] },
  { group: 'org', children: ['org view'] },
  { group: 'issue', children: ['issue list', 'issue view'] },
  { group: 'pr', children: ['pr list', 'pr view', 'pr checks', 'pr diff'] },
  { group: 'release', children: ['release list', 'release view'] },
  { group: 'run', children: ['run list'] },
  { group: 'secret', children: ['secret list'] },
  { group: 'variable', children: ['variable list'] },
  { group: 'label', children: ['label list'] },
  { group: 'search', children: ['search issues', 'search prs', 'search repos', 'search commits', 'search code'] },
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
