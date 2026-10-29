import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const target = new URL(process.env.ARTIUM_TEST_BEYONDTRUST_ORIGIN)
if (target.protocol !== 'https:' || target.hostname !== 'localhost') throw new Error('Expected local BeyondTrust fake')
const request = https.request
https.request = (input, options, listener) => {
  const url = new URL(input)
  if (url.origin !== 'https://example.pm.beyondtrustcloud.com') throw new Error('Unexpected BeyondTrust origin')
  return request(new URL(url.pathname + url.search, target), { ...options, servername: target.hostname,
    headers: { ...options.headers, host: url.host } }, listener)
}
globalThis.fetch = () => { throw new Error('Unexpected fetch in BeyondTrust fake') }
syncBuiltinESMExports()
