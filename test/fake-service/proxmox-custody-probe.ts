import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { decode } from '@toon-format/toon'
import { withFakeService } from './fixture.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { Runner } from '../../src/server/runner/runner.js'
import { ProxmoxAccess } from '../../src/server/runner/proxmox.js'
import { ProtectedResults } from '../../src/server/protected-results.js'
import { exchangeDelegation, verifyAccessFamily } from '../../src/server/auth/tokens.js'
import { createDelegation } from '../../src/server/auth/delegations.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { readCredentialTrust } from '../../src/server/store/trusted-certificates.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { SessionStore, sessionPath } from '../../src/cli/session.js'
import { seedToolUser } from '../fixtures/tokens.js'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, port, send }) => {
  const origin = `https://localhost:${port}`, calls = join(directory, 'calls')
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'custody.db'), provider), store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator=1; UPDATE tools SET enabled=1 WHERE name='proxmox-axi'")
  const caBundle = readFileSync(join(directory, 'ca.crt'), 'utf8')
  const password = { origin, caBundle, auth: 'password', userId: 'automation@pve', password: 'CANARY-proxmox-password' }
  store.replaceCredential('proxmox-axi', { origin, caBundle, auth: 'api-token', tokenId: 'reader@pve!automation', token: 'CANARY-proxmox-token' },
    0, 'synthetic-development-user', Date.now())
  const source = new EmbeddedSecretSource(store), resolver = new SharedIdentityResolver(store)
  const adapter = createProxmoxAdapter(source, join(directory, 'journal', 'writes.log'))
  let runner = await Runner.create(calls), closed = false, isolated: ProxmoxAccess | undefined
  const application = () => createApp({ db, runner, credentialStore: store, environment: {}, audit: new Audit(db), adapters: [adapter], resolver })
  let app = application()
  type Reply = { id: string, confirmation: string, result?: { id: string, path: string, operation: string }, error?: { code: string } }
  type Evidence = { applied: number, logins: number, passwordReceived: boolean, csrfReceived: boolean, nodeTickets: number[] }
  try {
    let loginAddress = 1
    const login = async (username = 'synthetic-user') => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: `192.0.2.${loginAddress++}`,
        payload: { username, password: 'CANARY-local-password' } })
      assert.equal(response.statusCode, 200, response.body); return response.json()
    }
    const session = await login(), headers = { authorization: `Bearer ${session.accessToken}` }
    const recent = async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      assert.equal(response.statusCode, 200, response.body)
      return { ...headers, 'x-artium-reauth-ticket': response.json().ticket }
    }
    const invoke = (args: string[], stdin?: string, proof = headers) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/run',
      headers: proof, payload: { args, ...(stdin === undefined ? {} : { stdin }) } })
    const success = async (args: string[], stdin?: string, proof = headers): Promise<Reply> => {
      const response = await invoke(args, stdin, proof)
      assert.equal(response.statusCode, 200, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|\/tmp\/|\/opt\/tools/)
      const result = response.json(); assert.equal(result.exitCode, 0, response.body)
      return (result.stdout.trimStart().startsWith('{') ? JSON.parse(result.stdout) : decode(result.stdout)) as Reply
    }
    const evidence = async (): Promise<Evidence> => JSON.parse(await send('/__proxmox/evidence'))
    const replace = async (value: Record<string, unknown>) => {
      const proof = await recent(), current = await app.inject({ url: '/v1/admin/tools/proxmox-axi', headers: proof })
      assert.equal(current.statusCode, 200, current.body)
      const response = await app.inject({ method: 'PUT', url: '/v1/admin/tools/proxmox-axi/credential', headers: proof,
        payload: { value, expectedRevision: store.findCredential('proxmox-axi')!.revision, expectedToolRevision: current.json().revision } })
      assert.equal(response.statusCode, 200, response.body); assert.doesNotMatch(response.body, /CANARY-/)
    }
    const writes = async (enabled: boolean, operations = inventory.writeOperations) => {
      const proof = await recent(), current = await app.inject({ url: '/v1/admin/tools/proxmox-axi', headers: proof })
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/proxmox-axi', headers: proof,
        payload: { expectedRevision: current.json().revision, nativeSettings: { writes: { operations: inventory.writeOperations },
          hostWrites: { allowWrites: enabled, operations } } } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const grants = async (tools: string[]) => {
      const proof = await recent(), role = await app.inject({ url: '/v1/admin/roles/synthetic-role', headers: proof })
      const response = await app.inject({ method: 'PUT', url: '/v1/admin/roles/synthetic-role/tools', headers: proof,
        payload: { tools, expectedRevision: role.json().revision } })
      assert.equal(response.statusCode, 200, response.body)
    }
    await success(['get', '/nodes'])
    assert.equal((await evidence()).logins, 0)
    const userOnly = ['set', '/access/password', '--protected-input']
    const userInput = JSON.stringify({ api: { userid: 'target@pve', password: { env: 'PVE_INPUT_NEW_PASSWORD' } },
      secrets: { PVE_INPUT_NEW_PASSWORD: 'CANARY-new-user-password' } })
    await writes(true)
    const tokenForbidden = await invoke([...userOnly, '--preview'], userInput)
    assert.equal(tokenForbidden.statusCode, 200, tokenForbidden.body)
    assert.equal((decode(tokenForbidden.json().stdout) as Reply).error?.code, 'AUTH_SESSION_REQUIRED')
    await replace({ origin, caBundle, auth: 'api-token', tokenId: 'reader@pve!automation', token: 'CANARY-invalid-api-token' })
    const invalidToken = await invoke(['get', '/nodes'])
    assert.equal(invalidToken.json().exitCode, 1, invalidToken.body)
    assert.equal((await evidence()).logins, 0)
    await replace(password)
    const beforeHealth = (await evidence()).logins
    for (const count of [1, 2]) {
      const health = await app.inject({ method: 'POST', url: '/v1/admin/tools/proxmox-axi/test',
        headers: await recent(), payload: {} })
      assert.equal(health.statusCode, 200, health.body)
      assert.equal(health.json().status, 'ok', health.body)
      assert.doesNotMatch(health.body, /CANARY-|ARTIUM_SECRET_/)
      assert.equal((await evidence()).logins, beforeHealth + count)
    }
    await send('/__proxmox/control?auth=hold')
    const firstLogin = (await evidence()).logins
    const firstReads = Promise.all([success(['get', '/nodes']), success(['get', '/nodes'])])
    await send(`/__proxmox/logins?count=${firstLogin + 1}`)
    await send('/__proxmox/control?auth=release')
    await firstReads
    const first = (await evidence()).nodeTickets.at(-1)!
    assert.ok(first > 0)
    assert.deepEqual((await evidence()).nodeTickets.slice(-2), [first, first])
    await Promise.all([success(['get', '/nodes']), success(['get', '/nodes'])])
    assert.deepEqual((await evidence()).nodeTickets.slice(-3), [first, first, first])
    const other = await login(), otherHeaders = { authorization: `Bearer ${other.accessToken}` }
    await success(['get', '/nodes'], undefined, otherHeaders)
    assert.notEqual((await evidence()).nodeTickets.at(-1), first)
    assert.equal((await evidence()).passwordReceived, true)
    await writes(true)
    const token = ['create', '/access/users/{userid}/token/{tokenid}', '--api-userid', 'automation@pve', '--api-tokenid', 'issued']
    const preview = await success([...token, '--preview'])
    assert.equal((await evidence()).applied, 0)
    const created = await success([...token, '--confirm', preview.confirmation])
    assert.ok(created.result)
    assert.equal((await evidence()).applied, 1)
    assert.equal((await evidence()).csrfReceived, true)
    const foreign = await app.inject({ url: created.result.path, headers: otherHeaders })
    assert.equal(foreign.statusCode, 404)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const environment = { ...process.env, ARTIUM_AXI_URL: address, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: join(directory, 'client') }
    new SessionStore(address, sessionPath(process.platform, environment)).write(session)
    const client = (fd: string) => new Promise<{ code: number | null, stdout: string, stderr: string, bytes: Buffer }>((resolve, reject) => {
      const child = spawn(process.execPath, ['/work/dist/cli/artium-axi.mjs', 'proxmox-axi', 'result', 'take', created.result!.operation, created.result!.id],
        { env: { ...environment, PROXMOX_AXI_RESULT_FD: fd }, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe'] })
      let stdout = '', stderr = ''; const chunks: Buffer[] = []
      child.stdout!.on('data', chunk => { stdout += chunk }); child.stderr!.on('data', chunk => { stderr += chunk })
      ;(child.stdio.at(5) as Readable).on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr, bytes: Buffer.concat(chunks) }))
    })
    const invalid = await client('1')
    assert.equal(invalid.code, 2); assert.doesNotMatch(invalid.stdout + invalid.stderr, /CANARY-/)
    const delivered = await client('5')
    assert.equal(delivered.code, 0, delivered.stdout + delivered.stderr)
    assert.doesNotMatch(delivered.stdout + delivered.stderr, /CANARY-/)
    assert.equal(delivered.bytes.readUInt32BE(0), delivered.bytes.length - 4)
    const frame = JSON.parse(delivered.bytes.subarray(4).toString('utf8'))
    assert.equal(frame.version, 1); assert.equal(frame.payload.value, 'CANARY-new-proxmox-secret-1')
    assert.equal((await app.inject({ url: created.result.path, headers })).statusCode, 404)
    assert.equal((await invoke([...token, '--confirm', preview.confirmation])).json().exitCode, 1)
    assert.equal((await evidence()).applied, 1)
    const pendingResults: { path: string }[] = []
    for (let index = 0; index < 4; index++) {
      const plan = await success([...token, '--preview'])
      pendingResults.push((await success([...token, '--confirm', plan.confirmation])).result!)
    }
    const capacityPlan = await success([...token, '--preview']), appliedBeforeLimit = (await evidence()).applied
    const full = await invoke([...token, '--confirm', capacityPlan.confirmation])
    assert.equal(full.statusCode, 429, full.body)
    assert.equal((await evidence()).applied, appliedBeforeLimit)
    assert.equal((await app.inject({ url: pendingResults[0].path, headers })).statusCode, 200)
    const freed = await success([...token, '--confirm', capacityPlan.confirmation])
    for (const result of [...pendingResults.slice(1), freed.result!]) assert.equal((await app.inject({ url: result.path, headers })).statusCode, 200)
    const batch = ['create', '/nodes/{node}/execute', '--protected-input']
    const batchInput = JSON.stringify({ api: { node: 'node', commands: JSON.stringify([
      { method: 'GET', path: 'version' },
      { method: 'POST', path: 'qemu/100/vncproxy' },
    ]) }, secrets: {} })
    await writes(true, inventory.writeOperations.filter(id => id !== 'OP-GET-22c6caf285'))
    const beforeDeniedBatch = (await evidence()).applied
    const deniedBatch = await invoke([...batch, '--preview'], batchInput)
    assert.equal(deniedBatch.statusCode, 400, deniedBatch.body)
    assert.equal(deniedBatch.json().error.code, 'FLAG_BLOCKED')
    assert.equal((await evidence()).applied, beforeDeniedBatch)
    await writes(true)
    db.exec('UPDATE delegation_settings SET minting_enabled = 1')
    const delegatedBatch = createDelegation(db, 'synthetic-development-user', { label: 'Synthetic batch scope',
      scope: { tools: [{ tool: 'proxmox-axi', commands: ['create *', 'get /nodes/{node}/version'] }] },
      readOnly: false, reusable: false, expiresAt: Date.now() + 60000 }, [adapter])
    const delegatedHeaders = { authorization: `Bearer ${exchangeDelegation(db, delegatedBatch.token).accessToken}` }
    const beforeScopedBatch = (await evidence()).applied
    for (const mode of [['--preview'], ['--confirm', `00000000-0000-4000-8000-000000000001.${'a'.repeat(64)}`]]) {
      const refused = await app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/run', headers: delegatedHeaders,
        payload: { args: [...batch, ...mode], stdin: batchInput } })
      assert.equal(refused.json().error.code, 'DELEGATED_SCOPE_DENIED', refused.body)
    }
    assert.equal((await evidence()).applied, beforeScopedBatch)
    const batchPlan = await success([...batch, '--preview'], batchInput)
    const batchResult = await success([...batch, '--confirm', batchPlan.confirmation], batchInput)
    const batchPrivate = await app.inject({ url: batchResult.result!.path, headers })
    assert.equal(batchPrivate.statusCode, 200)
    const batchPayload = JSON.parse(batchPrivate.rawPayload.subarray(4).toString('utf8')).payload
    assert.equal(batchPayload[0].data.repoid, 'synthetic-build')
    assert.equal(batchPayload[1].data.ticket, 'CANARY-vnc-ticket')
    const userPlan = await success([...userOnly, '--preview'], userInput), userBefore = (await evidence()).applied
    await success([...userOnly, '--confirm', userPlan.confirmation], userInput)
    assert.equal((await evidence()).applied, userBefore + 1)
    const retained = await success([...token, '--preview'])
    const result = await success([...token, '--confirm', retained.confirmation])
    await grants([])
    assert.equal((await invoke(['get', '/nodes'])).statusCode, 403)
    await grants(['proxmox-axi'])
    assert.equal((await app.inject({ url: result.result!.path, headers })).statusCode, 404)
    await success(['get', '/nodes'])
    assert.notEqual((await evidence()).nodeTickets.at(-1), first)
    db.exec(`INSERT INTO users (id,username,display_name,password_hash,must_change)
      SELECT 'synthetic-independent','independent-user','Independent',password_hash,0 FROM users WHERE id='synthetic-development-user';
      INSERT INTO roles (id,name) VALUES ('independent-role','Independent role');
      INSERT INTO user_roles (user_id,role_id) VALUES ('synthetic-independent','independent-role');
      INSERT INTO role_tools (role_id,tool) VALUES ('independent-role','proxmox-axi')`)
    const independent = await login('independent-user'), independentHeaders = { authorization: `Bearer ${independent.accessToken}` }
    await success(['get', '/nodes'], undefined, independentHeaders)
    const independentTicket = (await evidence()).nodeTickets.at(-1)
    await replace(password)
    await success(['get', '/nodes'], undefined, independentHeaders)
    const currentIndependentTicket = (await evidence()).nodeTickets.at(-1)
    assert.notEqual(currentIndependentTicket, independentTicket)
    await send('/__proxmox/control?auth=hold')
    const loginCount = (await evidence()).logins
    const acquiring = invoke(['get', '/nodes'])
    await send(`/__proxmox/logins?count=${loginCount + 1}`)
    await grants([])
    assert.deepEqual(readdirSync(calls), [])
    assert.equal((await acquiring).json().error.code, 'CANCELLED')
    await send('/__proxmox/control?auth=release')
    await success(['get', '/nodes'], undefined, independentHeaders)
    assert.equal((await evidence()).nodeTickets.at(-1), currentIndependentTicket)
    await grants(['proxmox-axi'])
    await success(['get', '/nodes'])
    await send('/__proxmox/control?mode=hold-read')
    const readCount = (await evidence()).nodeTickets.length, reading = invoke(['get', '/nodes'])
    await send(`/__proxmox/reads?count=${readCount + 1}`)
    await replace(password)
    assert.deepEqual(readdirSync(calls), [])
    assert.equal((await reading).json().error.code, 'CANCELLED')
    await replace({ origin, auth: 'password', userId: 'automation@pve', password: 'CANARY-proxmox-password' })
    const certificateProof = await recent()
    const inspected = await app.inject({ method: 'POST', url: '/v1/admin/tools/proxmox-axi/certificates/inspect',
      headers: certificateProof, payload: { endpointIndex: 0 } })
    assert.equal(inspected.statusCode, 200, inspected.body)
    const trusted = await app.inject({ method: 'POST', url: '/v1/admin/tools/proxmox-axi/certificates/trust',
      headers: await recent(), payload: { inspectionId: inspected.json().inspectionId, mode: 'ca' } })
    assert.equal(trusted.statusCode, 200, trusted.body)
    await success(['get', '/nodes'])
    await writes(true)
    const trustPlan = await success([...token, '--preview'])
    const trustResult = await success([...token, '--confirm', trustPlan.confirmation])
    const certificates = await app.inject({ url: '/v1/admin/tools/proxmox-axi/certificates', headers: await recent() })
    await send('/__proxmox/control?mode=hold-read')
    const trustedReadCount = (await evidence()).nodeTickets.length, trustedRead = invoke(['get', '/nodes'])
    await send(`/__proxmox/reads?count=${trustedReadCount + 1}`)
    const removed = await app.inject({ method: 'DELETE', url: '/v1/admin/tools/proxmox-axi/certificates', headers: await recent(),
      payload: { id: certificates.json().certificates[0].id } })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.deepEqual(readdirSync(calls), [])
    assert.equal((await trustedRead).json().error.code, 'CANCELLED')
    assert.equal((await app.inject({ url: trustResult.result!.path, headers })).statusCode, 404)
    await replace(password)
    await send('/__proxmox/control?auth=tfa')
    const tfa = await invoke(['get', '/nodes'])
    assert.equal(tfa.json().error.code, 'UPSTREAM_AUTH_FAILED', tfa.body)
    assert.match(tfa.body, /API token/); assert.doesNotMatch(tfa.body, /CANARY-|PVE:tfa/)
    await send('/__proxmox/control?auth=reject')
    const refused = await invoke(['get', '/nodes'])
    assert.equal(refused.json().error.code, 'UPSTREAM_AUTH_FAILED', refused.body)
    await send('/__proxmox/control?auth=ready')
    await success(['get', '/nodes'])
    const families: { accessToken: string }[] = []
    for (let index = 0; index < 3; index++) {
      const value = await login(); families.push(value)
      await success(['get', '/nodes'], undefined, { authorization: `Bearer ${value.accessToken}` })
    }
    const overflow = await login(), nodesBeforeLimit = (await evidence()).nodeTickets.length
    assert.equal((await invoke(['get', '/nodes'], undefined, { authorization: `Bearer ${overflow.accessToken}` })).statusCode, 429)
    assert.equal((await evidence()).nodeTickets.length, nodesBeforeLimit)
    const revoked = await app.inject({ method: 'POST',
      url: `/v1/admin/users/synthetic-development-user/sessions/${verifyAccessFamily(db, families[0].accessToken)}/revoke`,
      headers: await recent(), payload: {} })
    assert.equal(revoked.statusCode, 200, revoked.body)
    await success(['get', '/nodes'], undefined, { authorization: `Bearer ${overflow.accessToken}` })
    await grants([]); await grants(['proxmox-axi'])
    for (let user = 0; user < 16; user++) {
      const id = `capacity-${user}`
      db.prepare(`INSERT INTO users (id,username,display_name,password_hash,must_change)
        SELECT ?,?, ?,password_hash,0 FROM users WHERE id='synthetic-development-user'`).run(id, id, id)
      db.prepare('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)').run(id, 'synthetic-role')
      for (let family = 0; family < 4; family++) {
        const value = await login(id)
        await success(['get', '/nodes'], undefined, { authorization: `Bearer ${value.accessToken}` })
      }
    }
    const overflowGlobal = await login(), beforeGlobal = (await evidence()).nodeTickets.length
    assert.equal((await invoke(['get', '/nodes'], undefined, { authorization: `Bearer ${overflowGlobal.accessToken}` })).statusCode, 429)
    assert.equal((await evidence()).nodeTickets.length, beforeGlobal)
    await grants([]); await grants(['proxmox-axi'])
    await writes(true)
    await success(['get', '/nodes'])
    const beforeRestart = (await evidence()).nodeTickets.at(-1)
    await app.close(); closed = true
    runner = await Runner.create(calls); app = application(); closed = false
    await success(['get', '/nodes'])
    assert.notEqual((await evidence()).nodeTickets.at(-1), beforeRestart)
    await app.close(); closed = true
    runner = await Runner.create(calls)
    let now = Date.now()
    isolated = new ProxmoxAccess(db, resolver, runner, new ProtectedResults(), () => now)
    const dispatch = async (args: string[], after?: () => void) => {
      const credential = store.findCredential('proxmox-axi')!, prepared = await adapter.prepare(args, credential)
      return isolated!.execute({ userId: 'synthetic-development-user', familyId: verifyAccessFamily(db, session.accessToken),
        credential, requestId: 'synthetic-expiry' }, prepared,
      async limits => {
        const result = await runner.run('synthetic-development-user', prepared.executable, prepared.args, prepared.environment, prepared.secrets,
        { ...prepared.limits, publicContent: prepared.publicContent, credentialTrust: readCredentialTrust(db, credential), ...limits },
        {}, prepared.files, prepared.beforeSpawn)
        after?.()
        return result
      }, () => { throw new Error('Unexpected private result') })
    }
    const read = async () => {
      const result = await dispatch(['get', '/nodes'])
      assert.equal(result.exitCode, 0, result.stdout)
    }
    await read(); const cached = (await evidence()).nodeTickets.at(-1)
    await read(); assert.equal((await evidence()).nodeTickets.at(-1), cached)
    now += 300001
    await read(); assert.notEqual((await evidence()).nodeTickets.at(-1), cached)
    await send('/__proxmox/control?mode=hold-read')
    const expiryReadCount = (await evidence()).nodeTickets.length
    const expiring = read()
    const expired = assert.rejects(expiring, { code: 'CANCELLED' })
    await send(`/__proxmox/reads?count=${expiryReadCount + 1}`)
    now += 300001
    await isolated.reconcile()
    await expired
    const start = ['create', '/nodes/{node}/qemu/{vmid}/status/start', '--api-node', 'node', '--api-vmid', '100']
    const planned = await dispatch([...start, '--preview'])
    assert.equal(planned.exitCode, 0, planned.stdout)
    const plan = decode(planned.stdout) as Reply, appliedBeforeRace = (await evidence()).applied
    const revision = store.findCredential('proxmox-axi')!.revision!
    await assert.rejects(dispatch([...start, '--confirm', plan.confirmation], () => {
      store.replaceCredential('proxmox-axi', password, revision, 'synthetic-development-user', Date.now())
    }), { code: 'CANCELLED', processStarted: true })
    assert.equal((await evidence()).applied, appliedBeforeRace + 1)
    await isolated.close(); isolated = undefined
    assert.deepEqual(readdirSync(calls), [])
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-/)
    console.log(JSON.stringify({ proxmox: 'automatic authentication and protected results', package: inventory.version,
      authentication: 'managed credential, automatic reuse, family isolation, TFA refusal, expiry and restart',
      results: 'native frame, private CLI descriptor, one-shot retrieval, family and grant isolation', cleanup: 'verified' }))
  } finally {
    await isolated?.close()
    if (!closed) await app.close()
    await runner.shutdown(); db.close()
  }
})
