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
  if (url.pathname === '/oauth2/token') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const values = new URLSearchParams(body)
      requests.push({ method: req.method, host: req.headers.host, path: url.pathname,
        canaryReceived: values.get('client_id') === 'CANARY-falcon-id' && values.get('client_secret') === 'CANARY-falcon-secret' })
      if (req.headers.host === 'redirect.crowdstrike.com') {
        res.writeHead(302, { location: 'https://appliance.test/falcon-redirect-destination' })
        res.end()
      } else res.end(JSON.stringify({ access_token: 'CANARY-falcon-token', token_type: 'bearer', expires_in: 3600 }))
    })
    return
  }
  requests.push({ method: req.method, host: req.headers.host, path: url.pathname,
    canaryReceived: /CANARY-/.test(req.headers.authorization ?? ''),
    ...(url.pathname === '/alerts/queries/alerts/v2' ? { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') } : {}) })
  if (url.pathname === '/alerts/queries/alerts/v2') {
    if (req.headers.host === 'api-redirect.crowdstrike.com') {
      res.writeHead(302, { location: 'https://appliance.test/falcon-api-redirect-destination' })
      res.end()
    } else {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const ids = ['synthetic-detection-1', 'synthetic-detection-2']
      res.end(JSON.stringify({ resources: ids.slice(offset, offset + Number(url.searchParams.get('limit') ?? 1)),
        meta: { pagination: { offset, total: ids.length } } }))
    }
  } else if (url.pathname === '/alerts/entities/alerts/v2' && req.method === 'POST') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const { composite_ids: ids } = JSON.parse(body)
      res.end(JSON.stringify({ resources: ids.map(id => ({ composite_id: id, severity_name: 'Low',
        tactic: 'Discovery', device: { hostname: `host-${id}` } })) }))
    })
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'https://management.azure.com/redirect-destination' })
    res.end()
  } else if (url.pathname === '/cross-redirect') {
    res.writeHead(302, { location: 'https://graph.microsoft.com/cross-redirect-destination' })
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
    res.end(JSON.stringify({ value: [{ id: 'synthetic-page-1' }], nextLink: 'https://management.azure.com/page-next?api-version=2022-12-01' }))
  } else if (url.pathname === '/page-next') {
    res.end(JSON.stringify({ value: [{ id: 'synthetic-page-2' }] }))
  } else if (url.pathname.startsWith('/api/v2.5/detections')) {
    res.end(JSON.stringify({ count: 0, results: [], next: null }))
  } else {
    res.end(JSON.stringify({ value: [] }))
  }
})
server.listen(Number(process.argv[3] ?? 443), '0.0.0.0', () => console.log(`artium-test-ready ${server.address().port}`))
