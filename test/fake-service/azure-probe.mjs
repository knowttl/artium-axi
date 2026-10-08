import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAzAdapter } from '/work/dist/src/server/adapters/az.js'
import { AzureTokenCache } from '/work/dist/src/server/adapters/azure-token-cache.js'
import { FakeTokenTransport, azureTestTenant } from '/work/dist/test/fixtures/azure-token-transport.js'
import { Runner } from '/work/dist/src/server/runner/runner.js'

const directory = mkdtempSync(join(tmpdir(), 'artium-test-azure-'))
const reference = { id: 'synthetic-azure', tool: 'az-axi', revision: 1 }
const credential = { auth: 'secret', tenantId: azureTestTenant,
  clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
  subscriptions: ['synthetic-subscription'], allowWrites: true }
const network = new FakeTokenTransport()
const writeLog = join(directory, 'tool-logs', 'az-axi', 'writes.log')
const adapter = createAzAdapter({ getCredential: async () => credential }, writeLog, new AzureTokenCache(network))
const runner = await Runner.create(join(directory, 'calls'))
const binary = '/work/tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js'
const evidence = async () => (await fetch('https://management.azure.com/__evidence')).json()
const run = async (args, input = {}, selected = adapter) => {
  const call = await selected.prepare(args, reference, input)
  // The CA is test infrastructure. The adapter still supplies only its production environment.
  return runner.run('synthetic-user', process.execPath, [binary, ...call.args],
    { ...call.environment, NODE_EXTRA_CA_CERTS: '/test-ca.crt' }, call.secrets, call.limits,
    { ...input, fileArguments: call.fileArguments?.map(index => index + 1) }, call.files)
}
try {
  const reads = [
    [['sub', 'list'], 'arm', 'management.azure.com', '/subscriptions'],
    [['logs', 'query', 'Heartbeat', '-w', '33333333-3333-4333-8333-333333333333'], 'logs', 'api.loganalytics.io', '/v1/workspaces/33333333-3333-4333-8333-333333333333/query'],
    [['api', '/v1.0/users', '--resource=graph'], 'graph', 'graph.microsoft.com', '/v1.0/users'],
    [['storage', 'blob', 'list', '--account-name=synthetic', '--container-name=synthetic', '--full'], 'storage', 'synthetic.blob.core.windows.net', '/synthetic'],
    [['keyvault', 'secret', 'list', '--vault-name=synthetic', '--full'], 'vault', 'synthetic.vault.azure.net', '/secrets'],
    [['acr', 'repository', 'list', '--name=synthetic'], 'registry', 'synthetic.azurecr.io', '/acr/v1/_catalog'],
  ]
  for (const [args, resource, host, path] of reads) {
    const before = network.requests.length
    const result = await run(args)
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
    assert.equal(network.requests.length, before + 1)
    assert.ok(network.requests.at(-1).form.get('scope').includes(resource === 'arm' ? 'management.azure.com' :
      resource === 'logs' ? 'api.loganalytics.io' : resource === 'graph' ? 'graph.microsoft.com' :
        resource === 'registry' ? 'containerregistry.azure.net' : resource === 'vault' ? 'vault.azure.net' : 'storage.azure.com'))
    assert.ok((await evidence()).requests.some(request => request.host === host && request.path === path && request.canaryReceived))
    assert.doesNotMatch(result.stdout + result.stderr, /CANARY-|blob-content|account-key/)
    if (resource === 'storage') assert.match(result.stdout, /synthetic-blob/)
    if (resource === 'vault') assert.match(result.stdout, /synthetic-secret/)
  }
  const target = '/subscriptions/synthetic-subscription/resourceGroups/single-write?api-version=2022-12-01'
  const otherSubscription = '44444444-4444-4444-8444-444444444444'
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
  const bodyFile = await run(['api', 'PATCH', target, '--body-file=body.json'],
    { files: [{ name: 'body.json', contentBase64: Buffer.from('{"tags":{"synthetic":"yes"}}').toString('base64') }] })
  assert.equal(bodyFile.exitCode, 0, bodyFile.stdout)
  const stdinBody = await run(['api', 'PATCH', target], { stdin: '{"tags":{"synthetic":"yes"}}' })
  assert.equal(stdinBody.exitCode, 0, stdinBody.stdout)
  assert.equal((await evidence()).mutations, baseline + 1)
  assert.ok(readFileSync(writeLog, 'utf8').length > 0)
  const outside = await run(['api', 'PATCH', target.replace('synthetic-subscription', 'other-subscription'), '--body', '{}', '--execute'])
  assert.match(outside.stdout, /SUBSCRIPTION_NOT_WRITABLE/)
  const denied = createAzAdapter({ getCredential: async () => ({ ...credential, allowWrites: false }) }, writeLog, new AzureTokenCache(network))
  assert.match((await run(args, {}, denied)).stdout, /WRITES_DISABLED/)
  const destructive = ['api', 'DELETE', target]
  assert.match((await run([...destructive, '--execute'])).stdout, /CONFIRM_REQUIRED/)
  assert.match((await run([...destructive, '--execute', '--confirm=wrong'])).stdout, /CONFIRM_MISMATCH/)
  assert.equal((await evidence()).mutations, baseline + 1)
  const fileQuery = await run(['logs', 'query', '-w', '33333333-3333-4333-8333-333333333333', '--file=query.kql'],
    { files: [{ name: 'query.kql', contentBase64: Buffer.from('Heartbeat').toString('base64') }] })
  assert.equal(fileQuery.exitCode, 0, fileQuery.stdout)
  const stdinQuery = await run(['logs', 'query', '-w', '33333333-3333-4333-8333-333333333333'], { stdin: 'Heartbeat' })
  assert.equal(stdinQuery.exitCode, 0, stdinQuery.stdout)
  console.log('azure-probe: six token-mode resources, metadata-only listings, ARM-only mint, uploaded/stdin query, native preview/write/scope/confirmation gates and durable log passed; activation deferred for pinned ambiguous retry')
} finally {
  await runner.shutdown()
  rmSync(directory, { recursive: true, force: true })
}
