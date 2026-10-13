import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { errorResponseSchema, runSuccessSchema } from '../../src/shared/api.js'
import { decode } from '@toon-format/toon'
import { withFakeService } from '../fake-service/fixture.js'
import { FakeTokenTransport, azureTestTenant } from '../fixtures/azure-token-transport.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

const subscription = '44444444-4444-4444-8444-444444444444'
const apiTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-api`
const nativeTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-native`
const readTarget = `/subscriptions/${subscription}/resourceGroups/runner-timeout-read`

test.each([
  { name: 'API PATCH', args: ['api', 'PATCH', apiTarget, '--api-version', '2022-12-01', '--body', '{"tags":{"synthetic":"yes"}}', '--execute'],
    code: 'UNKNOWN_OUTCOME', path: apiTarget, mutations: 1, method: 'PATCH', operation: 'PATCH',
    guidance: `Check current state before trying again: artium-axi az-axi api GET ${apiTarget}`,
    check: ['api', 'GET', apiTarget, '--api-version', '2022-12-01'] },
  { name: 'native tag PATCH', args: ['tag', 'update', '--subscription', subscription, '--resource-id', nativeTarget,
    '--operation', 'merge', '--tags', 'synthetic=yes', '--execute'],
    code: 'UNKNOWN_OUTCOME', path: `${nativeTarget}/providers/Microsoft.Resources/tags/default`, mutations: 1, method: 'PATCH', operation: 'tag update',
    guidance: `Check current state before trying again: artium-axi az-axi api GET ${nativeTarget}/providers/Microsoft.Resources/tags/default`,
    check: ['api', 'GET', `${nativeTarget}/providers/Microsoft.Resources/tags/default`, '--api-version', '2021-04-01'] },
  { name: 'GET read', args: ['api', 'GET', readTarget, '--api-version', '2022-12-01'],
    code: 'TIMEOUT', path: readTarget, mutations: 0, method: 'GET', operation: 'exceeded its timeout',
    guidance: 'Check the tool status before retrying.', check: ['sub', 'list'] },
])('$name preserves its outcome when the fake service holds its response', async ({ args, code, path, mutations, method, operation, guidance, check }) => {
  await withFakeService(async ({ directory, port, send }) => {
    const db = openStore(join(directory, 'artium.db'),
      new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
    const runner = await Runner.create(join(directory, 'calls'))
    const reference = { id: 'synthetic-azure', tool: 'az-axi' as const, revision: 1 }
    const adapter = createAzAdapter({ getCredential: async () => ({ auth: 'secret', tenantId: azureTestTenant,
      clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
      subscriptions: [subscription], allowWrites: true }) }, join(directory, 'writes.log'), new AzureTokenCache(new FakeTokenTransport()))
    const hosted = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
      const call = await adapter.prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', fileURLToPath(new URL('../fake-service/azure-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', import.meta.url)), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 3), limits: { timeoutMs: 1500 },
        environment: { ...call.environment, NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt'),
          ARTIUM_TEST_AZURE_ORIGIN: `https://localhost:${port}` } }
    } }
    const app = createApp({ db, audit: new Audit(db), runner, adapters: [hosted],
      resolver: { resolve: async () => reference }, environment: {} })
    try {
      await seedToolUser(db)
      db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.6' WHERE name = 'az-axi'")
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      const response = await app.inject({ method: 'POST', url: '/v1/tools/az-axi/run',
        headers: { authorization: `Bearer ${token}` }, payload: { args } })
      expect(response.statusCode).toBe(504)
      const error = errorResponseSchema.parse(response.json()).error
      expect(error.code).toBe(code)
      expect(error.message).toContain(operation)
      expect(error.next).toContain(guidance)
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(mutations)
      expect(evidence.requests.filter((request: { path: string, method: string }) => request.path === path &&
        request.method === method)).toHaveLength(1)
      expect(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal'").get()).toEqual({ outcome: code })
      const recovered = await app.inject({ method: 'POST', url: '/v1/tools/az-axi/run',
        headers: { authorization: `Bearer ${token}` }, payload: { args: check } })
      expect(recovered.statusCode).toBe(200)
      expect(runSuccessSchema.parse(recovered.json()).exitCode).toBe(0)
      expect(JSON.parse(await send('/__evidence')).mutations).toBe(mutations)
    } finally {
      await app.close()
      db.close()
    }
  })
})

test.each([[[]], [['home']]])('dashboard %j performs authenticated ARM reads', async args => {
  await withFakeService(async ({ directory, port, send }) => {
    const runner = await Runner.create(join(directory, 'calls'))
    const adapter = createAzAdapter({ getCredential: async () => ({ auth: 'secret', tenantId: azureTestTenant,
      clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
      subscriptions: [subscription], allowWrites: true }) }, join(directory, 'writes.log'), new AzureTokenCache(new FakeTokenTransport()))
    try {
      const call = await adapter.prepare(args, { id: 'synthetic-azure', tool: 'az-axi', revision: 1 })
      const result = await runner.run('synthetic-user', process.execPath,
        ['--import', fileURLToPath(new URL('../fake-service/azure-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', import.meta.url)), ...call.args],
        { ...call.environment, NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt'), ARTIUM_TEST_AZURE_ORIGIN: `https://localhost:${port}` },
        call.secrets, { timeoutMs: 5000 }, {}, call.files)
      expect(result.exitCode).toBe(0)
      const dashboard = decode(result.stdout) as { help?: string[], exposure: unknown }
      expect(dashboard.help?.join('\n') ?? '').not.toContain('Could not')
      expect(dashboard.exposure).toEqual({ publicIps: 1, mgmtPorts: 1, anyAny: 1 })
      const evidence = JSON.parse(await send('/__evidence'))
      expect(evidence.mutations).toBe(0)
      expect(evidence.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/subscriptions', method: 'GET', canaryReceived: true }),
        expect.objectContaining({ path: '/providers/Microsoft.ResourceGraph/resources', method: 'POST', canaryReceived: true }),
      ]))
    } finally { await runner.shutdown() }
  })
})
