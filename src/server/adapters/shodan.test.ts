import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { toolPaths } from '../config.js'
import { createShodanAdapter, shodanProfile } from './shodan.js'
import { delegatedCommands, resolveDelegatedCommand } from '../auth/delegations.js'
import { execFileSync } from 'node:child_process'
import { decode } from '@toon-format/toon'

const reference = { id: 'synthetic-credential', tool: 'shodan-axi' as const, revision: 1 }
const previousPath = toolPaths['shodan-axi']
beforeEach(() => { Object.assign(toolPaths, { 'shodan-axi': join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js') }) })
afterEach(() => { Object.assign(toolPaths, { 'shodan-axi': previousPath }) })

test('version supports exact delegation and packaged help (r2)', async () => {
  const adapter = createShodanAdapter({ getCredential: async () => ({ auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }) })
  expect(resolveDelegatedCommand('version', adapter)).toBe('version')
  expect(delegatedCommands(JSON.stringify({ tools: [{ tool: 'shodan-axi', commands: ['version'] }] }), true, adapter)).toEqual(['version'])
  expect(adapter.classify(['version', '--help'])).toEqual({ command: 'version', effect: 'read' })
  const call = await adapter.prepare(['version', '--help'], reference)
  expect(decode(execFileSync(call.executable, call.args, { encoding: 'utf8' }))).toEqual({
    command: 'version', help: 'version - print the packaged version',
  })
  expect(execFileSync(call.executable, [toolPaths['shodan-axi'], 'version'], { encoding: 'utf8' })).toBe('0.1.1\n')
})

test('tool-wide delegation discovers only the minimal account commands', () => {
  const adapter = createShodanAdapter({ getCredential: async () => { throw new Error('credential accessed') } })
  expect(delegatedCommands(JSON.stringify({ tools: [{ tool: 'shodan-axi' }] }), true, adapter))
    .toEqual(['account profile', 'info', 'version'])
  expect(() => resolveDelegatedCommand('doctor', adapter)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})

test.each([
  ['host', 'search'], ['profile', 'set', 'other', '--env', 'KEY'], ['info', '--profile', 'other'],
  ['info', '--origin=https://example.invalid'], ['account', 'profile', '--config', '/tmp/config'],
  ['host', '192.0.2.1'], ['stream'], ['scan', 'submit', '192.0.2.1'],
  ['alert', 'create', 'synthetic', '192.0.2.1'], ['alert', 'remove', 'synthetic'], ['org', 'info'],
  ['data', 'list'], ['info', '--filename', '/tmp/result'],
  ['doctor'], ['doctor', '--help'], ['doctor', '--json'],
])('disallowed arguments %s are refused before reading the credential', async (...args) => {
  const adapter = createShodanAdapter({ getCredential: async () => { throw new Error('credential accessed') } })
  await expect(adapter.prepare(args, reference)).rejects.toMatchObject({ code: expect.stringMatching(/^(INVALID_INPUT|FLAG_BLOCKED)$/) })
})

test('only the selected API key is written to an isolated profile', async () => {
  const adapter = createShodanAdapter({ getCredential: async () => ({ auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }) })
  const call = await adapter.prepare(['account', 'profile'], reference)
  expect(call.secrets).toEqual(['CANARY-shodan-key'])
  expect(call.environment.ARTIUM_SECRET_0).toBe('CANARY-shodan-key')
  expect(JSON.parse(String(call.files[0].content))).toEqual({ version: 1, defaultProfile: 'artium', profiles: {
    artium: { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: { env: 'ARTIUM_SECRET_0' } },
  } })
})

test.each([
  { auth: 'none', origin: 'https://api.shodan.io', apiKey: 'key' },
  { auth: 'api-key', origin: 'https://example.invalid', apiKey: 'key' },
  { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'key', streamOrigin: 'https://example.invalid' },
])('host credential policy rejects unapproved authentication and origins', credential => {
  expect(shodanProfile.credentialSchema.safeParse(credential).success).toBe(false)
})
