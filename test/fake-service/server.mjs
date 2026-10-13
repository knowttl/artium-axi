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
  if (req.headers.host === 'synthetic.azurecr.io' && ['/oauth2/exchange', '/oauth2/token'].includes(url.pathname)) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const values = new URLSearchParams(body)
      requests.push({ method: req.method, host: req.headers.host, path: url.pathname,
        canaryReceived: values.get('access_token') === 'CANARY-AZURE-ACCESS-TOKEN' || values.get('refresh_token') === 'CANARY-registry-refresh' })
      res.end(JSON.stringify(url.pathname === '/oauth2/exchange'
        ? { refresh_token: 'CANARY-registry-refresh' } : { access_token: 'CANARY-registry-access' }))
    })
    return
  }
  if (url.pathname === '/api/v2.5/oauth2/token' || (url.pathname === '/oauth2/token' && req.headers.authorization?.startsWith('Basic '))) {
    requests.push({ method: req.method, host: req.headers.host, path: url.pathname,
      canaryReceived: req.headers.authorization === `Basic ${Buffer.from('synthetic-vectra-id:CANARY-vectra-secret').toString('base64')}` })
    req.resume()
    res.end(JSON.stringify({ access_token: 'CANARY-vectra-minted', refresh_token: 'CANARY-vectra-refresh',
      token_type: 'bearer', expires_in: 3600 }))
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
  const recorded = { method: req.method, host: req.headers.host, path: url.pathname,
    canaryReceived: /CANARY-/.test(req.headers.authorization ?? ''),
    ...(url.pathname === '/alerts/queries/alerts/v2' ? { offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit') } : {}) }
  requests.push(recorded)
  if (url.pathname === '/alerts/queries/alerts/v2') {
    if (req.headers.host === 'api-redirect.crowdstrike.com') {
      res.writeHead(302, { location: 'https://appliance.test/falcon-api-redirect-destination' })
      res.end()
    } else {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const ids = url.searchParams.get('filter') === "hostname:'synthetic-empty'" ? [] : ['synthetic-detection-1', 'synthetic-detection-2']
      const redaction = url.searchParams.get('filter') === "hostname:'synthetic-redaction'"
      res.end(JSON.stringify({ resources: redaction ? ['synthetic-redaction'] : ids.slice(offset, offset + Number(url.searchParams.get('limit') ?? 1)),
        meta: { pagination: { offset, total: ids.length } } }))
    }
  } else if (url.pathname === '/alerts/entities/alerts/v2' && req.method === 'POST') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const { composite_ids: ids } = JSON.parse(body)
      res.end(JSON.stringify({ resources: ids.map(id => ({ composite_id: id, severity_name: 'Low',
        tactic: 'Discovery', device: { hostname: id === 'synthetic-redaction' ? 'CANARY-falcon-token' : `host-${id}` } })) }))
    })
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, { location: 'https://management.azure.com/redirect-destination' })
    res.end()
  } else if (url.pathname === '/cross-redirect') {
    res.writeHead(302, { location: 'https://graph.microsoft.com/cross-redirect-destination' })
    res.end()
  } else if (/^\/api\/v(2\.5|3\.4)\/detections\/42\/?$/.test(url.pathname)) {
    res.end(JSON.stringify({ id: 42, detection_type: 'synthetic', description:
      ['CANARY-vectra-token', 'CANARY-vectra-secret', 'CANARY-vectra-minted', 'CANARY-vectra-refresh'].join(' ') }))
  } else if (/^\/api\/v(2\.5|3\.4)\/detections\/43\/?$/.test(url.pathname)) {
    res.end(JSON.stringify({ id: 43, description: Buffer.from('CANARY-vectra-minted').toString('base64') }))
  } else if (url.pathname === '/api/v2.5/tagging/detection/44') {
    res.writeHead(403)
    res.end(JSON.stringify({ error: 'Synthetic permission denial' }))
  } else if (url.pathname === '/subscriptions/synthetic-subscription/resourceGroups/permission-denied') {
    res.writeHead(403)
    res.end(JSON.stringify({ error: { code: 'AuthorizationFailed', message: 'Synthetic permission denial' } }))
  } else if (url.pathname === '/providers/Microsoft.ResourceGraph/resources') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      recorded.body = JSON.parse(body)
      res.end(JSON.stringify({ data: [{ name: 'synthetic-resource' }], totalRecords: 1, count: 1, resultTruncated: 'false' }))
    })
  } else if (req.headers.host === 'api.loganalytics.io' && /\/workspaces\/[^/]+\/query$/.test(url.pathname)) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      recorded.body = JSON.parse(body)
      res.end(JSON.stringify({ tables: [{ name: 'PrimaryResult', columns: [{ name: 'synthetic', type: 'string' }], rows: [['metadata']] }] }))
    })
  } else if (url.pathname.includes('/resourceGroups/runner-timeout-') && (req.method === 'PATCH' || url.pathname.endsWith('/runner-timeout-read'))) {
    req.resume()
    req.on('end', () => { if (req.method === 'PATCH') mutations++ })
  } else if (url.pathname === '/subscriptions/synthetic-subscription/resourceGroups/single-write' && req.method === 'PATCH') {
    mutations++
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      recorded.body = JSON.parse(body)
      res.end(JSON.stringify({ tags: { synthetic: 'yes' } }))
    })
  } else if (url.pathname === '/subscriptions/synthetic-subscription/resourceGroups/timeout-write' && req.method === 'PATCH') {
    req.resume()
    req.on('end', () => {
      mutations++
      // A gateway timeout after the service applied the request leaves its outcome unknown.
      res.writeHead(504, { 'retry-after': '0' })
      res.end(JSON.stringify({ error: { code: 'GatewayTimeout', message: 'Mutation recorded before gateway timed out' } }))
    })
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    mutations++
    if (url.pathname === '/api/v2.5/tagging/detection/45') req.socket.destroy()
    else if (url.pathname === '/api/v2.5/tagging/detection/42') res.end(JSON.stringify({ tags: ['synthetic'] }))
    else {
      res.writeHead(503, { 'retry-after': '0' })
      res.end(JSON.stringify({ error: { code: 'SyntheticAmbiguousWrite', message: 'Mutation recorded before response failed' } }))
    }
  } else if (url.pathname.startsWith('/api/v2.5/tagging/')) {
    res.end(JSON.stringify({ tags: [] }))
  } else if (req.headers.host === 'synthetic.blob.core.windows.net' && url.pathname === '/synthetic') {
    res.setHeader('content-type', 'application/xml')
    res.end('<EnumerationResults><Blobs><Blob><Name>synthetic-blob</Name><Properties><Content-Length>12</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob></Blobs><NextMarker></NextMarker></EnumerationResults>')
  } else if (req.headers.host === 'synthetic.vault.azure.net' && url.pathname === '/secrets') {
    res.end(JSON.stringify({ value: [{ id: 'https://synthetic.vault.azure.net/secrets/synthetic-secret',
      attributes: { enabled: true }, contentType: 'text/plain', value: 'CANARY-NEVER-SECRET-VALUE' }] }))
  } else if (req.headers.host === 'synthetic.azurecr.io' && url.pathname === '/acr/v1/_catalog') {
    res.end(JSON.stringify({ repositories: ['synthetic-repository'] }))
  } else if (url.pathname === '/page') {
    res.end(JSON.stringify({ value: [{ id: 'synthetic-page-1' }], nextLink: 'https://management.azure.com/page-next?api-version=2022-12-01' }))
  } else if (url.pathname === '/page-next') {
    res.end(JSON.stringify({ value: [{ id: 'synthetic-page-2' }] }))
  } else if (/^\/api\/v(2\.5|3\.4)\/detections/.test(url.pathname)) {
    res.end(JSON.stringify({ count: 0, results: [], next: null }))
  } else {
    res.end(JSON.stringify({ value: [] }))
  }
})
server.listen(Number(process.argv[3] ?? 443), '0.0.0.0', () => console.log(`artium-test-ready ${server.address().port}`))
