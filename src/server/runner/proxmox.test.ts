import { watch } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { PreparedCall } from '../adapters/types.js'
import { acquireProxmox, ProxmoxAccess } from './proxmox.js'
import { Runner, type RunnerResult } from './runner.js'
import { runnerLimits } from '../config.js'
import { createCredentialStore, openStore } from '../store/db.js'
import { EnvironmentKeyProvider } from '../store/key-provider.js'
import { SharedIdentityResolver } from '../policy/identity-resolver.js'
import { ProtectedResults } from '../protected-results.js'
import { proxmoxProfile } from '../adapters/proxmox.js'
import { createDelegation } from '../auth/delegations.js'
import { exchangeDelegation, verifyPrincipal } from '../auth/tokens.js'
import { issueTestAccessToken, seedToolUser } from '../../../test/fixtures/tokens.js'

let root: string
let runner: Runner
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-proxmox-test-'))
  runner = await Runner.create(join(root, 'calls'))
})
afterEach(async () => {
  await runner.shutdown()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

function prepared(script: string): PreparedCall {
  return { executable: process.execPath, args: ['auth.mjs'], environment: {
    PROXMOX_AXI_REQUEST_ID: 'synthetic-request', PROXMOX_AXI_ACTOR: 'synthetic-actor',
    PROXMOX_AXI_CREDENTIAL_REVISION: 'synthetic:1',
  }, files: [{ name: 'auth.mjs', content: script }], secrets: [], limits: { timeoutMs: 5000 },
  proxmox: { origin: 'https://synthetic.invalid', identity: 'automation@pve', password: true, authenticate: true } }
}

async function withAccess(check: (execute: (delegated: boolean) => Promise<RunnerResult>) => Promise<void>) {
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') })
  const db = openStore(join(root, 'store.db'), provider)
  await seedToolUser(db)
  db.exec("UPDATE tools SET enabled = 1 WHERE name = 'proxmox-axi'; UPDATE delegation_settings SET minting_enabled = 1")
  const store = createCredentialStore(db, provider), userId = 'synthetic-development-user'
  const password = { origin: 'https://synthetic.invalid', auth: 'password', userId: 'automation@pve', password: 'CANARY-password' }
  const credential = store.replaceCredential('proxmox-axi', password, 0, userId, Date.now())
  const results = new ProtectedResults()
  const access = new ProxmoxAccess(db, new SharedIdentityResolver(store), runner, results)
  const delegation = createDelegation(db, userId, { label: 'Synthetic', scope: { tools: [{ tool: 'proxmox-axi' }] },
    readOnly: true, reusable: true, expiresAt: Date.now() + 600_000 })
  const execute = (delegated: boolean) => {
    const token = delegated ? exchangeDelegation(db, delegation.token).accessToken : issueTestAccessToken(db, userId)
    const familyId = verifyPrincipal(db, token).familyId
    const call = prepared(`import {writeSync} from 'node:fs';
      const binding={origin:'https://synthetic.invalid',identity:'automation@pve',operation:'auth acquire',
        request:process.env.PROXMOX_AXI_REQUEST_ID,actor:process.env.PROXMOX_AXI_ACTOR,
        credentialRevision:process.env.PROXMOX_AXI_CREDENTIAL_REVISION};
      const payload={session:'00000000-0000-4000-8000-000000000001',state:'ready',expires:Date.now()+240000,
        ticket:'CANARY-ticket',csrfPreventionToken:'CANARY-csrf'};
      const bytes=Buffer.from(JSON.stringify({version:1,binding,payload})),header=Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);writeSync(Number(process.env.PROXMOX_AXI_RESULT_FD),Buffer.concat([header,bytes]));`)
    const profile = proxmoxProfile.prepare('proxmox-axi', password, undefined, true)
    call.files.push(...profile.files)
    Object.assign(call.environment, profile.environment)
    call.secrets.push(...profile.secrets)
    return access.execute({ userId, familyId, credential, delegated, requestId: 'synthetic-request' }, call,
      limits => runner.run(userId, process.execPath, ['-e', 'console.log("synthetic result")'], {}, [], { ...limits, delegated }), () => {})
  }
  try { await check(execute) }
  finally { await access.close(); results.clear(); db.close() }
}

test('delegated cached Proxmox sessions preserve two creator slots (R9)', async () => {
  await withAccess(async execute => {
    await expect(execute(true)).resolves.toMatchObject({ stdout: 'synthetic result\n' })
    await expect(execute(true)).resolves.toMatchObject({ stdout: 'synthetic result\n' })
    await expect(execute(true)).rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
    await expect(execute(true)).rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
    await expect(execute(false)).resolves.toMatchObject({ stdout: 'synthetic result\n' })
    await expect(execute(false)).resolves.toMatchObject({ stdout: 'synthetic result\n' })
    await expect(execute(false)).rejects.toMatchObject({ code: 'TOO_MANY_CALLS' })
  })
})

test('delegated pending Proxmox sessions preserve creator admission (R9)', async () => {
  await withAccess(async execute => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const held = [runner.runManaged('synthetic-development-user', undefined, () => gate, true),
      runner.runManaged('synthetic-development-user', undefined, () => gate, true)]
    const pending = [execute(true), execute(true)]
    const refused = execute(true).catch(error => error)
    const creator = execute(false)
    try {
      await expect(Promise.race([refused, creator])).resolves.toMatchObject({ code: 'TOO_MANY_CALLS' })
      await expect(creator).resolves.toMatchObject({ stdout: 'synthetic result\n' })
    } finally {
      release()
      await Promise.all([...held, ...pending, refused, creator])
    }
  })
})

test('delegated authentication cannot occupy a third creator slot', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = new AbortController(), second = new AbortController()
  const hold = (signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  const active = [runner.runManaged('synthetic-user', first.signal, hold, true),
    runner.runManaged('synthetic-user', second.signal, hold, true)]
  const pending = acquireProxmox(runner, 'synthetic-user', prepared('process.exit(1)'), [], undefined, () => {}, true)
    .catch(error => error)
  await vi.advanceTimersByTimeAsync(runnerLimits.admissionWaitMs)
  expect(await pending).toMatchObject({ code: 'TOO_MANY_CALLS', processStarted: false })
  first.abort(); second.abort()
  await Promise.all(active)
})

test.each([
  ['AUTH_REQUIRED', 'UPSTREAM_AUTH_FAILED', 'authentication'],
  ['SERVER_UNREACHABLE', 'UPSTREAM_NETWORK_FAILED', 'TCP'],
  ['TLS_UNTRUSTED', 'UPSTREAM_TLS_FAILED', 'TLS'],
  ['AUTH_RESPONSE_INVALID', 'UPSTREAM_RESPONSE_INVALID', 'response'],
])('automatic acquisition preserves native %s failures', async (toolCode, code, stage) => {
  const call = prepared(`console.log(JSON.stringify({error:{code:${JSON.stringify(toolCode)},message:'Synthetic failure'}})); process.exitCode=1`)
  await expect(acquireProxmox(runner, 'synthetic-user', call, [], undefined, () => {}))
    .rejects.toMatchObject({ code, diagnostic: { stage, toolCode } })
})

test('cancelling an authentication child does not mark the requested operation as started', async () => {
  const controller = new AbortController()
  const watcher = watch(root, (_event, name) => { if (name === 'ready') controller.abort() })
  const call = prepared(`import {writeFileSync} from 'node:fs';
    writeFileSync(process.env.READY_FILE,'ready'); setInterval(()=>{},1000)`)
  call.environment.READY_FILE = join(root, 'ready')
  try {
    await expect(acquireProxmox(runner, 'synthetic-user', call, [], controller.signal, () => {}))
      .rejects.toMatchObject({ code: 'CANCELLED', processStarted: false })
  } finally { watcher.close() }
})

test('automatic acquisition still returns a ready ticket from the private channel', async () => {
  const expires = Date.now() + 240000
  const call = prepared(`import {writeSync} from 'node:fs';
    const binding={origin:'https://synthetic.invalid',identity:'automation@pve',operation:'auth acquire',
      request:process.env.PROXMOX_AXI_REQUEST_ID,actor:process.env.PROXMOX_AXI_ACTOR,
      credentialRevision:process.env.PROXMOX_AXI_CREDENTIAL_REVISION};
    const payload={session:'00000000-0000-4000-8000-000000000001',state:'ready',expires:${expires},
      ticket:'CANARY-ticket',csrfPreventionToken:'CANARY-csrf'};
    const bytes=Buffer.from(JSON.stringify({version:1,binding,payload})),header=Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);writeSync(Number(process.env.PROXMOX_AXI_RESULT_FD),Buffer.concat([header,bytes]));`)
  await expect(acquireProxmox(runner, 'synthetic-user', call, [], undefined, () => {}))
    .resolves.toEqual({ ticket: 'CANARY-ticket', csrfPreventionToken: 'CANARY-csrf', expires })
})
