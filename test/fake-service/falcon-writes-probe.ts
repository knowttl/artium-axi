import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withFakeService } from './fixture.js'
import { falconTestHosts } from './falcon-loopback-guard.js'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { Runner } from '../../src/server/runner/runner.js'
import { loadTrustedCa } from '../../src/server/trusted-ca.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'

let held = () => {}
assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, send }) => {
  const runner = await Runner.create(join(directory, 'calls'), loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: join(directory, 'ca.crt') }))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'falcon.db'), provider)
  const initial = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'falcon-axi'")
  initial.replaceCredential('falcon-axi', { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: `https://${falconTestHosts[0]}`,
    rtr: { enabled: false, commands: ['ps'] } }, 0, 'synthetic-development-user', Date.now())
  const store = createCredentialStore(db, provider)
  const adapter = createFalconAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const app = createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const invoke = (args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/falcon-axi/run', headers, payload: { args } })
    const success = async (args: string[]) => {
      const response = await invoke(args)
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().exitCode, 0, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_/)
      return response.json().stdout as string
    }
    const reauth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    assert.equal(reauth.statusCode, 200, reauth.body)
    const proof = { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }
    const detail = () => app.inject({ url: '/v1/admin/tools/falcon-axi', headers: proof })
    const policy = async (operations: string[]) => {
      const current = await detail()
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/falcon-axi/write-access', headers: proof,
        payload: { enabled: true, operations, expectedRevision: current.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const evidence = async () => JSON.parse(await send('/__evidence')) as { mutations: number, requests: Array<{ method: string, path: string, canaryReceived: boolean }> }
    const device = 'a'.repeat(32)
    const rtr = ['rtr', 'run', device, '--command', 'ps']
    assert.match(await success(rtr), /preview:/)
    assert.equal((await evidence()).mutations, 0)
    assert.equal((await invoke(['search', 'start', '--query', 'synthetic'])).statusCode, 400)
    await policy(['malquery search'])
    assert.match(await success(['malquery', 'search', '--string', 'synthetic']), /11111111-1111-4111-8111-111111111111/)
    assert.match(await success(['malquery', 'search', '--string', 'synthetic', '--fuzzy']), /synthetic-family/)
    const beforeDenied = (await evidence()).mutations
    assert.equal((await invoke(['search', 'start', '--query', 'synthetic'])).statusCode, 400)
    assert.equal((await evidence()).mutations, beforeDenied)
    await policy(['search start'])
    assert.match(await success(['search', 'start', '--query', 'synthetic']), /synthetic-search/)
    assert.match(await success(['search', 'status', 'synthetic-search']), /done/)
    assert.equal((await invoke(['search', 'stop', 'synthetic-search'])).statusCode, 400)
    await policy(['search stop'])
    assert.match(await success(['search', 'stop', 'synthetic-search']), /synthetic-search/)
    for (const command of [['host', 'usb'], ['identity', 'activity']]) {
      await policy([command.join(' ')])
      const before = (await evidence()).mutations
      await success([...command, device])
      assert.equal((await evidence()).mutations, before + 1)
    }
    await policy(['search start'])
    const beforeLost = (await evidence()).mutations
    await send('/__falcon/drop-search')
    const lost = await invoke(['search', 'start', '--query', 'synthetic'])
    assert.notEqual(lost.json().exitCode, 0, lost.body)
    assert.equal((await evidence()).mutations, beforeLost + 1, 'Lost search response must not replay creation')
    await policy(['rtr run'])
    const execute = [...rtr, '--execute', '--confirm', `${device}:ps`]
    const beforeRtr = (await evidence()).mutations
    const optIn = await invoke(execute)
    assert.notEqual(optIn.json().exitCode, 0, optIn.body)
    assert.match(optIn.json().stdout, /READ_ONLY_VIOLATION/)
    assert.equal((await evidence()).mutations, beforeRtr)
    const current = await detail()
    const opted = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/falcon-axi', headers: proof,
      payload: { expectedRevision: current.json().revision, nativeSettings: { ...current.json().nativeSettings, rtr: { enabled: true, commands: ['ps'] } } } })
    assert.equal(opted.statusCode, 200, opted.body)
    assert.match(await success(execute), /synthetic process list/)
    assert.equal((await evidence()).mutations, beforeRtr + 3)
    const narrowed = await invoke(['rtr', 'run', device, '--command', 'users', '--execute', '--confirm', `${device}:users`])
    assert.notEqual(narrowed.json().exitCode, 0, narrowed.body)
    assert.equal((await evidence()).mutations, beforeRtr + 3)
    await send('/__falcon/hold-rtr?enabled=true')
    const controller = new AbortController()
    held = () => controller.abort()
    const prepared = await adapter.prepare(execute, store.findCredential('falcon-axi')!)
    await assert.rejects(runner.run('synthetic-development-user', prepared.executable, prepared.args, prepared.environment,
      prepared.secrets, { ...prepared.limits, signal: controller.signal }, {}, prepared.files), { code: 'CANCELLED' })
    assert.equal((await evidence()).requests.filter(row => row.method === 'DELETE' && row.path === '/real-time-response/entities/sessions/v1').length, 2)
    db.prepare("DELETE FROM role_tools WHERE tool = 'falcon-axi'").run()
    assert.equal((await invoke(['detection', 'list'])).statusCode, 403)
    assert.ok((await evidence()).requests.every(row => row.canaryReceived), 'Every native request must use the managed canary identity')
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-|ARTIUM_SECRET_/)
    console.log(JSON.stringify({ falcon: '1.0.0-rc.2', writes: 'exact grants, default off', rtr: 'profile opt-in, command restriction, native confirm and cancellation cleanup',
      search: 'no automatic replay after lost response', network: 'guarded loopback only', credentials: 'profile SecretRefs and redacted audit' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
}, () => held(), { port: 443, hosts: ['localhost', ...falconTestHosts] })
