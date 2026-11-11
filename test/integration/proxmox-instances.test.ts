import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
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
import { withFakeService } from '../fake-service/fixture.js'
import { toolPaths } from '../../src/server/config.js'
import { Client } from '../../src/cli/http.js'
import { openProxmoxStream } from '../../src/cli/proxmox-stream.js'
import { ProxmoxStreamWire } from '../../src/shared/proxmox-stream.js'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }

test('read-only Proxmox instances refuse stream writes but permit previews and reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-proxmox-readonly-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  db.prepare("UPDATE tools SET enabled=1, native_settings=? WHERE name='proxmox-axi'").run(JSON.stringify({
    writes: { operations: inventory.writeOperations }, hostWrites: { allowWrites: true, operations: inventory.writeOperations },
  }))
  const value = { origin: 'https://synthetic.invalid', auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }
  const instance = store.createInstance('proxmox-axi', { name: 'lab', description: '' }, value, user, Date.now())
  const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db),
    adapters: [createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))],
    environment: {}, resolver: new SharedIdentityResolver(store, db), credentialStore: store })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, user)}` }
  const upload = ['transfer', 'create', '/nodes/{node}/storage/{storage}/upload', '--api-node', 'node', '--api-storage', 'local',
    '--api-content', 'iso', '--api-filename', 'synthetic.iso', '--response-format', 'multipart']
  const source = { bytes: 1, sha256: 'a'.repeat(64) }
  const start = (args: string[], withSource = false) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers,
    payload: { instance: 'lab', args, ...(withSource ? { source } : {}) } })
  try {
    const read = await start(['transfer', 'get', '/nodes/{node}/rrd'])
    expect(read.statusCode).toBe(200)
    await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${read.json().id}`, headers })
    const preview = await start([...upload, '--preview'], true)
    expect(preview.statusCode).toBe(200)
    await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${preview.json().id}`, headers })
    const execute = [...upload, '--confirm', `00000000-0000-4000-8000-000000000001.${'a'.repeat(64)}`]
    expect((await start(execute, true)).json().error.code).toBe('FLAG_BLOCKED')
    const writable = store.setInstanceFlags('proxmox-axi', 'lab', { readOnly: false }, instance.id, instance.revision, user, Date.now())
    const lease = await start(execute, true)
    expect(lease.statusCode).toBe(200)
    store.setInstanceFlags('proxmox-axi', 'lab', { readOnly: true }, writable.id, writable.revision, user, Date.now())
    expect((await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${lease.json().id}`, headers })).statusCode).toBe(401)
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test.each([
  ['the write switch is turned off', { allowWrites: false, operations: inventory.writeOperations }],
  ['the operation is removed from the grant', { allowWrites: true, operations: [] }],
])('an admitted direct Proxmox write stream stops when %s with several instances', async (_name, revoked) => {
  const directory = mkdtempSync(join(tmpdir(), 'artium-proxmox-write-fence-'))
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  const hostWrites = (settings: object) => db.prepare("UPDATE tools SET enabled=1, native_settings=? WHERE name='proxmox-axi'")
    .run(JSON.stringify({ writes: { operations: inventory.writeOperations }, hostWrites: settings }))
  hostWrites({ allowWrites: true, operations: inventory.writeOperations })
  const value = { origin: 'https://synthetic.invalid', auth: 'api-token', tokenId: 'reader@pve!test', token: 'CANARY-token' }
  const lab = store.createInstance('proxmox-axi', { name: 'lab', description: '' }, value, user, Date.now())
  store.setInstanceFlags('proxmox-axi', 'lab', { readOnly: false }, lab.id, lab.revision, user, Date.now())
  store.createInstance('proxmox-axi', { name: 'production', description: '' }, value, user, Date.now())
  const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db),
    adapters: [createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))],
    environment: {}, resolver: new SharedIdentityResolver(store, db), credentialStore: store })
  const headers = { authorization: `Bearer ${issueTestAccessToken(db, user)}` }
  const upload = ['transfer', 'create', '/nodes/{node}/storage/{storage}/upload', '--api-node', 'node', '--api-storage', 'local',
    '--api-content', 'iso', '--api-filename', 'synthetic.iso', '--response-format', 'multipart',
    '--confirm', `00000000-0000-4000-8000-000000000001.${'a'.repeat(64)}`]
  try {
    const lease = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers,
      payload: { instance: 'lab', args: upload, source: { bytes: 1, sha256: 'a'.repeat(64) } } })
    expect(lease.statusCode).toBe(200)
    hostWrites(revoked)
    const stopped = await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${lease.json().id}`, headers })
    expect(stopped.statusCode).toBe(400)
    expect(stopped.json().error.code).toBe('FLAG_BLOCKED')
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
})

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

test('changing one Proxmox instance stops only its active byte transfer', async () => {
  await withFakeService(async ({ directory, port, send }) => {
  const previous = toolPaths['proxmox-axi']
  Object.assign(toolPaths, { 'proxmox-axi': join(process.cwd(), 'tools/node_modules/@knowttl/proxmox-axi/bin/proxmox-axi.mjs') })
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'store.db'), provider), store = createCredentialStore(db, provider)
  const user = 'synthetic-development-user'
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled=1 WHERE name='proxmox-axi'")
  const value = { origin: `https://localhost:${port}`, caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8'),
    auth: 'api-token', tokenId: 'reader@pve!automation', token: 'CANARY-proxmox-token' }
  const lab = store.createInstance('proxmox-axi', { name: 'lab', description: '' }, value, user, Date.now())
  store.createInstance('proxmox-axi', { name: 'production', description: '' }, value, user, Date.now())
  const adapter = createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'writes.log'))
  const app = createApp({ db, runner: await Runner.create(join(directory, 'calls')), audit: new Audit(db), adapters: [adapter],
    environment: {}, resolver: new SharedIdentityResolver(store, db), credentialStore: store })
  const token = issueTestAccessToken(db, user), headers = { authorization: `Bearer ${token}` }
  const args = ['transfer', 'get', '/nodes/{node}/rrd', '--api-node', 'node', '--api-ds', 'cpu', '--api-timeframe', 'hour', '--response-format', 'png']
  const start = (instance?: string) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers, payload: { ...(instance ? { instance } : {}), args } })
  try {
    expect((await start()).json().error.code).toBe('INSTANCE_REQUIRED')
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ ARTIUM_AXI_URL: address, ARTIUM_AXI_TEST_HTTP: '1', ARTIUM_AXI_CA_FILE: '' })
    const open = async (id: string) => {
      const { socket, head } = await openProxmoxStream(client, id, token, AbortSignal.timeout(20000))
      const chunks: Buffer[] = []
      let ready!: () => void, finished!: (result: { exitCode: number, stdout: string }) => void
      const reading = new Promise<void>(resolve => { ready = resolve })
      const result = new Promise<{ exitCode: number, stdout: string }>(resolve => { finished = resolve })
      const wire = new ProxmoxStreamWire(socket, false, async packet => {
        if (packet.type === 'data') { chunks.push(packet.bytes); ready() }
        if (packet.type === 'control' && packet.value.event === 'result') {
          finished(packet.value)
          await wire.send({ type: 'control', value: { event: 'delivered' } })
        }
      }, head)
      return { socket, chunks, reading, result }
    }
    await send('/__proxmox/control?mode=hold-stream')
    const [labStream, productionStream] = await Promise.all([start('lab'), start('production')])
    expect([labStream.statusCode, productionStream.statusCode]).toEqual([200, 200])
    const [labPipe, productionPipe] = await Promise.all([open(labStream.json().id), open(productionStream.json().id)])
    await Promise.all([labPipe.reading, productionPipe.reading])
    const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex')
    expect(Buffer.concat(labPipe.chunks)).toEqual(pngHeader)
    expect(Buffer.concat(productionPipe.chunks)).toEqual(pngHeader)
    const closed = once(labPipe.socket, 'close')
    store.replaceInstance('proxmox-axi', 'lab', { ...value, token: 'complete' }, lab.id, lab.revision, user, Date.now())
    await app.inject({ url: '/health/live' })
    await closed
    expect(productionPipe.socket.destroyed).toBe(false)
    await send('/__proxmox/control?mode=release-stream')
    expect((await productionPipe.result).exitCode).toBe(0)
    expect(Buffer.concat(productionPipe.chunks)).toEqual(Buffer.concat([pngHeader, Buffer.from('CANARY-proxmox-token\0\xff', 'latin1')]))
    productionPipe.socket.destroy()
  } finally { await app.close(); db.close(); Object.assign(toolPaths, { 'proxmox-axi': previous }) }
  })
}, 30000)
