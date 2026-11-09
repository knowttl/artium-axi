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

const policy = { sessions: { grants: { 'synthetic-development-user': ['OP-046'] }, perUser: 2, perCredential: 2, total: 2,
  sessionEvents: 10, totalEvents: 200, sessionBytes: 4096, totalBytes: 81920, retentionSeconds: 60, leaseSeconds: 60 },
scans: { grants: { 'synthetic-development-user': ['OP-009'] }, maxScanCredits: 10, maxRequests: 10 } }

test.each([
  { name: 'idle timeout', limit: '10', idleTimeout: '5000', fault: '/__shodan/scan-drop?enabled=false', code: 0,
    result: { status: 'completed', scanId: 'synthetic-scan', stream: { summary: { stopReason: 'idle-timeout' } }, cleanup: 'completed' } },
  { name: 'requested deadline', limit: '10', idleTimeout: '10000', waitSeconds: '3', fault: '/__shodan/scan-drop?enabled=false', code: 0,
    result: { status: 'completed', scanId: 'synthetic-scan', cleanup: 'completed' } },
  { name: 'event limit during submission', limit: '2', idleTimeout: '10000', fault: '/__shodan/scan-wait-stream', code: 0,
    result: { status: 'completed', scanId: 'synthetic-scan',
      events: [expect.objectContaining({ port: 443 }), expect.objectContaining({ port: 80 })] } },
  { name: 'lost scan response', limit: '10', idleTimeout: '5000', fault: '/__shodan/scan-drop', code: 1,
    result: { status: 'partial', cleanup: 'completed' } },
  { name: 'stream failure', limit: '10', idleTimeout: '5000', fault: '/__shodan/stream-fail', code: 1,
    result: { status: 'partial', scanId: 'synthetic-scan', cleanup: 'completed' } },
  { name: 'upstream loss', limit: '10', idleTimeout: '5000', fault: '/__shodan/stream-loss?count=2', code: 1,
    result: { status: 'partial', scanId: 'synthetic-scan', upstreamLoss: { 'upstream-discarded': 2 }, cleanup: 'completed' } },
])('scan collection reports $name', async ({ limit, idleTimeout, waitSeconds = '10', fault, code, result }) => {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR
  if (!packageRoot) throw new Error('SHODAN_AXI_PACKAGE_DIR must name the installed package')
  await withFakeService(async ({ directory, send }) => {
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
    const adapter = createShodanAdapter(source)
    const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
      resolver: new SharedIdentityResolver(store), adapters: [adapter] })
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
      new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: token,
        refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
      const scanEnv = { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' }
      const scan = async () => {
        const scanArgs = ['shodan-axi', 'scan', 'submit', '192.0.2.1', '--wait', waitSeconds, '--limit', limit, '--max-bytes', '4096',
          '--idle-timeout', idleTimeout, '--scan-credit-budget', '1', '--max-requests', '1',
          '--allow-operation', 'OP-009,OP-046', '--accept-unknown-cost', '--json']
        const preview = await promisify(execFile)(process.execPath, [bundle, ...scanArgs], { timeout: 10000, env: scanEnv })
        return await new Promise<{ code: number | string | null, stdout: string }>(resolve => {
          execFile(process.execPath, [bundle, ...scanArgs, '--execute', '--confirm', JSON.parse(preview.stdout).confirm],
            { timeout: 60000, env: scanEnv }, (error, stdout) => resolve({ code: error ? error.code ?? error.signal ?? 'failed' : 0, stdout }))
        })
      }
      await send('/__shodan/stream-loss?count=0')
      await send(fault)
      const collected = await scan()
      expect(collected.code, collected.stdout).toBe(code)
      expect(JSON.parse(collected.stdout)).toMatchObject(result)
      const rows = db.prepare("SELECT event, credential_id, instance FROM audit WHERE tool = 'shodan-axi' AND event IN ('run-start', 'run-terminal') ORDER BY id").all()
      const credentialId = store.findCredential('shodan-axi')!.id
      expect(rows).toEqual(expect.arrayContaining([
        { event: 'run-start', credential_id: credentialId, instance: 'default' },
        { event: 'run-terminal', credential_id: credentialId, instance: 'default' },
      ]))
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit WHERE tool = 'shodan-axi' AND event IN ('run-start', 'run-terminal') AND (credential_id IS NOT ? OR instance IS NOT 'default')").get(credentialId)).toEqual({ count: 0 })
    } finally {
      await app.close(); db.close()
      Object.assign(toolPaths, { 'shodan-axi': previousPath })
      Object.assign(healthDefaults, { tickMs: previousTick })
    }
  }, undefined, { port: 443, hosts: ['localhost', 'api.shodan.io', 'stream.shodan.io'] })
}, 240000)
