import { randomBytes, randomInt } from 'node:crypto'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { devicePollSchema, deviceUserCodeSchema, ssoReauthSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { deviceDefaults } from '../config.js'
import { escape } from '../admin/escape.js'
import { callout } from '../admin/design/ui.js'
import { timestamp } from '../admin/forms.js'
import { AuthRateLimits } from './attempts.js'
import { browserCookie, browserPage } from './browser.js'
import { browserIdentity, readBrowserSession } from './sessions.js'
import { hashToken, issueLoginTokens, issueRecentAuthTicket } from './tokens.js'

type Request = { userCode: string, address: string, createdAt: number, expiresAt: number,
  nextPollAt: number, proof?: string, approved?: string, denied?: boolean,
  reauth?: { tokenHash: string, userId: string } }

// Bounded process-local approvals. Restart invalidates all outstanding requests.
// Only hashes of device secrets are retained; browser proofs never leave the server.
export function registerDevice(app: FastifyInstance, db: Database.Database, audit: Audit) {
  const requests = new Map<string, Request>()
  const creationLimits = new AuthRateLimits()
  const entryLimits = new AuthRateLimits()
  function active(row?: Request): Request {
    if (!row) throw new ArtiumError('DEVICE_CODE_INVALID')
    if (row.expiresAt <= Date.now()) throw new ArtiumError('DEVICE_CODE_EXPIRED')
    if (row.denied) throw new ArtiumError('DEVICE_DENIED')
    return row
  }
  function byUserCode(code: string) {
    return active([...requests.values()].find(row => row.userCode === code))
  }
  function providers() {
    return db.prepare('SELECT id, name FROM sso_providers WHERE enabled = 1 ORDER BY name, id')
      .all() as { id: string, name: string }[]
  }
  function approver(token: string) {
    const current = readBrowserSession(db, token)
    const identity = browserIdentity(db, current)
    if (!providers().some(provider => provider.id === identity.provider_id)) throw new ArtiumError('SSO_PROVIDER_ERROR')
    return current
  }
  function create(request: FastifyRequest, reauth?: Request['reauth']) {
    creationLimits.admitAddress(request.ip)
    if (!providers().length) throw new ArtiumError('SSO_PROVIDER_ERROR')
    const now = Date.now()
    // Retain expired requests for one lifetime so clients receive an explicit expiry.
    for (const [key, row] of requests) if (row.expiresAt + deviceDefaults.lifetimeMs <= now) requests.delete(key)
    if (requests.size >= deviceDefaults.pendingLimit) throw new ArtiumError('AUTH_RATE_LIMITED')
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let userCode: string
    do {
      const letters = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('')
      userCode = letters.slice(0, 4) + '-' + letters.slice(4)
    } while ([...requests.values()].some(row => row.userCode === userCode))
    const deviceCode = randomBytes(32).toString('base64url')
    const expiresAt = now + deviceDefaults.lifetimeMs
    requests.set(hashToken(deviceCode), { userCode, address: request.ip, createdAt: now, expiresAt, nextPollAt: 0, reauth })
    return { deviceCode, userCode, verificationUri: `${request.protocol}://${request.host}/device`, expiresAt, intervalMs: deviceDefaults.intervalMs }
  }
  function poll(deviceCode: string) {
    const row = active(requests.get(hashToken(deviceCode)))
    if (row.nextPollAt > Date.now()) throw new ArtiumError('DEVICE_POLL_LIMITED')
    row.nextPollAt = Date.now() + deviceDefaults.intervalMs
    return row
  }
  function confirm(row: Request, token: string) {
    const current = approver(token)
    if (row.reauth && row.reauth.userId !== current.user_id) throw new ArtiumError('SSO_TOKEN_INVALID')
    return current
  }
  app.post('/v1/auth/device', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!z.strictObject({}).safeParse(request.body ?? {}).success) throw new ArtiumError('INVALID_INPUT')
    return create(request)
  })
  app.post('/v1/auth/device/poll', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = devicePollSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    const key = hashToken(input.data.deviceCode)
    if (requests.get(key)?.reauth) throw new ArtiumError('DEVICE_CODE_INVALID')
    const row = poll(input.data.deviceCode)
    if (!row.approved) return { status: 'pending' }
    const current = approver(row.approved)
    const tokens = audit.change({ event: 'sign-in', authenticationMethod: 'sso', userId: current.user_id,
      tool: null, outcome: 'success', requestId: request.id, clientAddress: request.ip },
    () => issueLoginTokens(db, current.user_id)).value
    requests.delete(key)
    return tokens
  })
  app.get('/device', async (request, reply) => {
    const input = z.strictObject({ code: deviceUserCodeSchema.optional() }).safeParse(request.query)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    if (!input.data.code) return browserPage(reply, 'CLI approval', `<form method="get" action="/device"><div class="field"><label for="code">Device code</label><input id="code" class="mono" name="code" autocomplete="off" maxlength="9" required></div><button class="btn btn-primary">Continue</button></form>`,
      undefined, 'Enter the code shown by your CLI sign-in or identity confirmation request on your own terminal.')
    entryLimits.admitAddress(request.ip)
    const code = input.data.code
    const row = byUserCode(code)
    let current
    if (request.cookies[browserCookie]) {
      try { current = readBrowserSession(db, request.cookies[browserCookie]!) }
      catch (error) { if (!(error instanceof ArtiumError)) throw error }
    }
    const details = `<p>Approve only if you just ${row.reauth ? 'requested identity confirmation' : 'ran <code>artium-axi login --sso</code>'} on a device you control and the code matches your terminal.</p>
      <div class="bigcode" role="group" aria-label="Code">${escape(code)}</div>
      <dl class="kv"><dt>Requested from</dt><dd class="mono">${escape(row.address)}</dd><dt>When</dt><dd>${timestamp(row.createdAt)}</dd><dt>Grants</dt><dd>${row.reauth ? 'Identity confirmation for privileged CLI operations' : 'Your tools, for up to 8 hours'}</dd></dl>
      <p class="hint">Never approve a code someone sent you.</p>`
    const proved = current && row.proof === hashToken(request.cookies[browserCookie]!)
    const csrf = reply.generateCsrf()
    let actions = callout('ok', '', 'This request is already approved. Return to your terminal.')
    if (!row.approved && proved) {
      actions = `<form method="post" action="/device">
        <input type="hidden" name="_csrf" value="${escape(csrf)}"><input type="hidden" name="code" value="${escape(code)}">
        <p class="hint">Approving as ${escape(current!.username)}.</p>
        <div class="auth-actions"><button class="btn btn-danger-outline" name="decision" value="deny">This wasn't me</button><button class="btn btn-primary" name="decision" value="approve">Approve</button></div></form>`
    } else if (!row.approved) {
      actions = '<p>Confirm your identity with a fresh provider sign-in before approving.</p>' + providers().map((provider, index) =>
        `<a class="btn ${index ? 'btn-secondary' : 'btn-primary'}" data-device-sso href="/auth/sso/${escape(encodeURIComponent(provider.id))}/start?device=${encodeURIComponent(code)}">Sign in with ${escape(provider.name)}</a>`).join('')
    }
    return browserPage(reply, row.reauth ? 'Approve CLI identity confirmation?' : 'Approve CLI sign-in?', details + actions, current, undefined, { layout: 'auth', helpTopic: 'CLI approval' })
  })
  app.post('/device', async (request, reply) => {
    entryLimits.admitAddress(request.ip)
    const input = z.strictObject({ code: deviceUserCodeSchema, decision: z.enum(['approve', 'deny']) }).safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    const row = byUserCode(input.data.code)
    const token = request.cookies[browserCookie] ?? ''
    const current = confirm(row, token)
    if (row.proof !== hashToken(token) || row.approved) throw new ArtiumError('DEVICE_CODE_INVALID')
    const denied = input.data.decision === 'deny'
    audit.record({ event: denied ? 'device-deny' : 'device-approve', userId: current.user_id, tool: null,
      outcome: 'success', requestId: request.id, clientAddress: request.ip, requestingAddress: row.address })
    if (denied) row.denied = true
    else row.approved = token
    return browserPage(reply, denied ? 'Request denied' : 'Request approved', '<a class="btn btn-secondary" href="/account">Your account</a>', current,
      denied ? 'No CLI access was granted.' : 'Return to your terminal.', { layout: 'auth', helpTopic: 'CLI approval', mark: denied ? { icon: 'x', tone: 'neutral' } : { icon: 'check', tone: 'ok' } })
  })
  app.addHook('onClose', async () => { requests.clear() })
  return {
    reauthenticate(request: FastifyRequest, token: string, userId: string) {
      const input = ssoReauthSchema.safeParse(request.body)
      if (!input.success) throw new ArtiumError('INVALID_INPUT')
      if (!('deviceCode' in input.data)) return create(request, { tokenHash: hashToken(token), userId })
      const key = hashToken(input.data.deviceCode)
      const pending = active(requests.get(key))
      if (pending.reauth?.tokenHash !== hashToken(token)) throw new ArtiumError('DEVICE_CODE_INVALID')
      const row = poll(input.data.deviceCode)
      if (!row.approved) return { status: 'pending' }
      const current = confirm(row, row.approved)
      const identity = browserIdentity(db, current)
      const ticket = audit.change({ event: 'reauth', authenticationMethod: 'sso', userId, tool: null,
        providerId: identity.provider_id, subject: identity.subject, outcome: 'success', requestId: request.id, clientAddress: request.ip },
      () => issueRecentAuthTicket(db, token)).value
      requests.delete(key)
      return ticket
    },
    validate(code: string) {
      const row = byUserCode(code)
      if (row.approved) throw new ArtiumError('DEVICE_CODE_INVALID')
    },
    signedIn(code: string, sessionToken: string) {
      const row = byUserCode(code)
      if (row.approved) throw new ArtiumError('DEVICE_CODE_INVALID')
      confirm(row, sessionToken)
      row.proof = hashToken(sessionToken)
    },
  }
}
