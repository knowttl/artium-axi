import { createServer } from 'node:https'
import { verify, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hybridResponse } from './hybrid.mjs'
import { checkpointResponse } from './checkpoint.mjs'

const requests = []
const resources = new Map()
let mutations = 0
let basicAuthEnabled = true
let githubDeviceScenario = 'success'
let githubDevicePolls = 0
const certs = process.argv[2] ?? '/certs'
const githubAppPublicKey = new X509Certificate(readFileSync(join(certs, 'server.crt'))).publicKey

function authorizationScheme(header) {
  if (typeof header !== 'string') return 'none'
  if (header.startsWith('Basic ')) return 'Basic'
  if (header.startsWith('Bearer ')) return 'Bearer'
  return 'none'
}

function basicPassword(header) {
  if (authorizationScheme(header) !== 'Basic') return ''
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  return separator === -1 ? '' : decoded.slice(separator + 1)
}
const server = createServer({ key: readFileSync(join(certs, 'server.key')), cert: readFileSync(join(certs, 'server.crt')) }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`)
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/__github/device') {
    githubDeviceScenario = url.searchParams.get('scenario') ?? 'success'
    githubDevicePolls = 0
    res.end('{}')
    return
  }
  if (['/login/device/code', '/login/oauth/access_token'].includes(url.pathname)) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const fields = new URLSearchParams(body)
      const valid = req.method === 'POST' && fields.get('client_id') === '178c6fc778ccc68e1d6a'
      requests.push({ method: req.method, path: url.pathname, validClient: valid,
        ...(url.pathname === '/login/device/code' ? { scope: fields.get('scope') }
          : { validGrant: fields.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code' }) })
      if (!valid) { res.writeHead(400); res.end('{}'); return }
      if (githubDeviceScenario === 'disabled') { res.end(JSON.stringify({ error: 'device_flow_disabled' })); return }
      if (url.pathname === '/login/device/code') {
        res.end(JSON.stringify({ device_code: 'CANARY-device-code', user_code: 'ABCD-EFGH',
          verification_uri: `https://${req.headers.host}/login/device`, expires_in: 900, interval: 5 }))
        return
      }
      if (fields.get('device_code') !== 'CANARY-device-code') { res.writeHead(400); res.end('{}'); return }
      githubDevicePolls++
      const error = githubDeviceScenario === 'denied' ? 'access_denied' : githubDeviceScenario === 'expired' ? 'expired_token'
        : githubDevicePolls === 1 ? 'authorization_pending' : githubDevicePolls === 2 ? 'slow_down' : undefined
      res.end(JSON.stringify(error ? { error } : { access_token: 'gho_CANARY-device-token', token_type: 'bearer',
        scope: 'repo,read:org,gist,workflow,project', ...(githubDeviceScenario === 'expiring' ? { expires_in: 3600 } : {}) }))
    })
    return
  }
  if (url.pathname === '/api/v3/user' && req.headers.authorization === 'Bearer gho_CANARY-device-token') {
    requests.push({ method: req.method, path: url.pathname, canaryReceived: true })
    res.end(JSON.stringify({ login: 'synthetic-machine' }))
    return
  }
  if (/^\/(?:api\/v3\/)?app\/installations\/[0-9]+\/access_tokens$/.test(url.pathname)) {
    const jwt = String(req.headers.authorization ?? '').replace(/^Bearer /, '').split('.')
    let valid = false
    try {
      const claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString())
      valid = verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), githubAppPublicKey, Buffer.from(jwt[2], 'base64url'))
        && claims.iss === '123' && claims.iat <= Date.now() / 1000 && claims.exp > Date.now() / 1000
    } catch {}
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, path: url.pathname, signed: valid, narrowing: JSON.parse(body || '{}') })
      if (!valid || req.method !== 'POST') { res.writeHead(401); res.end('{}'); return }
      res.writeHead(201)
      res.end(JSON.stringify({ token: 'CANARY-github-installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() }))
    })
    return
  }
  if (url.pathname === '/__evidence') {
    res.end(JSON.stringify({ requests, mutations }))
    return
  }
  if (url.pathname === '/__ado/reset' && req.method === 'POST') {
    resources.clear()
    requests.length = 0
    mutations = 0
    basicAuthEnabled = true
    res.end('{}')
    return
  }
  if (url.pathname === '/__awx/basic-auth' && req.method === 'POST') {
    basicAuthEnabled = url.searchParams.get('enabled') !== 'false'
    res.end('{}')
    return
  }
  if (req.headers.host === 'hybrid-analysis.com') {
    hybridResponse(req, res, url, requests, resources, () => { mutations++ })
    return
  }
  if (/^cloudinfra-gw(?:[.-][a-z]+)?\.portal\.checkpoint\.com$/.test(req.headers.host ?? '')) {
    checkpointResponse(req, res, url, requests, () => { mutations++ })
    return
  }
  if (req.headers.host === 'cloud.tenable.com') {
    const canaryReceived = req.headers['x-apikeys'] === 'accessKey=CANARY-tenable-access; secretKey=CANARY-tenable-secret'
    requests.push({ method: req.method, path: url.pathname, canaryReceived })
    if (!canaryReceived) { res.writeHead(401); res.end(JSON.stringify({ message: 'Invalid API keys' })); return }
    if (req.method === 'POST' && url.pathname === '/tags/categories') {
      mutations++
      res.end(JSON.stringify({ uuid: '11111111-1111-4111-8111-111111111111', name: 'Synthetic category', reserved: false }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/tags/categories') {
      res.end(JSON.stringify({ categories: [], pagination: { total: 0, offset: 0, limit: 100 } })); return
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/t1/inventory/export/assets') {
      mutations++
      res.end(JSON.stringify({ export_id: '22222222-2222-4222-8222-222222222222' }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/t1/exposure-view/cards') {
      const cards = Array.from({ length: 25 }, (_, index) => ({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        name: `Synthetic ${index === 0 ? 'exposure' : 'continuation'} ${index}`.padEnd(100, 'x'),
        ces_score: { score: 42 },
      }))
      const offset = Number(url.searchParams.get('offset') ?? 0)
      res.end(JSON.stringify({ data: cards.slice(offset, offset + 25), pagination: { total: cards.length } }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/t1/tags/properties') {
      res.end(JSON.stringify({ data: [] })); return
    }
    res.writeHead(404); res.end(JSON.stringify({ message: 'Unknown synthetic route' })); return
  }
  if (url.pathname === '/api/v2/tokens/' && req.method === 'POST') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { parsed = null }
      const recorded = { method: 'POST', path: url.pathname, auth: authorizationScheme(req.headers.authorization),
        accept: req.headers.accept ?? null, contentType: req.headers['content-type'] ?? null }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) recorded.body = parsed
      requests.push(recorded)
      const expectedBody = recorded.body?.description === 'awx-axi' && recorded.body?.scope === 'write' && Object.keys(recorded.body).length === 2
      const expectedAuthorization = `Basic ${Buffer.from('synthetic-awx:CANARY-awx-password').toString('base64')}`
      if (!basicAuthEnabled) {
        res.writeHead(401)
        res.end(JSON.stringify({ detail: `Authentication credentials were not provided. ${basicPassword(req.headers.authorization)}` }))
        return
      }
      if (req.headers.authorization !== expectedAuthorization || !expectedBody) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="api"' })
        res.end(JSON.stringify({ detail: 'Invalid username/password.' }))
        return
      }
      res.writeHead(201)
      res.end(JSON.stringify({ id: 7, token: 'CANARY-awx-minted-token', scope: 'write', description: 'awx-axi' }))
    })
    return
  }
  if (url.pathname.startsWith('/api/v2/')) {
    const authorization = req.headers.authorization
    const canaryReceived = authorization === 'Bearer CANARY-awx-token' || authorization === 'Bearer CANARY-awx-minted-token'
    requests.push({ method: req.method, path: url.pathname, auth: authorizationScheme(authorization), canaryReceived })
    if (!canaryReceived) { res.writeHead(401); res.end(JSON.stringify({ detail: 'Invalid token' })); return }
    if (req.method !== 'GET') {
      mutations++
      if (url.pathname === '/api/v2/jobs/42/cancel/') { res.writeHead(202); res.end('{}'); return }
      res.writeHead(400); res.end('{}'); return
    }
    if (url.pathname === '/api/v2/jobs/42/cancel/') { res.end(JSON.stringify({ can_cancel: true })); return }
    if (url.pathname === '/api/v2/me/') { res.end(JSON.stringify({ results: [{ username: 'synthetic-reader' }] })); return }
    if (url.pathname === '/api/v2/jobs/42/') {
      res.end(JSON.stringify({ id: 42, name: 'Synthetic AWX job', status: 'running', type: 'job' })); return
    }
    if (url.pathname === '/api/v2/unified_jobs/' || url.pathname === '/api/v2/jobs/') {
      res.end(JSON.stringify({ count: 1, next: null, results: [{ id: 42, name: 'Synthetic AWX job', status: 'running', type: 'job' }] })); return
    }
    res.end(JSON.stringify({ count: 0, next: null, results: [] }))
    return
  }
  if (['dev.azure.com', 'vsrm.dev.azure.com', 'vssps.dev.azure.com', 'almsearch.dev.azure.com'].includes(req.headers.host)) {
    const authorization = req.headers.authorization ?? ''
    const recorded = { method: req.method, host: req.headers.host, path: url.pathname, query: Object.fromEntries(url.searchParams),
      auth: authorization.startsWith('Basic ') ? 'Basic' : authorization.startsWith('Bearer ') ? 'Bearer' : 'none',
      canaryReceived: authorization === `Basic ${Buffer.from(':CANARY-ado-pat').toString('base64')}`
        || authorization === 'Bearer CANARY-AZURE-ACCESS-TOKEN' }
    requests.push(recorded)
    const workItem = resources.get('ado-work-item') ?? { id: 42, rev: 2, fields: { 'System.Title': 'Synthetic work item', 'System.State': 'Active',
      'System.WorkItemType': 'Task', 'System.Tags': 'synthetic', 'System.Description': 'Synthetic description',
      'System.AssignedTo': { id: 'synthetic-user', displayName: 'Synthetic User' } },
      relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/synthetic-org/_apis/wit/workItems/41' }] }
    const pr = resources.get('ado-pr') ?? { pullRequestId: 42, title: 'Synthetic PR', description: 'Synthetic description', status: 'active',
      repository: { id: 'synthetic-repo', name: 'Synthetic Repo', project: { id: 'synthetic-project' } },
      lastMergeSourceCommit: { commitId: 'a'.repeat(40) }, sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main',
      reviewers: [{ id: '11111111-1111-1111-1111-111111111111', displayName: 'Synthetic Reviewer', vote: 0 }], autoCompleteSetBy: null }
    const thread = resources.get('ado-thread') ?? { id: 5, status: 'fixed',
      comments: [{ id: 1, content: 'Synthetic discussion', commentType: 'text' }] }
    const refs = resources.get('ado-refs') ?? [{ name: 'refs/heads/main', objectId: 'a'.repeat(40) },
      { name: 'refs/heads/feature-existing', objectId: 'b'.repeat(40) }]
    const comments = resources.get('ado-comments') ?? []
    const apiPath = url.pathname.slice(url.pathname.indexOf('/_apis/'))
    const git = '/_apis/git/repositories/Synthetic%20Repo'
    resources.set('ado-work-item', workItem)
    resources.set('ado-pr', pr)
    resources.set('ado-thread', thread)
    resources.set('ado-refs', refs)
    resources.set('ado-comments', comments)
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (body) recorded.body = JSON.parse(body)
      if (url.pathname.endsWith('/_apis/projects') && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ id: 'synthetic-project', name: 'Synthetic Project', state: 'wellFormed' }], count: 1 }))
      } else if (url.pathname.endsWith('/_apis/connectionData') && req.method === 'GET') {
        res.end(JSON.stringify({ authenticatedUser: { id: 'synthetic-user', providerDisplayName: 'Synthetic User' } }))
      } else if (url.pathname.endsWith('/_apis/wit/wiql') && req.method === 'POST') {
        res.end(JSON.stringify({ workItems: [{ id: workItem.id }] }))
      } else if (url.pathname.endsWith('/_apis/wit/workitemsbatch') && req.method === 'POST') {
        res.end(JSON.stringify({ value: [workItem] }))
      } else if (apiPath === '/_apis/wit/workitems/$Task' && req.method === 'POST') {
        mutations++
        workItem.id = 43
        for (const patch of recorded.body) workItem.fields[patch.path.slice('/fields/'.length)] = patch.value
        res.end(JSON.stringify(workItem))
      } else if (apiPath === '/_apis/wit/workItems/42/comments' && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          mutations++
          const comment = { id: comments.length + 1, ...recorded.body }
          comments.push(comment)
          res.end(JSON.stringify(comment))
        } else res.end(JSON.stringify({ comments }))
      } else if (url.pathname.endsWith('/_apis/wit/workitems/42') && ['GET', 'PATCH'].includes(req.method)) {
        if (req.method === 'PATCH') {
          mutations++
          for (const patch of recorded.body) {
            if (patch.path.startsWith('/fields/')) workItem.fields[patch.path.slice('/fields/'.length)] = patch.value
            if (patch.path === '/relations/-') workItem.relations.push(patch.value)
          }
        }
        res.end(JSON.stringify(workItem))
      } else if (url.pathname.endsWith('/pullrequests/42/threads/5/comments') && req.method === 'POST') {
        mutations++
        const comment = { id: thread.comments.length + 1, ...recorded.body }
        thread.comments.push(comment)
        res.end(JSON.stringify(comment))
      } else if (apiPath === `${git}/pullrequests/42/threads/5` && ['GET', 'PATCH'].includes(req.method)) {
        if (req.method === 'PATCH') { mutations++; Object.assign(thread, recorded.body) }
        res.end(JSON.stringify(thread))
      } else if (url.pathname.endsWith('/pullrequests/42/threads') && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          mutations++
          Object.assign(thread, recorded.body)
          res.end(JSON.stringify(thread))
        } else res.end(JSON.stringify({ value: [thread] }))
      } else if (apiPath.startsWith(`${git}/pullrequests/42/reviewers/`) && ['PUT', 'DELETE'].includes(req.method)) {
        mutations++
        const id = apiPath.split('/').at(-1)
        pr.reviewers = pr.reviewers.filter(reviewer => reviewer.id !== id)
        const reviewer = { id, displayName: 'Synthetic added reviewer', ...recorded.body }
        if (req.method === 'PUT') pr.reviewers.push(reviewer)
        res.end(JSON.stringify(reviewer))
      } else if (apiPath === `${git}/pullrequests/42/reviewers` && req.method === 'GET') {
        res.end(JSON.stringify({ value: pr.reviewers }))
      } else if (apiPath === `${git}/pullrequests/42/statuses` && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ context: { name: 'Synthetic check' }, state: 'pending' }] }))
      } else if (apiPath === '/_apis/policy/evaluations' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [] }))
      } else if (apiPath === `${git}/pullrequests/42/iterations` && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ id: 1 }] }))
      } else if (apiPath === `${git}/pullrequests/42/iterations/1/changes` && req.method === 'GET') {
        res.end(JSON.stringify({ changeEntries: [{ item: { path: '/synthetic.txt' }, changeType: 'edit' }], count: 1 }))
      } else if ([`${git}/pullrequests`, '/_apis/git/pullrequests'].includes(apiPath) && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          mutations++
          pr.pullRequestId = 43
          Object.assign(pr, recorded.body)
          res.end(JSON.stringify(pr))
        } else res.end(JSON.stringify({ value: [pr], count: 1 }))
      } else if (url.pathname.endsWith('/pullrequests/42') && ['GET', 'PATCH'].includes(req.method)) {
        if (req.method === 'PATCH') {
          mutations++
          Object.assign(pr, recorded.body)
        }
        res.end(JSON.stringify(pr))
      } else if (apiPath === '/_apis/pipelines' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ id: 7, name: 'Synthetic pipeline' }] }))
      } else if (apiPath === '/_apis/pipelines/7/runs' && req.method === 'POST') {
        mutations++
        resources.set('ado-build', { id: 10, definition: { name: 'Synthetic pipeline' }, status: 'inProgress',
          sourceBranch: recorded.body.resources.repositories.self.refName })
        res.end(JSON.stringify({ id: 10, name: 'Synthetic queued run', state: 'inProgress' }))
      } else if (apiPath === '/_apis/build/builds' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [resources.get('ado-build') ??
          { id: 8, definition: { name: 'Synthetic pipeline' }, status: 'completed', result: 'succeeded' }] }))
      } else if (apiPath === '/_apis/build/builds/8' && req.method === 'GET') {
        res.end(JSON.stringify({ id: 8, definition: { name: 'Synthetic pipeline' }, status: 'completed', result: 'succeeded' }))
      } else if (apiPath === '/_apis/build/builds/8/timeline' && req.method === 'GET') {
        res.end(JSON.stringify({ records: [{ id: 'synthetic-job', name: 'Synthetic job', type: 'Job', state: 'completed', result: 'succeeded' }] }))
      } else if (apiPath === '/_apis/build/builds/8/logs' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ id: 1 }] }))
      } else if (apiPath === '/_apis/build/builds/8/logs/1' && req.method === 'GET') {
        res.end('Synthetic build log')
      } else if (apiPath === '/_apis/test/runs' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ id: 9, name: 'Synthetic tests', totalTests: 1, unanalyzedTests: 1 }] }))
      } else if (apiPath === '/_apis/test/Runs/9/results' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ testCaseTitle: 'Synthetic test case', outcome: 'Failed', errorMessage: 'Synthetic assertion failed' }] }))
      } else if (apiPath === '/_apis/git/repositories' && req.method === 'GET') {
        res.end(JSON.stringify({ value: [{ id: 'synthetic-repo', name: 'Synthetic Repo', defaultBranch: 'refs/heads/main' }] }))
      } else if (apiPath === `${git}/items` && req.method === 'GET') {
        res.end(JSON.stringify({ path: '/synthetic.txt', content: 'Synthetic file content' }))
      } else if (apiPath === `${git}/refs` && ['GET', 'POST'].includes(req.method)) {
        if (req.method === 'POST') {
          mutations++
          for (const ref of recorded.body) {
            const index = refs.findIndex(existing => existing.name === ref.name)
            if (index >= 0) refs.splice(index, 1)
            if (ref.newObjectId !== '0'.repeat(40)) refs.push({ name: ref.name, objectId: ref.newObjectId })
          }
          res.end(JSON.stringify({ value: recorded.body.map(ref => ({ ...ref, success: true })) }))
        } else res.end(JSON.stringify({ value: refs.filter(ref => ref.name.startsWith(`refs/${url.searchParams.get('filter') ?? ''}`)) }))
      } else if (url.pathname.endsWith('/_apis/redaction') && req.method === 'GET') {
        res.end(JSON.stringify(url.searchParams.get('form') === 'basic'
          ? { header: Buffer.from(':CANARY-ado-pat').toString('base64') }
          : { token: authorization.startsWith('Bearer ') ? 'CANARY-AZURE-ACCESS-TOKEN' : 'CANARY-ado-pat' }))
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ message: 'Unknown fake Azure DevOps route' }))
      }
    })
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
  if (url.pathname === '/real-time-response/queries/sessions/v1') {
    res.end(JSON.stringify({ resources: ['synthetic-rtr-session'], meta: { pagination: { total: 1, offset: 0 } } }))
  } else if (url.pathname === '/real-time-response/entities/sessions/GET/v1'
    || url.pathname === '/real-time-response-audit/combined/sessions/v1') {
    req.resume()
    res.end(JSON.stringify({ resources: [{ id: 'synthetic-rtr-session', hostname: 'SYNTHETIC-HOST',
      user_id: 'synthetic-operator', created_at: '2026-01-01T00:00:00Z' }], meta: { pagination: { total: 1, offset: 0 } } }))
  } else if (url.pathname === '/real-time-response/entities/sessions/v1') {
    req.resume()
    mutations++
    res.end(JSON.stringify({ resources: req.method === 'DELETE' ? [] : [{ session_id: 'synthetic-rtr-session' }] }))
  } else if (url.pathname === '/real-time-response/entities/command/v1') {
    req.resume()
    if (req.method === 'POST') mutations++
    const sequence = Number(url.searchParams.get('sequence_id') ?? 0)
    const output = ['synthetic process list\n', 'synthetic remaining processes'][sequence] ?? ''
    res.end(JSON.stringify({ resources: [req.method === 'POST' ? { cloud_request_id: 'synthetic-rtr-command' }
      : { stdout: output, stderr: '', complete: true, sequence_id: sequence }] }))
  } else if (url.pathname === '/alerts/queries/alerts/v2') {
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
  } else if (url.pathname.includes('/alerts/runner-timeout-alert')) {
    const target = url.pathname.replace(/\/(?:resolve|dismiss|activate)$/, '')
    if (req.method === 'POST') {
      req.resume()
      req.on('end', () => {
        mutations++
        resources.set(target, { id: target, properties: { status: 'Resolved' } })
      })
    } else res.end(JSON.stringify(resources.get(target) ?? { id: target, properties: { status: 'Active' } }))
  } else if (url.pathname.endsWith('/providers/Microsoft.OperationalInsights/workspaces') && url.pathname.includes('44444444-4444-4444-8444-444444444444')) {
    res.end(JSON.stringify({ value: [{ name: 'synthetic workspace',
      id: '/subscriptions/44444444-4444-4444-8444-444444444444/resourceGroups/runner-timeout-recovery/providers/Microsoft.OperationalInsights/workspaces/synthetic workspace',
      properties: { customerId: '33333333-3333-4333-8333-333333333333' } }] }))
  } else if (url.pathname.includes('/resourceGroups/runner-timeout-recovery/') && url.pathname.includes('/providers/Microsoft.SecurityInsights/incidents')) {
    const incident = '/subscriptions/44444444-4444-4444-8444-444444444444/resourceGroups/runner-timeout-recovery/providers/Microsoft.OperationalInsights/workspaces/synthetic%20workspace/providers/Microsoft.SecurityInsights/incidents/11111111-1111-4111-8111-111111111111'
    const state = { id: decodeURI(incident), name: '11111111-1111-4111-8111-111111111111', properties: { incidentNumber: 17, status: 'Active' } }
    if (req.method === 'PUT') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        mutations++
        recorded.body = JSON.parse(body)
        resources.set(url.pathname, { id: url.pathname, ...recorded.body })
        if (req.headers['x-artium-test-outcome'] === 'drop') req.socket.destroy()
        if (req.headers['x-artium-test-outcome'] === '504') {
          res.writeHead(504)
          res.end(JSON.stringify({ error: { code: 'GatewayTimeout' } }))
        }
      })
    } else if (url.pathname.endsWith('/comments')) {
      res.end(JSON.stringify({ value: [...resources.values()].filter(resource => resource.id.startsWith(url.pathname + '/')) }))
    } else if (/\/comments\/[^/]+$/.test(url.pathname)) {
      if (resources.has(url.pathname)) res.end(JSON.stringify(resources.get(url.pathname)))
      else {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'NotFound' } }))
      }
    } else res.end(JSON.stringify(url.pathname.endsWith('/incidents') ? { value: [resources.get(incident) ?? state] } : resources.get(url.pathname) ?? state))
  } else if (url.pathname.includes('/resourceGroups/runner-timeout-recovery/') && url.pathname.includes('/providers/Microsoft.Network/networkSecurityGroups/')) {
    if (req.method === 'PUT') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        mutations++
        resources.set(url.pathname, { id: url.pathname, ...JSON.parse(body) })
      })
    } else if (resources.has(url.pathname)) res.end(JSON.stringify(resources.get(url.pathname)))
    else if (url.pathname.includes('/securityRules/')) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: { code: 'NotFound' } }))
    } else res.end(JSON.stringify({ id: url.pathname, properties: { securityRules: [] } }))
  } else if (url.pathname.includes('/resourceGroups/runner-timeout-') && (req.method === 'PATCH' || url.pathname.endsWith('/runner-timeout-read'))) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.method === 'PATCH') {
        mutations++
        const value = JSON.parse(body)
        resources.set(url.pathname, value.properties?.tags ? { properties: { tags: value.properties.tags } } : value)
      }
    })
  } else if (resources.has(url.pathname)) {
    res.end(JSON.stringify(resources.get(url.pathname)))
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
    else if (url.pathname === '/api/v2.5/tagging/detection/42') {
      resources.set(url.pathname, { tags: ['synthetic'] })
      res.end(JSON.stringify(resources.get(url.pathname)))
    }
    else {
      res.writeHead(503, { 'retry-after': '0' })
      res.end(JSON.stringify({ error: { code: 'SyntheticAmbiguousWrite', message: 'Mutation recorded before response failed' } }))
    }
  } else if (url.pathname.startsWith('/api/v2.5/tagging/')) {
    res.end(JSON.stringify(resources.get(url.pathname) ?? { tags: [] }))
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
