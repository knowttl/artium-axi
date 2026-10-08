import assert from 'node:assert/strict'
import { lookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'

const hosts = JSON.parse(process.env.ARTIUM_TEST_HOSTS)
for (const host of hosts) {
  assert.ok((await lookup(host)).address)
  assert.equal((await fetch(`https://${host}/`, { signal: AbortSignal.timeout(3000) })).status, 200)
}
assert.ok(!readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)
  .some(line => line.split(/\s+/)[1] === '00000000'), 'Isolated client must have no default IPv4 route')
await assert.rejects(new Promise((resolve, reject) => {
  const socket = createConnection({ host: process.env.ARTIUM_TEST_OUTSIDE_IP, port: 443 })
  socket.once('connect', () => { socket.destroy(); resolve() })
  socket.once('error', reject)
  socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Synthetic outside TCP connection denied')) })
}))

const { sendRequest, requestAll } = await import('/work/tools/node_modules/@knowttl/az-axi/dist/lib/client.js')
const { runWithEffect } = await import('/work/tools/node_modules/@knowttl/az-axi/dist/lib/registry.js')
const profile = { name: 'synthetic', auth: 'token', subscriptions: ['synthetic-subscription'],
  writeSubscriptions: ['synthetic-subscription'], allowWrites: true }
await sendRequest(profile, { path: '/subscriptions', apiVersion: '2022-12-01' })
await sendRequest(profile, { path: '/redirect', apiVersion: '2022-12-01' })
await sendRequest(profile, { path: '/cross-redirect', apiVersion: '2022-12-01' })
await requestAll(profile, { path: '/page', apiVersion: '2022-12-01' })
await assert.rejects(runWithEffect('write', () => sendRequest(profile, {
  method: 'PATCH', path: '/subscriptions/synthetic-subscription/resourceGroups/synthetic',
  apiVersion: '2022-12-01', body: { tags: { synthetic: 'yes' } }, execute: true,
})), error => error.httpStatus === 503)
const evidence = await (await fetch('https://management.azure.com/__evidence')).json()
assert.ok(evidence.requests.some(req => req.host === 'management.azure.com' && req.canaryReceived))
assert.equal(evidence.mutations, 2, 'Pinned az-axi retries an uncertain write; write capability remains unavailable')
assert.ok(evidence.requests.some(req => req.host === 'graph.microsoft.com' && !req.canaryReceived))
console.log(JSON.stringify({ tls: 'trusted', dns: 'routed', outbound: 'denied',
  mutationRequests: evidence.mutations, requests: evidence.requests }))
