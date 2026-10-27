import { createHash } from 'node:crypto'

export function checkpointResponse(req, res, url, requests, mutate) {
  const envelope = responseData => JSON.stringify({ responseEnvelope: { responseCode: 0 }, responseData })
  const canaryReceived = req.headers.authorization === 'Bearer CANARY-checkpoint-token'
  const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), canaryReceived }
  requests.push(record)
  if (url.pathname === '/auth/external') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const value = JSON.parse(body)
      record.canaryReceived = value.clientId === 'synthetic-client' && value.accessKey === 'CANARY-checkpoint-secret'
      res.writeHead(record.canaryReceived ? 200 : 401)
      res.end(JSON.stringify({ token: 'CANARY-checkpoint-token' }))
    })
    return
  }
  if (!canaryReceived) { res.writeHead(401); res.end('{}'); return }
  if (url.pathname.startsWith('/app/hec-api/v1.0/download/entity/')) {
    const content = Buffer.from('Synthetic inert Check Point artifact\n')
    record.scope = req.headers.scopes ?? null
    if (!url.pathname.includes('/missing-hash')) res.setHeader('x-av-sha256', createHash('sha256').update(content).digest('hex'))
    res.setHeader('content-type', 'application/octet-stream')
    res.end(content)
    return
  }
  const email = { entityInfo: { entityId: 'synthetic-email', saasEntityType: 'office365_emails_email' },
    entityPayload: { subject: 'Synthetic email', isQuarantined: false, isRestored: false },
    entityAvailableActions: [{ entityActionName: 'quarantine' }, { entityActionName: 'restore' }] }
  const event = { eventId: 'synthetic-event', entityId: 'synthetic-email', type: 'phishing', state: 'open', severity: 'high',
    availableEventActions: [{ actionName: 'dismiss', actionParameter: {} }] }
  if (url.pathname.endsWith('/search/query') || url.pathname.endsWith('/search/entity/synthetic-email')) { res.end(envelope([email])); return }
  if (url.pathname.endsWith('/event/query') || url.pathname.endsWith('/event/synthetic-event')) { res.end(envelope([event])); return }
  if (url.pathname.endsWith('/task/synthetic-task')) {
    res.end(envelope([{ id: 'synthetic-task', status: 'completed', actions: [{ action_status: 'completed' }], progress: 1, total: 1 }])); return
  }
  if (url.pathname.endsWith('/action/entity') || url.pathname.endsWith('/action/event')) {
    mutate()
    res.end(envelope([{ entityId: 'synthetic-email', taskId: 'synthetic-task',
      ...(url.pathname.endsWith('/event') ? { eventId: 'synthetic-event' } : {}) }]))
    return
  }
  if (url.pathname.includes('/exceptions/') || url.pathname.includes('/sectools/') || url.pathname.includes('/sectool-exceptions/')) {
    if (req.method !== 'GET') mutate()
    res.end(envelope([])); return
  }
  res.writeHead(404); res.end('{}')
}
