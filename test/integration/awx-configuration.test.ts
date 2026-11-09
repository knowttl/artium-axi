import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createAwxAdapter } from '../../src/server/adapters/awx.js'
import { Audit } from '../../src/server/audit/audit.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { configurationTests } from './awx-configuration-cases.js'

test('AWX enabling writes in one tenant does not grant another tenant write access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-awx-tenants-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const tenants = await Promise.all(['first', 'second'].map(async name => {
    const db = openStore(join(directory, name, 'artium.db'), provider)
    await seedToolUser(db)
    db.exec('UPDATE users SET administrator = 1')
    const store = createCredentialStore(db, provider)
    const reference = store.replaceCredential('awx-axi', { origin: 'https://controller.example', token: 'CANARY-awx-token' },
      0, 'synthetic-development-user', Date.now())
    const adapter = createAwxAdapter(new EmbeddedSecretSource(store))
    const app = createApp({ db, audit: new Audit(db, Date.now, () => {}),
      runner: await Runner.create(join(directory, name, 'calls')), adapters: [adapter],
      credentialStore: store, resolver: new SharedIdentityResolver(store), environment: {} })
    return { db, app, adapter, reference, store }
  }))
  try {
    const [first, second] = tenants
    const login = await first.app.inject({ method: 'POST', url: '/v1/auth/login', payload: {
      username: 'synthetic-user', password: 'CANARY-local-password' } })
    const headers = { authorization: `Bearer ${login.json().accessToken}` }
    const reauth = await first.app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
    const grant = await first.app.inject({ method: 'PATCH', url: '/v1/admin/tools/awx-axi/write-access',
      headers: { ...headers, 'x-artium-reauth-ticket': reauth.json().ticket }, payload: { enabled: true, expectedRevision: 1 } })
    expect(grant.json(), grant.body).toMatchObject({ writeAccess: { enabled: true } })
    first.reference = first.store.findCredential('awx-axi')!
    for (const args of [['job', 'cancel', '42', '--confirm'], ['inventory', 'edit', '42', '--name', 'Synthetic', '--confirm'],
      ['organization', 'admin-add', '42', '--user', '7', '--confirm'], ['team', 'user-add', '42', '--user', '7', '--confirm'],
      ['user', 'edit', '42', '--is-superuser', '--confirm'], ['role', 'grant', '42', '--team', '7', '--confirm'],
      ['user', 'token-revoke', '7', '--confirm']]) {
      expect((await first.adapter.prepare(args, first.reference)).effect).toBe('write')
      await expect(second.adapter.prepare(args, second.reference)).rejects.toMatchObject({ code: 'FLAG_BLOCKED' })
    }
    expect((await second.adapter.prepare(['job', 'list'], second.reference)).effect).toBe('read')
    expect((await first.adapter.prepare(['job', 'list'], first.reference)).effect).toBe('read')
  } finally {
    for (const { app, db } of tenants) { await app.close(); db.close() }
    rmSync(directory, { recursive: true, force: true })
  }
})


configurationTests(['credential', 'job', 'notification-template'])
