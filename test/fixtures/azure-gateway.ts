import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { Audit } from '../../src/server/audit/audit.js'
import { Runner } from '../../src/server/runner/runner.js'
import { openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { withFakeService } from '../fake-service/fixture.js'
import { FakeTokenTransport, azureTestTenant } from './azure-token-transport.js'
import { issueTestAccessToken, seedToolUser } from './tokens.js'

export const subscription = '44444444-4444-4444-8444-444444444444'

export function hostedArgs(command: string): string[] {
  const tokens = command.match(/'[^']*'|[^\s]+/g)!.map(token => token.startsWith("'") ? token.slice(1, -1) : token)
  expect(tokens.slice(0, 2)).toEqual(['artium-axi', 'az-axi'])
  return tokens.slice(2)
}

export async function withAzureGateway(check: (fixture: {
  run: (args: string[], input?: { stdin: string }) => Promise<{ statusCode: number, json(): unknown }>
  send: (path: string) => Promise<string>
  db: ReturnType<typeof openStore>
}) => Promise<void>, outcome: 'hold' | '504' | 'drop' = 'hold') {
  await withFakeService(async ({ directory, port, send }) => {
    const db = openStore(join(directory, 'artium.db'),
      new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }))
    const runner = await Runner.create(join(directory, 'calls'))
    const reference = { id: 'synthetic-azure', tool: 'az-axi' as const, revision: 1 }
    const adapter = createAzAdapter({ getCredential: async () => ({ auth: 'secret', tenantId: azureTestTenant,
      clientId: '22222222-2222-4222-8222-222222222222', clientSecret: 'CANARY-azure-secret',
      subscriptions: [subscription], workspaces: { synthetic: '33333333-3333-4333-8333-333333333333' },
      allowWrites: true }) }, join(directory, 'writes.log'), new AzureTokenCache(new FakeTokenTransport()))
    const hosted = { ...adapter, async prepare(...input: Parameters<typeof adapter.prepare>) {
      const call = await adapter.prepare(...input)
      return { ...call, executable: process.execPath,
        args: ['--import', fileURLToPath(new URL('../fake-service/azure-transport.mjs', import.meta.url)),
          fileURLToPath(new URL('../../tools/node_modules/@knowttl/az-axi/dist/bin/az-axi.js', import.meta.url)), ...call.args],
        fileArguments: call.fileArguments?.map(index => index + 3), limits: { timeoutMs: 1500 },
        environment: { ...call.environment, NODE_EXTRA_CA_CERTS: join(directory, 'ca.crt'),
          ARTIUM_TEST_AZURE_OUTCOME: outcome,
          ARTIUM_TEST_AZURE_ORIGIN: `https://localhost:${port}` } }
    } }
    const app = createApp({ db, audit: new Audit(db), runner, adapters: [hosted],
      resolver: { resolve: async () => reference }, environment: {} })
    try {
      await seedToolUser(db)
      db.exec("UPDATE tools SET enabled = 1, pinned_version = '0.1.6' WHERE name = 'az-axi'")
      const token = issueTestAccessToken(db, 'synthetic-development-user')
      await check({ db, send, run: async (args, input) => app.inject({ method: 'POST', url: '/v1/tools/az-axi/run',
        headers: { authorization: `Bearer ${token}` }, payload: { args, ...input } }) })
    } finally {
      await app.close()
      db.close()
    }
  })
}
