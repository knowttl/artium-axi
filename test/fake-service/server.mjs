import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const requests = []
let mutations = 0
const certs = process.argv[2] ?? '/certs'
const server = createServer({ key: readFileSync(join(certs, 'server.key')), cert: readFileSync(join(certs, 'server.crt')) }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`)
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/__evidence') {
    res.end(JSON.stringify({ requests, mutations }))
    return
  }
  requests.push({ method: req.method, host: req.headers.host, path: url.pathname,
    canaryReceived: /CANARY-/.test(req.headers.authorization ?? '') })
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'https://management.azure.com/subscriptions' })
    res.end()
  } else if (url.pathname === '/cross-redirect') {
    res.writeHead(302, { location: 'https://graph.microsoft.com/subscriptions' })
    res.end()
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    mutations++
    if (url.pathname === '/api/v2.5/tagging/detection/42') res.end(JSON.stringify({ tags: ['synthetic'] }))
    else {
      res.writeHead(503, { 'retry-after': '0' })
      res.end(JSON.stringify({ error: { code: 'SyntheticAmbiguousWrite', message: 'Mutation recorded before response failed' } }))
    }
  } else if (url.pathname.startsWith('/api/v2.5/tagging/')) {
    res.end(JSON.stringify({ tags: [] }))
  } else if (url.pathname === '/page') {
    res.end(JSON.stringify({ value: [], nextLink: 'https://management.azure.com/subscriptions?api-version=2022-12-01' }))
  } else if (url.pathname.startsWith('/api/v2.5/detections')) {
    res.end(JSON.stringify({ count: 0, results: [], next: null }))
  } else {
    res.end(JSON.stringify({ value: [] }))
  }
})
server.listen(Number(process.argv[3] ?? 443), '0.0.0.0', () => console.log(`artium-test-ready ${server.address().port}`))
