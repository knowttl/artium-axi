import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SsoFetch } from '../../src/server/auth/sso.js'
import type { ProviderCredentials } from '../../src/server/store/provider-credentials.js'
import { createFakeOidcProvider } from '../fake-service/oidc.js'
import { hashToken } from '../../src/server/auth/tokens.js'

export const syntheticTenant = '11111111-1111-4111-8111-111111111111'
export const syntheticObject = '22222222-2222-4222-8222-222222222222'
const clientId = '33333333-3333-4333-8333-333333333333'
const issuer = `https://login.microsoftonline.com/${syntheticTenant}/v2.0`
export const ssoStart = '/auth/sso/synthetic-entra/start'

export function seedSsoInvitation(db: Database.Database, options: { userId?: string, expectedUsername?: string, providerId?: string } = {}) {
  const id = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.prepare(`INSERT INTO invitations (id, token_hash, provider_id, expected_username, display_name, user_id, created_at, created_by, expires_at)
    VALUES (?, ?, ?, ?, 'Synthetic invited user', ?, ?, 'synthetic-development-user', ?)`)
    .run(id, hashToken(token), options.providerId ?? 'synthetic-entra', options.expectedUsername ?? 'synthetic-invited', options.userId ?? null, now, now + 86_400_000)
  db.prepare('INSERT INTO invitation_roles (invitation_id, role_id) VALUES (?, ?)').run(id, 'synthetic-role')
  return { id, claimPath: `/auth/sso/${options.providerId ?? 'synthetic-entra'}/start?invitation=` + token }
}

export function seedSsoRules(db: Database.Database) {
  db.exec(`INSERT INTO roles (id, name) VALUES ('synthetic-rule-role', 'Synthetic rule role');
    INSERT INTO role_rules (id, provider_id, claim, value, role_id) VALUES
      ('synthetic-reader-rule', 'synthetic-entra', 'roles', 'Artium.Reader', 'synthetic-rule-role'),
      ('synthetic-overlap-rule', 'synthetic-entra', 'roles', 'Artium.Reader', 'synthetic-role')`)
}

export async function seedBrowserSso(db: Database.Database, credentials: ProviderCredentials, redirectUri: string,
  options: { authentication?: 'certificate' | 'secret', authorizationEndpoint?: string, endSessionEndpoint?: string, browserApproval?: boolean,
    secretMethod?: 'client_secret_basic' | 'client_secret_post',
    clientSecret?: string,
    generic?: { id: string, issuer: string, clientId: string } } = {}) {
  const providerId = options.generic?.id ?? 'synthetic-entra'
  const providerIssuer = options.generic?.issuer ?? issuer
  const providerClientId = options.generic?.clientId ?? clientId
  const userId = options.generic ? providerId + '-user' : 'synthetic-browser-sso'
  const authentication = options.authentication ?? 'certificate'
  const clientSecret = options.clientSecret ?? 'CANARY-sso-client-secret'
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const token: { claims?: Record<string, unknown>, tamperSignature?: boolean } = {}
  const configuration: Parameters<typeof createFakeOidcProvider>[0] = { issuer: providerIssuer, clientId: providerClientId, redirectUri, token,
    authorizationEndpoint: options.authorizationEndpoint ?? providerIssuer + '/authorize', browserApproval: options.browserApproval,
    endSessionEndpoint: options.endSessionEndpoint,
    authentication: authentication === 'certificate' ? { kind: 'certificate', publicKey } : { kind: 'secret', secret: clientSecret, method: options.secretMethod },
    claims: { sub: 'synthetic-subject', tid: syntheticTenant, oid: syntheticObject, preferred_username: 'synthetic-sso', roles: ['Artium.Reader'] } }
  const provider = await createFakeOidcProvider(configuration)
  db.prepare('INSERT INTO sso_providers (id, name, kind, issuer, enabled) VALUES (?, ?, ?, ?, 1)')
    .run(providerId, options.generic ? providerId : 'Synthetic Entra', options.generic ? 'oidc' : 'entra', providerIssuer)
  db.prepare(`INSERT INTO users (id, username, display_name, source, must_change)
    VALUES (?, ?, 'Synthetic browser SSO', 'sso', 0)`).run(userId, userId)
  db.prepare(`INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(options.generic ? providerId + '-identity' : 'synthetic-identity', userId,
      providerId, providerIssuer, options.generic ? 'synthetic-subject' : `${syntheticTenant}:${syntheticObject}`, Date.now())
  credentials.replace(providerId, { ...(options.generic ? {} : { tenantId: syntheticTenant }), clientId: providerClientId, auth: authentication,
    ...(authentication === 'certificate' ? { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), thumbprintSha256: '11'.repeat(32) }
      : { clientSecret }) }, 0, 'synthetic-development-user', Date.now())
  const fetchProvider: SsoFetch = (url, options) => {
    if (!url.startsWith(providerIssuer + '/')) throw new Error('Unexpected fake SSO destination')
    const path = url.slice(providerIssuer.length)
    return fetch(provider.url + path, options as RequestInit)
  }
  return { token, configuration, url: provider.url, fetch: fetchProvider, authorizations: provider.authorizations, close: provider.close }
}
