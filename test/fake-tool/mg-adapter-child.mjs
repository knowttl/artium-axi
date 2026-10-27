import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { executeArgv } from '../../tools/node_modules/@knowttl/mg-axi/dist/cli.js'
import { resolveSecret } from '../../tools/node_modules/@knowttl/mg-axi/dist/secrets.js'

const { encode } = await import(createRequire(new URL('../../tools/node_modules/@knowttl/mg-axi/package.json', import.meta.url)).resolve('@toon-format/toon'))
const groupId = '00000000-0000-0000-0000-000000000003'
const userId = '00000000-0000-0000-0000-000000000004'
let sends = 0
const application = { async credential(profile) {
  assert.equal(profile.mode, 'application')
  assert.equal(profile.allowDeviceCode, false)
  assert.ok(resolveSecret(profile.clientSecret ?? profile.privateKey ?? profile.token).startsWith('CANARY-'))
  return { token: 'CANARY-graph-token', tenantId: profile.tenantId, clientId: profile.clientId,
    mode: 'application', cloud: 'commercial' }
} }
const transport = async request => {
  const url = new URL(request.url)
  assert.equal(url.origin, 'https://graph.microsoft.com')
  assert.equal(request.headers.Authorization, 'Bearer CANARY-graph-token')
  if (url.pathname === '/v1.0/security/runHuntingQuery') {
    assert.equal(request.method, 'POST')
    const body = JSON.parse(request.body)
    assert.equal(body.Timespan, 'P1D')
    assert.ok(body.Query.endsWith('\n| take 101'))
    const value = body.Query.includes('CANARY-query-leak') ? body.Query.replace(/\n\| take 101$/, '')
      : body.Query.includes('CANARY-secret-leak') ? Buffer.from(process.env.ARTIUM_SECRET_0).toString('base64') : 'Synthetic Device'
    return { status: 200, headers: {}, body: JSON.stringify({ schema: [{ name: 'DeviceName', type: 'String' }],
      results: [{ DeviceName: value }] }) }
  }
  assert.equal(request.method, 'GET')
  let body
  if (url.pathname === '/v1.0/users') body = { value: [{ id: userId,
    displayName: url.searchParams.get('$filter') === 'encoded-canary'
      ? Buffer.from(process.env.ARTIUM_SECRET_0).toString('base64') : 'Synthetic User' }] }
  else if (url.pathname === `/v1.0/groups/${groupId}`) body = { id: groupId,
    displayName: 'Synthetic Group', isAssignableToRole: false, securityEnabled: true, groupTypes: [], membershipRule: null }
  else if (url.pathname === `/v1.0/users/${userId}`) body = { id: userId }
  else if (url.pathname === `/v1.0/groups/${groupId}/members`) body = { value: [] }
  else throw new Error('Unreviewed fake Graph route')
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}
try {
  const result = await executeArgv(process.argv.slice(2), { application, delegated: {}, transport,
    mutationTransport: async request => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, `https://graph.microsoft.com/v1.0/groups/${groupId}/members/$ref`)
      assert.equal(request.headers.Authorization, 'Bearer CANARY-graph-token')
      assert.deepEqual(JSON.parse(request.body), { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` })
      sends++
      return { status: 204, headers: {}, body: '' }
    } })
  console.log(typeof result === 'string' ? result : encode({ ...result, fakeSends: sends }))
} catch (error) {
  if (!error.code) throw error
  assert.equal(sends, 0)
  console.log(encode({ error: { code: error.code }, fakeSends: sends }))
  process.exitCode = 1
}
