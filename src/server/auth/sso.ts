import { createPrivateKey, randomBytes, randomUUID, webcrypto } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import * as oidc from 'openid-client'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit, AuditEvent } from '../audit/audit.js'
import { ssoDefaults } from '../config.js'
import type { ProviderCredentials } from '../store/provider-credentials.js'
import { escape } from '../admin/escape.js'
import { AuthRateLimits } from './attempts.js'
import { browserCookie, browserPage, cookieOptions } from './browser.js'
import { createBrowserSession } from './sessions.js'
import { hashToken, revokeUserSessions } from './tokens.js'

export type SsoFetch = NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]>
const preauthCookie = 'artium-sso'
const preauthOptions = { ...cookieOptions, path: '/auth/sso/', sameSite: 'lax' } as const
const credentialSchema = z.discriminatedUnion('auth', [
  z.object({ auth: z.literal('secret'), tenantId: z.uuid(), clientId: z.uuid(), clientSecret: z.string().min(1) }),
  z.object({ auth: z.literal('certificate'), tenantId: z.uuid(), clientId: z.uuid(), privateKey: z.string().min(1), thumbprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
])
type Provider = { id: string, issuer: string, revision: number }
type Pending = { provider: Provider, credentialRevision: number, config: oidc.Configuration, state: string,
  nonce: string, verifier: string, redirectUri: string, expiresAt: number, invitationHash?: string }
type Invitation = { id: string, expected_username: string, display_name: string, user_id: string | null }

// Transactions are process-local, bounded and consumed before any asynchronous exchange.
// Restarting the server invalidates outstanding sign-ins; tokens never enter the store.
export function registerSso(app: FastifyInstance, db: Database.Database, audit: Audit,
  credentials?: ProviderCredentials, transport?: SsoFetch): void {
  const pending = new Map<string, Pending>()
  const limits = new AuthRateLimits()
  const context = (request: FastifyRequest, providerId: string) => ({ event: 'sign-in' as const,
    authenticationMethod: 'sso' as const, providerId, userId: null, tool: null,
    requestId: request.id, clientAddress: request.ip })
  function provider(id: string): Provider {
    const row = db.prepare("SELECT id, issuer, revision FROM sso_providers WHERE id = ? AND kind = 'entra' AND enabled = 1").get(id) as Provider | undefined
    if (!row) throw new ArtiumError('SSO_PROVIDER_ERROR')
    return row
  }
  function unchanged(transaction: Pending): void {
    const current = provider(transaction.provider.id)
    if (current.revision !== transaction.provider.revision || current.issuer !== transaction.provider.issuer ||
      credentials?.read(current.id)?.revision !== transaction.credentialRevision) throw new ArtiumError('SSO_PROVIDER_ERROR')
  }
  function invitation(hash: string, providerId: string): Invitation {
    const row = db.prepare(`SELECT id, expected_username, display_name, user_id FROM invitations
      WHERE token_hash = ? AND provider_id = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .get(hash, providerId, Date.now()) as Invitation | undefined
    if (!row) throw new ArtiumError('SSO_INVITE_INVALID')
    return row
  }
  app.get<{ Params: { provider: string } }>('/auth/sso/:provider/start', async (request, reply) => {
    const event = context(request, request.params.provider)
    try {
      limits.admitAddress(request.ip)
      for (const [key, transaction] of pending) if (transaction.expiresAt <= Date.now()) pending.delete(key)
      if (pending.size >= ssoDefaults.pendingLimit) throw new ArtiumError('AUTH_RATE_LIMITED')
      const query = z.object({ invitation: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() }).strict().safeParse(request.query)
      if (!query.success) throw new ArtiumError('INVALID_INPUT')
      const current = provider(request.params.provider)
      const invitationHash = query.data.invitation ? hashToken(query.data.invitation) : undefined
      if (invitationHash) invitation(invitationHash, current.id)
      const stored = credentials?.read(current.id)
      const parsed = credentialSchema.safeParse(stored?.value)
      if (!parsed.success || !stored) throw new ArtiumError('SSO_PROVIDER_ERROR')
      const value = parsed.data
      if (current.issuer !== `https://login.microsoftonline.com/${value.tenantId}/v2.0` || request.protocol !== 'https') {
        throw new ArtiumError('SSO_PROVIDER_ERROR')
      }
      let authentication: oidc.ClientAuth
      let config: oidc.Configuration
      if (value.auth === 'secret') authentication = oidc.ClientSecretPost(value.clientSecret)
      else {
        const key = await webcrypto.subtle.importKey('pkcs8', createPrivateKey(value.privateKey).export({ type: 'pkcs8', format: 'der' }),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
        authentication = oidc.PrivateKeyJwt(key, { [oidc.modifyAssertion]: (header, payload) => {
          header['x5t#S256'] = Buffer.from(value.thumbprintSha256, 'hex').toString('base64url')
          payload.aud = config.serverMetadata().token_endpoint!
        } })
      }
      config = await oidc.discovery(new URL(current.issuer), value.clientId,
        { id_token_signed_response_alg: 'RS256' }, authentication,
        { ...(transport ? { [oidc.customFetch]: transport } : {}), execute: [oidc.enableNonRepudiationChecks], timeout: 10 })
      const verifier = oidc.randomPKCECodeVerifier()
      const transaction: Pending = { provider: current, credentialRevision: stored.revision, config,
        state: oidc.randomState(), nonce: oidc.randomNonce(), verifier,
        redirectUri: `https://${request.host}/auth/sso/${encodeURIComponent(current.id)}/callback`,
        expiresAt: Date.now() + ssoDefaults.transactionMs, invitationHash }
      unchanged(transaction)
      const url = oidc.buildAuthorizationUrl(config, { response_type: 'code', response_mode: 'query', scope: 'openid profile',
        redirect_uri: transaction.redirectUri, state: transaction.state, nonce: transaction.nonce,
        code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier) })
      const handle = randomBytes(32).toString('base64url')
      if (pending.size >= ssoDefaults.pendingLimit) throw new ArtiumError('AUTH_RATE_LIMITED')
      if (request.cookies[preauthCookie]) pending.delete(hashToken(request.cookies[preauthCookie]!))
      pending.set(hashToken(handle), transaction)
      return reply.setCookie(preauthCookie, handle, { ...preauthOptions, maxAge: ssoDefaults.transactionMs / 1000 }).redirect(url.href)
    } catch (error) {
      const failure = error instanceof ArtiumError ? error : new ArtiumError('SSO_PROVIDER_ERROR')
      audit.record({ ...event, outcome: failure.code })
      throw failure
    }
  })
  app.get<{ Params: { provider: string } }>('/auth/sso/:provider/callback', async (request, reply) => {
    const event = context(request, request.params.provider)
    let userId: string | null = null
    let subject: string | undefined
    reply.clearCookie(preauthCookie, preauthOptions)
    const key = hashToken(request.cookies[preauthCookie] ?? '')
    const transaction = pending.get(key)
    pending.delete(key)
    try {
      limits.admitAddress(request.ip)
      const url = new URL(request.url, `https://${request.host}`)
      if (!transaction || transaction.expiresAt <= Date.now() || transaction.provider.id !== request.params.provider ||
        url.origin + url.pathname !== transaction.redirectUri || url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== transaction.state) throw new ArtiumError('SSO_STATE_INVALID')
      unchanged(transaction)
      let claims
      try {
        const tokens = await oidc.authorizationCodeGrant(transaction.config, url, { pkceCodeVerifier: transaction.verifier,
          expectedState: transaction.state, expectedNonce: transaction.nonce, idTokenExpected: true })
        claims = tokens.claims()
      } catch (error) {
        throw new ArtiumError(error instanceof oidc.AuthorizationResponseError || error instanceof oidc.ResponseBodyError
          ? 'SSO_PROVIDER_ERROR' : 'SSO_TOKEN_INVALID')
      }
      const identity = z.object({ tid: z.uuid(), oid: z.uuid(), iat: z.number().finite().max(Date.now() / 1000 + 30),
        preferred_username: z.string().min(1).max(256).optional(), roles: z.array(z.string()).optional() }).safeParse(claims)
      if (!identity.success || transaction.provider.issuer !== `https://login.microsoftonline.com/${identity.data.tid}/v2.0` ||
        (claims?.azp !== undefined && claims.azp !== transaction.config.clientMetadata().client_id)) {
        throw new ArtiumError('SSO_TOKEN_INVALID')
      }
      subject = `${identity.data.tid}:${identity.data.oid}`
      const csrfSecret = randomBytes(32).toString('base64url')
      const events: AuditEvent[] = []
      const session = audit.change(events, () => {
        unchanged(transaction)
        const linked = db.prepare(`SELECT users.id, users.disabled FROM identities JOIN users ON users.id = identities.user_id
          WHERE provider_id = ? AND issuer = ? AND subject = ?`).get(transaction.provider.id, transaction.provider.issuer, subject) as
          { id: string, disabled: number } | undefined
        if (transaction.invitationHash) {
          const invite = invitation(transaction.invitationHash, transaction.provider.id)
          if (linked || identity.data.preferred_username !== invite.expected_username) throw new ArtiumError('SSO_INVITE_INVALID')
          const now = Date.now()
          if (invite.user_id) {
            const local = db.prepare("SELECT id FROM users WHERE id = ? AND source = 'local' AND disabled = 0 AND archived_at IS NULL")
              .get(invite.user_id)
            if (!local || db.prepare('SELECT 1 FROM identities WHERE user_id = ?').get(invite.user_id)) throw new ArtiumError('SSO_INVITE_INVALID')
            userId = invite.user_id
            db.prepare(`UPDATE users SET source = 'sso', password_hash = NULL, must_change = 0, failed_attempts = 0,
              locked_until = NULL, revision = revision + 1, updated_at = ?, updated_by = NULL WHERE id = ?`).run(now, userId)
            revokeUserSessions(db, userId, now)
            events.push({ ...event, event: 'identity-link', userId, subject: subject!, targetId: userId, outcome: 'success' })
          } else {
            if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(invite.expected_username)) throw new ArtiumError('SSO_INVITE_INVALID')
            userId = randomUUID()
            db.prepare(`INSERT INTO users (id, username, display_name, source, must_change)
              VALUES (?, ?, ?, 'sso', 0)`).run(userId, invite.expected_username, invite.display_name)
          }
          db.prepare('INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), userId, transaction.provider.id, transaction.provider.issuer, subject, now)
          db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id)
            SELECT ?, role_id FROM invitation_roles WHERE invitation_id = ?`).run(userId, invite.id)
          db.prepare('UPDATE invitations SET user_id = ?, claimed_at = ?, revision = revision + 1 WHERE id = ?').run(userId, now, invite.id)
          events.push({ ...event, event: 'invite-claim', userId, subject: subject!, targetId: invite.id, outcome: 'success' })
        } else {
          if (!linked) throw new ArtiumError('SSO_NOT_INVITED')
          userId = linked.id
          if (linked.disabled) throw new ArtiumError('USER_DISABLED')
        }
        const rules = db.prepare("SELECT id, role_id, value FROM role_rules WHERE provider_id = ? AND claim = 'roles' ORDER BY id")
          .all(transaction.provider.id) as { id: string, role_id: string, value: string }[]
        const previous = db.prepare(`SELECT origin FROM user_roles JOIN role_rules ON role_rules.id = user_roles.origin
          WHERE user_id = ? AND provider_id = ?`).all(userId, transaction.provider.id) as { origin: string }[]
        const matching = rules.filter(rule => identity.data.roles?.includes(rule.value))
        const removed = previous.filter(row => !matching.some(rule => rule.id === row.origin)).map(row => row.origin)
        const added = matching.filter(rule => !previous.some(row => row.origin === rule.id)).map(rule => rule.id)
        for (const origin of removed) db.prepare('DELETE FROM user_roles WHERE user_id = ? AND origin = ?').run(userId, origin)
        for (const rule of matching) db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, origin) VALUES (?, ?, ?)')
          .run(userId, rule.role_id, rule.id)
        if (added.length || removed.length) events.push({ ...event, event: 'role-sync', userId, subject: subject!, outcome: 'success', added, removed })
        events.push({ ...event, userId, subject, outcome: 'success' })
        const created = createBrowserSession(db, userId!, csrfSecret)
        // SSO recent-auth is implemented in P3c; this protocol cannot authorize admin changes.
        db.prepare('UPDATE sessions SET reauthenticated_at = NULL WHERE id = ?').run(hashToken(created.id))
        if (request.cookies[browserCookie]) db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
          .run(Date.now(), hashToken(request.cookies[browserCookie]!))
        return created
      }).value
      reply.setCookie(browserCookie, session.id, cookieOptions).setCookie('_csrf', csrfSecret, cookieOptions)
      // A document and user navigation establish a same-site hop before Strict cookies are needed.
      return browserPage(reply, 'Sign-in complete', `<p>Your identity has been verified.</p><p><a href="${escape(session.administrator ? '/admin' : '/account')}">Continue to artium</a></p>`)
    } catch (error) {
      const failure = error instanceof ArtiumError ? error : new ArtiumError('SSO_PROVIDER_ERROR')
      audit.record({ ...event, userId, subject, outcome: failure.code })
      throw failure
    }
  })
  app.addHook('onClose', async () => { pending.clear() })
}
