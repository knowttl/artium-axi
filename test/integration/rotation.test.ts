import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createFalconAdapter } from '../../src/server/adapters/falcon.js'
import { createVectraAdapter } from '../../src/server/adapters/vectra.js'
import { createAzAdapter } from '../../src/server/adapters/az.js'
import { AzureTokenCache } from '../../src/server/adapters/azure-token-cache.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { encryptCredential } from '../../src/server/store/crypto.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { rotateKey } from '../../src/server/store/rotate-key.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { withFakeService } from '../fake-service/fixture.js'
import { FakeTokenTransport, azureTestTenant, azureTestToken } from '../fixtures/azure-token-transport.js'

test('all three adapters run with persisted credentials after offline rotation', async () => {
  await withFakeService(async ({ directory, port, send }) => {
    const oldProvider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
    const newProvider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 2).toString('base64') })
    const file = join(directory, 'data', 'artium.db')
    const credentials = {
      'falcon-axi': { clientId: 'CANARY-falcon-id', clientSecret: 'CANARY-falcon-secret', region: 'us-2', memberCid: 'synthetic-member' },
      'vectra-axi': { kind: 'qux', apiVersion: '2.5', auth: 'token', token: 'CANARY-vectra-token',
        origin: `https://localhost:${port}`, caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') },
      'az-axi': { auth: 'secret', tenantId: azureTestTenant, clientId: '22222222-2222-4222-8222-222222222222',
        clientSecret: 'CANARY-azure-secret', subscriptions: ['synthetic-subscription'] },
    }
    const seed = openStore(file, oldProvider)
    for (const [tool, value] of Object.entries(credentials)) {
      const row = encryptCredential(tool, tool, Buffer.from(JSON.stringify(value)), oldProvider.getKey())
      seed.prepare(`INSERT INTO credentials (id, tool, schema_version, key_id, nonce, ciphertext, authentication_tag)
        VALUES (@id, @tool, @schema_version, @key_id, @nonce, @ciphertext, @authentication_tag)`).run(row)
    }
    seed.close()
    rotateKey(file, oldProvider, newProvider)
    const db = openStore(file, newProvider)
    const runner = await Runner.create(join(directory, 'calls'))
    try {
      const store = createCredentialStore(db, newProvider)
      const source = new EmbeddedSecretSource(store)
      const resolver = new SharedIdentityResolver(store)
      const falcon = await createFalconAdapter(source).prepare(['detection', 'list'], await resolver.resolve('synthetic-user', 'falcon-axi'))
      const falconResult = await runner.run('synthetic-user', process.execPath,
        ['-e', 'console.log(process.env.FALCON_CLIENT_ID === "CANARY-falcon-id" && process.env.FALCON_CLIENT_SECRET === "CANARY-falcon-secret")'],
        falcon.environment, falcon.secrets)
      expect(falconResult).toMatchObject({ stdout: 'true\n', exitCode: 0 })
      const vectra = await createVectraAdapter(source, join(directory, 'tool-logs', 'vectra-axi', 'writes.log'))
        .prepare(['detection', 'list'], await resolver.resolve('synthetic-user', 'vectra-axi'))
      const vectraResult = await runner.run('synthetic-user', process.execPath,
        [join(process.cwd(), 'tools/node_modules/@knowttl/vectra-axi/bin/vectra-axi.js'), ...vectra.args],
        vectra.environment, vectra.secrets, vectra.limits, {}, vectra.files)
      expect(vectraResult.exitCode).toBe(0)
      expect(vectraResult.stdout).toContain('0 detections')
      expect(JSON.parse(await send('/__evidence')).requests[0].canaryReceived).toBe(true)
      const transport = new FakeTokenTransport()
      const az = await createAzAdapter(source, join(directory, 'tool-logs', 'az-axi', 'writes.log'), new AzureTokenCache(transport))
        .prepare(['sub', 'list'], await resolver.resolve('synthetic-user', 'az-axi'))
      expect(transport.requests[0].form.get('client_secret')).toBe(credentials['az-axi'].clientSecret)
      expect(az.environment.AZ_AXI_ARM_TOKEN).toBe(azureTestToken)
      const azResult = await runner.run('synthetic-user', process.execPath, ['-e', `
        const fs = require('node:fs');
        const profile = JSON.parse(fs.readFileSync(process.env.AZ_AXI_CONFIG)).profiles.artium;
        console.log(process.env.AZ_AXI_ARM_TOKEN === 'CANARY-AZURE-ACCESS-TOKEN' && profile.tenant === '${azureTestTenant}');
      `], az.environment, az.secrets, az.limits, {}, az.files)
      expect(azResult).toMatchObject({ stdout: 'true\n', exitCode: 0 })
    } finally { await runner.shutdown(); db.close() }
  })
}, 15_000)
