import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

test('changing one Proxmox instance stops only its streams', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-proxmox-instances-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled=1 WHERE name='proxmox-axi'")
  const value = { origin: 'https://synthetic.invalid', auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }
  const lab = store.createInstance('proxmox-axi', { name: 'lab', description: '' }, value, user, Date.now())
  store.createInstance('proxmox-axi', { name: 'production', description: '' }, value, user, Date.now())
  const adapter = createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [adapter],
    environment: {}, resolver: new SharedIdentityResolver(store), credentialStore: store })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, user)}` }
  const args = ['transfer', 'get', '/nodes/{node}/storage/{storage}/file-restore/download']
  const start = (instance?: string) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers, payload: { ...(instance ? { instance } : {}), args } })
  const stop = (id: string) => app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${id}`, headers })
  try {
    expect((await start()).json().error.code).toBe('INSTANCE_REQUIRED')
    const [labStream, productionStream] = await Promise.all([start('lab'), start('production')])
    expect([labStream.statusCode, productionStream.statusCode]).toEqual([200, 200])
    store.replaceInstance('proxmox-axi', 'lab', { ...value, token: 'CANARY-rotated' }, lab.id, lab.revision, user, Date.now())
    expect((await stop(labStream.json().id)).statusCode).toBe(401)
    expect((await stop(productionStream.json().id)).statusCode).toBe(204)
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})
