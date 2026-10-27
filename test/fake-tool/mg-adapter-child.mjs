import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { executeArgv } from '../../tools/node_modules/@knowttl/mg-axi/dist/cli.js'
import { resolveSecret } from '../../tools/node_modules/@knowttl/mg-axi/dist/secrets.js'
import { KqlValidationError } from '../../tools/node_modules/@knowttl/mg-axi/dist/kql.js'

const { encode } = await import(createRequire(new URL('../../tools/node_modules/@knowttl/mg-axi/package.json', import.meta.url)).resolve('@toon-format/toon'))
const groupId = '00000000-0000-0000-0000-000000000003'
const userId = '00000000-0000-0000-0000-000000000004'
let sends = 0
let reads = 0
let credentialCalls = 0
const application = { async credential(profile) {
  credentialCalls++
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
  reads++
  const mailRoot = '/v1.0/users/mailbox%40contoso.example'
  const mailPath = url.pathname.slice(mailRoot.length)
  if (url.pathname.startsWith(mailRoot + '/')) {
    const folder = { id: 'inbox', displayName: 'Synthetic Inbox', totalItemCount: 1, unreadItemCount: 1 }
    const message = { id: 'synthetic-message', subject: 'Synthetic Mail', isRead: false, categories: ['Existing'], flag: { flagStatus: 'notFlagged' },
      body: { contentType: 'text', content: 'Outside sender content' } }
    const rule = { id: 'synthetic-rule', displayName: 'Synthetic Rule', sequence: 1, isEnabled: true, isReadOnly: false, actions: { markAsRead: true } }
    const routes = {
      '/mailFolders': { value: [folder] }, '/mailFolders/inbox': folder,
      '/messages': { value: [message] }, '/messages/synthetic-message': message,
      '/messages/synthetic-message/attachments': { value: [{ id: 'synthetic-attachment', name: 'metadata.txt',
        contentType: 'text/plain', size: 12, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment', contentBytes: 'DO-NOT-PRINT' }] },
      '/mailboxSettings': { timeZone: 'UTC' },
      '/mailFolders/inbox/messageRules': { value: [rule] },
      '/mailFolders/inbox/messageRules/synthetic-rule': rule,
      '/outlook/masterCategories': { value: [{ id: 'synthetic-category', displayName: 'Synthetic Category', color: 'preset0' }] },
    }
    if (/^\/mailFolders\/[^/]+$/.test(mailPath) && !Object.hasOwn(routes, mailPath)) {
      const id = mailPath.split('/').at(-1)
      routes[mailPath] = { id: id === 'custom-folder' ? id : `protected-${id}`, totalItemCount: 0, childFolderCount: 0 }
    }
    if (/^\/messages\/[^/]+$/.test(mailPath)) routes[mailPath] = { ...message, id: mailPath.split('/').at(-1) }
    assert.ok(Object.hasOwn(routes, mailPath), 'Unreviewed fake mail route')
    if (mailPath === '/messages') {
      assert.equal(url.searchParams.get('$top'), '100')
      assert.equal(url.searchParams.get('$select'), 'id,subject,receivedDateTime,isRead')
    }
    return { status: 200, headers: {}, body: JSON.stringify(routes[mailPath]) }
  }
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
      const url = new URL(request.url)
      const root = '/v1.0/users/mailbox%40contoso.example'
      if (url.pathname.startsWith(root + '/')) {
        assert.equal(request.headers.Authorization, 'Bearer CANARY-graph-token')
        const path = url.pathname.slice(root.length)
        const body = request.body ? JSON.parse(request.body) : undefined
        if (/^\/messages\/[^/]+(?:\/(?:move|copy))?$/.test(path)) {
          assert.ok(['PATCH', 'POST'].includes(request.method))
          assert.ok(['categories', 'flag', 'isRead', 'destinationId'].some(key => Object.hasOwn(body, key)))
          if (body.categories) assert.deepEqual(body.categories, ['Existing', 'Reviewed'])
          if (body.flag) assert.deepEqual(body.flag, { flagStatus: 'flagged' })
          if (Object.hasOwn(body, 'isRead')) assert.equal(body.isRead, true)
          if (body.destinationId) assert.ok(['archive', 'deleteditems', 'CANARY-private-folder'].includes(body.destinationId))
        } else if (path === '/mailFolders') {
          assert.equal(request.method, 'POST'); assert.deepEqual(body, { displayName: 'Reviewed' })
        } else if (path === '/mailFolders/custom-folder') {
          assert.equal(request.method, 'DELETE')
        } else if (path === '/outlook/masterCategories') {
          assert.equal(request.method, 'POST'); assert.deepEqual(body, { displayName: 'Reviewed', color: 'preset4' })
        } else if (path === '/mailFolders/inbox/messageRules') {
          assert.equal(request.method, 'POST'); assert.equal(body.displayName, 'Reviewed')
        } else if (path === '/mailFolders/inbox/messageRules/synthetic-rule') {
          assert.ok(['PATCH', 'DELETE'].includes(request.method))
        } else throw new Error('Unreviewed fake mail mutation')
        sends++
        if (path.includes('failed-message')) return { status: 403, headers: {}, body: '' }
        if (path.includes('unknown-message')) throw new Error('Synthetic unknown outcome')
        return { status: request.method === 'DELETE' ? 204 : 200, headers: {}, body: JSON.stringify({ id: 'new-id' }) }
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.url, `https://graph.microsoft.com/v1.0/groups/${groupId}/members/$ref`)
      assert.equal(request.headers.Authorization, 'Bearer CANARY-graph-token')
      assert.deepEqual(JSON.parse(request.body), { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` })
      sends++
      return { status: 204, headers: {}, body: '' }
    } })
  console.log(typeof result === 'string' ? result : encode({ ...result, fakeSends: sends, fakeReads: reads, credentialCalls }))
} catch (error) {
  if (!error.code) throw error
  assert.equal(sends, 0)
  console.log(encode({ error: { code: error.code },
    ...(error instanceof KqlValidationError ? { diagnostics: error.diagnostics } : {}), fakeSends: sends, fakeReads: reads, credentialCalls }))
  process.exitCode = error instanceof KqlValidationError ? 2 : 1
}
