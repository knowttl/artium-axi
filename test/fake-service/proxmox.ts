import type { IncomingMessage, ServerResponse } from 'node:http'

// Synthetic payloads follow the pinned Proxmox response contracts.
export function proxmoxController(record: (event: { method: string, path: string, canaryReceived: boolean }) => void) {
  let version = '9.2.0', mode = '', applied = 0, attempts = 0, sequence = 0, scans = 0, secretReceived = false
  let authMode = '', logins = 0, passwordReceived = false, csrfReceived = false
  const tickets = new Map<string, { id: number, csrf: string }>(), nodeTickets: number[] = []
  const authWaiters: { count: number, response: ServerResponse }[] = [], heldAuth: (() => void)[] = []
  const readWaiters: { count: number, response: ServerResponse }[] = []
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
    if (method === 'GET' && path === '/nodes/node/version') return { version, release: '1', repoid: 'synthetic-build' }
    applied++; notify()
    if (path.includes('/access/users/') && path.includes('/token/')) return { 'full-tokenid': 'automation@pve!issued',
      info: { privsep: true }, value: `CANARY-new-proxmox-secret-${applied}` }
    if (path.startsWith('/access/tfa/') && method === 'POST') return { id: 'synthetic-tfa', recovery: ['CANARY-recovery-code'] }
    if (path.endsWith('/vncproxy')) return { cert: 'synthetic-certificate', port: '5901',
      ticket: 'CANARY-vnc-ticket', password: 'CANARY-vnc-password', user: 'automation@pve',
      upid: 'UPID:node:00000001:00000002:00000003:vncproxy:100:reader@pve:' }
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
    if (url.pathname === '/__proxmox/evidence') {
      res.end(JSON.stringify({ applied, attempts, scans, secretReceived, logins, passwordReceived, csrfReceived, nodeTickets })); return true
    }
    if (url.pathname === '/__proxmox/control') {
      mode = url.searchParams.get('mode') ?? ''; version = url.searchParams.get('version') ?? version
      authMode = url.searchParams.get('auth') ?? authMode
      if (authMode === 'release') { authMode = ''; for (const finish of heldAuth.splice(0)) finish() }
      if (url.searchParams.has('clear-tickets')) tickets.clear()
      res.end('{}'); return true
    }
    if (url.pathname === '/__proxmox/logins') {
      const count = Number(url.searchParams.get('count'))
      if (logins >= count) res.end('{}')
      else authWaiters.push({ count, response: res })
      return true
    }
    if (url.pathname === '/__proxmox/reads') {
      const count = Number(url.searchParams.get('count'))
      if (nodeTickets.length >= count) res.end('{}')
      else readWaiters.push({ count, response: res })
      return true
    }
    if (url.pathname === '/__proxmox/applied') {
      const count = Number(url.searchParams.get('count'))
      if (applied >= count) res.end('{}')
      else waiters.push({ count, response: res })
      return true
    }
    if (!url.pathname.startsWith('/api2/json/')) return false
    const path = url.pathname.slice('/api2/json'.length)
    if (path === '/access/ticket' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const values = new URLSearchParams(body), id = ++logins
        passwordReceived ||= values.get('password') === 'CANARY-proxmox-password'
        for (let index = authWaiters.length - 1; index >= 0; index--) if (logins >= authWaiters[index].count) {
          authWaiters[index].response.end('{}'); authWaiters.splice(index, 1)
        }
        const finish = () => {
          if (res.destroyed) return
          if (authMode === 'reject' || values.get('password') !== 'CANARY-proxmox-password') { reply(401, null); return }
          if (authMode === 'tfa') { reply(200, { username: values.get('username'), ticket: 'PVE:tfa!CANARY-signed-challenge' }); return }
          const ticket = `PVE:automation@pve:CANARY-issued-ticket-${id}`, csrf = `CANARY-csrf-${id}`
          tickets.set(ticket, { id, csrf })
          reply(200, { username: values.get('username'), ticket, CSRFPreventionToken: csrf })
        }
        if (authMode === 'hold') {
          heldAuth.push(finish)
          res.once('close', () => { const index = heldAuth.indexOf(finish); if (index >= 0) heldAuth.splice(index, 1) })
        }
        else finish()
      })
      return true
    }
    const ticket = tickets.get(decodeURIComponent(String(req.headers.cookie ?? '').replace(/^PVEAuthCookie=/, '')))
    const apiToken = req.headers.authorization === 'PVEAPIToken=reader@pve!automation=CANARY-proxmox-token'
    const canaryReceived = apiToken || ticket !== undefined
    record({ method: req.method ?? 'GET', path: url.pathname, canaryReceived })
    if (!canaryReceived) { reply(401, null); return true }
    if (ticket && req.method !== 'GET') {
      if (req.headers.csrfpreventiontoken !== ticket.csrf) { reply(403, null); return true }
      csrfReceived = true
    }
    if (path === '/nodes') {
      nodeTickets.push(ticket?.id ?? 0)
      for (let index = readWaiters.length - 1; index >= 0; index--) if (nodeTickets.length >= readWaiters[index].count) {
        readWaiters[index].response.end('{}'); readWaiters.splice(index, 1)
      }
      if (mode === 'hold-read') { mode = ''; return true }
    }
    if (path === '/version' || path === '/nodes/node/version') { reply(200, { version, release: '1', repoid: 'synthetic-build' }); return true }
    if (path === '/access/permissions') { reply(200, {}); return true }
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
