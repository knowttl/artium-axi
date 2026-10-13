import { ClientAssertion, ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node'
import type { INetworkModule, NodeAuthOptions } from '@azure/msal-node'
import { z } from 'zod'
import { ArtiumError } from '../../shared/errors.js'

const nonempty = z.string().min(1).refine(value => value.trim().length > 0)
const identity = { tenantId: z.uuid(), clientId: z.uuid() }
export const azureCredentialSchema = z.discriminatedUnion('auth', [
  z.object({ ...identity, auth: z.literal('secret'), clientSecret: nonempty }).strict(),
  z.object({ ...identity, auth: z.literal('certificate'), privateKey: nonempty,
    thumbprintSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict(),
])
export type AzureCredential = z.infer<typeof azureCredentialSchema>

// az-axi 0.1.6 dist/lib/auth.js RESOURCE_URL. Live scope acceptance remains pending.
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
  try {
    const parsed = azureCredentialSchema.safeParse(value)
    if (!parsed.success || !Object.hasOwn(azureAudiences, resource)) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
    const credential = parsed.data
    const secrets = [credential.auth === 'secret' ? credential.clientSecret : credential.privateKey]
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
        return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() as T }
      }
      networkClient = {
        sendGetRequestAsync: (url, options) => request(url, 'GET', options),
        sendPostRequestAsync: (url, options) => request(url, 'POST', options),
      }
    }
    const client = new ConfidentialClientApplication({
      auth,
      system: { ...(networkClient ? { networkClient } : {}),
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
    })
    const result = await client.acquireTokenByClientCredential({ scopes: [`${azureAudiences[resource]}/.default`] })
    if (!result?.accessToken || !result.expiresOn) throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
    return { accessToken: result.accessToken, expiresAt: result.expiresOn.getTime(), secrets: [...secrets, result.accessToken] }
  } catch {
    // MSAL and transport errors may embed credentials, assertions or service diagnostics.
    throw new ArtiumError('CREDENTIAL_UNAVAILABLE')
  }
}
