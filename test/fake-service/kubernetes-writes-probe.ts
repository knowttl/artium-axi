import assert from 'node:assert/strict'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { withFakeService } from './fixture.js'
import { createKubernetesAdapter } from '../../src/server/adapters/kubernetes.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { runnerLimits, toolPaths } from '../../src/server/config.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
const nativeCodec = await import(pathToFileURL(createRequire(realpathSync(toolPaths['kubernetes-axi'])).resolve('@toon-format/toon')).href) as { decode: (text: string) => unknown }
await withFakeService(async ({ directory, port, send }) => {
  const workflow = join(directory, 'workflow')
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'kubernetes.db'), provider)
  const store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'kubernetes-axi'")
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, must_change)
    SELECT 'synthetic-other', 'synthetic-other', 'Synthetic Other', password_hash, 0 FROM users WHERE id = 'synthetic-development-user';
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-other', 'synthetic-role')`)
  const credential = { origin: `https://localhost:${port}`, auth: 'token', namespace: 'synthetic',
    certificateAuthority: readFileSync(join(directory, 'ca.crt'), 'utf8'), token: 'CANARY-kubernetes-token' }
  store.replaceCredential('kubernetes-axi', credential, 0, 'synthetic-development-user', Date.now())
  let runner = await Runner.create(join(directory, 'calls'))
  const adapter = await createKubernetesAdapter(new EmbeddedSecretSource(store), undefined, workflow)
  const application = () => createApp({ db, audit: new Audit(db, Date.now, () => {}), runner, adapters: [adapter], credentialStore: store,
    resolver: new SharedIdentityResolver(store), environment: {} })
  let app = application()
  try {
    const login = async (username = 'synthetic-user') => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password: 'CANARY-local-password' } })
      assert.equal(response.statusCode, 200, response.body)
      return { authorization: `Bearer ${response.json().accessToken}` }
    }
    const headers = await login()
    const invoke = (args: string[], identity = headers) => app.inject({ method: 'POST', url: '/v1/tools/kubernetes-axi/run', headers: identity, payload: { args } })
    const result = async (args: string[], identity = headers) => {
      const response = await invoke(args, identity)
      assert.equal(response.statusCode, 200, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|\/opt\/tools|artium-call-/)
      return { code: response.json().exitCode as number, value: nativeCodec.decode(response.json().stdout) as Record<string, any> }
    }
    const success = async (args: string[], identity = headers) => {
      const output = await result(args, identity)
      assert.equal(output.code, 0, JSON.stringify(output))
      return output.value
    }
    const evidence = async () => JSON.parse(await send('/__evidence')) as {
      mutations: number, requests: Array<{ method: string, path: string, canaryReceived: boolean, dryRun?: boolean }>
    }
    const ticket = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    assert.equal(ticket.statusCode, 200, ticket.body)
    const proof = { ...headers, 'x-artium-reauth-ticket': ticket.json().ticket }
    const writes = async (enabled: boolean) => {
      const detail = await app.inject({ url: '/v1/admin/tools/kubernetes-axi', headers: proof })
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/kubernetes-axi/write-access', headers: proof,
        payload: { enabled, expectedRevision: detail.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const create = ['create', 'configmap', 'synthetic-new', '--from-literal=mode=prepared']
    assert.equal((await success(['confirm', '--help'])).usage, 'artium-axi kubernetes-axi confirm <request-key> --digest <exact-digest>')
    assert.equal((await success(['prepare', '--', 'create', 'configmap', '--help'])).usage, 'artium-axi kubernetes-axi prepare -- create configmap [flags]')
    const denied = await invoke(['prepare', '--', ...create])
    assert.equal(denied.json().error.code, 'FLAG_BLOCKED')
    await writes(true)
    const blockers = Array.from({ length: runnerLimits.globalCalls }, (_, index) => {
      const controller = new AbortController()
      let admitted!: () => void
      const ready = new Promise<void>(resolve => { admitted = resolve })
      const pending = runner.run(`synthetic-blocker-${index}`, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, [],
        { signal: controller.signal }, {}, [], admitted)
      return { controller, ready, pending }
    })
    try {
      await Promise.all(blockers.map(blocker => blocker.ready))
      const queued = invoke(['prepare', '--', ...create])
      await new Promise<void>(resolve => setImmediate(resolve))
      const disabling = writes(false)
      await new Promise<void>(resolve => setImmediate(resolve))
      for (const blocker of blockers) blocker.controller.abort()
      await Promise.allSettled(blockers.map(blocker => blocker.pending))
      await disabling
      assert.equal((await queued).json().error.code, 'CREDENTIAL_INVALID')
    } finally {
      for (const blocker of blockers) blocker.controller.abort()
      await Promise.allSettled(blockers.map(blocker => blocker.pending))
    }
    await writes(true)
    let prepared = await success(['prepare', '--', ...create])
    assert.equal((await evidence()).mutations, 0)
    let preview = await success(['preview', prepared.request])
    const beforePreview = (await evidence()).requests.length
    assert.deepEqual(await success(['preview', prepared.request]), preview)
    assert.equal((await evidence()).requests.length, beforePreview)
    await writes(false)
    const beforeDisabledPreview = (await evidence()).requests.length
    assert.equal((await result(['preview', prepared.request])).value.error.code, 'REQUEST_NOT_FOUND')
    assert.equal((await evidence()).requests.length, beforeDisabledPreview)
    assert.equal((await invoke(['confirm', prepared.request, '--digest', preview.digest])).json().error.code, 'FLAG_BLOCKED')
    await writes(true)
    prepared = await success(['prepare', '--', ...create])
    preview = await success(['preview', prepared.request])
    const wrong = await result(['confirm', prepared.request, '--digest', '0'.repeat(64)])
    assert.equal(wrong.value.error.code, 'PREVIEW_MISMATCH')
    for (const identity of [await login(), await login('synthetic-other')]) {
      assert.equal((await result(['preview', prepared.request], identity)).value.error.code, 'REQUEST_NOT_FOUND')
    }
    await app.close()
    runner = await Runner.create(join(directory, 'calls'))
    app = application()
    assert.deepEqual(await success(['preview', prepared.request]), preview)
    const confirm = ['confirm', prepared.request, '--digest', preview.digest]
    assert.equal((await success(confirm)).complete, true)
    assert.equal((await evidence()).mutations, 1)
    assert.equal((await success(confirm)).replayed, true)
    assert.equal((await evidence()).mutations, 1)
    await success(['server-dry-run', '--', 'create', 'configmap', 'synthetic-dry', '--from-literal=mode=dry'])
    assert.equal((await evidence()).mutations, 1)
    assert.ok((await evidence()).requests.some(row => row.method === 'POST' && row.dryRun === true))
    const stale = await success(['prepare', '--', 'label', 'configmap', 'synthetic-config', 'phase=stale'])
    const stalePreview = await success(['preview', stale.request])
    await send('/__kubernetes/control?mode=bump&name=synthetic-config')
    assert.equal((await result(['confirm', stale.request, '--digest', stalePreview.digest])).value.error.code, 'PREVIEW_STALE')
    assert.equal((await evidence()).mutations, 1)
    const partial = await success(['prepare', '--', 'label', 'configmap', 'synthetic-config', 'synthetic-second', 'phase=partial'])
    const partialPreview = await success(['preview', partial.request])
    await send('/__kubernetes/control?mode=deny&name=synthetic-second')
    const partialResult = await result(['confirm', partial.request, '--digest', partialPreview.digest])
    assert.notEqual(partialResult.code, 0)
    assert.deepEqual(partialResult.value.results.map((row: { outcome: string }) => row.outcome), ['committed', 'failed'])
    assert.equal((await evidence()).mutations, 2)
    await result(['confirm', partial.request, '--digest', partialPreview.digest])
    assert.equal((await evidence()).mutations, 2)
    const lost = await success(['prepare', '--', 'create', 'configmap', 'synthetic-lost', '--from-literal=mode=lost'])
    const lostPreview = await success(['preview', lost.request])
    await send('/__kubernetes/control?mode=drop&name=synthetic-lost')
    assert.notEqual((await result(['confirm', lost.request, '--digest', lostPreview.digest])).code, 0)
    await result(['confirm', lost.request, '--digest', lostPreview.digest])
    assert.equal((await evidence()).mutations, 3)
    const concurrent = await success(['prepare', '--', 'create', 'configmap', 'synthetic-concurrent', '--from-literal=mode=concurrent'])
    const concurrentPreview = await success(['preview', concurrent.request])
    const beforeConcurrent = (await evidence()).requests.filter(row => row.method === 'POST').length
    const confirmations = await Promise.all([
      result(['confirm', concurrent.request, '--digest', concurrentPreview.digest]),
      result(['confirm', concurrent.request, '--digest', concurrentPreview.digest]),
    ])
    assert.ok(confirmations.some(output => output.code === 0 && output.value.complete === true))
    assert.equal((await evidence()).requests.filter(row => row.method === 'POST').length, beforeConcurrent + 1)
    assert.equal((await evidence()).mutations, 4)
    const bulk = ['prepare', '--', 'delete', 'configmap', 'synthetic-config', 'synthetic-second', '--wait=false']
    assert.equal((await result(bulk)).value.error.code, 'CAPABILITY_UNAVAILABLE')
    assert.equal((await evidence()).mutations, 4)
    const current = await app.inject({ url: '/v1/admin/tools/kubernetes-axi', headers: proof })
    const opted = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/kubernetes-axi', headers: proof,
      payload: { expectedRevision: current.json().revision, nativeSettings: { allowWrites: true, collectionDelete: true } } })
    assert.equal(opted.statusCode, 200, opted.body)
    const collection = await success(bulk)
    const collectionPreview = await success(['preview', collection.request])
    assert.equal((await success(['confirm', collection.request, '--digest', collectionPreview.digest])).complete, true)
    assert.equal((await evidence()).mutations, 6)
    const revisionPlan = await success(['prepare', '--', 'create', 'configmap', 'synthetic-revision', '--from-literal=mode=revision'])
    const revision = store.findCredential('kubernetes-axi')!
    store.replaceCredential('kubernetes-axi', credential, revision.revision!, 'synthetic-development-user', Date.now())
    assert.equal((await result(['preview', revisionPlan.request])).value.error.code, 'REQUEST_NOT_FOUND')
    const delegated = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic workflow',
      scope: { tools: [{ tool: 'kubernetes-axi', commands: ['create configmap'] }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
    const scopedHeaders = { authorization: `Bearer ${exchangeDelegation(db, delegated.token).accessToken}` }
    const scopedPlan = await success(['prepare', '--', 'create', 'configmap', 'synthetic-delegated', '--from-literal=mode=scoped'], scopedHeaders)
    const scopedPreview = await success(['preview', scopedPlan.request], scopedHeaders)
    assert.equal((await success(['confirm', scopedPlan.request, '--digest', scopedPreview.digest], scopedHeaders)).complete, true)
    db.prepare("DELETE FROM role_tools WHERE tool = 'kubernetes-axi'").run()
    assert.equal((await invoke(['preview', prepared.request])).statusCode, 403)
    assert.ok((await evidence()).requests.every(row => row.canaryReceived))
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-|ARTIUM_SECRET_/)
    for (const scope of readdirSync(workflow)) assert.deepEqual(readdirSync(join(workflow, scope)).filter(name => name !== 'requests'), [])
    console.log(JSON.stringify({ kubernetes: '0.1.3', writes: 'default off and native exact confirmation', scope: 'caller, family and revision',
      restart: 'saved native requests retained', replay: 'atomic native claims preserved', failures: 'stale, partial and lost response', cleanup: 'per-call profiles removed' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
