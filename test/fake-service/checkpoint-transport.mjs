import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { REGIONS } from '../../tools/node_modules/@knowttl/checkpoint-axi/dist/src/regions.js'

// Redirect the real pinned transport only at its HTTPS boundary. Unknown origins
// fail locally; this preload cannot contact a regional service.
const target = new URL(process.env.ARTIUM_TEST_CHECKPOINT_ORIGIN)
if (target.protocol !== 'https:' || target.hostname !== 'localhost') throw new Error('Expected local Check Point fake')
const request = https.request
https.request = (input, options, listener) => {
  const url = new URL(input)
  if (!Object.values(REGIONS).includes(url.origin)) throw new Error('Unexpected Check Point origin')
  return request(new URL(url.pathname + url.search, target), { ...options, servername: target.hostname,
    headers: { ...options.headers, host: url.host } }, listener)
}
syncBuiltinESMExports()
