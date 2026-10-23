import { request } from 'node:https'

// Preserve the published origin policy while redirecting only test sockets.
const target = new URL(process.env.ARTIUM_TEST_HYBRID_ORIGIN)
if (target.protocol !== 'https:' || target.hostname !== 'localhost') throw new Error('Expected local fake Hybrid Analysis')
globalThis.fetch = async (input, options) => {
  const original = new Request(input, options)
  const url = new URL(original.url)
  if (url.origin !== 'https://hybrid-analysis.com') throw new Error('Unexpected fake Hybrid Analysis origin')
  const bytes = Buffer.from(await original.arrayBuffer())
  return new Promise((resolve, reject) => {
    const req = request(new URL(url.pathname + url.search, target), {
      servername: target.hostname, method: original.method, signal: options?.signal,
      headers: { ...Object.fromEntries(original.headers), host: url.host },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
        status: res.statusCode, headers: res.headers,
      })))
    })
    req.on('error', reject)
    req.end(bytes)
  })
}
