import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { toolPaths } from '../config.js'
import { inspectShodanStream } from './shodan-stream.js'

const previous = toolPaths['shodan-axi']
const base = { operation: 'OP-047', selector: { flag: '--asn', value: 'AS64496' },
  bounds: { limit: 10, maxBytes: 4096, timeout: 10000, idleTimeout: 5000 }, limits: {}, acceptUnknownCost: true as const }

beforeEach(() => {
  const root = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  Object.assign(toolPaths, { 'shodan-axi': join(root, 'bin/shodan-axi.js') })
})
afterEach(() => { Object.assign(toolPaths, { 'shodan-axi': previous }) })

test('the packaged planner accepts the selected stream operation', async () => {
  await expect(inspectShodanStream(base)).resolves.toContain('--asn')
})

test.each([
  { ...base, operation: 'OP-048' },
  { ...base, selector: { flag: '--asn', value: 'invalid' } },
  { ...base, selector: { flag: '--config', value: '/tmp/config' } },
])('selector and operation must match the packaged planner', async input => {
  await expect(inspectShodanStream(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
