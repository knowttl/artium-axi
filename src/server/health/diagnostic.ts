import { ArtiumError, type Diagnostic, type ErrorCode } from '../../shared/errors.js'
import { SecretScanner } from '../runner/scan.js'
import type { ToolName } from '../store/credential-store.js'

export const diagnosticLimit = 4096
export const certificateErrorCodePattern = new RegExp(`\\b(?:${[
  'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'CERT_REVOKED', 'CERT_CHAIN_TOO_LONG',
  'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'CERTIFICATE_VERIFY_FAILED',
  'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'CRL_SIGNATURE_FAILURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_CRL',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'INVALID_CA', 'PATH_LENGTH_EXCEEDED', 'HOSTNAME_MISMATCH', 'INVALID_PURPOSE',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
].join('|')})\\b`)
export const azureAdvice: Record<string, string> = {
  AADSTS7000215: 'The client secret is invalid. Save the secret value, then test again.',
  AADSTS7000222: 'The client secret expired. Create and save a replacement secret.',
  AADSTS700016: 'The application was not found in the tenant. Check tenantId and clientId.',
  AADSTS90002: 'The tenant was not found. Check tenantId.',
  AADSTS700027: 'The client certificate signature was rejected. Check the registered certificate and matching private key.',
}

// Scan the complete detail before bounding it, including fields other than message.
export function safeDiagnostic(detail: Diagnostic | undefined, secrets: readonly string[]): Diagnostic | undefined {
  if (!detail || new SecretScanner(secrets.filter(Boolean)).scan('stderr', Buffer.from(JSON.stringify(detail)))) return
  let remaining = diagnosticLimit
  return Object.fromEntries(Object.entries(detail).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value]
    const bounded = value.slice(0, remaining)
    remaining -= bounded.length
    return [key, bounded]
  })) as unknown as Diagnostic
}

export function diagnosticError(code: ErrorCode, detail: Diagnostic): ArtiumError {
  const error = new ArtiumError(code)
  error.diagnostic = detail
  return error
}

export function toolFailure(stdout: string, stderr: string, exitCode: number, tool?: ToolName): ArtiumError {
  const text = [stderr, stdout].filter(Boolean).join('\n')
  const toolCode = /^\s*(?:code|error_code):\s*["']?([A-Za-z][A-Za-z0-9_]{0,79})["']?\s*$/mi.exec(text)?.[1]
    ?? /\bAADSTS\d{4,8}\b/.exec(text)?.[0]
  const providerCode = /\bAADSTS\d{4,8}\b/.exec(text)?.[0]
  const hint = /^\s*(?:hint|next):\s*(.+)$/mi.exec(text)?.[1] ?? (providerCode ? azureAdvice[providerCode] : undefined)
  const message = text.trim() || `Tool exited with status ${exitCode}.`
  let code: ErrorCode = 'TOOL_FAILED'
  let stage: Diagnostic['stage'] = 'tool run'
  if (toolCode === 'AUTH_EXCHANGE_FAILED') {
    stage = 'token acquisition'
    if (/OAuth credential exchange could not complete/.test(text)) code = 'UPSTREAM_NETWORK_FAILED'
  } else if (certificateErrorCodePattern.test(text) || /TLS.*(?:FAIL|ERROR)|ERR_TLS|certificate verification/i.test(text)) {
    code = 'UPSTREAM_TLS_FAILED'; stage = 'TLS'
  } else if (/ENOTFOUND|EAI_AGAIN|DNS|name resolution/i.test(text)) {
    code = 'UPSTREAM_NETWORK_FAILED'; stage = 'DNS'
  } else if (/^(SERVER_UNREACHABLE|OPERATION_TIMEOUT|TRANSPORT_FAILED)$/.test(toolCode ?? '') || /ECONN|ETIMEDOUT|NETWORK|timed? ?out|socket hang up|fetch failed/i.test(text)) {
    code = 'UPSTREAM_NETWORK_FAILED'; stage = 'TCP'
  } else if (/^(AUTH_FAILED|AUTH_REQUIRED|AUTH_EXPIRED|ACCESS_DENIED|PASSWORD_EXPIRED|ACCOUNT_DISABLED|ACCOUNT_EXPIRED|ACCOUNT_LOCKED|INSUFFICIENT_ACCESS|STRONGER_AUTH_REQUIRED|GSSAPI_CREDENTIAL_UNAVAILABLE|GSSAPI_NEGOTIATION_FAILED)$/.test(toolCode ?? '')
    || /AADSTS|invalid_client|AuthenticationError|InvalidAuthenticationToken|UNAUTHORIZED|FORBIDDEN|invalid.credentials|invalid password|invalidCredentials|\b401\b|\b403\b/i.test(text)) {
    code = 'UPSTREAM_AUTH_FAILED'; stage = tool === 'mg-axi' && toolCode === 'AUTH_REQUIRED' && !/\b401\b/.test(text) ? 'token acquisition' : 'authentication'
  } else if (exitCode === 2 || /INVALID_(?:INPUT|CONFIG|ARGUMENT)|CONFIG.*INVALID|cannot be combined|unknown (?:flag|option)|required field/i.test(text)) {
    code = 'TOOL_REJECTED_INPUT'; stage = 'configuration'
  }
  return diagnosticError(code, { stage, message, ...(toolCode ? { toolCode } : {}), ...(providerCode ? { providerCode } : {}), ...(hint ? { hint } : {}) })
}
