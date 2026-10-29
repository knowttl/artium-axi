// Synthetic fixtures cite the published v3 OpenAPI routes.
export const resourceId = '11111111-1111-4111-8111-111111111111'
export function beyondtrustResponse(req, res, url, requests, mutate) {
  const record = { method: req.method, path: url.pathname, canaryReceived: req.headers.authorization === 'Bearer CANARY-beyondtrust-token' }
  requests.push(record)
  if (url.pathname === '/oauth/connect/token') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      record.canaryReceived = form.get('client_id') === 'synthetic-client' && form.get('client_secret') === 'CANARY-beyondtrust-secret'
        && form.get('grant_type') === 'client_credentials'
      res.writeHead(record.canaryReceived ? 200 : 401)
      res.end(JSON.stringify({ access_token: 'CANARY-beyondtrust-token', token_type: 'Bearer', expires_in: 3600 }))
    })
    return
  }
  if (!record.canaryReceived) { res.writeHead(401); res.end('{}'); return }
  if (url.pathname.endsWith('/Content') || url.pathname.endsWith('/GetYamlApiDefinitionFile')) {
    res.setHeader('content-type', 'application/octet-stream')
    res.end('Synthetic inert BeyondTrust artifact\n')
    return
  }
  const computer = { id: resourceId, host: 'example', groupId: resourceId, authorisationState: 'Pending' }
  if (req.method !== 'GET') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => { record.body = body; mutate(); res.end(JSON.stringify(resourceId)) })
    return
  }
  if (url.pathname === '/management-api/v3/About') { res.end(JSON.stringify({ version: '3' })); return }
  if (url.pathname === '/management-api/v3/Computers') {
    const size = Number(url.searchParams.get('Pagination.PageSize') ?? 50)
    const count = url.searchParams.get('Filter.Host') === 'fleet' ? 1001 : 1
    res.end(JSON.stringify({ pageNumber: 1, pageSize: size, totalRecordCount: count, pageCount: Math.ceil(count / size), data: Array.from({ length: Math.min(size, count) }, () => computer) })); return
  }
  if (url.pathname === '/management-api/v3/Computers/' + resourceId) { res.end(JSON.stringify(computer)); return }
  if (url.pathname === '/management-api/v3/Groups/' + resourceId) { res.end(JSON.stringify({ id: resourceId, name: 'example' })); return }
  res.writeHead(404); res.end('{}')
}
