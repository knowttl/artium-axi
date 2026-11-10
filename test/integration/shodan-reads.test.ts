import { execFile } from 'node:child_process'
import { cpSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { Audit } from '../../src/server/audit/audit.js'
import { healthDefaults, toolPaths } from '../../src/server/config.js'
import { ToolHealth } from '../../src/server/health/health.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SessionStore } from '../../src/cli/session.js'
import { copyClientInput } from '../fixtures/client-inputs.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'
import { withFakeService } from '../fake-service/fixture.js'

test.each([
  { args: ['search', 'port:443', '--allow-operation', 'OP-003', '--query-credit-budget', '1'],
    expected: { total: 1, items: [{ ip_str: '192.0.2.1', port: 443, data: 'synthetic' }] }, path: '/shodan/host/search' },
  { args: ['domain', 'example.test', '--allow-operation', 'OP-040', '--query-credit-budget', '1'],
    expected: { domain: 'example.test', records: [{ type: 'A', value: '192.0.2.1' }] }, path: '/dns/domain/example.test' },
])('credit-spending read reaches the fake service: $args', async ({ args, expected, path }) => {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  await withFakeService(async ({ directory, port, send }) => {
    const bootstrap = join(directory, 'shodan-fake-route.mjs')
    writeFileSync(bootstrap, `import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const request = https.request
https.request = (url, options, callback) => {
  if (url.origin !== 'https://api.shodan.io') throw new Error('Unexpected endpoint')
  return request(new URL(url.pathname + url.search, ${JSON.stringify(`https://localhost:${port}`)}), options, callback)
}
syncBuiltinESMExports()
`)
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const previousPath = toolPaths['shodan-axi']
    Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
    try {
      const adapter = createShodanAdapter({ getCredential: async () => ({ auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }) })
      const call = await adapter.prepare([...args, '--json'], { id: 'synthetic-credential', tool: 'shodan-axi', revision: 1 })
      const result = await runner.run('synthetic-user', call.executable, ['--import', bootstrap, ...call.args], call.environment, call.secrets, { ...call.limits, publicContent: call.publicContent }, {}, call.files)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject(expected)
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([expect.objectContaining({ method: 'GET', path, canaryReceived: true })])
    } finally {
      await runner.shutdown()
      Object.assign(toolPaths, { 'shodan-axi': previousPath })
    }
  })
})
test.each([
  { args: ['host', '192.0.2.1'], path: '/shodan/host/192.0.2.1', expected: { host: { ip_str: '192.0.2.1', ports: [443], data: [] }, banners: [], historyRequested: false } },
  { args: ['scan', 'protocols'], path: '/shodan/protocols', expected: { https: 'HTTPS' } },
  { args: ['scan', 'list'], path: '/shodan/scans', expected: { items: [{ id: 'synthetic-scan', status: 'DONE' }], total: 1, pagination: 'undocumented', complete: true } },
  { args: ['scan', 'status', 'synthetic-scan'], path: '/shodan/scan/synthetic-scan', expected: { id: 'synthetic-scan', status: 'DONE', polling: 'complete' } },
])('packaged read $args uses the managed profile', async ({ args, path, expected }) => {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  await withFakeService(async ({ directory, port, send }) => {
    const executable = join(packageRoot, 'bin/shodan-axi.js')
    const bootstrap = join(directory, 'shodan-fake-route.mjs')
    writeFileSync(bootstrap, `import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const request = https.request
https.request = (url, options, callback) => {
  if (url.origin !== 'https://api.shodan.io') throw new Error('Unexpected endpoint')
  return request(new URL(url.pathname + url.search, ${JSON.stringify(`https://localhost:${port}`)}), options, callback)
}
syncBuiltinESMExports()
`)
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const previousPath = toolPaths['shodan-axi']
    Object.assign(toolPaths, { 'shodan-axi': executable })
    try {
      const adapter = createShodanAdapter({ getCredential: async () => ({ auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }) })
      const call = await adapter.prepare([...args, '--json'], { id: 'synthetic-credential', tool: 'shodan-axi', revision: 1 })
      const result = await runner.run('synthetic-user', call.executable, ['--import', bootstrap, ...call.args], call.environment, call.secrets, { ...call.limits, publicContent: call.publicContent }, {}, call.files)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(expected)
      expect(result.stdout + result.stderr).not.toContain('CANARY-')
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([{ method: 'GET', path, canaryReceived: true, parameters: ['key'] }])
    } finally {
      await runner.shutdown()
      Object.assign(toolPaths, { 'shodan-axi': previousPath })
    }
  })
})

test.each([
  { args: ['scan', 'list'], output: { items: [{ id: 'synthetic-scan', status: 'DONE', api_key: 'CANARY-issued-secret' }], total: 1, pagination: 'undocumented', complete: true } },
  { args: ['scan', 'status', 'synthetic-scan'], output: { id: 'synthetic-scan', status: 'DONE', polling: 'complete', api_key: 'CANARY-issued-secret' } },
  { args: ['data', 'list'], output: { items: [{ name: 'synthetic', description: 'Synthetic', url: 'CANARY-issued-secret' }], count: 1 } },
  { args: ['data', 'list'], output: { items: [{ name: 'synthetic', size: 42 }], count: 1 } },
  { args: ['data', 'list', '--dataset', 'synthetic'], output: { items: [{ name: 'synthetic', size: 42, url: 'CANARY-issued-secret' }], count: 1 } },
  { args: ['data', 'list', '--dataset', 'synthetic'], output: { items: [{ name: 'synthetic', description: 'Synthetic' }], count: 1 } },
  { args: ['data', 'list'], output: { items: [], count: 0, url: 'CANARY-issued-secret' } },
])('output outside the package contract is withheld: $args', async ({ args, output }) => {
  const packageRoot = process.env.SHODAN_AXI_PACKAGE_DIR ?? join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  await withFakeService(async ({ directory }) => {
    const executable = join(directory, 'unexpected-output.mjs')
    writeFileSync(executable, `console.log(${JSON.stringify(JSON.stringify(output))})`)
    const runner = await Runner.create(join(directory, 'calls'))
    const previousPath = toolPaths['shodan-axi']
    Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
    try {
      const adapter = createShodanAdapter({ getCredential: async () => ({ auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }) })
      const call = await adapter.prepare([...args, '--json'], { id: 'synthetic-credential', tool: 'shodan-axi', revision: 1 })
      await expect(runner.run('synthetic-user', call.executable, [executable], call.environment, call.secrets,
        { ...call.limits, publicContent: call.publicContent }, {}, call.files)).rejects.toMatchObject({ code: 'SECRET_IN_OUTPUT' })
    } finally {
      await runner.shutdown()
      Object.assign(toolPaths, { 'shodan-axi': previousPath })
    }
  })
})

test('credential replacement and scheduled health checks do not probe Shodan', async () => {
  await withFakeService(async ({ directory }) => {
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }, 0, 'synthetic-development-user', Date.now())
    db.prepare("UPDATE tools SET enabled = 1 WHERE name = 'shodan-axi'").run()
    const runner = await Runner.create(join(directory, 'calls'))
    const health = new ToolHealth(db, new Audit(db), runner, [createShodanAdapter(new EmbeddedSecretSource(store))], store)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await health.refresh('shodan-axi', true)
      health.start()
      await vi.advanceTimersByTimeAsync(healthDefaults.tickMs * 2)
      expect(health.checking('shodan-axi')).toBe(false)
      expect(db.prepare("SELECT event FROM audit WHERE tool = 'shodan-axi' AND event IN ('run-start', 'health-check')").all()).toEqual([])
    } finally { await health.stop(); vi.useRealTimers(); await runner.shutdown(); db.close() }
  })
})

test('a package inventory mismatch is refused before credential access', async () => {
  const packageRoot = join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  await withFakeService(async ({ directory }) => {
    const previousPath = toolPaths['shodan-axi']
    let credentialReads = 0
    const adapter = createShodanAdapter({ getCredential: async () => {
      credentialReads++
      return { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' }
    } })
    const reference = { id: 'synthetic-credential', tool: 'shodan-axi' as const, revision: 1 }
    try {
      Object.assign(toolPaths, { 'shodan-axi': join(packageRoot, 'bin/shodan-axi.js') })
      await adapter.prepare(['info'], reference)
      expect(credentialReads).toBe(1)
      const altered = join(directory, 'altered-package')
      cpSync(packageRoot, altered, { recursive: true, dereference: true })
      writeFileSync(join(altered, 'command-inventory.json'), '{}')
      Object.assign(toolPaths, { 'shodan-axi': join(altered, 'bin/shodan-axi.js') })
      await expect(adapter.prepare(['info'], reference)).rejects.toMatchObject({ code: 'SPAWN_FAILED' })
      expect(credentialReads).toBe(1)
    } finally { Object.assign(toolPaths, { 'shodan-axi': previousPath }) }
  })
})

test('packaged account reads use the managed profile through the real runner', async () => {
  const packageRoot = join(process.cwd(), 'tools/node_modules/@knowttl/shodan-axi')
  await withFakeService(async ({ directory, port, send }) => {
    const bootstrap = join(directory, 'shodan-fake-route.mjs')
    const executable = join(packageRoot, 'bin/shodan-axi.js')
    writeFileSync(bootstrap, `import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const request = https.request
https.request = (url, options, callback) => {
  if (url.origin !== 'https://api.shodan.io') throw new Error('Unexpected endpoint')
  url = new URL(url.pathname + url.search, ${JSON.stringify(`https://localhost:${port}`)})
  return request(url, options, callback)
}
syncBuiltinESMExports()
`)
    const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const db = openStore(join(directory, 'artium.db'), provider)
    await seedToolUser(db)
    const store = createCredentialStore(db, provider)
    store.replaceCredential('shodan-axi', { auth: 'api-key', origin: 'https://api.shodan.io', apiKey: 'CANARY-shodan-key' },
      0, 'synthetic-development-user', Date.now())
    db.prepare("UPDATE tools SET enabled = 1 WHERE name = 'shodan-axi'").run()
    const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
    const previousPath = toolPaths['shodan-axi']
    Object.assign(toolPaths, { 'shodan-axi': executable })
    const source = new EmbeddedSecretSource(store)
    let credentialReads = 0
    const adapter = createShodanAdapter({ getCredential: reference => {
        credentialReads++
        return source.getCredential(reference)
      } })
    const prepare = adapter.prepare.bind(adapter)
    adapter.prepare = async (...input) => {
      const call = await prepare(...input)
      return { ...call, args: ['--import', bootstrap, ...call.args] }
    }
    const app = createApp({ db, runner, audit: new Audit(db), credentialStore: store, environment: {},
      resolver: new SharedIdentityResolver(store), adapters: [adapter] })
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 })
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      for (const args of [['host', 'search'], ['profile', 'set', 'other', '--env', 'KEY'],
        ['info', '--profile', 'other'], ['info', '--origin=https://example.invalid']]) {
        const response = await app.inject({ method: 'POST', url: '/v1/tools/shodan-axi/run',
          headers: { authorization: `Bearer ${token}` }, payload: { args } })
        expect(response.json().error.code).toMatch(/^(INVALID_INPUT|FLAG_BLOCKED)$/)
      }
      expect(credentialReads).toBe(0)
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([])
      const bundle = copyClientInput('bundle', join(directory, 'client.mjs'))
      new SessionStore(url, join(directory, 'artium-axi/session.json')).write({ status: 'authenticated', accessToken: token,
        refreshToken: 'CANARY-refresh', accessExpiresAt: Date.now() + 3_600_000, familyExpiresAt: Date.now() + 43_200_000 })
      const cli = (args: string[], json = true) => promisify(execFile)(process.execPath, [bundle, 'shodan-axi', ...args, ...(json ? ['--json'] : [])], { timeout: 10_000,
        env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, ARTIUM_AXI_URL: url,
          ARTIUM_AXI_TEST_HTTP: '1', SHODAN_AXI_API_KEY: 'CANARY-conflicting-key' } })
      const info = await cli(['info'])
      const account = await cli(['account', 'profile'])
      expect((await cli(['version'], false)).stdout.trim()).toBe('0.1.2')
      expect(JSON.parse(info.stdout)).toMatchObject({ plan: 'synthetic', query_credits: 20, scan_credits: 98 })
      expect(JSON.parse(account.stdout)).toMatchObject({ member: false, credits: 7 })
      expect(info.stdout + info.stderr + account.stdout + account.stderr).not.toContain('CANARY-')
      expect(JSON.parse(await send('/__evidence')).requests).toEqual([
        { method: 'GET', path: '/api-info', canaryReceived: true, parameters: ['key'] },
        { method: 'GET', path: '/account/profile', canaryReceived: true, parameters: ['key'] },
      ])
      expect(JSON.stringify(db.prepare('SELECT * FROM audit').all())).not.toContain('CANARY-')
      expect(readdirSync(join(directory, 'calls'))).toEqual([])
    } finally {
      await app.close()
      db.close()
      Object.assign(toolPaths, { 'shodan-axi': previousPath })
    }
  })
})
