import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Synthetic Network payloads follow the pinned published OpenAPI contract.
export function unifiController(record: (event: { method: string, path: string, canaryReceived: boolean }) => void) {
  const networks = new Map<string, Record<string, unknown>>([['11111111-1111-4111-8111-111111111111', {
    id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic network', vlanId: 7, enabled: true,
    default: false, management: 'UNMANAGED', metadata: { origin: 'USER_DEFINED' },
  }]])
  let version = '10.6.109', mode = '', applied = 0, attempts = 0
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const reply = (status: number, body?: unknown) => { res.writeHead(status); res.end(body === undefined ? undefined : JSON.stringify(body)) }
    if (url.pathname === '/__unifi/evidence') { reply(200, { applied, attempts, resources: networks.size }); return true }
    if (url.pathname === '/__unifi/control') {
      mode = url.searchParams.get('mode') ?? ''
      version = url.searchParams.get('version') ?? version
      if (mode === 'drift') networks.get('11111111-1111-4111-8111-111111111111')!.name = 'Concurrent synthetic change'
      reply(200, { configured: true }); return true
    }
    if (!url.pathname.startsWith('/proxy/network/integration/')) return false
    const canaryReceived = req.headers['x-api-key'] === 'CANARY-unifi-key'
    record({ method: req.method ?? 'GET', path: url.pathname, canaryReceived })
    if (!canaryReceived) { reply(403, { code: 'UNAUTHORIZED' }); return true }
    if (url.pathname === '/proxy/network/integration/v1/info') { reply(200, { applicationVersion: version }); return true }
    const match = /^\/proxy\/network\/integration\/v1\/sites\/[a-f0-9-]{36}\/networks(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname)
    if (!match) { reply(404, { code: 'NOT_FOUND' }); return true }
    const id = match[1]
    if (req.method === 'GET') {
      if (id) reply(networks.has(id) ? 200 : 404, networks.get(id) ?? { code: 'NOT_FOUND' })
      else {
        const data = [...networks.values()], offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 25)
        reply(200, { data: data.slice(offset, offset + limit), count: Math.min(limit, Math.max(0, data.length - offset)),
          offset, limit, totalCount: data.length })
      }
      return true
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      attempts++
      const next = mode; mode = ''
      if (next === 'reject') { reply(409, { code: 'SYNTHETIC_CONFLICT', message: 'Rejected CANARY-unifi-key', requestId: 'synthetic-rejection' }); return }
      const value = body ? JSON.parse(body) as Record<string, unknown> : {}
      const target = id ?? randomUUID()
      if (req.method === 'DELETE') networks.delete(target)
      else networks.set(target, { ...value, id: target, default: false, metadata: { origin: 'USER_DEFINED' } })
      applied++
      if (next === 'drop') { req.socket.destroy(); return }
      reply(req.method === 'POST' ? 201 : 200, req.method === 'DELETE' ? undefined : networks.get(target))
    })
    return true
  }
}
