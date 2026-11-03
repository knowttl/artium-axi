import { watch } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { PreparedCall } from '../adapters/types.js'
import { acquireProxmox } from './proxmox.js'
import { Runner } from './runner.js'

let root: string
let runner: Runner
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'artium-proxmox-test-'))
  runner = await Runner.create(join(root, 'calls'))
})
afterEach(async () => {
  await runner.shutdown()
  await rm(root, { recursive: true, force: true })
})

function prepared(script: string): PreparedCall {
  return { executable: process.execPath, args: ['auth.mjs'], environment: {
    PROXMOX_AXI_REQUEST_ID: 'synthetic-request', PROXMOX_AXI_ACTOR: 'synthetic-actor',
    PROXMOX_AXI_CREDENTIAL_REVISION: 'synthetic:1',
  }, files: [{ name: 'auth.mjs', content: script }], secrets: [], limits: { timeoutMs: 5000 },
  proxmox: { origin: 'https://synthetic.invalid', identity: 'automation@pve', password: true, authenticate: true } }
}

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
