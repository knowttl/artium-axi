import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { createDelegation, revokeDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { issueTestAccessToken, seedToolUser } from '../fixtures/tokens.js'

test.each([
  ['duplex create /nodes/{node}/lxc/{vmid}/mtunnel', 'OP-POST-45ae134aef'],
  ['transfer create /nodes/{node}/lxc/{vmid}/spiceproxy', 'OP-POST-9a334b54b5'],
  ['duplex create /nodes/{node}/lxc/{vmid}/termproxy', 'OP-POST-129daba473'],
  ['duplex create /nodes/{node}/lxc/{vmid}/vncproxy', 'OP-POST-660f98e613'],
  ['duplex create /nodes/{node}/qemu/{vmid}/mtunnel', 'OP-POST-cb6766cea8'],
  ['transfer create /nodes/{node}/qemu/{vmid}/spiceproxy', 'OP-POST-6807588e8e'],
  ['duplex create /nodes/{node}/qemu/{vmid}/termproxy', 'OP-POST-792d5f0b19'],
  ['duplex create /nodes/{node}/qemu/{vmid}/vncproxy', 'OP-POST-7b3d9d8def'],
  ['transfer create /nodes/{node}/spiceshell', 'OP-POST-3764420a92'],
  ['duplex create /nodes/{node}/termproxy', 'OP-POST-04add518d5'],
  ['duplex create /nodes/{node}/vncshell', 'OP-POST-9db93dca1d'],
])('delegated %s requires result access before admitting confirmed setup (R2)', async (command, operation) => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-proxmox-delegated-setup-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled=1 WHERE name='proxmox-axi'; UPDATE delegation_settings SET minting_enabled=1")
  db.prepare("UPDATE tools SET native_settings=? WHERE name='proxmox-axi'").run(JSON.stringify({
    hostWrites: { allowWrites: true, operations: [operation] },
  }))
  store.replaceCredential('proxmox-axi', { origin: 'https://synthetic.invalid', auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }, 0, user, Date.now())
  const adapter = createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [adapter],
    environment: {}, resolver: new SharedIdentityResolver(store), credentialStore: store })
  const start = (token: string, args: string[]) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams',
    headers: { authorization: `Bearer ${token}` }, payload: { args } })
  try {
    const selected = createDelegation(db, user, { label: 'Setup only', scope: { tools: [{ tool: 'proxmox-axi', commands: [command] }] },
      readOnly: false, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
    const token = exchangeDelegation(db, selected.token).accessToken
    const preview = await start(token, [...command.split(' '), '--preview'])
    expect(preview.statusCode).toBe(200)
    await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${preview.json().id}`,
      headers: { authorization: `Bearer ${token}` } })
    const args = [...command.split(' '), '--confirm', '00000000-0000-0000-0000-000000000001.' + 'a'.repeat(64)]
    const denied = await start(token, args)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('DELEGATED_SCOPE_DENIED')
    const complete = createDelegation(db, user, { label: 'Setup and result', scope: { tools: [{ tool: 'proxmox-axi', commands: [command, 'result take'] }] },
      readOnly: false, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
    expect((await start(exchangeDelegation(db, complete.token).accessToken, args)).statusCode).toBe(200)
    expect((await start(issueTestAccessToken(db, user), args)).statusCode).toBe(200)
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('delegated streams reserve owner capacity and revocation preserves owner leases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-proxmox-delegated-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled=1 WHERE name='proxmox-axi'; UPDATE delegation_settings SET minting_enabled=1")
  store.replaceCredential('proxmox-axi', { origin: 'https://synthetic.invalid', auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }, 0, user, Date.now())
  const adapter = createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [adapter],
    environment: {}, resolver: new SharedIdentityResolver(store), credentialStore: store })
  const args = ['transfer', 'get', '/nodes/{node}/rrd', '--api-node', 'node', '--api-ds', 'cpu', '--api-timeframe', 'hour', '--response-format', 'png']
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const start = (token: string, command = args) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers: headers(token), payload: { args: command } })
  const stop = (token: string, id: string) => app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${id}`, headers: headers(token) })
  try {
    const owner = issueTestAccessToken(db, user)
    const delegation = createDelegation(db, user, { label: 'Synthetic', scope: { tools: [{ tool: 'proxmox-axi' }] },
      readOnly: false, reusable: true, expiresAt: Date.now() + 60000 }, [adapter])
    const token = exchangeDelegation(db, delegation.token).accessToken
    const readOnly = createDelegation(db, user, { label: 'Read only', scope: { tools: [{ tool: 'proxmox-axi' }] },
      readOnly: true, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
    const readToken = exchangeDelegation(db, readOnly.token).accessToken
    const exact = createDelegation(db, user, { label: 'Selected', scope: { tools: [{ tool: 'proxmox-axi',
      commands: ['stream limits', 'transfer get /nodes/{node}/rrd'] }] },
    readOnly: false, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
    const exactToken = exchangeDelegation(db, exact.token).accessToken
    const proxy = ['duplex', 'create', '/nodes/{node}/qemu/{vmid}/vncproxy', '--api-node', 'node', '--api-vmid', '100', '--preview']
    expect((await start(readToken, proxy)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
    expect((await start(readToken)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
    expect((await start(token, proxy)).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
    expect((await start(readToken, ['transfer', 'get', '/nodes/{node}/qemu/{vmid}/agent/file-read'])).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
    const tools = await app.inject({ url: '/v1/tools', headers: headers(readToken) })
    const commands = tools.json().tools.find((tool: { name: string }) => tool.name === 'proxmox-axi').commands
    expect(commands).not.toContain('transfer get /nodes/{node}/rrd')
    expect(commands).not.toContain('duplex create /nodes/{node}/qemu/{vmid}/vncproxy')
    expect(commands).not.toContain('transfer get /nodes/{node}/qemu/{vmid}/agent/file-read')
    const selected = await start(exactToken)
    expect(selected.statusCode).toBe(200)
    expect((await start(exactToken, ['transfer', 'get', '/nodes/{node}/journal'])).json().error.code).toBe('DELEGATED_SCOPE_DENIED')
    await stop(exactToken, selected.json().id)
    const first = await start(owner), second = await start(owner)
    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    expect((await start(owner)).statusCode).toBe(429)
    await stop(owner, first.json().id); await stop(owner, second.json().id)
    const delegated = await start(token)
    expect(delegated.statusCode).toBe(200)
    expect((await start(token)).statusCode).toBe(429)
    const own = await start(owner)
    expect(own.statusCode).toBe(200)
    revokeDelegation(db, delegation.id, user, false)
    expect((await stop(owner, own.json().id)).statusCode).toBe(204)
    expect((await start(owner)).statusCode).toBe(200)
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})
