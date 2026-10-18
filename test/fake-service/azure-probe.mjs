import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createAzAdapter } from '/work/dist/src/server/adapters/az.js'
import { AzureTokenCache } from '/work/dist/src/server/adapters/azure-token-cache.js'
import { loadCredentialProfile } from '/work/dist/src/server/adapters/credential-profile.js'
import { FakeTokenTransport, azureTestTenant } from '/work/dist/test/fixtures/azure-token-transport.js'
import { Runner } from '/work/dist/src/server/runner/runner.js'
import { loadTrustedCa } from '/work/dist/src/server/trusted-ca.js'
import { createApp } from '/work/dist/src/server/app.js'
import { Audit } from '/work/dist/src/server/audit/audit.js'
import { openStore } from '/work/dist/src/server/store/db.js'
import { EnvironmentKeyProvider } from '/work/dist/src/server/store/key-provider.js'
import { seedToolUser } from '/work/dist/test/fixtures/tokens.js'
import { rewriteSuggestions } from '/work/dist/src/cli/rewrite.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-test-azure-'))
const reference = { id: 'synthetic-azure', tool: 'az-axi', revision: 1 }
const credential = { auth: 'secret', tenantId: azureTestTenant,
  clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
  subscriptions: ['synthetic-subscription'], allowWrites: true }
const network = new FakeTokenTransport()
const writeLog = join(directory, 'tool-logs', 'az-axi', 'writes.log')
const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(network))
const trustedCa = loadTrustedCa({ ARTIUM_AXI_EXTRA_CA_FILE: '/test-ca.crt' })
const runner = await Runner.create(join(directory, 'calls'), trustedCa)
const binary = '/work/tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js'
const { decode } = await import(createRequire(realpathSync(binary)).resolve('@toon-format/toon'))
const evidence = async () => (await fetch('https://management.azure.com/__evidence')).json()
const run = async (args, input = {}, selected = adapter) => {
  const call = await selected.prepare(args, reference, input)
  return runner.run('synthetic-user', process.execPath, [binary, ...call.args],
    call.environment, call.secrets, call.limits,
    { ...input, fileArguments: call.fileArguments?.map(index => index + 1) }, call.files)
}
try {
  const db = openStore(join(directory, 'data', 'artium.db'),
    new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.6' WHERE name = 'az-axi'")
  const apiRunner = await Runner.create(join(directory, 'api-calls'), trustedCa)
  const nativeApiAdapter = createAzAdapter({ getCredential: async () => credential }, writeLog,
    new AzureTokenCache(new FakeTokenTransport()))
  const apiAdapter = { ...nativeApiAdapter, async prepare(...args) {
    const call = await nativeApiAdapter.prepare(...args)
    return { ...call, executable: process.execPath, args: [binary, ...call.args] }
  } }
  const app = createApp({ db, audit: new Audit(db), runner: apiRunner, adapters: [apiAdapter],
    resolver: { resolve: async () => reference }, environment: {} })
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const login = await fetch(`${origin}/v1/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'synthetic-user', password: 'CANARY-local-password' }) })
    assert.equal(login.status, 200)
    const { accessToken } = await login.json()
    const request = async args => {
      const response = await fetch(`${origin}/v1/tools/az-axi/run`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ args }) })
      assert.equal(response.status, 200)
      return response.json()
    }
    const read = await request(['sub', 'list'])
    assert.equal(read.source, 'az-axi')
    assert.equal(read.exitCode, 0, read.stdout + read.stderr)
    assert.ok((await evidence()).requests.some(request => request.path === '/subscriptions' && request.canaryReceived))
    const before = (await evidence()).mutations
    const path = '/subscriptions/synthetic-subscription/resourceGroups/timeout-write'
    const write = await request(['api', 'PATCH', `${path}?api-version=2022-12-01`,
      '--body', '{"tags":{"synthetic":"yes"}}', '--execute'])
    assert.equal(write.source, 'az-axi')
    assert.equal(write.exitCode, 1, write.stdout + write.stderr)
    assert.match(write.stdout, /UNKNOWN_OUTCOME/)
    assert.match(write.stdout, /[Cc]heck.*state/)
    const after = await evidence()
    assert.equal(after.mutations, before + 1)
    assert.equal(after.requests.filter(request => request.path === path && request.method === 'PATCH').length, 1)
    const hosted = decode(rewriteSuggestions(write.stdout, 'az-axi'))
    const suggestion = hosted.help.find(line => line.startsWith('Check current state before trying again:'))
    const recovery = /^Check current state before trying again: `artium-axi az-axi api GET '([^']+)' (--full)`$/.exec(suggestion)
    assert.ok(recovery, suggestion)
    const checked = await request(['api', 'GET', recovery[1], recovery[2]])
    assert.equal(checked.exitCode, 0, checked.stdout + checked.stderr)
    const recovered = await evidence()
    assert.equal(recovered.mutations, after.mutations)
    assert.equal(recovered.requests.at(-1).method, 'GET')
    assert.equal(recovered.requests.at(-1).path, path)
    console.log(JSON.stringify({ scenario: 'public API gateway timeout after mutation', output: write.stdout, mutationRequests: 1 }))
  } finally {
    await app.close()
    db.close()
  }
  const reads = [
    [['sub', 'list'], 'arm', 'management.azure.com', '/subscriptions'],
    [['logs', 'query', 'Heartbeat', '-w', '33333333-3333-4333-8333-333333333333'], 'logs', 'api.loganalytics.io', '/v1/workspaces/33333333-3333-4333-8333-333333333333/query'],
    [['api', '/v1.0/users', '--resource=graph'], 'graph', 'graph.microsoft.com', '/v1.0/users'],
    [['storage', 'blob', 'list', '--account-name=synthetic', '--container-name=synthetic', '--full'], 'storage', 'synthetic.blob.core.windows.net', '/synthetic'],
    [['keyvault', 'secret', 'list', '--vault-name=synthetic', '--full'], 'vault', 'synthetic.vault.azure.net', '/secrets'],
    [['acr', 'repository', 'list', '--name=synthetic'], 'registry', 'synthetic.azurecr.io', '/acr/v1/_catalog'],
  ]
  const schemaNetwork = new FakeTokenTransport()
  const schemaAdapter = createAzAdapter({ getCredential: async () => credential }, writeLog,
    new AzureTokenCache(schemaNetwork),
    loadCredentialProfile('az-axi', '/work/tools/node_modules/@knowttl/az-axi/axi-credential.schema.json'))
  for (const [args, resource, host, path, preparation, selected, transport] of reads.flatMap(read => [
    [...read, 'fallback', adapter, network], [...read, 'published schema', schemaAdapter, schemaNetwork],
  ])) {
    const before = transport.requests.length
    const result = await run(args, {}, selected)
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /deprecated|tokenEnv/i)
    assert.equal(transport.requests.length, before + 1)
    assert.ok(transport.requests.at(-1).form.get('scope').includes(resource === 'arm' ? 'management.azure.com' :
      resource === 'logs' ? 'api.loganalytics.io' : resource === 'graph' ? 'graph.microsoft.com' :
        resource === 'registry' ? 'containerregistry.azure.net' : resource === 'vault' ? 'vault.azure.net' : 'storage.azure.com'))
    assert.ok((await evidence()).requests.some(request => request.host === host && request.path === path && request.canaryReceived))
    if (resource === 'logs') assert.equal((await evidence()).requests.at(-1).body.query, 'Heartbeat')
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY-|blob-content|account-key/)
    if (resource === 'storage') {
      const [blob] = decode(result.stdout).blobs
      assert.equal(blob.name, 'synthetic-blob')
      assert.equal(blob.size, '12')
      assert.equal(blob.blobType, 'BlockBlob')
    }
    if (resource === 'vault') {
      const [secret] = decode(result.stdout).secrets
      assert.equal(secret.name, 'synthetic-secret')
      assert.equal(secret.enabled, true)
      assert.equal(secret.contentType, 'text/plain')
    }
    console.log(JSON.stringify({ scenario: 'token-mode metadata read', preparation, resource, args,
      output: result.stdout, stderr: result.stderr }))
  }
  const target = '/subscriptions/synthetic-subscription/resourceGroups/single-write?api-version=2022-12-01'
  const otherSubscription = '44444444-4444-4444-8444-444444444444'
  for (const subscriptions of [undefined, []]) {
    const unscoped = createAzAdapter({ getCredential: async () => ({ ...credential, subscriptions }) }, writeLog, new AzureTokenCache(network))
    for (const args of [['sub', 'list'], ['api', '/v1.0/users', '--resource=graph']]) {
      const prepared = await unscoped.prepare(args, reference)
      const profile = JSON.parse(prepared.files[0].content).profiles.artium
      assert.equal(profile.allowWrites, true)
      assert.deepEqual(profile.subscriptions, subscriptions)
      const result = await run(args, {}, unscoped)
      assert.match(result.stdout, /CONFIG_INVALID/)
      assert.match(result.stdout, /invalid write configuration/)
      console.log(JSON.stringify({ scenario: 'unscoped read prepares; native configuration gate retained', profile, args, output: result.stdout }))
    }
  }
  const query = 'Resources | where name == "--subscription=literal"\n| take 1'
  for (const selectors of [['--subscription=' + otherSubscription], ['--subscription', otherSubscription], ['-s', otherSubscription], ['-s=' + otherSubscription]]) {
    for (const command of [['rg', 'query'], ['logs', 'query', '-w', '33333333-3333-4333-8333-333333333333']]) {
      const result = await run([...selectors, ...command, '--', query])
      assert.equal(result.exitCode, 0, result.stdout + result.stderr)
      const request = (await evidence()).requests.at(-1)
      assert.equal(request.body.query, query)
      if (command[0] === 'rg') assert.deepEqual(request.body.subscriptions, [otherSubscription])
      console.log(JSON.stringify({ scenario: 'leading selector with literal query', selectors, command, request, output: result.stdout }))
    }
  }
  const otherRead = await run(['group', 'list', '-s', otherSubscription])
  assert.equal(otherRead.exitCode, 0, otherRead.stdout)
  assert.ok((await evidence()).requests.some(request => request.path.toLowerCase() === `/subscriptions/${otherSubscription}/resourcegroups`))
  const permission = await run(['api', target.replace('single-write', 'permission-denied')])
  assert.match(permission.stdout, /FORBIDDEN/)
  const origin = await run(['api', 'https://appliance.test/subscriptions?api-version=2022-12-01'])
  assert.match(origin.stdout, /VALIDATION_ERROR/)
  const args = ['api', 'PATCH', target, '--body', '{"tags":{"synthetic":"yes"}}']
  const baseline = (await evidence()).mutations
  const preview = await run(args)
  assert.equal(preview.exitCode, 0, preview.stdout)
  assert.equal((await evidence()).mutations, baseline)
  const written = await run([...args, '--execute'])
  assert.equal(written.exitCode, 0, written.stdout)
  assert.equal((await evidence()).mutations, baseline + 1)
  assert.deepEqual((await evidence()).requests.at(-1).body, { tags: { synthetic: 'yes' } })
  const bodyInputs = [
    [['api', 'PATCH', target, '--body-file=body.json'],
      { files: [{ name: 'body.json', contentBase64: Buffer.from('{"tags":{"synthetic":"yes"}}').toString('base64') }] }],
    [['api', 'PATCH', target], { stdin: '{"tags":{"synthetic":"yes"}}' }],
  ]
  for (const [bodyArgs, input] of bodyInputs) {
    const before = await evidence()
    const previewBody = await run(bodyArgs, input)
    assert.equal(previewBody.exitCode, 0, previewBody.stdout)
    assert.equal((await evidence()).mutations, before.mutations)
    const executedBody = await run([...bodyArgs, '--execute'], input)
    assert.equal(executedBody.exitCode, 0, executedBody.stdout)
    const after = await evidence()
    assert.equal(after.mutations, before.mutations + 1)
    assert.equal(after.requests.filter(request => request.method === 'PATCH').length,
      before.requests.filter(request => request.method === 'PATCH').length + 1)
    assert.deepEqual(after.requests.at(-1).body, { tags: { synthetic: 'yes' } })
  }
  assert.ok(readFileSync(writeLog, 'utf8').length > 0)
  const outside = await run(['api', 'PATCH', target.replace('synthetic-subscription', 'other-subscription'), '--body', '{}', '--execute'])
  assert.match(outside.stdout, /SUBSCRIPTION_NOT_WRITABLE/)
  const denied = createAzAdapter({ getCredential: async () => ({ ...credential, allowWrites: false }) }, writeLog, new AzureTokenCache(network))
  assert.match((await run(args, {}, denied)).stdout, /WRITES_DISABLED/)
  const destructive = ['api', 'DELETE', target]
  assert.match((await run([...destructive, '--execute'])).stdout, /CONFIRM_REQUIRED/)
  assert.match((await run([...destructive, '--execute', '--confirm=wrong'])).stdout, /CONFIRM_MISMATCH/)
  assert.equal((await evidence()).mutations, baseline + 3)
  console.log(JSON.stringify({ scenario: 'native gates', preview: preview.stdout, executed: written.stdout,
    permission: permission.stdout, origin: origin.stdout, scope: outside.stdout, mutations: (await evidence()).mutations - baseline,
    writeLog: readFileSync(writeLog, 'utf8') }))
  const queryInputs = [
    [['logs', 'query', '-w', '33333333-3333-4333-8333-333333333333', '--file=query.kql'],
      { files: [{ name: 'query.kql', contentBase64: Buffer.from('Heartbeat').toString('base64') }] }],
    [['logs', 'query', '-w', '33333333-3333-4333-8333-333333333333'], { stdin: 'Heartbeat' }],
  ]
  for (const [queryArgs, input] of queryInputs) {
    const before = (await evidence()).requests.length
    const result = await run(queryArgs, input)
    assert.equal(result.exitCode, 0, result.stdout)
    const after = await evidence()
    assert.equal(after.requests.length, before + 1)
    assert.equal(after.requests.at(-1).body.query, 'Heartbeat')
    console.log(JSON.stringify({ scenario: 'uploaded or piped query', queryArgs, request: after.requests.at(-1), output: result.stdout }))
  }
  console.log('azure-probe: six token-mode resources, metadata-only listings, ARM-only mint, uploaded/stdin query, native preview/write/scope/confirmation gates and durable log passed')
} finally {
  await runner.shutdown()
  rmSync(directory, { recursive: true, force: true })
}
