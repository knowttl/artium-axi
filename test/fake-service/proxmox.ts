import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { Duplex } from 'node:stream'

// Synthetic payloads follow the pinned Proxmox response contracts.
export function proxmoxController(record: (event: { method: string, path: string, canaryReceived: boolean }) => void) {
  let version = '9.2.0', mode = '', applied = 0, attempts = 0, sequence = 0, scans = 0, secretReceived = false
  let authMode = '', logins = 0, passwordReceived = false, csrfReceived = false
  let opened = 0, closed = 0, uploaded: { bytes: number, sha256: string } | undefined
  const tickets = new Map<string, { id: number, csrf: string }>(), nodeTickets: number[] = []
  const heldStreams = new Map<ServerResponse, Buffer>()
  const authWaiters: { count: number, response: ServerResponse }[] = [], heldAuth: (() => void)[] = []
  const readWaiters: { count: number, response: ServerResponse }[] = []
  const socketWaiters: { kind: 'opened' | 'closed', count: number, response: ServerResponse }[] = []
  const notifySockets = () => {
    for (let index = socketWaiters.length - 1; index >= 0; index--) {
      const waiter = socketWaiters[index]
      if ((waiter.kind === 'opened' ? opened : closed) >= waiter.count) { waiter.response.end('{}'); socketWaiters.splice(index, 1) }
    }
  }
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
    if (path.endsWith('/mtunnel')) return { socket: 'synthetic-migration-socket', ticket: 'CANARY-migration-ticket',
      upid: 'UPID:node:00000001:00000002:00000003:qmigrate:100:reader@pve:' }
    if (path.endsWith('/termproxy') || path.endsWith('/vncshell')) return { port: '5901', ticket: 'CANARY-vnc-ticket', user: 'automation@pve',
      ...(path.endsWith('/vncshell') ? { cert: 'synthetic-certificate' } : {}),
      upid: 'UPID:node:00000001:00000002:00000003:termproxy:100:reader@pve:' }
    if (path.endsWith('/upload')) return 'UPID:node:00000001:00000002:00000003:imgcopy:100:reader@pve:'
    if (path.endsWith('/vncproxy')) return { cert: 'synthetic-certificate', port: '5901',
      ticket: 'CANARY-vnc-ticket', ...(path.includes('/qemu/') ? { password: 'CANARY-vnc-password' } : {}), user: 'automation@pve',
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
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const reply = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify({ data })) }
    if (url.pathname === '/__proxmox/evidence') {
      res.end(JSON.stringify({ applied, attempts, scans, secretReceived, logins, passwordReceived, csrfReceived, nodeTickets, opened, closed, uploaded })); return true
    }
    if (url.pathname === '/__proxmox/control') {
      mode = url.searchParams.get('mode') ?? ''; version = url.searchParams.get('version') ?? version
      authMode = url.searchParams.get('auth') ?? authMode
      if (mode === 'release-stream') { for (const [response, bytes] of heldStreams) response.end(bytes); heldStreams.clear(); mode = '' }
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
    if (url.pathname === '/__proxmox/sockets') {
      const kind = url.searchParams.has('opened') ? 'opened' : 'closed', count = Number(url.searchParams.get(kind))
      if ((kind === 'opened' ? opened : closed) >= count) res.end('{}')
      else socketWaiters.push({ kind, count, response: res })
      return true
    }
    if (url.pathname === '/__proxmox/applied') {
      const count = Number(url.searchParams.get('count'))
      if (applied >= count) res.end('{}')
      else waiters.push({ count, response: res })
      return true
    }
    const formatter = /^\/api2\/(json|png|spiceconfig)\//.exec(url.pathname)?.[1]
    if (!formatter) return false
    const path = url.pathname.replace(/^\/api2\/(json|png|spiceconfig)/, '')
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
    const apiToken = ['PVEAPIToken=reader@pve!automation=CANARY-proxmox-token', 'PVEAPIToken=reader@pve!automation=complete'].includes(String(req.headers.authorization))
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
    if (req.method === 'GET' && (path.endsWith('/rrd') || path.endsWith('/file-restore/download') || path.endsWith('/journal')
      || path.endsWith('/log') && ['true', '1'].includes(url.searchParams.get('download') ?? ''))) {
      const bytes = path.endsWith('/rrd') ? Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('CANARY-proxmox-token\0\xff', 'latin1')])
        : path.endsWith('/file-restore/download') ? Buffer.from([0, 255, 10, 13, 128, 1]) : Buffer.from('Synthetic text\nCANARY-proxmox-token\n')
      if (mode === 'hold-stream') {
        res.writeHead(200); res.write(bytes.subarray(0, 8)); heldStreams.set(res, bytes.subarray(8))
        res.once('close', () => heldStreams.delete(res)); return true
      }
      if (mode === 'bad-hash') { mode = ''; res.end(Buffer.from('invalid PNG')); return true }
      if (mode === 'gzip') { mode = ''; res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(bytes)) }
      else res.end(bytes)
      return true
    }
    if (req.method === 'GET' && path.endsWith('/agent/file-read')) {
      reply(200, ['false', '0'].includes(url.searchParams.get('decode') ?? '') ? { content: 'AA==/w==', 'bytes-read': 2, truncated: false }
        : { content: 'hello ☃', 'bytes-read': 9, truncated: false })
      return true
    }
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
    const body: Buffer[] = []
    req.on('data', chunk => { body.push(Buffer.from(chunk)) })
    req.on('end', () => {
      attempts++
      const next = mode
      if (mode !== 'drop-duplex') mode = ''
      if (next === 'reject') { reply(403, { message: 'Rejected CANARY-proxmox-token' }); return }
      const payload = Buffer.concat(body)
      if (path.endsWith('/upload')) {
        const boundary = /boundary=([^;]+)/.exec(String(req.headers['content-type']))?.[1]
        const marker = payload.indexOf(Buffer.from('name="filename"; filename="'))
        const start = payload.indexOf(Buffer.from('\r\n\r\n'), marker) + 4
        const end = payload.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`))
        if (!boundary || marker < 0 || start < 4 || end < start) { reply(400, null); return }
        const bytes = payload.subarray(start, end)
        uploaded = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
      const values = Object.fromEntries(req.method === 'GET' || req.method === 'DELETE' ? url.searchParams : new URLSearchParams(payload.toString('utf8')))
      const data = mutate(req.method ?? 'GET', path, values)
      if (next === 'drop') { req.socket.destroy(); return }
      if (next === 'hold') return
      if (formatter === 'spiceconfig') { res.end('[virt-viewer]\r\ntype=spice\r\npassword=CANARY-private-spice\r\nhost=synthetic.invalid\r\n'); return }
      reply(200, data)
    })
    return true
  }
  return Object.assign(handle, { upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '', 'https://synthetic.invalid')
    if (!url.pathname.startsWith('/api2/')) return
    const ticket = tickets.get(decodeURIComponent(String(req.headers.cookie ?? '').replace(/^PVEAuthCookie=/, '')))
    const authorized = req.headers.authorization === 'PVEAPIToken=reader@pve!automation=CANARY-proxmox-token' || !!ticket
    if (!authorized || !/\/(vncwebsocket|mtunnelwebsocket)$/.test(url.pathname)
      || !(url.searchParams.get('vncticket') === 'CANARY-vnc-ticket' || url.searchParams.get('ticket') === 'CANARY-migration-ticket')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
    }
    const key = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: binary\r\n\r\n`)
    opened++; notifySockets(); socket.on('error', () => {}); socket.once('close', () => { closed++; notifySockets() })
    const frame = (payload: Buffer, opcode = 2, final = true) => {
      const header = payload.length < 126 ? Buffer.from([(final ? 128 : 0) | opcode, payload.length])
        : Buffer.from([(final ? 128 : 0) | opcode, 126, payload.length >> 8, payload.length & 255])
      return Buffer.concat([header, payload])
    }
    let pending = head
    const receive = (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes])
      while (pending.length >= 2) {
        const opcode = pending[0] & 15
        let length = pending[1] & 127, offset = 2
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4 }
        if (length === 127) { if (pending.length < 10) return; const size = pending.readBigUInt64BE(2); if (size > 1048576n) { socket.destroy(); return }; length = Number(size); offset = 10 }
        if (!(pending[1] & 128) || pending.length < offset + 4 + length) return
        const mask = pending.subarray(offset, offset + 4), payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length))
        pending = pending.subarray(offset + 4 + length)
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4]
        if (opcode === 8) { socket.write(frame(Buffer.from('final-peer-message'))); socket.end(Buffer.from([0x88, 2, 3, 232])); return }
        if (opcode !== 2) continue
        if (mode === 'drop-duplex') { mode = ''; socket.destroy(); return }
        const middle = Math.floor(payload.length / 2)
        socket.write(frame(payload.subarray(0, middle), 2, false)); socket.write(frame(payload.subarray(middle), 0))
      }
    }
    socket.on('data', receive)
    if (head.length) receive(Buffer.alloc(0))
  } })
}
