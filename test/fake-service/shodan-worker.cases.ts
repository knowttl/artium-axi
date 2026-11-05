import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { inspectShodanStream } from '../../src/server/adapters/shodan-stream.js'
import { shodanProfile } from '../../src/server/adapters/shodan.js'
import { toolPaths } from '../../src/server/config.js'
import { shodanNativePreview } from '../../src/server/shodan-preview.js'
import { ShodanWorker } from '../../src/server/shodan-worker.js'
import { withFakeService } from './fixture.js'

test('packaged stream worker receives fake vendor events and cleans its private profile on stop', async () => {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR
  if (!packageRoot) throw new Error('SHODAN_AXI_PACKAGE_DIR must name the installed package')
  await withFakeService(async ({ directory, send }) => {
    const previous = toolPaths['shodan-axi'], privateDir = join(directory, 'worker')
    Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
    const input = { operation: 'OP-046', selector: {}, bounds: { limit: 10, maxBytes: 4096, timeout: 10000, idleTimeout: 10000 },
      limits: {}, acceptUnknownCost: true as const }
    const profile = () => shodanProfile.prepare('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, undefined, false)
    const controller = new AbortController(), ca = readFileSync(join(directory, 'ca.crt'), 'utf8')
    const events: unknown[] = [], summaries: unknown[] = []
    let received!: () => void
    const event = new Promise<void>(resolve => { received = resolve })
    try {
      const args = await inspectShodanStream(input)
      const confirmation = await shodanNativePreview(privateDir, args, input.operation, input.bounds, profile(), controller.signal, () => {}, ca)
      const worker = new ShodanWorker({ directory: privateDir, input, confirmation, profile: profile(), signal: controller.signal,
        configuredCaPem: ca, authorize: () => {}, onReady: () => {}, onLoss: () => {}, onClosed: summary => summaries.push(summary),
        onEvent: value => { events.push(value); received() } })
      const running = worker.start()
      await event
      await worker.stop()
      await running
      expect(events).toMatchObject([{ ip_str: '192.0.2.1', port: 443 }])
      expect(JSON.stringify(events)).not.toContain('CANARY-')
      expect(summaries).toMatchObject([{ stopReason: 'cancelled' }])
      expect(existsSync(privateDir)).toBe(false)
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([
        { method: 'GET', path: '/shodan/banners', canaryReceived: true, parameters: ['key', 't', 'debug'] },
      ])
    } finally { Object.assign(toolPaths, { 'shodan-axi': previous }) }
  }, undefined, { port: 443, hosts: ['localhost', 'api.shodan.io', 'stream.shodan.io'] })
}, 120000)
