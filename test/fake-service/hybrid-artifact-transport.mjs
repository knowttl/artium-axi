import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

// Network boundary for the installed native executable in the no-network probe.
// Native catalogue, profile, confirmation, journal and publication remain real.
let requests = 0
const size = Number(process.env.ARTIUM_TEST_ARTIFACT_BYTES)
assert.ok(Number.isSafeInteger(size) && size >= 0)
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options)
  const url = new URL(request.url)
  assert.equal(url.origin, 'https://hybrid-analysis.com')
  assert.equal(request.method, 'GET')
  assert.equal(request.headers.get('api-key'), 'CANARY-artifact-key')
  if (url.pathname === '/api/v2/key/current') {
    return Response.json({ auth_level_name: 'default' })
  }
  assert.match(url.pathname, /^\/api\/v2\/overview\/[a-f0-9]{64}\/sample$/)
  requests++
  let remaining = size
  return new Response(new ReadableStream({ pull(controller) {
    if (!remaining) { controller.close(); return }
    const count = Math.min(remaining, 1024 * 1024)
    controller.enqueue(new Uint8Array(count).fill(0xa5))
    remaining -= count
  } }), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
}
process.once('exit', () => writeFileSync(process.env.ARTIUM_TEST_RSS_FILE,
  JSON.stringify({ maxRssBytes: process.resourceUsage().maxRSS * 1024, bytes: size, requests })))
