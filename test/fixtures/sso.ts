import { generateKeyPairSync } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SsoFetch } from '../../src/server/auth/sso.js'
import type { ProviderCredentials } from '../../src/server/store/provider-credentials.js'
import { createFakeOidcProvider } from '../fake-service/oidc.js'

export const syntheticTenant = '11111111-1111-4111-8111-111111111111'
export const syntheticObject = '22222222-2222-4222-8222-222222222222'
const clientId = '33333333-3333-4333-8333-333333333333'
const issuer = `https://login.microsoftonline.com/${syntheticTenant}/v2.0`
export const ssoStart = '/auth/sso/synthetic-entra/start'

export async function seedBrowserSso(db: Database.Database, credentials: ProviderCredentials, redirectUri: string,
  options: { authentication?: 'certificate' | 'secret', authorizationEndpoint?: string, browserApproval?: boolean } = {}) {
  const authentication = options.authentication ?? 'certificate'
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const token: { claims?: Record<string, unknown>, tamperSignature?: boolean } = {}
  const configuration: Parameters<typeof createFakeOidcProvider>[0] = { issuer, clientId, redirectUri, token,
    authorizationEndpoint: options.authorizationEndpoint ?? issuer + '/authorize', browserApproval: options.browserApproval,
    authentication: authentication === 'certificate' ? { kind: 'certificate', publicKey } : { kind: 'secret', secret: 'CANARY-sso-client-secret' },
    claims: { sub: 'synthetic-subject', tid: syntheticTenant, oid: syntheticObject, preferred_username: 'synthetic-sso', roles: ['Artium.Reader'] } }
  const provider = await createFakeOidcProvider(configuration)
  db.prepare("INSERT INTO sso_providers (id, name, kind, issuer, enabled) VALUES ('synthetic-entra', 'Synthetic Entra', 'entra', ?, 1)").run(issuer)
  db.exec(`INSERT INTO users (id, username, display_name, source, must_change)
    VALUES ('synthetic-browser-sso', 'synthetic-browser-sso', 'Synthetic browser SSO', 'sso', 0)`)
  db.prepare(`INSERT INTO identities (id, user_id, provider_id, issuer, subject, created_at)
    VALUES ('synthetic-identity', 'synthetic-browser-sso', 'synthetic-entra', ?, ?, ?)`).run(issuer, `${syntheticTenant}:${syntheticObject}`, Date.now())
  credentials.replace('synthetic-entra', { tenantId: syntheticTenant, clientId, auth: authentication,
    ...(authentication === 'certificate' ? { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), thumbprintSha256: '11'.repeat(32) }
      : { clientSecret: 'CANARY-sso-client-secret' }) }, 0, 'synthetic-development-user', Date.now())
  const fetchProvider: SsoFetch = (url, options) => {
    if (!url.startsWith(issuer + '/')) throw new Error('Unexpected fake SSO destination')
    const path = url.slice(issuer.length)
    return fetch(provider.url + path, options as RequestInit)
  }
  return { token, configuration, url: provider.url, fetch: fetchProvider, close: provider.close }
}
