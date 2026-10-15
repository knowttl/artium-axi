import { createPrivateKey, randomBytes, webcrypto } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import * as oidc from 'openid-client'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import type { Audit } from '../audit/audit.js'
import { ssoDefaults } from '../config.js'
import type { ProviderCredentials } from '../store/provider-credentials.js'
import { escape } from '../admin/escape.js'
import { AuthRateLimits } from './attempts.js'
import { browserCookie, browserPage, cookieOptions } from './browser.js'
import { createBrowserSession } from './sessions.js'
import { hashToken } from './tokens.js'

export type SsoFetch = NonNullable<oidc.DiscoveryRequestOptions[typeof oidc.customFetch]>
const preauthCookie = 'artium-sso'
const preauthOptions = { ...cookieOptions, path: '/auth/sso/', sameSite: 'lax' } as const
const credentialSchema = z.discriminatedUnion('auth', [
  z.object({ auth: z.literal('secret'), tenantId: z.uuid(), clientId: z.uuid(), clientSecret: z.string().min(1) }),
  z.object({ auth: z.literal('certificate'), tenantId: z.uuid(), clientId: z.uuid(), privateKey: z.string().min(1), thumbprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }),
])
type Provider = { id: string, issuer: string, revision: number }
type Pending = { provider: Provider, credentialRevision: number, config: oidc.Configuration, state: string,
  nonce: string, verifier: string, redirectUri: string, expiresAt: number }

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
  app.get<{ Params: { provider: string } }>('/auth/sso/:provider/start', async (request, reply) => {
    const event = context(request, request.params.provider)
    try {
      limits.admitAddress(request.ip)
      for (const [key, transaction] of pending) if (transaction.expiresAt <= Date.now()) pending.delete(key)
      if (pending.size >= ssoDefaults.pendingLimit) throw new ArtiumError('AUTH_RATE_LIMITED')
      // Invitation claims are deliberately deferred to P3b-2.
      if (Object.keys(request.query as object).length) throw new ArtiumError('INVALID_INPUT')
      const current = provider(request.params.provider)
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
        expiresAt: Date.now() + ssoDefaults.transactionMs }
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
      const identity = z.object({ tid: z.uuid(), oid: z.uuid(), iat: z.number().finite().max(Date.now() / 1000 + 30) }).safeParse(claims)
      if (!identity.success || transaction.provider.issuer !== `https://login.microsoftonline.com/${identity.data.tid}/v2.0` ||
        (claims?.azp !== undefined && claims.azp !== transaction.config.clientMetadata().client_id)) {
        throw new ArtiumError('SSO_TOKEN_INVALID')
      }
      subject = `${identity.data.tid}:${identity.data.oid}`
      const linked = db.prepare(`SELECT users.id, users.disabled FROM identities JOIN users ON users.id = identities.user_id
        WHERE provider_id = ? AND issuer = ? AND subject = ?`).get(transaction.provider.id, transaction.provider.issuer, subject) as
        { id: string, disabled: number } | undefined
      if (!linked) throw new ArtiumError('SSO_NOT_INVITED')
      userId = linked.id
      if (linked.disabled) throw new ArtiumError('USER_DISABLED')
      const csrfSecret = randomBytes(32).toString('base64url')
      const session = audit.change({ ...event, userId, subject, outcome: 'success' }, () => {
        unchanged(transaction)
        const created = createBrowserSession(db, linked.id, csrfSecret)
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
