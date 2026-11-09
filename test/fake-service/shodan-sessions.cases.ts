import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { healthDefaults, toolPaths } from '../../src/server/config.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { copyClientInput } from '../fixtures/client-inputs.js'
import { withFakeService } from '../fake-service/fixture.js'
import { SessionStore } from '../../src/cli/session.js'

const input = { operation: 'OP-046', selector: {}, bounds: { limit: 10, maxBytes: 4096, timeout: 8000, idleTimeout: 10000 },
  limits: {}, acceptUnknownCost: true }
const policy = { sessions: { grants: { 'synthetic-development-user': ['OP-046'] }, perUser: 2, perCredential: 2, total: 2,
  sessionEvents: 10, totalEvents: 200, sessionBytes: 4096, totalBytes: 81920, retentionSeconds: 60, leaseSeconds: 60 } }


test('hosted stream preview, read and stop use the real packaged worker with private cleanup', async () => {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR
  if (!packageRoot) throw new Error('SHODAN_AXI_PACKAGE_DIR must name the installed package')
  await withFakeService(async ({ directory, send }) => {
    await send('/__shodan/stream-loss?count=0')
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' },
      0, 'synthetic-development-user', Date.now())
    db.prepare("UPDATE tools SET enabled=1,native_settings=? WHERE name='shodan-axi'").run(JSON.stringify(policy))
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const previousPath = toolPaths['shodan-axi'], previousTick = healthDefaults.tickMs
    Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
    Object.assign(healthDefaults, { tickMs: 2_147_483_647 })
    const source = new EmbeddedSecretSource(store)
    let credentialReads = 0
    const adapter = createShodanAdapter({ getCredential: ref => { credentialReads++; return source.getCredential(ref) } })
    const abandoned = join(directory, 'tool-logs/shodan-axi/sessions/session-abandoned')
    mkdirSync(abandoned, { recursive: true })
    writeFileSync(join(abandoned, 'profile'), 'CANARY-abandoned')
    const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
      resolver: new SharedIdentityResolver(store), adapters: [adapter] })
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      expect(existsSync(abandoned)).toBe(false)
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      const other = issueTestAccessToken(db, 'synthetic-development-user')
      const headers = { authorization: `Bearer ${token}` }, prefix = '/v1/tools/shodan-axi/sessions'
      const denied = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers,
        payload: { ...input, operation: 'OP-047', selector: { flag: '--asn', value: 'AS64496' } } })
      expect(denied.statusCode).toBe(403)
      expect(credentialReads).toBe(0)
      const stale = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
      const staleConfirm = stale.json().confirm
      const changed = await app.inject({ method: 'POST', url: `${prefix}/start`, headers,
        payload: { ...input, bounds: { ...input.bounds, limit: 9 }, confirm: staleConfirm } })
      expect(changed.statusCode).toBe(400)
      const replay = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...input, confirm: staleConfirm } })
      expect(replay.statusCode).toBe(404)
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      const preview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
      expect(preview.statusCode).toBe(200)
      const confirm = preview.json().confirm
      expect(credentialReads).toBe(2)
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
      new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: token,
        refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
      const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
        [bundle, 'shodan-axi', 'stream', 'session', ...args, '--json'],
        { timeout: 30000, env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' } })).stdout)
      const startedAt = performance.now()
      const started = await cli('start', '--operation', 'OP-046', '--limit', '10', '--max-bytes', '4096',
        '--timeout', '8000', '--idle-timeout', '10000', '--accept-unknown-cost', '--confirm', confirm)
      const id = started.id
      expect(await cli('status', id)).toMatchObject({ id, operation: 'OP-046' })
      const forbidden = await app.inject({ method: 'GET', url: `${prefix}/${id}`, headers: { authorization: `Bearer ${other}` } })
      expect(forbidden.statusCode).toBe(404)
      const result = await cli('read', id, '--limit', '10', '--wait')
      expect(result.items).toMatchObject([{ sequence: 1, value: { ip_str: '192.0.2.1', port: 443 } }])
      expect(JSON.stringify(result)).not.toContain('CANARY-')
      const extension = await cli('extend', id, '--seconds', '10')
      const extended = await cli('extend', id, '--confirm', extension.confirm)
      expect(extended).toMatchObject({ state: 'running', expiresAt: started.expiresAt + 10000 })
      const continued = await cli('read', id, '--continuation', result.continuation, '--limit', '1', '--wait')
      expect(continued).toMatchObject({ state: 'running', items: [{ value: { ip_str: '192.0.2.1' } }] })
      const later = await cli('read', id, '--continuation', continued.continuation, '--limit', '1', '--wait')
      expect(later).toMatchObject({ state: 'running', items: [{ value: { ip_str: '192.0.2.2' } }] })
      expect(performance.now() - startedAt).toBeGreaterThan(input.bounds.timeout)
      const ended = await app.inject({ method: 'GET', url: `${prefix}/${id}?waitMs=20000`, headers })
      expect(ended.json()).toMatchObject({ cleaned: true, expiresAt: extended.expiresAt })
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(input.bounds.timeout + 10000)
      expect(performance.now() - startedAt).toBeLessThan(input.bounds.timeout + 12000)
      const forged = await app.inject({ method: 'POST', url: `${prefix}/${id}/read`, headers, payload: { continuation: 'forged' } })
      expect(forged.statusCode).toBe(400)
      expect(await cli('stop', id)).toMatchObject({ cleaned: true })
      expect(db.prepare("SELECT event, credential_id, instance FROM audit WHERE request_id = ? AND event IN ('run-start', 'run-terminal') ORDER BY id").all(id))
        .toEqual([{ event: 'run-start', credential_id: store.findCredential('shodan-axi')!.id, instance: 'default' },
          { event: 'run-terminal', credential_id: store.findCredential('shodan-axi')!.id, instance: 'default' }])
      expect(existsSync(join(directory, 'tool-logs/shodan-axi/sessions', `session-${id}`))).toBe(false)
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([
        { method: 'GET', path: '/shodan/banners', canaryReceived: true, parameters: ['key', 't', 'debug'] },
      ])
      const planOne = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
      const sessionOne = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...input, confirm: planOne.json().confirm } })
      const planTwo = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
      const sessionTwo = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...input, confirm: planTwo.json().confirm } })
      expect([sessionOne.statusCode, sessionTwo.statusCode]).toEqual([200, 200])
      const full = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
      expect(full.statusCode).toBe(429)
      await app.inject({ method: 'DELETE', url: `${prefix}/${sessionOne.json().id}`, headers })
      await app.inject({ method: 'DELETE', url: `${prefix}/${sessionTwo.json().id}`, headers })
      const expiry = { ...input, bounds: { ...input.bounds, timeout: 1000 }, limits: { leaseSeconds: 2 } }
      const expiryPreview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: expiry })
      const expiryStart = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...expiry, confirm: expiryPreview.json().confirm } })
      const expired = await app.inject({ method: 'GET', url: `${prefix}/${expiryStart.json().id}?waitMs=5000`, headers })
      expect(expired.json()).toMatchObject({ cleaned: true })
      expect(existsSync(join(directory, 'tool-logs/shodan-axi/sessions', `session-${expiryStart.json().id}`))).toBe(false)
      const nextPreview = await app.inject({ method: 'POST', url: `${prefix}/preview`, headers, payload: input })
      const next = await app.inject({ method: 'POST', url: `${prefix}/start`, headers, payload: { ...input, confirm: nextPreview.json().confirm } })
      const nextId = next.json().id
      const nextRead = await app.inject({ method: 'POST', url: `${prefix}/${nextId}/read`, headers, payload: { limit: 10, waitMs: 10000 } })
      expect(nextRead.json().items).toMatchObject([{ sequence: 1, value: { ip_str: '192.0.2.1' } }])
      store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-replacement' },
        1, 'synthetic-development-user', Date.now())
      await app.inject({ method: 'GET', url: `${prefix}/${nextId}`, headers })
      const removed = await app.inject({ method: 'GET', url: `${prefix}/${nextId}`, headers })
      expect(removed.statusCode).toBe(404)
      expect(existsSync(join(directory, 'tool-logs/shodan-axi/sessions', `session-${nextId}`))).toBe(false)
    } finally {
      await app.close(); db.close()
      Object.assign(toolPaths, { 'shodan-axi': previousPath })
      Object.assign(healthDefaults, { tickMs: previousTick })
    }
  }, undefined, { port: 443, hosts: ['localhost', 'api.shodan.io', 'stream.shodan.io'] })
}, 120000)
