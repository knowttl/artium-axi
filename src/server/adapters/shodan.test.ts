import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { toolPaths } from '../config.js'
import { createShodanAdapter, shodanProfile } from './shodan.js'

const reference = { id: 'synthetic-credential', tool: 'shodan-axi' as const, revision: 1 }
const previousPath = toolPaths['shodan-axi']
beforeEach(() => { Object.assign(toolPaths, { 'shodan-axi': join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js') }) })
afterEach(() => { Object.assign(toolPaths, { 'shodan-axi': previousPath }) })

test.each([
  ['host', 'search'], ['profile', 'set', 'other', '--env', 'KEY'], ['info', '--profile', 'other'],
  ['info', '--origin=https://example.invalid'], ['account', 'profile', '--config', '/tmp/config'],
  ['host', '192.0.2.1'], ['stream'], ['scan', 'submit', '192.0.2.1'],
  ['alert', 'create', 'synthetic', '192.0.2.1'], ['alert', 'remove', 'synthetic'], ['org', 'info'],
  ['data', 'list'], ['info', '--filename', '/tmp/result'],
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
