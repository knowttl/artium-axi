import { nativeSettingsSchemas } from '../shared/api.js'
import type { ToolName } from './store/credential-store.js'
import checkpoint from '../../tools/inventories/checkpoint-axi.json' with { type: 'json' }
import { diagnosticError } from './health/diagnostic.js'

export function toolEndpoints(tool: ToolName, credential: Record<string, unknown>): URL[] {
  if (tool === 'gh-axi') {
    const origin = new URL(String(credential.origin))
    return [origin, origin.hostname === 'github.com' ? new URL('https://api.github.com')
      : origin.hostname.endsWith('.ghe.com') ? new URL(`https://api.${origin.hostname}`) : new URL('/api/v3', origin)]
  }
  if (tool === 'beyondtrust-axi') return [new URL(`https://${credential.host}`)]
  if (tool === 'checkpoint-axi') {
    const origin = checkpoint.regions[credential.region as keyof typeof checkpoint.regions]
    if (!origin) throw diagnosticError('CREDENTIAL_INVALID', { stage: 'configuration', message: 'Invalid credential field: region.' })
    return [new URL(origin)]
  }
  if (tool === 'hybrid-axi') return [new URL('https://hybrid-analysis.com')]
  if (tool === 'tenable-axi') return [new URL('https://cloud.tenable.com')]
  if (tool === 'vectra-axi' || tool === 'awx-axi') return [new URL(String(credential.origin))]
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
