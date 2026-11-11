import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { Audit } from '../../src/server/audit/audit.js'
import { toolPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'
import { SessionStore } from '../../src/cli/session.js'
import { copyClientInput } from '../fixtures/client-inputs.js'

test('granted stream preview validates the native plan without starting a session', async () => {
  await withFakeService(async ({ directory, send }) => {
    const previous = toolPaths['shodan-axi']
    Object.assign(toolPaths, { 'shodan-axi': join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi/bin/shodan-axi.js') })
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, 0, 'synthetic-development-user', Date.now())
    const settings = { sessions: { grants: { 'synthetic-development-user': ['OP-047'] }, perUser: 1, perCredential: 1, total: 1,
      sessionEvents: 10, totalEvents: 10, sessionBytes: 4096, totalBytes: 4096, retentionSeconds: 60, leaseSeconds: 60 } }
    db.prepare("UPDATE tools SET enabled=1, native_settings=? WHERE name='shodan-axi'").run(JSON.stringify(settings))
    const runner = await Runner.create(join(directory, 'calls'))
    const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
      resolver: new SharedIdentityResolver(store, db), adapters: [createShodanAdapter(new EmbeddedSecretSource(store))] })
    try {
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      const headers = { authorization: `Bearer ${token}` }
      const payload = { operation: 'OP-047', selector: { flag: '--asn', value: 'AS64496' },
        bounds: { limit: 10, maxBytes: 4096, timeout: 10000, idleTimeout: 5000 }, limits: {}, acceptUnknownCost: true }
      const response = await app.inject({ method: 'POST', url: '/v1/tools/shodan-axi/sessions/preview', headers, payload })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ status: 'preview', operation: 'OP-047', selector: payload.selector, cost: 'unknown' })
      expect(response.body).not.toContain('CANARY-')
      const denied = await app.inject({ method: 'POST', url: '/v1/tools/shodan-axi/sessions/preview', headers,
        payload: { ...payload, operation: 'OP-046', selector: {} } })
      expect(denied.json().error.code).toBe('TOOL_NOT_GRANTED')
      expect((await app.inject({ method: 'POST', url: '/v1/tools/shodan-axi/sessions/start', headers, payload })).statusCode).toBe(404)
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
      new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: token,
        refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3600000, familyExpiresAt: Date.now() + 3600000 })
      const result = await promisify(execFile)(process.execPath, [bundle, 'shodan-axi', 'stream', 'session', 'preview', '--operation', 'OP-047',
        '--selector', '--asn', '--value', 'AS64496', '--limit', '10', '--max-bytes', '4096', '--timeout', '10000', '--idle-timeout', '5000',
        '--accept-unknown-cost', '--json'], { timeout: 10000, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory,
        ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'preview', operation: 'OP-047', selector: payload.selector })
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
    } finally { await app.close(); db.close(); Object.assign(toolPaths, { 'shodan-axi': previous }) }
  })
})
