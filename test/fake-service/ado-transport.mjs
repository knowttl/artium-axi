import { request } from 'node:https'

globalThis.fetch = (input, options) => {
  const url = new URL(input)
  if (url.protocol !== 'https:' || !['dev.azure.com', 'vsrm.dev.azure.com', 'vssps.dev.azure.com', 'almsearch.dev.azure.com'].includes(url.hostname)) {
    throw new Error('Unexpected fake Azure DevOps origin')
  }
  // Node fetch rewrites Host to the redirected destination. Use HTTPS directly
  // so the fake service sees the original ADO host and still verifies its CA.
  const target = new URL(url.pathname + url.search, process.env.ARTIUM_TEST_ADO_ORIGIN)
  return new Promise((resolve, reject) => {
    const req = request(target, {
      servername: target.hostname,
      method: options?.method, signal: options?.signal, headers: { ...options?.headers, host: url.host,
        ...(options?.body !== undefined ? { 'content-length': Buffer.byteLength(options.body) } : {}) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode, headers: { 'content-type': res.headers['content-type'] ?? 'application/json' },
      })))
    })
    req.on('error', reject)
    req.end(options?.body)
  })
}
