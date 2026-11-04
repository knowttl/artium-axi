import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from '@toon-format/toon'
import { withFakeService } from './fixture.js'
import { createProxmoxAdapter } from '../../src/server/adapters/proxmox.js'
import { Runner } from '../../src/server/runner/runner.js'
import { createApp } from '../../src/server/app.js'
import { Audit } from '../../src/server/audit/audit.js'
import { createCredentialStore, openStore } from '../../src/server/store/db.js'
import { EnvironmentKeyProvider } from '../../src/server/store/key-provider.js'
import { EmbeddedSecretSource } from '../../src/server/store/secret-source.js'
import { SharedIdentityResolver } from '../../src/server/policy/identity-resolver.js'
import { seedToolUser } from '../fixtures/tokens.js'
import { SessionStore, sessionPath } from '../../src/cli/session.js'
import inventory from '../../tools/inventories/proxmox-axi.json' with { type: 'json' }

assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).some(line => line.split(/\s+/)[1] === '00000000'))
await withFakeService(async ({ directory, port, send }) => {
  const origin = `https://localhost:${port}`, log = join(directory, 'journal', 'writes.log')
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(directory, 'proxmox.db'), provider), store = createCredentialStore(db, provider)
  await seedToolUser(db)
  db.exec("UPDATE users SET administrator = 1; UPDATE tools SET enabled = 1 WHERE name = 'proxmox-axi'")
  store.replaceCredential('proxmox-axi', { origin, auth: 'api-token', tokenId: 'reader@pve!automation', token: 'CANARY-proxmox-token',
    caBundle: readFileSync(join(directory, 'ca.crt'), 'utf8') }, 0, 'synthetic-development-user', Date.now())
  let runner = await Runner.create(join(directory, 'calls')), terminal: (() => void) | undefined
  const application = () => createApp({ db, runner, credentialStore: store, environment: {},
    audit: new Audit(db, Date.now, line => { const event = JSON.parse(line); if (event.event === 'run-terminal' && event.outcome === 'UNKNOWN_OUTCOME') terminal?.() }),
    adapters: [createProxmoxAdapter(new EmbeddedSecretSource(store), log)], resolver: new SharedIdentityResolver(store) })
  let app = application()
  try {
    const login = async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'synthetic-user', password: 'CANARY-local-password' } })
      assert.equal(response.statusCode, 200, response.body); return response.json()
    }
    const session = await login(), headers = { authorization: `Bearer ${session.accessToken}` }
    const invoke = (args: string[], stdin?: string, proof = headers) => app.inject({ method: 'POST', url: '/v1/tools/proxmox-axi/run', headers: proof,
      payload: { args, ...(stdin === undefined ? {} : { stdin }) } })
    type Reply = { id: string, confirmation: string, status: string, upid: string,
      journal: { status: string, observation?: { desiredStateObserved: boolean } }, error?: { code: string } }
    const native = async (args: string[], stdin?: string, proof = headers) => {
      const response = await invoke(args, stdin, proof)
      assert.equal(response.statusCode, 200, response.body)
      assert.doesNotMatch(response.body, /CANARY-|ARTIUM_SECRET_|\/opt\/tools|\/tmp\/artium/)
      const result = response.json()
      return { code: result.exitCode as number, value: (result.stdout.trimStart().startsWith('{') ? JSON.parse(result.stdout) : decode(result.stdout)) as Reply }
    }
    const success = async (args: string[], stdin?: string) => {
      const result = await native(args, stdin); assert.equal(result.code, 0, JSON.stringify(result)); return result.value
    }
    const settings = async (enabled: boolean, nativeOperations = inventory.writeOperations, hostOperations = inventory.writeOperations) => {
      const auth = await app.inject({ method: 'POST', url: '/v1/auth/reauth', headers, payload: { password: 'CANARY-local-password' } })
      assert.equal(auth.statusCode, 200, auth.body)
      const proof = { ...headers, 'x-artium-reauth-ticket': auth.json().ticket }
      const current = await app.inject({ url: '/v1/admin/tools/proxmox-axi', headers: proof })
      assert.equal(current.statusCode, 200, current.body)
      const response = await app.inject({ method: 'PATCH', url: '/v1/admin/tools/proxmox-axi', headers: proof, payload: {
        expectedRevision: current.json().revision, nativeSettings: { writes: { operations: nativeOperations }, hostWrites: { allowWrites: enabled, operations: hostOperations } },
      } })
      assert.equal(response.statusCode, 200, response.body)
    }
    const evidence = async () => JSON.parse(await send('/__proxmox/evidence')) as { applied: number, attempts: number, scans: number, secretReceived: boolean }
    const start = ['create', '/nodes/{node}/qemu/{vmid}/status/start', '--api-node', 'node', '--api-vmid', '100']
    const confirm = (args: string[], preview: Reply) => [...args, '--confirm', preview.confirmation]
    await success(['get', '/version'])
    for (const flag of ['--version', '-v', '-V']) {
      const response = await invoke([flag])
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().exitCode, 0, response.body)
      assert.equal(response.json().stdout.trim(), inventory.version)
    }
    assert.equal((await invoke([...start, '--preview'])).json().error.code, 'FLAG_BLOCKED')
    await settings(true, [])
    assert.equal((await native([...start, '--preview'])).value.error?.code, 'WRITE_DISABLED')
    await settings(false)
    assert.equal((await invoke([...start, '--preview'])).json().error.code, 'FLAG_BLOCKED')
    await settings(true)
    const preview = await success([...start, '--preview'])
    assert.equal((await evidence()).applied, 0)
    assert.equal((await native([...start.slice(0, -1), '101', '--confirm', preview.confirmation])).value.error?.code, 'CONFIRMATION_MISMATCH')
    const other = { authorization: `Bearer ${(await login()).accessToken}` }
    assert.equal((await native(confirm(start, preview), undefined, other)).value.error?.code, 'CONFIRMATION_MISMATCH')
    const concurrent = await Promise.all([native(confirm(start, preview)), native(confirm(start, preview))])
    assert.equal(concurrent.filter(result => result.code === 0).length, 1)
    assert.equal(concurrent.find(result => result.code !== 0)!.value.error?.code, 'CONFIRMATION_USED')
    assert.equal((await evidence()).applied, 1)
    const accepted = concurrent.find(result => result.code === 0)!.value
    assert.equal(accepted.status, 'accepted')
    const task = ['--api-node', 'node', '--api-upid', accepted.upid, '--journal', preview.id]
    assert.equal((await success(['task', 'status', ...task])).status, 'success')
    await success(['task', 'log', ...task])
    assert.equal((await success(['task', 'wait', ...task, '--wait-ms', '1000'])).status, 'success')
    assert.equal((await success(['journal', 'reconcile', preview.id])).journal.status, 'success')
    assert.equal((await native(['journal', 'show', preview.id], undefined, other)).value.error?.code, 'PERMISSION_DENIED')
    const update = ['set', '/nodes/{node}/qemu/{vmid}/config', '--protected-input']
    const body = (description: string, password = 'CANARY-protected-input') => JSON.stringify({ api: {
      node: 'node', vmid: 100, description, cipassword: { env: 'PVE_INPUT_PASSWORD' },
    }, secrets: { PVE_INPUT_PASSWORD: password } })
    for (const password of ['a', 'success']) {
      const input = body('Synthetic configuration', password), plan = await success([...update, '--preview'], input)
      assert.equal((await success(confirm(update, plan), input)).status, 'success')
    }
    assert.equal((await evidence()).applied, 3)
    const changed = await success([...update, '--preview'], body('Original description'))
    assert.equal((await native(confirm(update, changed), body('Changed description'))).value.error?.code, 'CONFIRMATION_MISMATCH')
    await send('/__proxmox/control?version=8.2.7')
    assert.equal((await native(confirm(update, changed), body('Original description'))).value.error?.code, 'CONFIRMATION_MISMATCH')
    await send('/__proxmox/control?version=9.2.0')
    const lost = await success([...update, '--preview'], body('Lost acknowledgement'))
    await send('/__proxmox/control?mode=drop')
    assert.equal((await native(confirm(update, lost), body('Lost acknowledgement'))).value.error?.code, 'WRITE_UNCERTAIN')
    const observed = await success(['journal', 'reconcile', lost.id])
    assert.equal(observed.journal.status, 'uncertain')
    assert.equal(observed.journal.observation?.desiredStateObserved, true)
    assert.equal((await native(confirm(update, lost), body('Lost acknowledgement'))).value.error?.code, 'CONFIRMATION_USED')
    assert.equal((await evidence()).applied, 4)
    const rejected = await success([...start, '--preview'])
    await send('/__proxmox/control?mode=reject')
    assert.equal((await native(confirm(start, rejected))).value.error?.code, 'PERMISSION_DENIED')
    assert.equal((await success(['journal', 'show', rejected.id])).journal.status, 'failed')
    assert.equal((await native(confirm(start, rejected))).value.error?.code, 'CONFIRMATION_USED')
    assert.equal((await evidence()).applied, 4)
    const scan = ['get', '/nodes/{node}/scan/cifs', '--protected-input']
    const scanBody = JSON.stringify({ api: { node: 'node', server: 'storage.invalid', username: 'synthetic-reader', password: { env: 'PVE_INPUT_PASSWORD' } },
      secrets: { PVE_INPUT_PASSWORD: 'CANARY-protected-input' } })
    const scanPlan = await success([...scan, '--preview'], scanBody)
    assert.equal((await evidence()).scans, 0)
    await success(confirm(scan, scanPlan), scanBody)
    assert.equal((await evidence()).scans, 1)
    const batch = ['create', '/nodes/{node}/execute', '--protected-input']
    const batchBody = JSON.stringify({ api: { node: 'node', commands: JSON.stringify([
      { method: 'POST', path: 'qemu/100/status/start' }, { method: 'PUT', path: 'qemu/100/config', args: { description: 'Batch configuration' } },
    ]) }, secrets: {} })
    const batchPlan = await success([...batch, '--preview'], batchBody)
    await settings(true, inventory.writeOperations, ['OP-POST-c4fdd6f30b'])
    assert.equal((await invoke([...batch, '--preview'], batchBody)).json().error.code, 'FLAG_BLOCKED')
    await settings(true)
    const freshBatch = await success([...batch, '--preview'], batchBody)
    await success(confirm(batch, freshBatch), batchBody)
    assert.equal((await evidence()).applied, 7)
    assert.equal((await native(confirm(batch, batchPlan), batchBody)).value.error?.code, 'CONFIRMATION_MISMATCH')
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const environment = { ...process.env, ARTIUM_AXI_URL: address, ARTIUM_AXI_TEST_HTTP: '1', XDG_CONFIG_HOME: join(directory, 'client') }
    new SessionStore(address, sessionPath(process.platform, environment)).write(session)
    const cliInput = body('CLI configuration')
    const cli = await new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
      const child = execFile(process.execPath, ['/work/dist/cli/artium-axi.mjs', 'proxmox-axi', ...update, '--preview'],
        { env: environment, timeout: 30000 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
      child.stdin!.end(cliInput)
    })
    assert.doesNotMatch(cli.stdout + cli.stderr, /CANARY-|ARTIUM_SECRET_|\/tmp\//)
    await success(confirm(update, decode(cli.stdout) as Reply), cliInput)
    assert.equal((await evidence()).applied, 8)
    const cancel = ['task', 'cancel', '--api-node', 'node', '--api-upid', accepted.upid]
    const cancelPlan = await success([...cancel, '--preview'])
    await success(confirm(cancel, cancelPlan))
    assert.equal((await evidence()).applied, 9)
    const interruptedBody = body('Interrupted configuration'), interrupted = await success([...update, '--preview'], interruptedBody)
    await send('/__proxmox/control?mode=hold')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const settled = new Promise<void>((resolve, reject) => { terminal = resolve; timer = setTimeout(() => reject(new Error('Cancellation did not settle')), 15000) })
    const pending = fetch(address + '/v1/tools/proxmox-axi/run', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ args: confirm(update, interrupted), stdin: interruptedBody }), signal: controller.signal })
    await send('/__proxmox/applied?count=10')
    controller.abort()
    await assert.rejects(pending)
    try { await settled } finally { clearTimeout(timer!); terminal = undefined }
    const interruptedStatus = (await success(['journal', 'show', interrupted.id])).journal.status
    // Termination may precede the native catch that records an uncertain response.
    assert.ok(['intent', 'uncertain'].includes(interruptedStatus), interruptedStatus)
    assert.equal((await native(confirm(update, interrupted), interruptedBody)).value.error?.code, 'CONFIRMATION_USED')
    assert.equal((await evidence()).applied, 10)
    for (const route of inventory.commands.filter(route => route.effect === 'write')) await success([...route.command.split(' '), '--help'])
    for (const args of [['auth', 'acquire'], ['transfer', 'get', '/nodes/{node}/rrd'], ['create', '/access/users/{userid}/token/{tokenid}'],
      [...start, '--body-file', '/etc/passwd'], [...start, '--api-password=CANARY-caller'], ['get', '/version', '--profile=other']]) assert.ok((await invoke(args)).statusCode >= 400)
    const unsafe = JSON.stringify({ api: { node: 'node', vmid: 100, cipassword: { file: '/etc/passwd' } }, secrets: {} })
    assert.equal((await invoke([...update, '--preview'], unsafe)).json().error.code, 'FLAG_BLOCKED')
    await app.close()
    runner = await Runner.create(join(directory, 'calls')); app = application()
    assert.equal((await success(['journal', 'show', interrupted.id])).journal.status, interruptedStatus)
    const stale = await success([...start, '--preview'])
    await settings(false)
    assert.equal((await invoke(confirm(start, stale))).json().error.code, 'FLAG_BLOCKED')
    await settings(true)
    assert.equal((await native(confirm(start, stale))).value.error?.code, 'CONFIRMATION_MISMATCH')
    db.prepare("DELETE FROM role_tools WHERE tool = 'proxmox-axi'").run()
    assert.equal((await invoke(['get', '/version'])).statusCode, 403)
    const records = readdirSync(log + '.d', { recursive: true }).filter(path => String(path).endsWith('.json'))
      .map(path => readFileSync(join(log + '.d', String(path)), 'utf8')).join('\n')
    assert.doesNotMatch(records + JSON.stringify(db.prepare('SELECT * FROM audit').all()), /CANARY-|Original description|CLI configuration|Interrupted configuration/)
    assert.deepEqual(readdirSync(join(directory, 'calls')), [])
    assert.equal((await evidence()).secretReceived, true)
    console.log(JSON.stringify({ proxmox: '0.1.3', grants: 'independent native and host exact operations', confirmation: 'one-shot, concurrent and revision-bound',
      recovery: 'durable journal, tasks, rejection, uncertainty, child cancellation and restart without resend', input: 'private SecretRefs and short-secret protocol compatibility', cleanup: 'verified' }))
  } finally { await app.close(); db.close(); await runner.shutdown() }
})
