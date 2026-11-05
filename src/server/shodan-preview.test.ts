import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { inspectShodanStream } from './adapters/shodan-stream.js'
import { shodanProfile } from './adapters/shodan.js'
import { toolPaths } from './config.js'
import { runShodanNative, shodanNativePreview } from './shodan-preview.js'

let root: string
const previous = toolPaths['shodan-axi']
const input = { operation: 'OP-047', selector: { flag: '--asn', value: 'AS64496' },
  bounds: { limit: 10, maxBytes: 4096, timeout: 10000, idleTimeout: 5000 }, limits: {}, acceptUnknownCost: true as const }
beforeEach(() => {
  const pkg = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  root = mkdtempSync(join(tmpdir(), 'shodan-preview-'))
  Object.assign(toolPaths, { 'shodan-axi': join(pkg, 'bin/shodan-axi.js') })
})
afterEach(() => { Object.assign(toolPaths, { 'shodan-axi': previous }); delete process.env.NODE_EXTRA_CA_CERTS; delete process.env.SSL_CERT_FILE; rmSync(root, { recursive: true, force: true }) })

test('native preview retains only its private plan and removes the credential workspace', async () => {
  const args = await inspectShodanStream(input)
  const profile = shodanProfile.prepare('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, undefined, true)
  const token = await shodanNativePreview(root, args, input.operation, input.bounds, profile, new AbortController().signal, () => {})
  expect(readdirSync(join(root, 'state/shodan-axi/plans'))).toContain(`${token}.json`)
  expect(existsSync(join(root, 'preview'))).toBe(false)
  expect(profile.secrets).toEqual([''])
})

test.each([
  { configuredCaPem: undefined, expected: 'no-configured-ca' },
  { configuredCaPem: 'synthetic-configured-ca', expected: 'synthetic-configured-ca' },
])('native child uses only its configured CA bundle', async ({ configuredCaPem, expected }) => {
  const executable = join(root, 'native.mjs')
  writeFileSync(executable, `import { readFileSync } from 'node:fs'; console.log(JSON.stringify({ ca: process.env.NODE_EXTRA_CA_CERTS ? readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') : 'no-configured-ca', ambient: process.env.SSL_CERT_FILE ?? null }))`)
  Object.assign(toolPaths, { 'shodan-axi': executable })
  process.env.NODE_EXTRA_CA_CERTS = join(root, 'ambient-ca')
  process.env.SSL_CERT_FILE = join(root, 'ambient-ca')
  const profile = shodanProfile.prepare('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, undefined, true)
  const result = await runShodanNative(root, [], profile, new AbortController().signal, () => {}, configuredCaPem)
  expect(result).toEqual({ ca: expected, ambient: null })
  expect(existsSync(join(root, 'preview'))).toBe(false)
})
