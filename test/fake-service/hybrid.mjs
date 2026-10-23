export function hybridResponse(req, res, url, requests, resources, mutated) {
  const canaryReceived = ['CANARY-hybrid-key', 'CANARY-hybrid-restricted'].includes(req.headers['api-key'])
  requests.push({ method: req.method, path: url.pathname, canaryReceived })
  const json = value => res.end(JSON.stringify(value))
  if (!canaryReceived) { res.writeHead(401); json({ message: 'Invalid API key' }); return }
  if (url.pathname === '/api/v2/key/current') { json({ auth_level_name: req.headers['api-key'] === 'CANARY-hybrid-restricted' ? 'restricted' : 'default' }); return }
  if (url.pathname === '/api/v2/key/submission-quota') {
    const quota = { apikey: null, quota_reached: false }
    json({ detonation: quota, quick_scan: quota }); return
  }
  if (url.pathname.startsWith('/api/v2/overview/')) {
    if (req.headers['api-key'] === 'CANARY-hybrid-restricted') {
      res.writeHead(403); json({ message: 'Restricted key cannot access this synthetic resource' }); return
    }
    json({ sha256: 'a'.repeat(64), verdict: 'malicious', threat_score: 42 }); return
  }
  if (url.pathname === '/api/labs/hunting/matches/recent') {
    mutated(); json([{ id: 'synthetic-match', rule_id: 'synthetic-rule', sample_sha256: 'a'.repeat(64), match_date: '2026-01-01T00:00:00Z' }]); return
  }
  const rule = { id: 'synthetic-rule', identifier: 'Synthetic rule', active: false }
  if (url.pathname.startsWith('/api/labs/hunting/yara-rules')) {
    if (req.method === 'GET') { json(url.pathname.endsWith('/yara-rules') ? [...resources.values()] : resources.get('hybrid-rule') ?? rule); return }
    if (req.method === 'DELETE') { resources.delete('hybrid-rule'); mutated(); res.writeHead(204); res.end(); return }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const value = { ...rule, ...resources.get('hybrid-rule'), ...JSON.parse(body) }
      resources.set('hybrid-rule', value); mutated(); json(value)
    })
    return
  }
  if (req.method === 'POST' && /\/api\/v2\/(submit\/|quick-scan\/)/.test(url.pathname)) {
    let bytes = 0
    req.on('data', chunk => { bytes += chunk.length })
    req.on('end', () => {
      requests.at(-1).uploadedBytes = bytes
      if (url.pathname === '/api/v2/quick-scan/file' || url.pathname === '/api/v2/quick-scan/url') {
        json({ id: 'synthetic-scan', finished: true, sha256: 'a'.repeat(64) })
      } else {
        mutated(); json({ job_id: 'synthetic-job', submission_id: 'synthetic-submission', environment_id: 160, sha256: 'a'.repeat(64) })
      }
    })
    return
  }
  res.writeHead(404); json({ message: 'Unknown synthetic Hybrid Analysis route' })
}
