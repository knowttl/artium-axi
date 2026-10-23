import { request } from 'node:https'

// The published client keeps its fixed origin; only this test preload redirects sockets.
const target = new URL(process.env.ARTIUM_TEST_TENABLE_ORIGIN)
if (target.protocol !== 'https:' || target.hostname !== 'localhost') throw new Error('Expected local fake Tenable')
globalThis.fetch = (input, options) => {
  const url = new URL(input)
  if (url.origin !== 'https://cloud.tenable.com') throw new Error('Unexpected fake Tenable origin')
  return new Promise((resolve, reject) => {
    const req = request(new URL(url.pathname + url.search, target), {
      servername: target.hostname,
      method: options?.method, signal: options?.signal, headers: { ...options?.headers, host: url.host },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode, headers: { 'content-type': 'application/json' },
      })))
    })
    req.on('error', reject)
    req.end(options?.body)
  })
}
