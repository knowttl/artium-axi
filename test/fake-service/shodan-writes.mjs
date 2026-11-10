export function shodanWrites(record) {
  const alerts = new Map([['synthetic-alert', { id: 'synthetic-alert', name: 'Synthetic', filters: { ip: ['192.0.2.0/24'] },
    expiration: null, notifiers: ['synthetic-notifier'], triggers: { new_service: {} }, notify: { token: 'CANARY-notifier-secret' } }]])
  const members = new Map([['reader@example.test', { username: 'reader', email: 'reader@example.test', api_key: 'CANARY-issued-secret' }]])
  const notifiers = new Map([['synthetic-notifier', { id: 'synthetic-notifier', provider: 'webhook', description: 'Synthetic', args: { url: 'https://hooks.example.test/old' } }]])
  let dropWrites = false
  let created = 0
  const reply = (res, status, value) => { res.writeHead(status); res.end(JSON.stringify(value)) }
  return (req, res, url) => {
    const path = url.pathname
    if (path === '/__shodan/write-drop') { dropWrites = url.searchParams.get('enabled') !== 'false'; reply(res, 200, {}); return true }
    if (path === '/__shodan/member') { members.set(url.searchParams.get('email'), { email: url.searchParams.get('email') }); reply(res, 200, {}); return true }
    const alertId = /^\/shodan\/alert\/([^/]+)\/info$/.exec(path)?.[1]
    const alertMutation = /^\/shodan\/alert\/([^/]+)(?:\/(trigger|notifier)\/([^/]+)(?:\/ignore\/([^/]+))?)?$/.exec(path)
    const memberEmail = /^\/org\/member\/([^/]+)$/.exec(path)?.[1]
    const notifierId = /^\/notifier\/([^/]+)$/.exec(path)?.[1]
    if (!['/shodan/alert/info', '/shodan/alert', '/org', '/notifier'].includes(path) && !alertId && !alertMutation && !memberEmail && !notifierId) return false
    if (notifierId === 'provider') return false
    record({ method: req.method, path, canaryReceived: url.searchParams.get('key') === 'CANARY-shodan-key', parameters: [...url.searchParams.keys()] })
    if (url.searchParams.get('key') !== 'CANARY-shodan-key') { reply(res, 401, {}); return true }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      if (req.method !== 'GET' && dropWrites) { req.socket.destroy(); return }
      if (req.method === 'GET' && path === '/shodan/alert/info') reply(res, 200, [...alerts.values()])
      else if (req.method === 'GET' && alertId) alerts.has(alertId) ? reply(res, 200, alerts.get(alertId)) : reply(res, 404, {})
      else if (alertMutation) {
        const [, id, kind, item, service] = alertMutation, alert = alerts.get(id)
        if (!alert) { reply(res, 404, {}); return }
        if (!kind && req.method === 'DELETE') alerts.delete(id)
        else if (!kind && req.method === 'POST') Object.assign(alert, JSON.parse(body))
        else if (kind === 'notifier' && req.method === 'PUT') alert.notifiers = [...new Set([...alert.notifiers, item])]
        else if (kind === 'notifier' && req.method === 'DELETE') alert.notifiers = alert.notifiers.filter(value => value !== item)
        else if (kind === 'trigger' && service && req.method === 'PUT') {
          alert.triggers[item] ??= {}
          alert.triggers[item].ignore ??= []
          alert.triggers[item].ignore.push(decodeURIComponent(service))
        } else if (kind === 'trigger' && service && req.method === 'DELETE') {
          if (alert.triggers[item]?.ignore) alert.triggers[item].ignore = alert.triggers[item].ignore.filter(value => value !== decodeURIComponent(service))
        } else if (kind === 'trigger' && req.method === 'PUT') alert.triggers[item] = {}
        else if (kind === 'trigger' && req.method === 'DELETE') delete alert.triggers[item]
        else { reply(res, 404, {}); return }
        reply(res, 200, { success: true })
      }
      else if (req.method === 'POST' && path === '/shodan/alert') {
        const input = JSON.parse(body)
        const alert = { id: `created-alert-${++created}`, name: input.name, filters: input.filters, expiration: null }
        alerts.set(alert.id, alert)
        reply(res, 200, alert)
      } else if (req.method === 'GET' && path === '/org') reply(res, 200, { id: 'synthetic-org', name: 'Synthetic', admins: [], members: [...members.values()],
        domains: ['example.test'], logo: false, api_key: 'CANARY-issued-secret' })
      else if (req.method === 'PUT' && memberEmail) { const email = decodeURIComponent(memberEmail); members.set(email, { email }); reply(res, 200, { success: true }) }
      else if (req.method === 'DELETE' && memberEmail) { members.delete(decodeURIComponent(memberEmail)); reply(res, 200, { success: true }) }
      else if (req.method === 'GET' && path === '/notifier') reply(res, 200, { matches: [...notifiers.values()].map(({ id, provider }) => ({ id, provider })), total: notifiers.size })
      else if (req.method === 'POST' && path === '/notifier') {
        const { provider, description, ...args } = Object.fromEntries(new URLSearchParams(body))
        const notifier = { id: `created-notifier-${++created}`, provider, ...description === undefined ? {} : { description }, args }
        notifiers.set(notifier.id, notifier)
        reply(res, 200, { success: true, id: notifier.id })
      } else if (req.method === 'GET' && notifierId) notifiers.has(notifierId) ? reply(res, 200, notifiers.get(notifierId)) : reply(res, 404, {})
      else if (notifierId && req.method === 'DELETE' && notifiers.has(notifierId)) { notifiers.delete(notifierId); reply(res, 200, { success: true }) }
      else if (notifierId && req.method === 'PUT' && notifiers.has(notifierId)) {
        const { description, ...args } = Object.fromEntries(new URLSearchParams(body))
        Object.assign(notifiers.get(notifierId), { ...(description === undefined ? {} : { description }), args })
        reply(res, 200, { success: true })
      }
      else reply(res, 404, {})
    })
    return true
  }
}
