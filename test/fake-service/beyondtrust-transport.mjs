import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { writeFileSync } from 'node:fs'

const target = new URL(process.env.ARTIUM_TEST_BEYONDTRUST_ORIGIN)
if (target.protocol !== 'https:' || target.hostname !== 'localhost') throw new Error('Expected local BeyondTrust fake')
const request = https.request
const interruption = process.env.ARTIUM_TEST_BEYONDTRUST_INTERRUPTION
if (interruption === 'before-intent-crash') process.kill(process.pid, 'SIGKILL')
if (interruption === 'native-deadline') {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  AbortSignal.timeout = milliseconds => timeout(milliseconds === 60_000 ? 1000 : milliseconds)
}
https.request = (input, options, listener) => {
  const url = new URL(input)
  if (url.origin !== 'https://example.pm.beyondtrustcloud.com') throw new Error('Unexpected BeyondTrust origin')
  const stall = interruption && options.method !== 'GET' && url.pathname.startsWith('/management-api/')
  return request(new URL(url.pathname + url.search, target), { ...options, servername: target.hostname,
    headers: { ...options.headers, host: url.host,
      ...(process.env.ARTIUM_TEST_BEYONDTRUST_INVALID_RESPONSE ? { 'x-artium-test-beyondtrust-invalid-response': '1' } : {}),
      ...(stall ? { 'x-artium-test-beyondtrust-stall': '1' } : {}) } }, response => {
    if (stall) {
      writeFileSync(process.env.ARTIUM_TEST_BEYONDTRUST_COMMITTED, 'committed')
      if (interruption === 'crash') process.kill(process.pid, 'SIGKILL')
      if (interruption === 'exit') process.exit(7)
    }
    listener(response)
  })
}
globalThis.fetch = () => { throw new Error('Unexpected fetch in BeyondTrust fake') }
syncBuiltinESMExports()
