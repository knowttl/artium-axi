import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { copyClientInput } from '../../test/fixtures/client-inputs.js'
import { SessionStore } from './session.js'

test('radar consumes every retained page before saving its output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artium-radar-'))
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url?.endsWith('/read')) {
      const continuation = JSON.parse(body).continuation
      response.end(JSON.stringify({ items: [{ sequence: continuation ? 2 : 1,
        value: { location: continuation ? { latitude: -10, longitude: 20 } : { latitude: 10, longitude: -20 } } }],
      lost: [], upstreamLoss: {}, continuation: continuation ? 'second' : 'first', cleaned: true, hasMore: !continuation }))
    } else response.end('{}')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: 'CANARY-token',
      refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 7200000 })
    const bundle = copyClientInput('bundle', join(directory, 'client.mjs')), output = join(directory, 'radar.json')
    await promisify(execFile)(process.execPath, [bundle, 'shodan-axi', 'radar', '--session', '00000000-0000-4000-8000-000000000001',
      '--max-events', '10', '--output', output], { env: { PATH: process.env.PATH, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ events: 2, plottedPoints: 2, ignoredPoints: 0 })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
