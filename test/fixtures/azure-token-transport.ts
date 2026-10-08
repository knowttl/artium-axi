import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-node'

export const azureTestTenant = '11111111-1111-4111-8111-111111111111'
export const azureTestAuthority = `https://login.microsoftonline.com/${azureTestTenant}`
export const azureTestEndpoint = `${azureTestAuthority}/oauth2/v2.0/token`
export const azureTestToken = 'CANARY-AZURE-ACCESS-TOKEN'

export class FakeTokenTransport implements INetworkModule {
  readonly requests: { url: string, form: URLSearchParams }[] = []
  response: Record<string, unknown> = { access_token: azureTestToken, token_type: 'Bearer', expires_in: 3600 }
  status = 200
  failure?: string

  async sendGetRequestAsync<T>(url: string): Promise<NetworkResponse<T>> {
    if (url.startsWith('https://login.microsoftonline.com/common/discovery/instance?')) {
      return this.reply({ tenant_discovery_endpoint: `${azureTestAuthority}/v2.0/.well-known/openid-configuration`,
        metadata: [{ preferred_network: 'login.microsoftonline.com', preferred_cache: 'login.microsoftonline.com',
          aliases: ['login.microsoftonline.com'] }] })
    }
    if (url !== `${azureTestAuthority}/v2.0/.well-known/openid-configuration`) throw new Error('Unexpected fake discovery URL')
    return this.reply({ authorization_endpoint: `${azureTestAuthority}/oauth2/v2.0/authorize`, token_endpoint: azureTestEndpoint,
      issuer: `${azureTestAuthority}/v2.0`, jwks_uri: `${azureTestAuthority}/discovery/v2.0/keys`,
      end_session_endpoint: `${azureTestAuthority}/oauth2/v2.0/logout` })
  }

  async sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
    this.requests.push({ url, form: new URLSearchParams(options?.body) })
    if (this.failure) throw new Error(this.failure)
    return this.reply(this.response, this.status)
  }

  private reply<T>(body: unknown, status = 200): NetworkResponse<T> {
    return { headers: {}, status, body: body as T }
  }
}
