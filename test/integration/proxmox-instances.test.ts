import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createProxmoxAdapter, proxmoxProfile } from '../../src/server/adapters/proxmox.js'
import { Runner } from '../../src/server/runner/runner.js'
import { ProxmoxAccess } from '../../src/server/runner/proxmox.js'
import { ProtectedResults } from '../../src/server/protected-results.js'
import { verifyPrincipal } from '../../src/server/auth/tokens.js'
import type { CredentialReference } from '../../src/server/store/credential-store.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

test('changing one Proxmox instance replaces only its cached ticket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-proxmox-tickets-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled=1 WHERE name='proxmox-axi'")
  const value = { origin: 'https://synthetic.invalid', auth: 'password', userId: 'automation@pve', password: 'CANARY-password' }
  const lab = store.createInstance('proxmox-axi', { name: 'lab', description: '' }, value, user, Date.now())
  const production = store.createInstance('proxmox-axi', { name: 'production', description: '' }, value, user, Date.now())
  const runner = await Runner.create(join(directory, 'calls')), results = new ProtectedResults()
  const access = new ProxmoxAccess(db, new SharedIdentityResolver(store, db), runner, results)
  const familyId = verifyPrincipal(db, issueTestAccessToken(db, user)).familyId
  const evidence = join(directory, 'acquisitions')
  const execute = (credential: CredentialReference) => {
    const profile = proxmoxProfile.prepare('proxmox-axi', value, undefined, true)
    const call = { executable: process.execPath, args: ['auth.mjs'], environment: { ...profile.environment, EVIDENCE: evidence },
      files: [...profile.files, { name: 'auth.mjs', content: `import {appendFileSync,writeSync} from 'node:fs';
        appendFileSync(process.env.EVIDENCE, process.env.PROXMOX_AXI_CREDENTIAL_REVISION + '\\n');
        const binding={origin:'https://synthetic.invalid',identity:'automation@pve',operation:'auth acquire',
          request:process.env.PROXMOX_AXI_REQUEST_ID,actor:process.env.PROXMOX_AXI_ACTOR,credentialRevision:process.env.PROXMOX_AXI_CREDENTIAL_REVISION};
        const payload={session:'00000000-0000-4000-8000-000000000001',state:'ready',expires:Date.now()+240000,ticket:'CANARY-ticket',csrfPreventionToken:'CANARY-csrf'};
        const bytes=Buffer.from(JSON.stringify({version:1,binding,payload})),header=Buffer.alloc(4);
        header.writeUInt32BE(bytes.length);writeSync(Number(process.env.PROXMOX_AXI_RESULT_FD),Buffer.concat([header,bytes]));` }],
      secrets: [...profile.secrets], limits: { timeoutMs: 5000 },
      proxmox: { origin: value.origin, identity: value.userId, password: true, authenticate: true } }
    return access.execute({ userId: user, familyId, credential, requestId: 'synthetic-request' }, call,
      limits => runner.run(user, process.execPath, ['-e', 'process.stdout.write("ok")'], {}, [], limits), () => {})
  }
  try {
    await execute(lab); await execute(production)
    await execute(lab); await execute(production)
    const rotated = store.replaceInstance('proxmox-axi', 'lab', { ...value, password: 'CANARY-rotated' }, lab.id, lab.revision, user, Date.now())
    await access.reconcile()
    await expect(execute(lab)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
    await expect(execute(production)).resolves.toMatchObject({ stdout: 'ok' })
    await expect(execute(rotated)).resolves.toMatchObject({ stdout: 'ok' })
    expect(readFileSync(evidence, 'utf8').trim().split('\n')).toEqual([
      `${lab.id}:${lab.revision}`, `${production.id}:${production.revision}`, `${rotated.id}:${rotated.revision}`,
    ])
  } finally { await access.close(); results.clear(); await runner.shutdown(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})

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
