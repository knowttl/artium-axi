import { readSuccessfulTestHealth, structuredDiagnostic } from '../shared/diagnostic.js'
import { errors } from '../shared/errors.js'
import type { TestOutcome } from './test-outcome.js'

export async function retestConnection(url: string, csrf: unknown): Promise<TestOutcome | { redirect: string }> {
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Artium-Retest': '1' }, body: JSON.stringify({ _csrf: csrf }) })
  } catch {
    return { message: 'Connection test: Could not reach the artium admin server. Run Test connection again.' }
  }
  if (response.redirected) return { redirect: response.url }
  const status = ` HTTP ${response.status}.`
  let result
  try { result = await response.json() }
  catch (error) {
    return { message: error instanceof SyntaxError
      ? `Connection test: response was not valid JSON.${status} Check the server or proxy response format. Run Test connection again.`
      : `Connection test: response body could not be read.${status} Check the connection for an interrupted response. Run Test connection again.` }
  }
  if (response.ok) {
    const health = readSuccessfulTestHealth(result)
    return health ? { message: 'Connected', health }
      : { message: `Connection test: response did not match the connection-test format.${status} Check server and client version compatibility. Run Test connection again.` }
  }
  const code = result?.error?.code
  const errorCode = typeof code === 'string' && Object.hasOwn(errors, code) ? code as keyof typeof errors : undefined
  const detail = structuredDiagnostic(result?.error?.diagnostic)
  const message = `Connection test:${status}` + (errorCode ? ` ${errors[errorCode].message} (${errorCode}).` : ' Server error code unavailable.') +
    (detail?.stage ? ` Failed step: ${detail.stage}.` : '') + (detail?.toolCode ? ` Code: ${detail.toolCode}.` : '') +
    (detail?.transportCode ? ` Transport: ${detail.transportCode}.` : '') + (detail?.providerCode ? ` Provider: ${detail.providerCode}.` : '') +
    (detail?.upstreamStatus === undefined ? '' : ` Upstream HTTP ${detail.upstreamStatus}.`) +
    (detail?.trust ? ` Certificate trust: ${detail.trust}.` : '') + ' Run Test connection again.'
  return { message }
}
