import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto'
import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import { z } from 'zod'

interface FakeOidcOptions {
  issuer?: string
  authorizationEndpoint?: string
  endSessionEndpoint?: string | null
  browserApproval?: boolean
  clientId: string
  redirectUri: string
  authentication: { kind: 'secret', secret: string } | { kind: 'certificate', publicKey: KeyObject }
  claims: { sub: string, [key: string]: unknown }
  now?: () => number
  token?: { claims?: Record<string, unknown>, tamperSignature?: boolean }
}

// Serves one synthetic identity. This loopback server is test infrastructure only.
export async function createFakeOidcProvider(options: FakeOidcOptions) {
  const app = Fastify()
  await app.register(formbody)
  const now = options.now ?? Date.now
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = 'synthetic-signing-key'
  const codes = new Map<string, { challenge: string, nonce: string, expires: number, authTime?: number }>()
  const authorizations: Record<string, unknown>[] = []
  const assertions = new Set<string>()
  let issuer: string
  let url: string
  const authorizeInput = z.object({ client_id: z.literal(options.clientId), redirect_uri: z.literal(options.redirectUri),
    response_type: z.literal('code'), scope: z.string().refine(value => value.split(' ').includes('openid')),
    state: z.string().min(1), nonce: z.string().min(1), code_challenge: z.string().min(1), code_challenge_method: z.literal('S256'),
    prompt: z.literal('login').optional() })
  const tokenInput = z.object({ grant_type: z.literal('authorization_code'), code: z.string(),
    redirect_uri: z.literal(options.redirectUri), client_id: z.literal(options.clientId), code_verifier: z.string() })

  app.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: options.authorizationEndpoint ?? url + '/authorize',
    token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', response_types_supported: ['code'],
    subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: [options.authentication.kind === 'certificate' ? 'private_key_jwt' : 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    ...(options.endSessionEndpoint === null ? {} : { end_session_endpoint: options.endSessionEndpoint ?? issuer + '/logout' }) }))
  app.get('/jwks', async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] }))
  app.get('/authorize', async (request, reply) => {
    const parsed = authorizeInput.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' })
    const input = parsed.data
    authorizations.push(input)
    const code = randomBytes(32).toString('base64url')
    codes.set(code, { challenge: input.code_challenge, nonce: input.nonce, expires: now() + 60_000,
      ...(input.prompt === 'login' ? { authTime: Math.floor(now() / 1000) } : {}) })
    const redirect = new URL(options.redirectUri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', input.state)
    if (options.browserApproval) return reply.type('text/html').send(`<!doctype html><html lang="en"><head><title>Synthetic identity provider</title></head><body><h1>Synthetic identity provider</h1><p><a data-oidc-approve href="${redirect.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">Continue with synthetic identity</a></p></body></html>`)
    return reply.redirect(redirect.href)
  })
  app.post('/token', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const body = request.body as Record<string, unknown>
    let authenticated = false
    if (options.authentication.kind === 'secret') authenticated = body?.client_secret === options.authentication.secret
    else {
      try {
        if (body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || typeof body.client_assertion !== 'string') throw new Error('Invalid assertion')
        const [header, payload, signature, extra] = body.client_assertion.split('.')
        const algorithm = JSON.parse(Buffer.from(header, 'base64url').toString()).alg
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
        authenticated = !extra && algorithm === 'RS256' && verify('RSA-SHA256', Buffer.from(header + '.' + payload),
          options.authentication.publicKey, Buffer.from(signature, 'base64url')) && claims.iss === options.clientId
          && claims.sub === options.clientId && claims.aud === issuer + '/token'
          && Number.isFinite(claims.exp) && claims.exp > now() / 1000
          && typeof claims.jti === 'string' && !assertions.has(claims.jti)
        if (authenticated) assertions.add(claims.jti)
      } catch { authenticated = false }
    }
    if (!authenticated) return reply.code(401).send({ error: 'invalid_client' })
    const parsed = tokenInput.safeParse(body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' })
    const input = parsed.data
    const code = codes.get(input.code)
    if (!code || code.expires <= now() || createHash('sha256').update(input.code_verifier).digest('base64url') !== code.challenge) {
      return reply.code(400).send({ error: 'invalid_grant' })
    }
    codes.delete(input.code)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ ...options.claims, iss: issuer, aud: options.clientId,
      iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 300, nonce: code.nonce,
      ...(code.authTime === undefined ? {} : { auth_time: code.authTime }),
      ...options.token?.claims })).toString('base64url')
    const signed = header + '.' + payload
    return { token_type: 'Bearer', access_token: 'CANARY-' + randomBytes(16).toString('base64url'), expires_in: 300,
      id_token: signed + '.' + sign('RSA-SHA256', Buffer.from(options.token?.tamperSignature ? signed + 'tampered' : signed), privateKey).toString('base64url') }
  })
  app.get('/logout', async (request, reply) => {
    const input = z.object({ client_id: z.literal(options.clientId),
      post_logout_redirect_uri: z.literal(new URL('/login', options.redirectUri).href) }).safeParse(request.query)
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' })
    return reply.type('text/html').send(`<!doctype html><html lang="en"><head><title>Synthetic sign-out</title></head><body><h1>Signed out of synthetic provider</h1><a href="${input.data.post_logout_redirect_uri}">Return to artium</a></body></html>`)
  })
  url = await app.listen({ host: '127.0.0.1', port: 0 })
  issuer = options.issuer ?? url
  return { issuer, url, authorizations, close: () => app.close() }
}
