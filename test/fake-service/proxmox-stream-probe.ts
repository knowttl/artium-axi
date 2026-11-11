import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Duplex, Readable } from 'node:stream'
import { decode } from '@toon-format/toon'
import { withFakeService } from './fixture.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { SessionStore, sessionPath } from '../../src/cli/session.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { createDelegation, revokeDelegation } from '../../src/server/auth/delegations.js'
import { exchangeDelegation } from '../../src/server/auth/tokens.js'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, port, send }) => {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'streams.db'), provider), store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator=1; UPDATE tools SET enabled=1 WHERE name='proxmox-axi'")
  store.replaceCredential('proxmox-axi', { origin: `https://localhost:${port}`, caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8'),
    auth: 'api-token', tokenId: 'reader@pve!automation', token: 'CANARY-proxmox-token' }, 0, 'synthetic-development-user', Date.now())
  const runner = await Runner.create(join(directory, 'calls'))
  const app = createApp({ db, runner, credentialStore: store, environment: { ARTIUM_PVE_TRANSFER_BYTES: '1048576', ARTIUM_PVE_STREAM_MS: '60000' },
    audit: new Audit(db), adapters: [createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'journal', 'writes.log'))],
    resolver: new SharedIdentityResolver(store, db) })
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(login.statusCode, 200, login.body)
    const session = login.json(), headers = { authorization: `Bearer ${session.accessToken}` }
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const environment = { ...process.env, ARTIUM_AXI_URL: address, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: join(directory, 'client') }
    new SessionStore(address, sessionPath(process.platform, environment)).write(session)
    const cli = (args: string[], options: { input?: Buffer, invalidFd?: boolean, aliasSetup?: boolean, onBytes?: () => void, onSetup?: () => void, config?: string, onStart?: (cancel: () => void) => void } = {}) => new Promise<{
      code: number | null, stdout: string, stderr: string, bytes: Buffer, setup: Buffer
    }>((resolve, reject) => {
      const child = spawn(process.execPath, ['/work/dist/cli/artium-axi.mjs', 'proxmox-axi', 'stream', '--', ...args, '--format', 'json'], {
        env: { ...environment, XDG_CONFIG_HOME: options.config ?? environment.XDG_CONFIG_HOME,
          PROXMOX_AXI_STREAM_FD: options.invalidFd ? '1' : '5', PROXMOX_AXI_RESULT_FD: options.aliasSetup ? '5' : '6' },
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe', 'pipe'],
      })
      options.onStart?.(() => child.kill('SIGTERM'))
      const bytes: Buffer[] = [], setup: Buffer[] = []
      let stdout = '', stderr = '', fed = false, notified = false
      child.stdout!.on('data', chunk => { stdout += chunk }); child.stderr!.on('data', chunk => { stderr += chunk })
      const channel = child.stdio.at(5) as Duplex, privateResult = child.stdio.at(6) as Readable
      channel.on('data', chunk => { bytes.push(Buffer.from(chunk)); options.onBytes?.() })
      channel.on('error', () => {})
      privateResult.on('data', chunk => {
        setup.push(Buffer.from(chunk))
        const frame = Buffer.concat(setup)
        if (!notified && frame.length >= 4 && frame.length === frame.readUInt32BE(0) + 4) { notified = true; options.onSetup?.() }
        if (options.input && !fed && frame.length >= 4 && frame.length === frame.readUInt32BE(0) + 4) {
          fed = true
          const header = Buffer.alloc(4); header.writeUInt32BE(options.input.length)
          channel.end(Buffer.concat([header, options.input]))
        }
      })
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Stream CLI deadline exceeded')) }, 20000)
      child.once('error', reject)
      child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr, bytes: Buffer.concat(bytes), setup: Buffer.concat(setup) }) })
    })
    const success = async (args: string[], options?: { input?: Buffer }) => {
      const result = await cli(args, options)
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, /CANARY-|ARTIUM_SECRET_|\/tmp\/|\/opt\/tools/)
      return { ...result, value: JSON.parse(result.stdout) }
    }
    const writes = async (enabled: boolean) => {
      const proof = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      assert.equal(proof.statusCode, 200, proof.body)
      const authenticated = { ...headers, 'x-artium-reauth-ticket': proof.json().ticket }
      const current = await app.inject({ url: '/v1/admin/tools/proxmox-axi', headers: authenticated })
      assert.equal(current.statusCode, 200, current.body)
      const saved = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/proxmox-axi', headers: authenticated,
        payload: { expectedRevision: current.json().revision, nativeSettings: { writes: { operations: inventory.writeOperations },
          hostWrites: { allowWrites: enabled, operations: inventory.writeOperations } } } })
      assert.equal(saved.statusCode, 200, saved.body)
    }
    const proof = async () => {
      const result = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      assert.equal(result.statusCode, 200, result.body)
      return { ...headers, 'x-artium-reauth-ticket': result.json().ticket }
    }
    const grants = async (tools: string[]) => {
      const authenticated = await proof(), role = await app.inject({ url: '/v1/admin/roles/synthetic-role', headers: authenticated })
      const result = await app.inject({ method: 'PUT', url: '/v1/admin/roles/synthetic-role/tools', headers: authenticated,
        payload: { tools, expectedRevision: role.json().revision } })
      assert.equal(result.statusCode, 200, result.body)
    }
    const replace = async (value: Record<string, unknown>) => {
      const authenticated = await proof(), current = await app.inject({ url: '/v1/admin/tools/proxmox-axi', headers: authenticated })
      const result = await app.inject({ method: 'PUT', url: '/v1/admin/tools/proxmox-axi/credential', headers: authenticated,
        payload: { value, expectedRevision: store.findCredential('proxmox-axi')!.revision, expectedToolRevision: current.json().revision } })
      assert.equal(result.statusCode, 200, result.body)
    }
    const png = ['transfer', 'get', '/nodes/{node}/rrd', '--api-node', 'node', '--api-ds', 'cpu', '--api-timeframe', 'hour', '--response-format', 'png']
    const expectedPng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('CANARY-proxmox-token\0\xff', 'latin1')])
    assert.deepEqual((await success(png)).bytes, expectedPng)
    const invalid = await cli(png, { invalidFd: true })
    assert.notEqual(invalid.code, 0); assert.match(invalid.stdout + invalid.stderr, /private pipe/)
    const ordinary = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/run', headers, payload: { args: png } })
    assert.equal(ordinary.statusCode, 400, ordinary.body)
    for (const selection of [
      ['/nodes/{node}/qemu/{vmid}/rrd', '--api-vmid', '100'],
      ['/nodes/{node}/lxc/{vmid}/rrd', '--api-vmid', '100'],
      ['/nodes/{node}/storage/{storage}/rrd', '--api-storage', 'local'],
    ]) assert.deepEqual((await success(['transfer', 'get', selection[0], '--api-node', 'node', '--api-ds', 'cpu', '--api-timeframe', 'hour',
      '--response-format', 'png', ...selection.slice(1)])).bytes, expectedPng)
    const journal = ['transfer', 'get', '/nodes/{node}/journal', '--api-node', 'node', '--response-format', 'text']
    await send('/__proxmox/control?mode=gzip')
    assert.deepEqual((await success(journal)).bytes, Buffer.from('Synthetic text\nCANARY-proxmox-token\n'))
    assert.deepEqual((await success(['transfer', 'get', '/nodes/{node}/tasks/{upid}/log', '--api-node', 'node', '--api-upid',
      'UPID:node:00000001:00000002:00000003:qmstart:100:reader@pve:', '--api-download', 'true', '--response-format', 'text'])).bytes,
    Buffer.from('Synthetic text\nCANARY-proxmox-token\n'))
    const guest = ['transfer', 'get', '/nodes/{node}/qemu/{vmid}/agent/file-read', '--api-node', 'node', '--api-vmid', '100', '--api-file', '/synthetic', '--response-format', 'guest-file']
    assert.deepEqual((await success(guest)).bytes, Buffer.from('hello ☃'))
    assert.deepEqual((await success([...guest, '--api-decode', 'false', '--raw'])).bytes, Buffer.from([0, 255]))
    await send('/__proxmox/control?version=8.2.7')
    const legacy = await success(guest)
    assert.equal(legacy.value.transfer.encoding, 'legacy-unknown')
    assert.notEqual((await cli([...guest, '--raw'])).code, 0)
    await send('/__proxmox/control?version=9.2.0')
    await send('/__proxmox/control?mode=bad-hash')
    assert.notEqual((await cli(png)).code, 0)
    assert.notEqual((await cli([...png, '--expected-sha256', '0'.repeat(64)])).code, 0)
    const download = ['transfer', 'get', '/nodes/{node}/storage/{storage}/file-restore/download', '--api-node', 'node', '--api-storage', 'local',
      '--api-volume', 'local:backup/synthetic.vma', '--api-filepath', '/', '--response-format', 'download']
    assert.deepEqual((await success(download)).bytes, Buffer.from([0, 255, 10, 13, 128, 1]))
    const downloadAdapter = createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'journal', 'writes.log'))
    await send('/__proxmox/control?mode=')
    for (const [args, expected] of [[guest, Buffer.from('hello ☃')], [download, Buffer.from([0, 255, 10, 13, 128, 1])]] as const) {
      const command = args.slice(0, 3).join(' ')
      for (const [label, commands, readOnly] of [
        ['exact', [command], false], ['wide', undefined, false], ['read-only', [command], true],
      ] as const) {
        const delegated = createDelegation(db, 'synthetic-development-user', { label, scope: { tools: [{ tool: 'proxmox-axi', commands: commands && [...commands] }] },
          readOnly, reusable: false, expiresAt: Date.now() + 60000 }, [downloadAdapter])
        const config = join(directory, `download-${delegated.id}`)
        new SessionStore(address, sessionPath(process.platform, { ...environment, XDG_CONFIG_HOME: config })).write(exchangeDelegation(db, delegated.token))
        const result = await cli(args, { config })
        if (label === 'exact') {
          assert.equal(result.code, 0, result.stdout + result.stderr)
          assert.deepEqual(result.bytes, expected)
          const transfer = JSON.parse(result.stdout).transfer
          assert.equal(transfer.bytes, expected.length)
          assert.equal(transfer.sha256, createHash('sha256').update(expected).digest('hex'))
          assert.deepEqual(db.prepare("SELECT outcome FROM audit WHERE delegation_id=? AND event='run-terminal'").all(delegated.id), [{ outcome: 'completed' }])
        } else {
          assert.notEqual(result.code, 0)
          assert.match(result.stdout + result.stderr, /DELEGATED_SCOPE_DENIED/)
          assert.equal(result.bytes.length, 0)
        }
      }
    }
    const spice = ['transfer', 'create', '/nodes/{node}/qemu/{vmid}/spiceproxy', '--api-node', 'node', '--api-vmid', '100', '--response-format', 'spiceconfig']
    assert.notEqual((await cli([...spice, '--preview'])).code, 0)
    await writes(true)
    const credentialGrant = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic credential issue', scope: { tools: [{ tool: 'proxmox-axi',
      commands: ['transfer create /nodes/{node}/qemu/{vmid}/spiceproxy', 'result take'] }] }, readOnly: false, reusable: false,
    expiresAt: Date.now() + 60000 }, [downloadAdapter])
    const credentialConfig = join(directory, 'credential-issue')
    new SessionStore(address, sessionPath(process.platform, { ...environment, XDG_CONFIG_HOME: credentialConfig })).write(exchangeDelegation(db, credentialGrant.token))
    const delegatedPreview = await cli([...spice, '--preview'], { config: credentialConfig })
    assert.equal(delegatedPreview.code, 0, delegatedPreview.stdout + delegatedPreview.stderr)
    const credentialId = store.findCredential('proxmox-axi')!.id
    assert.deepEqual(db.prepare("SELECT event, outcome, credential_id, instance FROM audit WHERE delegation_id = ? AND event IN ('credential-issue', 'run-start', 'run-terminal') ORDER BY id").all(credentialGrant.id), [
      { event: 'credential-issue', outcome: 'preview', credential_id: credentialId, instance: 'default' },
      { event: 'run-start', outcome: 'started', credential_id: credentialId, instance: 'default' },
      { event: 'run-terminal', outcome: 'completed', credential_id: credentialId, instance: 'default' },
    ])
    const spicePlan = await success([...spice, '--preview'])
    const beforeInvalidSpice = JSON.parse(await send('/__proxmox/evidence')).applied
    const invalidSpice = await cli([...spice.slice(0, -1), 'png', '--confirm', spicePlan.value.confirmation])
    assert.notEqual(invalidSpice.code, 0)
    assert.equal((invalidSpice.stdout.trimStart().startsWith('{') ? JSON.parse(invalidSpice.stdout) : decode(invalidSpice.stdout)).error.code, 'INVALID_INPUT')
    assert.equal(JSON.parse(await send('/__proxmox/evidence')).applied, beforeInvalidSpice)
    const spiceResult = await success([...spice, '--confirm', spicePlan.value.confirmation])
    assert.deepEqual(spiceResult.bytes, Buffer.from('[virt-viewer]\r\ntype=spice\r\npassword=CANARY-private-spice\r\nhost=synthetic.invalid\r\n'))
    assert.equal(spiceResult.setup.length, 0)
    for (const selection of [
      ['/nodes/{node}/lxc/{vmid}/spiceproxy', '--api-vmid', '100'], ['/nodes/{node}/spiceshell'],
    ]) {
      const args = ['transfer', 'create', selection[0], '--api-node', 'node', '--response-format', 'spiceconfig', ...selection.slice(1)]
      const plan = await success([...args, '--preview'])
      assert.deepEqual((await success([...args, '--confirm', plan.value.confirmation])).bytes, spiceResult.bytes)
    }
    const file = join(directory, 'source.bin'), source = Buffer.from([0, 255, 13, 10, 128, 1])
    writeFileSync(file, source, { mode: 0o600 })
    const upload = ['transfer', 'create', '/nodes/{node}/storage/{storage}/upload', '--api-node', 'node', '--api-storage', 'local',
      '--api-content', 'iso', '--api-filename', 'synthetic.iso', '--response-format', 'multipart', '--input-file', file]
    const uploadPlan = await success([...upload, '--preview'])
    const uploaded = await success([...upload, '--confirm', uploadPlan.value.confirmation])
    assert.equal(uploaded.value.transfer.sha256, createHash('sha256').update(source).digest('hex'))
    assert.deepEqual(JSON.parse(await send('/__proxmox/evidence')).uploaded, { bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') })
    const changedPlan = await success([...upload, '--preview']), beforeChanged = JSON.parse(await send('/__proxmox/evidence')).applied
    writeFileSync(file, Buffer.concat([source, Buffer.from([2])]))
    assert.notEqual((await cli([...upload, '--confirm', changedPlan.value.confirmation])).code, 0)
    assert.equal(JSON.parse(await send('/__proxmox/evidence')).applied, beforeChanged)
    writeFileSync(file, source)
    const duplex = ['duplex', 'create', '/nodes/{node}/qemu/{vmid}/vncproxy', '--api-node', 'node', '--api-vmid', '100']
    const plan = await success([...duplex, '--preview']), message = Buffer.from([0, 255, 13, 10, 128, 1])
    const beforeAlias = JSON.parse(await send('/__proxmox/evidence')).applied
    assert.notEqual((await cli([...duplex, '--confirm', plan.value.confirmation], { aliasSetup: true })).code, 0)
    assert.equal(JSON.parse(await send('/__proxmox/evidence')).applied, beforeAlias)
    const active = await success([...duplex, '--confirm', plan.value.confirmation], { input: message })
    assert.equal(JSON.parse(active.setup.subarray(4).toString('utf8')).payload.ticket, 'CANARY-vnc-ticket')
    const first = active.bytes.readUInt32BE(0), secondOffset = 4 + first, last = active.bytes.readUInt32BE(secondOffset)
    assert.deepEqual(active.bytes.subarray(4, secondOffset), message)
    assert.deepEqual(active.bytes.subarray(secondOffset + 4, secondOffset + 4 + last), Buffer.from('final-peer-message'))
    assert.equal(active.value.transfer.framesReceived, 2)
    for (const selection of [
      ['/nodes/{node}/lxc/{vmid}/vncproxy', '--api-vmid', '100'],
      ['/nodes/{node}/qemu/{vmid}/termproxy', '--api-vmid', '100'],
      ['/nodes/{node}/lxc/{vmid}/termproxy', '--api-vmid', '100'], ['/nodes/{node}/termproxy'], ['/nodes/{node}/vncshell'],
      ['/nodes/{node}/qemu/{vmid}/mtunnel', '--api-vmid', '100'], ['/nodes/{node}/lxc/{vmid}/mtunnel', '--api-vmid', '100'],
    ]) {
      const args = ['duplex', 'create', selection[0], '--api-node', 'node', ...selection.slice(1)]
      const plan = await success([...args, '--preview'])
      assert.equal((await success([...args, '--confirm', plan.value.confirmation], { input: message })).value.transfer.framesReceived, 2)
    }
    const failedPlan = await success([...duplex, '--preview']), beforeDrop = JSON.parse(await send('/__proxmox/evidence')).applied
    await send('/__proxmox/control?mode=drop-duplex')
    assert.notEqual((await cli([...duplex, '--confirm', failedPlan.value.confirmation], { input: message })).code, 0)
    assert.notEqual((await cli([...duplex, '--confirm', failedPlan.value.confirmation], { input: message })).code, 0)
    assert.equal(JSON.parse(await send('/__proxmox/evidence')).applied, beforeDrop + 1)
    const reservations = await Promise.all([app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers, payload: { args: png } }),
      app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers, payload: { args: png } })])
    assert.deepEqual(reservations.map(response => response.statusCode).sort(), [200, 200])
    const reserved = reservations.find(response => response.statusCode === 200)!
    assert.equal(reserved.statusCode, 200, reserved.body)
    assert.equal((await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers, payload: { args: png } })).statusCode, 429)
    const other = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
    assert.equal(other.statusCode, 200, other.body)
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${reserved.json().id}`,
      headers: { authorization: `Bearer ${other.json().accessToken}` } })).statusCode, 404)
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${reserved.json().id}`, headers })).statusCode, 204)
    const second = reservations.find(response => response.json().id !== reserved.json().id)!
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${second.json().id}`, headers })).statusCode, 204)
    const blockedPlan = await success([...duplex, '--preview']), opened = JSON.parse(await send('/__proxmox/evidence')).opened
    let setupReady!: () => void
    const ready = new Promise<void>(resolve => { setupReady = resolve })
    const held = cli([...duplex, '--confirm', blockedPlan.value.confirmation], { onSetup: setupReady })
    await ready
    await send(`/__proxmox/sockets?opened=${opened + 1}`)
    await grants([])
    assert.notEqual((await held).code, 0)
    await send(`/__proxmox/sockets?closed=${opened + 1}`)
    await grants(['proxmox-axi'])
    const delegatedAdapter = createProxmoxAdapter(new EmbeddedSecretSource(store), join(directory, 'journal', 'writes.log'))
    const delegation = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic', scope: { tools: [{ tool: 'proxmox-axi',
      commands: ['transfer get /nodes/{node}/rrd'] }] }, readOnly: false, reusable: false, expiresAt: Date.now() + 60000 }, [delegatedAdapter])
    const delegatedConfig = join(directory, 'delegated')
    new SessionStore(address, sessionPath(process.platform, { ...environment, XDG_CONFIG_HOME: delegatedConfig })).write(exchangeDelegation(db, delegation.token))
    await send('/__proxmox/control?mode=hold-stream')
    let ownerReady!: () => void, delegatedReady!: () => void, cancelOwner!: () => void, ownerFinished = false
    const ownerReading = new Promise<void>(resolve => { ownerReady = resolve })
    const delegatedReading = new Promise<void>(resolve => { delegatedReady = resolve })
    const ownerStream = cli(png, { onBytes: ownerReady, onStart: cancel => { cancelOwner = cancel } }).then(result => { ownerFinished = true; return result })
    const delegatedStream = cli(png, { config: delegatedConfig, onBytes: delegatedReady })
    await Promise.all([ownerReading, delegatedReading])
    revokeDelegation(db, delegation.id, 'synthetic-development-user', false)
    await app.inject({ url: '/health/live' })
    assert.notEqual((await delegatedStream).code, 0)
    assert.equal(ownerFinished, false)
    cancelOwner()
    assert.notEqual((await ownerStream).code, 0)
    await send('/__proxmox/control?mode=')
    let readReady!: () => void
    const reading = new Promise<void>(resolve => { readReady = resolve })
    await send('/__proxmox/control?mode=hold-stream')
    const heldRead = cli(png, { onBytes: readReady })
    await reading
    const credential = { origin: `https://localhost:${port}`, caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8'),
      auth: 'api-token', tokenId: 'reader@pve!automation', token: 'complete' }
    await replace(credential)
    assert.notEqual((await heldRead).code, 0)
    await send('/__proxmox/control?mode=')
    assert.deepEqual((await success(png)).bytes, expectedPng)
    await replace({ origin: credential.origin, caBundle: credential.caBundle, auth: 'password', userId: 'automation@pve', password: 'CANARY-proxmox-password' })
    const beforePassword = JSON.parse(await send('/__proxmox/evidence')).logins
    await success(png); await success(png)
    assert.equal(JSON.parse(await send('/__proxmox/evidence')).logins, beforePassword + 1)
    const actors: { authorization: string }[] = [headers]
    for (let index = 0; index < 16; index++) {
      const id = `synthetic-stream-${index}`
      db.prepare(`INSERT INTO users (id,username,display_name,password_hash,must_change)
        SELECT ?,?,?,password_hash,0 FROM users WHERE id='synthetic-development-user'`).run(id, id, id)
      db.prepare('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)').run(id, 'synthetic-role')
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: `192.0.2.${index + 1}`,
        payload: { username: id, password: 'CANARY-local-password' } })
      assert.equal(login.statusCode, 200, login.body)
      actors.push({ authorization: `Bearer ${login.json().accessToken}` })
    }
    const leases: string[] = []
    for (const actor of actors.slice(0, 16)) {
      const result = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers: actor, payload: { args: png } })
      assert.equal(result.statusCode, 200, result.body); leases.push(result.json().id)
    }
    assert.equal((await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers: actors[16], payload: { args: png } })).statusCode, 429)
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${leases[0]}`, headers: actors[0] })).statusCode, 204)
    const freed = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/streams', headers: actors[16], payload: { args: png } })
    assert.equal(freed.statusCode, 200, freed.body)
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/tools/proxmox-axi/streams/${freed.json().id}`, headers: actors[16] })).statusCode, 204)
    for (let index = 1; index < leases.length; index++) assert.equal((await app.inject({ method: 'DELETE',
      url: `/v1/tools/proxmox-axi/streams/${leases[index]}`, headers: actors[index] })).statusCode, 204)
    assert.deepEqual(readdirSync(join(directory, 'calls')), [])
    assert.deepEqual(readdirSync(join(directory, 'tool-logs', 'proxmox-axi', 'byte-streams')), [])
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-/)
    console.log('proxmox-stream: native downloads, gzip, guest chunks, raw SPICE, verified uploads and duplex setup/fragmentation/final EOF passed')
  } finally { await app.close(); db.close() }
})
