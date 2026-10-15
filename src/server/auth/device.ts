import { randomBytes, randomInt } from 'node:crypto'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { devicePollSchema, deviceUserCodeSchema } from '../../shared/api.js'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { deviceDefaults } from '../config.js'
import { escape } from '../admin/escape.js'
import { AuthRateLimits } from './attempts.js'
import { browserCookie, browserPage } from './browser.js'
import { browserIdentity, readBrowserSession } from './sessions.js'
import { hashToken, issueLoginTokens } from './tokens.js'

type Request = { userCode: string, address: string, createdAt: number, expiresAt: number,
  nextPollAt: number, proof?: string, approved?: string, denied?: boolean }

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
    return db.prepare("SELECT id, name FROM sso_providers WHERE kind = 'entra' AND enabled = 1 ORDER BY name, id")
      .all() as { id: string, name: string }[]
  }
  function approver(token: string) {
    const current = readBrowserSession(db, token)
    const identity = browserIdentity(db, current)
    if (!providers().some(provider => provider.id === identity.provider_id)) throw new ArtiumError('SSO_PROVIDER_ERROR')
    return current
  }
  app.post('/v1/auth/device', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    creationLimits.admitAddress(request.ip)
    if (!z.strictObject({}).safeParse(request.body ?? {}).success) throw new ArtiumError('INVALID_INPUT')
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
    requests.set(hashToken(deviceCode), { userCode, address: request.ip, createdAt: now, expiresAt, nextPollAt: 0 })
    return { deviceCode, userCode, verificationUri: `${request.protocol}://${request.host}/device`, expiresAt, intervalMs: deviceDefaults.intervalMs }
  })
  app.post('/v1/auth/device/poll', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const input = devicePollSchema.safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    const key = hashToken(input.data.deviceCode)
    const row = active(requests.get(key))
    if (row.nextPollAt > Date.now()) throw new ArtiumError('DEVICE_POLL_LIMITED')
    row.nextPollAt = Date.now() + deviceDefaults.intervalMs
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
    if (!input.data.code) return browserPage(reply, 'CLI sign-in', `<p>Enter the code shown by artium-axi login --sso on your own terminal.</p>
      <form method="get" action="/device"><label>Device code <input name="code" autocomplete="off" maxlength="9" required></label><button>Continue</button></form>`)
    entryLimits.admitAddress(request.ip)
    const code = input.data.code
    const row = byUserCode(code)
    let current
    if (request.cookies[browserCookie]) {
      try { current = readBrowserSession(db, request.cookies[browserCookie]!) }
      catch (error) { if (!(error instanceof ArtiumError)) throw error }
    }
    const details = `<section><h2>Approve CLI sign-in</h2><p>Code: <strong>${escape(code)}</strong></p>
      <p>Requesting IP: <strong>${escape(row.address)}</strong></p><p>Requested: ${escape(new Date(row.createdAt).toISOString())}</p>
      <p>Warning: Approve only if you just ran artium-axi login --sso on a device you control and the code matches your terminal.
      Approval gives that device access to your artium tools for up to 8 hours. Never approve a code someone sent you.</p></section>`
    const proved = current && row.proof === hashToken(request.cookies[browserCookie]!)
    const csrf = reply.generateCsrf()
    let actions = '<p>This request is already approved. Return to your terminal.</p>'
    if (!row.approved && proved) {
      actions = `<p>Approve as ${escape(current!.username)}.</p><form method="post" action="/device">
        <input type="hidden" name="_csrf" value="${escape(csrf)}"><input type="hidden" name="code" value="${escape(code)}">
        <button name="decision" value="approve">Approve</button><button name="decision" value="deny">This wasn't me</button></form>`
    } else if (!row.approved) {
      actions = '<p>Confirm your identity with a fresh Microsoft sign-in before approving.</p>' + providers().map(provider =>
        `<p><a data-device-sso href="/auth/sso/${escape(encodeURIComponent(provider.id))}/start?device=${encodeURIComponent(code)}">Sign in with Microsoft (${escape(provider.name)})</a></p>`).join('')
    }
    return browserPage(reply, 'CLI sign-in', details + actions, current)
  })
  app.post('/device', async (request, reply) => {
    entryLimits.admitAddress(request.ip)
    const input = z.strictObject({ code: deviceUserCodeSchema, decision: z.enum(['approve', 'deny']) }).safeParse(request.body)
    if (!input.success) throw new ArtiumError('INVALID_INPUT')
    const row = byUserCode(input.data.code)
    const token = request.cookies[browserCookie] ?? ''
    const current = approver(token)
    if (row.proof !== hashToken(token) || row.approved) throw new ArtiumError('DEVICE_CODE_INVALID')
    const denied = input.data.decision === 'deny'
    audit.record({ event: denied ? 'device-deny' : 'device-approve', userId: current.user_id, tool: null,
      outcome: 'success', requestId: request.id, clientAddress: request.ip, requestingAddress: row.address })
    if (denied) row.denied = true
    else row.approved = token
    return browserPage(reply, 'CLI sign-in', `<p>${denied ? 'Request denied. No CLI access was granted.' : 'Request approved. Return to your terminal.'}</p><p><a href="/account">Account</a></p>`, current)
  })
  app.addHook('onClose', async () => { requests.clear() })
  return {
    validate(code: string) {
      const row = byUserCode(code)
      if (row.approved) throw new ArtiumError('DEVICE_CODE_INVALID')
    },
    signedIn(code: string, sessionToken: string) {
      const row = byUserCode(code)
      if (row.approved) throw new ArtiumError('DEVICE_CODE_INVALID')
      row.proof = hashToken(sessionToken)
    },
  }
}
