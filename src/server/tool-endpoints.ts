import { nativeSettingsSchemas } from '../shared/api.js'
import type { ToolName } from './store/credential-store.js'
import { diagnosticError } from './health/diagnostic.js'

export function toolEndpoints(tool: ToolName, credential: Record<string, unknown>): URL[] {
  if (tool === 'vectra-axi') return [new URL(String(credential.origin))]
  if (tool === 'ldap-axi') return [new URL(String(credential.url))]
  if (tool === 'ado-axi') return [
    ...(credential.auth === 'client-secret' ? ['login.microsoftonline.com'] : []),
    'dev.azure.com', 'vsrm.dev.azure.com', 'vssps.dev.azure.com', 'almsearch.dev.azure.com',
  ].map(host => new URL(`https://${host}`))
  if (tool === 'mg-axi') return ['login.microsoftonline.com', 'graph.microsoft.com'].map(host => new URL(`https://${host}`))
  if (tool === 'az-axi') {
    const destinations = nativeSettingsSchemas['az-axi'].shape.tlsDestinations.parse(credential.tlsDestinations)
    return [...new Set(['login.microsoftonline.com', 'management.azure.com', 'graph.microsoft.com', 'api.loganalytics.io',
      ...(destinations?.storageAccounts ?? []).map(name => `${name}.blob.core.windows.net`),
      ...(destinations?.keyVaults ?? []).map(name => `${name}.vault.azure.net`),
      ...(destinations?.registries ?? []).map(name => `${name}.azurecr.io`),
    ])].map(host => new URL(`https://${host}`))
  }
  const regions: Record<string, string> = { 'us-1': 'api.crowdstrike.com', 'us-2': 'api.us-2.crowdstrike.com',
    'eu-1': 'api.eu-1.crowdstrike.com', 'us-gov-1': 'api.laggar.gcw.crowdstrike.com',
    'us-gov-2': 'api.us-gov-2.crowdstrike.mil' }
  const region = String(credential.region)
  const host = Object.entries(regions).find(([name, host]) => region === name || region === `https://${host}` || region === `https://${host}/`)?.[1]
  if (!host) throw diagnosticError('CREDENTIAL_INVALID', { stage: 'configuration', message: 'Invalid credential field: region.' })
  return [new URL(`https://${host}`)]
}
