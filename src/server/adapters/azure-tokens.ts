import { ClientAssertion, ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node'
import type { INetworkModule, NodeAuthOptions } from '@azure/msal-node'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'
import { azureAdvice, certificateErrorCodePattern, diagnosticError, safeDiagnostic } from '../health/diagnostic.js'

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
const identity = { tenantId: z.uuid(), clientId: z.uuid() }
export const azureCredentialSchema = z.discriminatedUnion('auth', [
  z.object({ ...identity, auth: z.literal('secret'), clientSecret: nonempty }).strict(),
  z.object({ ...identity, auth: z.literal('certificate'), privateKey: nonempty,
    thumbprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict(),
])
export type AzureCredential = z.infer<typeof azureCredentialSchema>

// Pinned az-axi dist/lib/auth.js RESOURCE_URL; the pin is owned by tools/package.json.
// Live scope acceptance: https://github.com/knowttl/artium-axi/blob/archive/internal-docs/docs/evidence-ledger.md.
export const azureAudiences = Object.freeze({
  arm: 'https://management.azure.com/',
  logs: 'https://api.loganalytics.io',
  graph: 'https://graph.microsoft.com',
  storage: 'https://storage.azure.com/',
  vault: 'https://vault.azure.net/',
  registry: 'https://containerregistry.azure.net',
})
export type AzureResource = keyof typeof azureAudiences

export interface AzureToken {
  accessToken: string
  expiresAt: number
  secrets: string[]
}

// One acquisition, with no persistent cache.
export async function mintAzureToken(value: unknown, resource: AzureResource, networkClient?: INetworkModule, signal?: AbortSignal): Promise<AzureToken> {
  let transportFailure: unknown
  const secrets: string[] = []
  try {
    const parsed = azureCredentialSchema.safeParse(value)
    if (!parsed.success || !Object.hasOwn(azureAudiences, resource)) throw new ArtiumError('CREDENTIAL_INVALID')
    const credential = parsed.data
    secrets.push(credential.auth === 'secret' ? credential.clientSecret : credential.privateKey)
    const auth: NodeAuthOptions = {
      clientId: credential.clientId,
      authority: `https://login.microsoftonline.com/${credential.tenantId}`,
    }
    if (credential.auth === 'secret') auth.clientSecret = credential.clientSecret
    else {
      const assertion = ClientAssertion.fromCertificateWithSha256Thumbprint(credential.thumbprintSha256, credential.privateKey)
      // MSAL signs the assertion. Retain the exact submitted value for the runner's output scan.
      auth.clientAssertion = async ({ clientId, tokenEndpoint }) => {
        const jwt = assertion.getJwt(new CryptoProvider(), clientId, tokenEndpoint!)
        secrets.push(jwt)
        return jwt
      }
    }
    if (!networkClient && signal) {
      const request = async <T>(url: string, method: string, options?: import('@azure/msal-node').NetworkRequestOptions) => {
        const response = await fetch(url, { method, headers: options?.headers, body: options?.body, signal })
        let body: T
        try { body = await response.json() as T } catch {
          throw Object.assign(new Error('Invalid identity provider response'), { status: response.status })
        }
        if (!response.ok && ![400, 401, 403].includes(response.status)) {
          const errorCode = (body as { error?: unknown } | null)?.error
          throw Object.assign(new Error('Identity provider HTTP failure'), {
            status: response.status, ...(typeof errorCode === 'string' ? { errorCode } : {}),
          })
        }
        return { status: response.status, headers: Object.fromEntries(response.headers), body }
      }
      networkClient = {
        sendGetRequestAsync: (url, options) => request(url, 'GET', options),
        sendPostRequestAsync: (url, options) => request(url, 'POST', options),
      }
    }
    if (networkClient) {
      const transport = networkClient
      const guarded = async <T>(request: () => Promise<T>): Promise<T> => {
        try { return await request() } catch (error) { transportFailure = error; throw error }
      }
      networkClient = {
        sendGetRequestAsync: (url, options) => guarded(() => transport.sendGetRequestAsync(url, options)),
        sendPostRequestAsync: (url, options) => guarded(() => transport.sendPostRequestAsync(url, options)),
      }
    }
    const client = new ConfidentialClientApplication({
      auth,
      system: { ...(networkClient ? { networkClient } : {}),
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
    })
    const result = await client.acquireTokenByClientCredential({ scopes: [`${azureAudiences[resource]}/.default`] })
    if (!result?.accessToken || !result.expiresOn) throw diagnosticError('UPSTREAM_AUTH_FAILED', {
      stage: 'token acquisition', host: 'login.microsoftonline.com', message: 'The identity provider returned no usable access token.' })
    return { accessToken: result.accessToken, expiresAt: result.expiresOn.getTime(), secrets: [...secrets, result.accessToken] }
  } catch (error) {
    if (error instanceof ArtiumError) throw error
    const failure = azureTokenFailure(transportFailure ?? error, transportFailure !== undefined)
    failure.diagnostic = safeDiagnostic(failure.diagnostic, secrets)
    throw failure
  }
}

function azureTokenFailure(error: unknown, transport: boolean): ArtiumError {
  const fields = error as { errorCode?: string, errorMessage?: string, message?: string, code?: string, status?: number, cause?: { code?: string } }
  // Inspect only to select an allowlisted explanation. Never forward the response body.
  const text = [fields?.errorCode, fields?.errorMessage, fields?.message, fields?.code, fields?.cause?.code].join(' ')
  const providerCode = /\bAADSTS\d{4,8}\b/.exec(text)?.[0]
  const host = 'login.microsoftonline.com'
  const toolCode = providerCode ?? (/^[a-z][a-z0-9_]{0,79}$/.test(fields?.errorCode ?? '') ? fields.errorCode : undefined)
  if (fields?.status !== undefined && ![400, 401, 403].includes(fields.status)
    || ['temporarily_unavailable', 'server_error'].includes(fields?.errorCode ?? '')) return diagnosticError('TOOL_FAILED', {
    stage: 'token acquisition', host, message: 'The identity provider service could not complete token acquisition.',
    ...(toolCode ? { toolCode } : {}), hint: 'Try again later and check identity provider service availability.' })
  const verificationCode = certificateErrorCodePattern.exec(text)?.[0]
  if (verificationCode || /certificate verification|ERR_TLS/i.test(text)) return diagnosticError('UPSTREAM_TLS_FAILED', {
    stage: 'TLS', host, message: `TLS certificate verification failed contacting ${host}.`,
    ...(verificationCode ? { toolCode: verificationCode } : {}), hint: 'Check the certificate chain and upstream trusted-CA configuration.' })
  if (transport && fields?.status === undefined || /network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|timeout|aborted/i.test(text)) return diagnosticError('UPSTREAM_NETWORK_FAILED', {
    stage: /ENOTFOUND|EAI_AGAIN|DNS/i.test(text) ? 'DNS' : 'token acquisition', host,
    message: `Token acquisition could not reach ${host}.`, hint: 'Check DNS, routing, firewall rules and timeouts.' })
  if (/key|PEM|DECODER|crypto/i.test(text) && !providerCode) return diagnosticError('CREDENTIAL_INVALID', {
    stage: 'configuration', message: 'Invalid credential field: privateKey.' })
  return diagnosticError('UPSTREAM_AUTH_FAILED', { stage: 'token acquisition', host,
    message: 'The identity provider rejected token acquisition.', ...(toolCode ? { toolCode } : {}),
    hint: providerCode && azureAdvice[providerCode] || 'Check the tenant, application credential and permissions.' })
}
