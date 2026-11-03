import type { IncomingMessage, ServerResponse } from 'node:http'

// Synthetic payloads follow the pinned Proxmox response contracts.
export function proxmoxController(record: (event: { method: string, path: string, canaryReceived: boolean }) => void) {
  let version = '9.2.0', mode = '', applied = 0, attempts = 0, sequence = 0, scans = 0, secretReceived = false
  const config: Record<string, unknown> = { description: 'Synthetic configuration', name: 'synthetic-vm', memory: 1024, cores: 1 }
  let state = 'stopped'
  const tasks = new Map<string, string>()
  const waiters: { count: number, response: ServerResponse }[] = []
  const notify = () => {
    for (let index = waiters.length - 1; index >= 0; index--) if (applied >= waiters[index].count) {
      waiters[index].response.end('{}'); waiters.splice(index, 1)
    }
  }
  const mutate = (method: string, path: string, values: Record<string, unknown>): unknown => {
    if (path === '/nodes/node/execute') {
      return (JSON.parse(String(values.commands)) as { method: string, path: string, args?: Record<string, unknown> }[])
        .map(child => ({ status: 200, data: mutate(child.method, '/nodes/node/' + child.path, child.args ?? {}) }))
    }
    applied++; notify()
    if (method === 'PUT' && path.endsWith('/qemu/100/config')) {
      Object.assign(config, values)
      secretReceived ||= values.cipassword !== undefined
      return null
    }
    if (path.includes('/scan/')) { scans++; secretReceived ||= values.password !== undefined; return [] }
    if (method === 'DELETE' && path.includes('/tasks/')) { tasks.set(decodeURIComponent(path.split('/').at(-1)!), 'interrupted'); return null }
    if (path.includes('/status/')) {
      state = path.endsWith('/start') ? 'running' : 'stopped'
      const upid = `UPID:node:00000001:00000002:00000003:qmstart:${100 + sequence++}:reader@pve:`
      tasks.set(upid, 'OK'); return upid
    }
    return null
  }
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const reply = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify({ data })) }
    if (url.pathname === '/__proxmox/evidence') { res.end(JSON.stringify({ applied, attempts, scans, secretReceived })); return true }
    if (url.pathname === '/__proxmox/control') {
      mode = url.searchParams.get('mode') ?? ''; version = url.searchParams.get('version') ?? version
      res.end('{}'); return true
    }
    if (url.pathname === '/__proxmox/applied') {
      const count = Number(url.searchParams.get('count'))
      if (applied >= count) res.end('{}')
      else waiters.push({ count, response: res })
      return true
    }
    if (!url.pathname.startsWith('/api2/json/')) return false
    const canaryReceived = req.headers.authorization === 'PVEAPIToken=reader@pve!automation=CANARY-proxmox-token'
    record({ method: req.method ?? 'GET', path: url.pathname, canaryReceived })
    if (!canaryReceived) { reply(401, null); return true }
    const path = url.pathname.slice('/api2/json'.length)
    if (path === '/version' || path === '/nodes/node/version') { reply(200, { version, release: '1', repoid: 'synthetic-build' }); return true }
    if (req.method === 'GET' && !path.includes('/scan/')) {
      if (path.endsWith('/qemu/100/config')) reply(200, config)
      else if (path.endsWith('/qemu/100/status/current')) reply(200, { vmid: 100, status: state, ha: {} })
      else if (path.includes('/tasks/')) {
        const upid = decodeURIComponent(path.split('/').at(-2)!)
        reply(200, path.endsWith('/log') ? [{ n: 1, t: 'Synthetic task finished' }] : {
          upid, node: 'node', pid: 1, pstart: 2, starttime: 3, type: 'qmstart', id: '100', user: 'reader@pve',
          status: 'stopped', exitstatus: tasks.get(upid) ?? 'OK',
        })
      } else reply(200, [])
      return true
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      attempts++
      const next = mode; mode = ''
      if (next === 'reject') { reply(403, { message: 'Rejected CANARY-proxmox-token' }); return }
      const values = Object.fromEntries(req.method === 'GET' || req.method === 'DELETE' ? url.searchParams : new URLSearchParams(body))
      const data = mutate(req.method ?? 'GET', path, values)
      if (next === 'drop') { req.socket.destroy(); return }
      if (next === 'hold') return
      reply(200, data)
    })
    return true
  }
}
