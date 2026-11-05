import { execFile } from 'node:child_process'
import { cpSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createShodanAdapter } from '../../src/server/adapters/shodan.js'
import { Audit } from '../../src/server/audit/audit.js'
import { toolPaths } from '../../src/server/config.js'
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
      expect((await cli(['version'], false)).stdout.trim()).toBe('0.1.1')
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
